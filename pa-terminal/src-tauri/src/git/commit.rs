//! 作業ツリーを書き換える操作（変更ストリップの Commit / Stash と、
//! コミット履歴の右クリックからの巻き戻し）。

use std::path::PathBuf;

use super::diff::valid_git_hash;
use super::run::{git_output_text, git_result, run_git};
use super::status::GIT_MAX_FILES;

/// コミット履歴の右クリック用: 現在の HEAD を選択コミットまで戻す。
/// 選択後にブランチが切り替わった場合などに別系統へ移動しないよう、現在の HEAD の祖先だけを許可する。
/// `reset --hard` なので追跡中の作業ツリー変更は破棄されるが、未追跡ファイルは削除しない。
#[tauri::command]
pub(crate) async fn git_reset_to_commit(root: String, hash: String) -> Result<String, String> {
    if !PathBuf::from(&root).is_dir() || !valid_git_hash(&hash) {
        return Err("bad commit".into());
    }

    // 省略ハッシュを一意な commit object に解決してから後続コマンドへ渡す。
    let revision = format!("{hash}^{{commit}}");
    let resolved_out = run_git(&["-C", &root, "rev-parse", "--verify", &revision])?;
    if !resolved_out.status.success() {
        return Err(git_output_text(&resolved_out));
    }
    let resolved = String::from_utf8_lossy(&resolved_out.stdout)
        .trim()
        .to_string();
    if !valid_git_hash(&resolved) {
        return Err("bad resolved commit".into());
    }

    let ancestor_out = run_git(&[
        "-C",
        &root,
        "merge-base",
        "--is-ancestor",
        &resolved,
        "HEAD",
    ])?;
    if !ancestor_out.status.success() {
        return Err("the selected commit is no longer in the current history".into());
    }

    git_result(run_git(&["-C", &root, "reset", "--hard", &resolved])?)
}

/// 変更ストリップの「Stash」。表示と同じ「cwd 配下」スコープで未追跡も含めて退避する
#[tauri::command]
pub(crate) async fn git_stash(cwd: String) -> Result<String, String> {
    git_result(run_git(&[
        "-C",
        &cwd,
        "stash",
        "push",
        "--include-untracked",
        "--",
        ".",
    ])?)
}

/// コミットモーダルで選択したファイルだけを、未追跡ファイルも含めてコミットする。
/// パスは git_changes が返すリポジトリルート相対パス。cwd 配下だけに制限し、
/// 選択外ですでにステージされている変更は `--only` でコミットへ混入させない。
#[tauri::command]
pub(crate) async fn git_commit(
    cwd: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message is empty".into());
    }
    if paths.is_empty() || paths.len() > GIT_MAX_FILES {
        return Err("no commit paths selected".into());
    }
    if !PathBuf::from(&cwd).is_dir() {
        return Err("bad working directory".into());
    }
    let root_out = run_git(&["-C", &cwd, "rev-parse", "--show-toplevel"])?;
    if !root_out.status.success() {
        return Err(git_output_text(&root_out));
    }
    let root = String::from_utf8_lossy(&root_out.stdout).trim().to_string();
    let prefix_out = run_git(&["-C", &cwd, "rev-parse", "--show-prefix"])?;
    if !prefix_out.status.success() {
        return Err(git_output_text(&prefix_out));
    }
    let prefix = String::from_utf8_lossy(&prefix_out.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let mut selected: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        let valid = !path.is_empty()
            && path.len() <= 4096
            && PathBuf::from(&path)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
            && (prefix.is_empty() || path.starts_with(&prefix));
        if !valid {
            return Err("bad commit path".into());
        }
        if !selected.contains(&path) {
            selected.push(path);
        }
    }

    // パス中の `*` や `:(exclude)` を pathspec として解釈せず、表示したファイル名そのものを扱う。
    let mut add_args = vec![
        "--literal-pathspecs",
        "-C",
        root.as_str(),
        "add",
        "--all",
        "--",
    ];
    add_args.extend(selected.iter().map(String::as_str));
    git_result(run_git(&add_args)?)?;

    let mut commit_args = vec![
        "--literal-pathspecs",
        "-C",
        root.as_str(),
        "commit",
        "--only",
        "--message",
        message,
        "--",
    ];
    commit_args.extend(selected.iter().map(String::as_str));
    git_result(run_git(&commit_args)?)
}

