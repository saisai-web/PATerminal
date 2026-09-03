//! worktree の作成（変更ストリップの Worktree モーダルと Issue 実行が共有する）。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::ignore::ensure_worktree_ignored;
use super::inherit::{inherit_ignored, InheritProgress};
use super::path::{
    normalized_worktree_directory, resolved_external_directory, worktree_dir_name,
    worktree_parent_path,
};
use crate::git::{git_output_text, git_remotes, run_git};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeBranch {
    name: String,
    reference: String,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeBranches {
    branches: Vec<WorktreeBranch>,
}

/// worktree のベース候補。ローカルブランチを先、リモートブランチを後に返す。
#[tauri::command]
pub(crate) async fn git_worktree_branches(root: String) -> Result<WorktreeBranches, String> {
    if !PathBuf::from(&root).is_dir() {
        return Err("repository not found".into());
    }
    let current = run_git(&["-C", &root, "symbolic-ref", "-q", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let out = run_git(&[
        "-C",
        &root,
        "for-each-ref",
        "--format=%(refname)%09%(refname:short)",
        "refs/heads",
        "refs/remotes",
    ])?;
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    let mut branches: Vec<WorktreeBranch> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (reference, name) = line.split_once('\t')?;
            // origin/HEAD 等のシンボリックなリモート既定参照はベース候補に出さない
            if reference.starts_with("refs/remotes/") && reference.ends_with("/HEAD") {
                return None;
            }
            Some(WorktreeBranch {
                name: name.to_string(),
                reference: reference.to_string(),
                current: current.as_deref() == Some(reference),
            })
        })
        .collect();
    branches.sort_by_key(|b| {
        (
            !b.current,
            b.reference.starts_with("refs/remotes/"),
            b.name.clone(),
        )
    });
    Ok(WorktreeBranches { branches })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeResult {
    path: String,
    branch: String,
    reused: bool,
    /// 作成元から引き継いだ gitignore 対象の最上位エントリ数（再利用時と引き継ぎなしは 0）
    inherited: usize,
    /// 引き継ぎで一部失敗したときの内容。worktree 自体はできているので致命扱いにしない
    inherit_warning: Option<String>,
}

/// 格納先ディレクトリの解決。2つ目が `Some` のときだけルートの `.gitignore` を触る
/// （= リポジトリ配下モード）。未指定は従来どおり "inside" として扱う。
fn worktree_destination(
    root_path: &std::path::Path,
    directory: &str,
    location: Option<&str>,
) -> Result<(PathBuf, Option<String>), String> {
    match location.unwrap_or("inside") {
        "inside" => {
            let directory = normalized_worktree_directory(directory)?;
            Ok((
                worktree_parent_path(root_path, &directory)?,
                Some(directory),
            ))
        }
        "outside" => Ok((resolved_external_directory(root_path, directory)?, None)),
        _ => Err("invalid worktree location".into()),
    }
}

/// ブランチ名の妥当性（`worktree add -b` とシェルに渡す前の門番）。
fn valid_branch_name(branch: &str) -> Result<(), String> {
    let full_branch = format!("refs/heads/{branch}");
    let valid = run_git(&["check-ref-format", &full_branch])?;
    if !valid.status.success() || branch.starts_with('-') || branch.trim().is_empty() {
        return Err("invalid branch name".into());
    }
    Ok(())
}

/// そのブランチで既に登録されている worktree のパス（実在するものだけ）。
fn existing_worktree_path(root: &str, branch: &str) -> Option<String> {
    let full_branch = format!("refs/heads/{branch}");
    let out = run_git(&["-C", root, "worktree", "list", "--porcelain"]).ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut path: Option<String> = None;
    for line in text.lines().chain(std::iter::once("")) {
        if let Some(v) = line.strip_prefix("worktree ") {
            path = Some(v.to_string());
        } else if line == format!("branch {full_branch}") {
            if let Some(p) = path.as_ref().filter(|p| PathBuf::from(p).is_dir()) {
                return Some(p.clone());
            }
        } else if line.is_empty() {
            path = None;
        }
    }
    None
}

/// worktree を置くディレクトリと、まだ使われていない作成先パス。
fn free_worktree_target(worktrees_dir: &std::path::Path, branch: &str) -> Result<PathBuf, String> {
    let leaf = worktree_dir_name(branch);
    if leaf.is_empty() {
        return Err("invalid branch name".into());
    }
    let target = worktrees_dir.join(&leaf);
    if target.exists() {
        return Err(format!("worktree path already exists: {}", target.display()));
    }
    Ok(target)
}

/// 選択ブランチを起点に新しいブランチ + worktree を作る。
/// 同じブランチの登録済み worktree があれば再利用し、それ以外の衝突はエラーにする。
/// `location` は "inside"（リポジトリ配下）か "outside"（リポジトリ外。UI の既定）。
/// 配下のときだけルートの `.gitignore` へ格納先を追記する。
/// 未指定時は `directory` の解釈が変わってしまうので、従来どおり "inside" として扱う
/// （フロントは常に明示的に渡す）。
/// `inherit` が真なら、作成元の gitignore 対象（.env / node_modules など）を新しい worktree へコピーする。
#[tauri::command]
pub(crate) async fn git_worktree_create(
    app: AppHandle,
    root: String,
    base_ref: String,
    branch: String,
    directory: String,
    location: Option<String>,
    inherit: Option<bool>,
) -> Result<WorktreeResult, String> {
    create_worktree(
        Some(app),
        root,
        base_ref,
        branch,
        directory,
        location,
        inherit,
    )
    .await
}

/// `git_worktree_create` の本体。`app` は引き継ぎの進捗イベントの送り先（テストでは None）。
pub(crate) async fn create_worktree(
    app: Option<AppHandle>,
    root: String,
    base_ref: String,
    branch: String,
    directory: String,
    location: Option<String>,
    inherit: Option<bool>,
) -> Result<WorktreeResult, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir()
        || !(base_ref.starts_with("refs/heads/") || base_ref.starts_with("refs/remotes/"))
    {
        return Err("bad repository or base branch".into());
    }
    let (worktrees_dir, ignore_directory) =
        worktree_destination(&root_path, &directory, location.as_deref())?;
    valid_branch_name(&branch)?;
    let full_branch = format!("refs/heads/{branch}");
    let base = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &base_ref])?;
    if !base.status.success() {
        return Err("base branch not found".into());
    }

    // 既に同じブランチ用 worktree がある場合は安全に再利用する
    if let Some(path) = existing_worktree_path(&root, &branch) {
        return Ok(WorktreeResult {
            path,
            branch,
            reused: true,
            inherited: 0,
            inherit_warning: None,
        });
    }

    let exists = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &full_branch])?;
    if exists.status.success() {
        return Err(format!("branch already exists: {branch}"));
    }
    let target = free_worktree_target(&worktrees_dir, &branch)?;
    fs::create_dir_all(&worktrees_dir).map_err(|e| e.to_string())?;
    let target_s = target.to_string_lossy().into_owned();
    let out = run_git(&[
        "-C", &root, "worktree", "add", "-b", &branch, &target_s, &base_ref,
    ])?;
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    add_worktree_ignore(&root_path, &root, ignore_directory.as_deref(), &target);
    let (inherited, inherit_warning) = inherit_into(app, &root, &target, inherit).await;
    Ok(WorktreeResult {
        path: target_s,
        branch,
        reused: false,
        inherited,
        inherit_warning,
    })
}

/// 「リポジトリ配下」モードのときだけルートの `.gitignore` へ格納先を足す。
/// 追記は `worktree add` に成功した後で行い、失敗しても致命扱いにしない
/// （worktree はもうできているので、ignore 行だけを残さない方が安全）。
fn add_worktree_ignore(
    root_path: &std::path::Path,
    root: &str,
    ignore_directory: Option<&str>,
    target: &std::path::Path,
) {
    let (Some(directory), Some(leaf)) = (ignore_directory, target.file_name()) else {
        return;
    };
    let relative_target = format!("{directory}/{}", leaf.to_string_lossy());
    let _ = ensure_worktree_ignored(root_path, root, directory, &relative_target);
}

/// 引き継ぎの進捗イベント（`worktree:inherit`）。フロントは `root` で自分のダイアログ宛か判定する。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InheritProgressPayload {
    root: String,
    target: String,
    done: usize,
    total: usize,
    entry: String,
}

/// 作成元の gitignore 対象を新しい worktree へコピーする（`inherit` が真のときだけ）。
/// `.gitignore` 追記と同じく `worktree add` 成功後に走らせ、失敗は警告として返すだけにする。
/// ファイル走査は重いので、非同期ランタイムを塞がないよう blocking スレッドで行う。
/// 進捗は `worktree:inherit` イベントで UI に流す（`app` が無いテストでは送らない）。
async fn inherit_into(
    app: Option<AppHandle>,
    root: &str,
    target: &std::path::Path,
    inherit: Option<bool>,
) -> (usize, Option<String>) {
    if !inherit.unwrap_or(false) {
        return (0, None);
    }
    let root = root.to_string();
    let target = target.to_path_buf();
    let job = move || {
        let target_s = target.to_string_lossy().into_owned();
        let mut report = |p: InheritProgress| {
            if let Some(app) = app.as_ref() {
                let _ = app.emit(
                    "worktree:inherit",
                    InheritProgressPayload {
                        root: root.clone(),
                        target: target_s.clone(),
                        done: p.done,
                        total: p.total,
                        entry: p.entry,
                    },
                );
            }
        };
        inherit_ignored(&root, &target, &mut report)
    };
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(Ok(summary)) => (summary.copied, summary.warning_text()),
        Ok(Err(e)) => (0, Some(e)),
        Err(e) => (0, Some(e.to_string())),
    }
}