#[cfg(test)]
mod tests {
    use super::{git_commit, git_reset_to_commit, git_stash};
    use crate::testutil::{test_git, TempRepo};
    use std::fs;

    #[tokio::test]
    async fn commit_includes_only_selected_paths_and_keeps_other_staged_changes() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::create_dir(repo.0.join("sub")).unwrap();
        fs::write(repo.0.join("sub/selected.txt"), "before\n").unwrap();
        fs::write(repo.0.join("outside.txt"), "before\n").unwrap();
        test_git(&repo.0, &["add", "sub/selected.txt", "outside.txt"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);

        fs::write(repo.0.join("sub/selected.txt"), "selected change\n").unwrap();
        fs::write(repo.0.join("outside.txt"), "staged outside change\n").unwrap();
        fs::write(repo.0.join("sub/new file.txt"), "new\n").unwrap();
        test_git(&repo.0, &["add", "outside.txt"]);

        git_commit(
            repo.0.join("sub").to_string_lossy().into_owned(),
            "selected files".into(),
            vec!["sub/selected.txt".into(), "sub/new file.txt".into()],
        )
        .await
        .unwrap();

        assert_eq!(
            test_git(&repo.0, &["show", "HEAD:sub/selected.txt"]),
            "selected change"
        );
        assert_eq!(test_git(&repo.0, &["show", "HEAD:sub/new file.txt"]), "new");
        assert_eq!(test_git(&repo.0, &["show", "HEAD:outside.txt"]), "before");
        assert_eq!(
            test_git(&repo.0, &["diff", "--cached", "--name-only"]),
            "outside.txt"
        );
    }

    #[tokio::test]
    async fn reset_to_commit_discards_tracked_changes_but_keeps_untracked_files() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );

        let tracked = repo.0.join("tracked.txt");
        fs::write(&tracked, "first\n").unwrap();
        test_git(&repo.0, &["add", "tracked.txt"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "first"]);
        let first = test_git(&repo.0, &["rev-parse", "HEAD"]);

        fs::write(&tracked, "second\n").unwrap();
        test_git(&repo.0, &["commit", "--quiet", "-am", "second"]);
        fs::write(&tracked, "dirty\n").unwrap();
        let untracked = repo.0.join("untracked.txt");
        fs::write(&untracked, "keep\n").unwrap();

        git_reset_to_commit(
            repo.0.to_string_lossy().into_owned(),
            first[..7].to_string(),
        )
        .await
        .unwrap();

        assert_eq!(test_git(&repo.0, &["rev-parse", "HEAD"]), first);
        assert_eq!(fs::read_to_string(tracked).unwrap(), "first\n");
        assert_eq!(fs::read_to_string(untracked).unwrap(), "keep\n");
    }

    #[tokio::test]
    async fn stash_saves_untracked_changes_under_the_watched_cwd_only() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        let sub = repo.0.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("tracked.txt"), "first\n").unwrap();
        fs::write(repo.0.join("outside.txt"), "first\n").unwrap();
        test_git(&repo.0, &["add", "."]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "first"]);

        fs::write(sub.join("tracked.txt"), "dirty\n").unwrap();
        fs::write(sub.join("untracked.txt"), "new\n").unwrap();
        fs::write(repo.0.join("outside.txt"), "dirty\n").unwrap();

        // 変更ストリップと同じ「cwd 配下」スコープ: sub/ の変更だけが退避される
        git_stash(sub.to_string_lossy().into_owned()).await.unwrap();

        assert_eq!(
            fs::read_to_string(sub.join("tracked.txt")).unwrap(),
            "first\n"
        );
        assert!(!sub.join("untracked.txt").exists());
        assert_eq!(
            fs::read_to_string(repo.0.join("outside.txt")).unwrap(),
            "dirty\n"
        );
        assert!(!test_git(&repo.0, &["stash", "list"]).is_empty());
    }
}