/// GitHub の PR（head ブランチ）で作業するための worktree を用意する。
///
/// 「PR のブランチを持ってくる」ことだけが仕事で、gh は使わない（PR の一覧は
/// フロントが `pr_list` で取り、ここには番号と head ブランチ名だけが渡る）。
/// 探す順番は **登録済み worktree → ローカルブランチ → リモート追跡ブランチ →
/// `pull/<番号>/head` の fetch** で、最後の経路が fork からの PR を拾う。
#[tauri::command]
pub(crate) async fn git_worktree_from_pr(
    app: AppHandle,
    root: String,
    number: u32,
    branch: String,
    directory: String,
    location: Option<String>,
    inherit: Option<bool>,
) -> Result<WorktreeResult, String> {
    worktree_from_pr(
        Some(app),
        root,
        number,
        branch,
        directory,
        location,
        inherit,
    )
    .await
}

/// `git_worktree_from_pr` の本体。`app` は引き継ぎの進捗イベントの送り先（テストでは None）。
pub(crate) async fn worktree_from_pr(
    app: Option<AppHandle>,
    root: String,
    number: u32,
    branch: String,
    directory: String,
    location: Option<String>,
    inherit: Option<bool>,
) -> Result<WorktreeResult, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("repository not found".into());
    }
    if number == 0 {
        return Err("invalid pull request number".into());
    }
    valid_branch_name(&branch)?;
    let (worktrees_dir, ignore_directory) =
        worktree_destination(&root_path, &directory, location.as_deref())?;

    // 既にその PR のブランチで作業している worktree があれば、それをそのまま使う
    if let Some(path) = existing_worktree_path(&root, &branch) {
        return Ok(WorktreeResult {
            path,
            branch,
            reused: true,
            inherited: 0,
            inherit_warning: None,
        });
    }

    let target = free_worktree_target(&worktrees_dir, &branch)?;
    fs::create_dir_all(&worktrees_dir).map_err(|e| e.to_string())?;
    let target_s = target.to_string_lossy().into_owned();
    let full_branch = format!("refs/heads/{branch}");
    let local = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &full_branch])?;

    let out = if local.status.success() {
        // ローカルにブランチがある = 既に checkout 済みの PR。新規作成せず紐付けるだけ
        run_git(&["-C", &root, "worktree", "add", &target_s, &branch])?
    } else if let Some(remote) = tracking_remote_for(&root, &branch) {
        let start = format!("{remote}/{branch}");
        run_git(&[
            "-C", &root, "worktree", "add", "--track", "-b", &branch, &target_s, &start,
        ])?
    } else {
        // fork からの PR や未 fetch のブランチ。GitHub は pull/<番号>/head を持っている
        let remotes = git_remotes(&root)?;
        let remote = if remotes.iter().any(|r| r == "origin") {
            "origin"
        } else if remotes.len() == 1 {
            remotes[0].as_str()
        } else if remotes.is_empty() {
            return Err("no Git remote is configured".into());
        } else {
            return Err("could not tell which remote hosts this pull request".into());
        };
        let refspec = format!("pull/{number}/head");
        let fetched = run_git(&["-C", &root, "fetch", remote, &refspec])?;
        if !fetched.status.success() {
            return Err(git_output_text(&fetched));
        }
        run_git(&[
            "-C",
            &root,
            "worktree",
            "add",
            "-b",
            &branch,
            &target_s,
            "FETCH_HEAD",
        ])?
    };
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    add_worktree_ignore(&root_path, &root, ignore_directory.as_deref(), &target);
    let (inherited, inherit_warning) = inherit_into(app, &root, &target, inherit).await;
    Ok(WorktreeResult {
        path: target_s,
        branch,
        reused: false,
        inherited,
        inherit_warning,
    })
}

/// そのブランチのリモート追跡ブランチを持つリモート（origin を優先）。
fn tracking_remote_for(root: &str, branch: &str) -> Option<String> {
    let remotes = git_remotes(root).ok()?;
    let mut ordered: Vec<String> = remotes
        .iter()
        .filter(|r| *r == "origin")
        .cloned()
        .chain(remotes.iter().filter(|r| *r != "origin").cloned())
        .collect();
    ordered.dedup();
    ordered.into_iter().find(|remote| {
        let reference = format!("refs/remotes/{remote}/{branch}");
        run_git(&["-C", root, "show-ref", "--verify", "--quiet", &reference])
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::{create_worktree, worktree_from_pr};
    use crate::testutil::{test_git, TempRepo};
    use crate::worktree::list::{git_worktree_list, git_worktree_remove};
    use std::fs;
    use std::path::{Path, PathBuf};

    /// bare remote + そこから clone したローカルを作る。返すのは（remote, local）。
    fn repo_with_remote(repo: &Path) -> (PathBuf, PathBuf) {
        let remote = repo.join("remote.git");
        let seed = repo.join("seed");
        let local = repo.join("local");
        test_git(repo, &["init", "--bare", "--quiet", "remote.git"]);
        fs::create_dir(&seed).unwrap();
        test_git(&seed, &["init", "--quiet"]);
        test_git(&seed, &["config", "user.name", "PATerminal Test"]);
        test_git(&seed, &["config", "user.email", "paterminal@example.invalid"]);
        fs::write(seed.join("tracked.txt"), "base\n").unwrap();
        test_git(&seed, &["add", "tracked.txt"]);
        test_git(&seed, &["commit", "--quiet", "-m", "initial"]);
        test_git(&seed, &["branch", "-M", "main"]);
        let remote_text = remote.to_string_lossy().into_owned();
        test_git(&seed, &["remote", "add", "origin", &remote_text]);
        test_git(&seed, &["push", "--quiet", "-u", "origin", "main"]);
        test_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        test_git(repo, &["clone", "--quiet", &remote_text, "local"]);
        (seed, local)
    }

    #[tokio::test]
    async fn pr_worktree_checks_out_the_remote_head_branch_and_can_be_reused() {
        let repo = TempRepo::new();
        let (seed, local) = repo_with_remote(&repo.0);
        // PR の head ブランチを remote に用意して local へ取り込む（追跡ブランチだけがある状態）
        test_git(&seed, &["switch", "--quiet", "-c", "feature/pr-head"]);
        fs::write(seed.join("tracked.txt"), "pr\n").unwrap();
        test_git(&seed, &["commit", "--quiet", "-am", "pr work"]);
        test_git(&seed, &["push", "--quiet", "origin", "feature/pr-head"]);
        let head = test_git(&seed, &["rev-parse", "HEAD"]);
        test_git(&local, &["fetch", "--quiet", "origin"]);

        let outside = repo.0.join("trees");
        let root = local.to_string_lossy().into_owned();
        let result = worktree_from_pr(
            None,
            root.clone(),
            12,
            "feature/pr-head".into(),
            outside.to_string_lossy().into_owned(),
            Some("outside".into()),
            None,
        )
        .await
        .unwrap();

        let target = outside.join("feature-pr-head");
        assert_eq!(PathBuf::from(&result.path), target);
        assert!(!result.reused);
        assert_eq!(test_git(&target, &["branch", "--show-current"]), "feature/pr-head");
        assert_eq!(test_git(&target, &["rev-parse", "HEAD"]), head);
        // 追跡ブランチとして作るので、そのまま pull / push できる
        assert_eq!(
            test_git(&target, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/feature/pr-head"
        );

        // 2回目は同じ worktree を再利用する（= 既存があれば紐付けるだけ）
        let again = worktree_from_pr(
            None,
            root,
            12,
            "feature/pr-head".into(),
            outside.to_string_lossy().into_owned(),
            Some("outside".into()),
            None,
        )
        .await
        .unwrap();
        assert!(again.reused);
        // 再利用のパスは git の出力そのままなので、綴りではなく実体で比べる
        // （Windows の TEMP は 8.3 短縮名で来ることがあり、文字列では一致しない）
        assert_eq!(
            fs::canonicalize(&again.path).unwrap(),
            fs::canonicalize(&target).unwrap()
        );
    }

    #[tokio::test]
    async fn pr_worktree_falls_back_to_fetching_the_pull_ref() {
        let repo = TempRepo::new();
        let (seed, local) = repo_with_remote(&repo.0);
        // fork からの PR: head ブランチは remote のブランチとして存在せず、
        // GitHub が持つ pull/<番号>/head だけがある状態を作る
        test_git(&seed, &["switch", "--quiet", "-c", "fork-work"]);
        fs::write(seed.join("tracked.txt"), "from fork\n").unwrap();
        test_git(&seed, &["commit", "--quiet", "-am", "fork work"]);
        let head = test_git(&seed, &["rev-parse", "HEAD"]);
        test_git(&seed, &["push", "--quiet", "origin", "HEAD:refs/pull/7/head"]);

        let root = local.to_string_lossy().into_owned();
        let result = worktree_from_pr(
            None,
            root,
            7,
            "pr-7".into(),
            ".worktree".into(),
            Some("inside".into()),
            None,
        )
        .await
        .unwrap();

        let target = local.join(".worktree/pr-7");
        assert_eq!(PathBuf::from(&result.path), target);
        assert_eq!(test_git(&target, &["branch", "--show-current"]), "pr-7");
        assert_eq!(test_git(&target, &["rev-parse", "HEAD"]), head);
        assert!(target.join("tracked.txt").is_file());
        // 配下モードなので .gitignore へ格納先が足される
        assert!(fs::read_to_string(local.join(".gitignore"))
            .unwrap()
            .contains(".worktree"));
    }

    #[tokio::test]
    async fn pr_worktree_uses_an_existing_local_branch_without_recreating_it() {
        let repo = TempRepo::new();
        let (_seed, local) = repo_with_remote(&repo.0);
        test_git(&local, &["switch", "--quiet", "-c", "already/local"]);
        let head = test_git(&local, &["rev-parse", "HEAD"]);
        test_git(&local, &["switch", "--quiet", "main"]);

        let outside = repo.0.join("trees");
        let result = worktree_from_pr(
            None,
            local.to_string_lossy().into_owned(),
            3,
            "already/local".into(),
            outside.to_string_lossy().into_owned(),
            Some("outside".into()),
            None,
        )
        .await
        .unwrap();

        let target = outside.join("already-local");
        assert_eq!(PathBuf::from(&result.path), target);
        assert!(!result.reused);
        assert_eq!(test_git(&target, &["branch", "--show-current"]), "already/local");
        assert_eq!(test_git(&target, &["rev-parse", "HEAD"]), head);
    }

    #[tokio::test]
    async fn pr_worktree_rejects_bad_input() {
        let repo = TempRepo::new();
        let (_seed, local) = repo_with_remote(&repo.0);
        let root = local.to_string_lossy().into_owned();
        for (number, branch) in [(0u32, "feature/x"), (1, "--force"), (1, "bad branch")] {
            assert!(worktree_from_pr(
                None,
                root.clone(),
                number,
                branch.into(),
                ".worktree".into(),
                Some("inside".into()),
                None,
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn worktree_is_created_below_repo_and_adds_gitignore_source_change() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        fs::write(repo.0.join(".gitignore"), "dist/\n").unwrap();
        test_git(&repo.0, &["add", "tracked.txt", ".gitignore"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        test_git(&repo.0, &["branch", "-M", "main"]);

        let result = create_worktree(
            None,
            repo.0.to_string_lossy().into_owned(),
            "refs/heads/main".into(),
            "issue/42-fix".into(),
            ".worktree".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let target = repo.0.join(".worktree/issue-42-fix");
        assert_eq!(PathBuf::from(result.path), target);
        assert_eq!(result.branch, "issue/42-fix");
        assert!(!result.reused);
        assert_eq!(
            fs::read_to_string(repo.0.join(".gitignore")).unwrap(),
            "dist/\n/.worktree/\n"
        );
        assert_eq!(
            test_git(&target, &["branch", "--show-current"]),
            "issue/42-fix"
        );
        assert!(
            test_git(&repo.0, &["check-ignore", ".worktree/issue-42-fix"])
                .contains(".worktree/issue-42-fix")
        );
    }

    #[tokio::test]
    async fn worktree_does_not_duplicate_existing_ignore_rule() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        fs::write(repo.0.join(".gitignore"), ".trees/\n").unwrap();
        test_git(&repo.0, &["add", "tracked.txt", ".gitignore"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        test_git(&repo.0, &["branch", "-M", "main"]);

        create_worktree(
            None,
            repo.0.to_string_lossy().into_owned(),
            "refs/heads/main".into(),
            "feature/test".into(),
            ".trees".into(),
            Some("inside".into()),
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            fs::read_to_string(repo.0.join(".gitignore")).unwrap(),
            ".trees/\n"
        );
    }

    #[tokio::test]
    async fn worktree_created_outside_repo_does_not_touch_gitignore() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        fs::write(repo.0.join(".gitignore"), "dist/\n").unwrap();
        test_git(&repo.0, &["add", "tracked.txt", ".gitignore"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        test_git(&repo.0, &["branch", "-M", "main"]);

        let outside = repo.0.parent().unwrap().join(format!(
            "pa-outside-{}",
            repo.0.file_name().unwrap().to_string_lossy()
        ));
        let result = create_worktree(
            None,
            repo.0.to_string_lossy().into_owned(),
            "refs/heads/main".into(),
            "feature/outside".into(),
            outside.to_string_lossy().into_owned(),
            Some("outside".into()),
            None,
        )
        .await
        .unwrap();

        let target = outside.join("feature-outside");
        assert_eq!(PathBuf::from(&result.path), target);
        assert_eq!(
            test_git(&target, &["branch", "--show-current"]),
            "feature/outside"
        );
        // リポジトリ外なので .gitignore は一切変わらない
        assert_eq!(
            fs::read_to_string(repo.0.join(".gitignore")).unwrap(),
            "dist/\n"
        );

        // 一覧に出て、削除できる（ブランチは残る）
        let root = repo.0.to_string_lossy().into_owned();
        let listed = git_worktree_list(root.clone()).await.unwrap().entries;
        assert!(listed[0].is_main && listed[0].is_current);
        let created = listed
            .iter()
            .find(|e| e.branch == "feature/outside")
            .unwrap();
        assert!(!created.is_main && !created.is_current && !created.missing);

        git_worktree_remove(root.clone(), result.path.clone(), false)
            .await
            .unwrap();
        assert!(!target.exists());
        assert_eq!(
            git_worktree_list(root.clone()).await.unwrap().entries.len(),
            1
        );
        assert!(
            test_git(&repo.0, &["branch", "--list", "feature/outside"]).contains("feature/outside")
        );

        // メイン worktree は消せない
        assert!(git_worktree_remove(root.clone(), root, false)
            .await
            .is_err());
        let _ = fs::remove_dir_all(&outside);
    }

    /// `.env` と `node_modules/` を ignore する単独リポジトリ（作成元の環境ファイル付き）
    fn repo_with_ignored_env(root: &Path) {
        test_git(root, &["init", "--quiet"]);
        test_git(root, &["config", "user.name", "PATerminal Test"]);
        test_git(
            root,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        fs::write(root.join(".gitignore"), ".env\nnode_modules/\n").unwrap();
        test_git(root, &["add", "tracked.txt", ".gitignore"]);
        test_git(root, &["commit", "--quiet", "-m", "initial"]);
        test_git(root, &["branch", "-M", "main"]);
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "pkg\n").unwrap();
    }

    #[tokio::test]
    async fn worktree_inherits_ignored_files_only_when_asked() {
        let repo = TempRepo::new();
        let repo_dir = repo.0.join("repo");
        fs::create_dir(&repo_dir).unwrap();
        repo_with_ignored_env(&repo_dir);
        let root = repo_dir.to_string_lossy().into_owned();
        let outside = repo.0.join("trees");

        let result = create_worktree(
            None,
            root.clone(),
            "refs/heads/main".into(),
            "feature/with-env".into(),
            outside.to_string_lossy().into_owned(),
            Some("outside".into()),
            Some(true),
        )
        .await
        .unwrap();
        let target = PathBuf::from(&result.path);
        assert_eq!(result.inherited, 2, "{:?}", result.inherit_warning);
        assert!(result.inherit_warning.is_none());
        assert_eq!(
            fs::read_to_string(target.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        assert_eq!(
            fs::read_to_string(target.join("node_modules/pkg/index.js")).unwrap(),
            "pkg\n"
        );
        assert_eq!(
            fs::read_to_string(target.join("tracked.txt")).unwrap(),
            "base\n"
        );

        // 再利用時は何もコピーしない（作成元で後から増えたものも入らない）
        fs::write(repo_dir.join(".env.local"), "later\n").unwrap();
        let again = create_worktree(
            None,
            root.clone(),
            "refs/heads/main".into(),
            "feature/with-env".into(),
            outside.to_string_lossy().into_owned(),
            Some("outside".into()),
            Some(true),
        )
        .await
        .unwrap();
        assert!(again.reused);
        assert_eq!(again.inherited, 0);
        assert!(!target.join(".env.local").exists());

        for (branch, inherit) in [("feature/no-env", Some(false)), ("feature/unset", None)] {
            let result = create_worktree(
                None,
                root.clone(),
                "refs/heads/main".into(),
                branch.into(),
                outside.to_string_lossy().into_owned(),
                Some("outside".into()),
                inherit,
            )
            .await
            .unwrap();
            let target = PathBuf::from(&result.path);
            assert_eq!(result.inherited, 0);
            assert!(!target.join(".env").exists(), "{branch}");
            assert!(!target.join("node_modules").exists(), "{branch}");
        }
    }

    #[tokio::test]
    async fn inside_worktree_inherits_without_copying_the_worktree_container() {
        let repo = TempRepo::new();
        repo_with_ignored_env(&repo.0);
        let root = repo.0.to_string_lossy().into_owned();

        let first = create_worktree(
            None,
            root.clone(),
            "refs/heads/main".into(),
            "feature/first".into(),
            ".worktree".into(),
            Some("inside".into()),
            Some(true),
        )
        .await
        .unwrap();
        let second = create_worktree(
            None,
            root.clone(),
            "refs/heads/main".into(),
            "feature/second".into(),
            ".worktree".into(),
            Some("inside".into()),
            Some(true),
        )
        .await
        .unwrap();
        for result in [&first, &second] {
            let target = PathBuf::from(&result.path);
            assert_eq!(result.inherited, 2, "{:?}", result.inherit_warning);
            assert_eq!(
                fs::read_to_string(target.join(".env")).unwrap(),
                "SECRET=1\n"
            );
            // `.worktree/` 自体も ignore 対象だが、他の worktree を巻き込んでコピーしない
            assert!(!target.join(".worktree").exists());
        }
    }
}
