//! ブランチとリモート。変更ストリップの操作バー
//! （Checkout / Push / Fetch / Pull）とプルモーダルが使う。

use serde::Serialize;

use super::run::{git_output_text, git_result, run_git};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranches {
    pub(crate) current: Option<String>,
    upstream: Option<String>,
    pub(crate) local_branches: Vec<String>,
    branches: Vec<String>,
    remotes: Vec<String>,
}

/// 変更ストリップ用: 現在ブランチ・ローカルブランチ・その upstream・
/// リモートブランチ一覧（"origin/main" 形式）
#[tauri::command]
pub(crate) async fn git_branches(root: String) -> Result<GitBranches, String> {
    let rev_parse = |arg: &str| {
        run_git(&["-C", &root, "rev-parse", "--abbrev-ref", arg])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    // symbolic-ref は unborn HEAD も名前を返し、detached HEAD だけを None にできる。
    let current = run_git(&["-C", &root, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let upstream = rev_parse("@{upstream}");
    let remotes = run_git(&["-C", &root, "remote"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.starts_with('-'))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let mut local_branches: Vec<String> = Vec::new();
    if let Ok(o) = run_git(&[
        "-C",
        &root,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
    ]) {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let name = line.trim();
                if !name.is_empty() {
                    local_branches.push(name.to_string());
                }
            }
        }
    }
    // 初回コミット前のブランチは refs/heads にまだ存在しないが、現在ブランチとして表示する。
    if let Some(name) = current.as_ref() {
        if !local_branches.contains(name) {
            local_branches.push(name.clone());
        }
    }

    let mut branches: Vec<String> = Vec::new();
    if let Ok(o) = run_git(&[
        "-C",
        &root,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes",
    ]) {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let name = line.trim();
                // "/" を含まない行は origin/HEAD の short（= リモート名だけ）なので除外
                if !name.is_empty() && name.contains('/') {
                    branches.push(name.to_string());
                }
            }
        }
    }
    Ok(GitBranches {
        current,
        upstream,
        local_branches,
        branches,
        remotes,
    })
}

/// 選択した既存ローカルブランチへ切り替える。未コミット変更と競合する場合や、別 worktree で
/// 使用中の場合は Git 自身に拒否させ、そのメッセージをフロントへ返す。
#[tauri::command]
pub(crate) async fn git_switch_branch(root: String, branch: String) -> Result<String, String> {
    if branch.is_empty() || branch.len() > 1024 || branch.starts_with('-') {
        return Err("invalid branch name".into());
    }
    let full_ref = format!("refs/heads/{branch}");
    let valid = run_git(&["check-ref-format", &full_ref])?;
    if !valid.status.success() {
        return Err("invalid branch name".into());
    }
    let exists = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &full_ref])?;
    if !exists.status.success() {
        return Err("local branch not found".into());
    }
    git_result(run_git(&["-C", &root, "switch", "--no-guess", &branch])?)
}

/// 現在ブランチを upstream へ Push。upstream が無い初回は origin（無ければ唯一の
/// リモート）へ Push し、upstream を同時に設定する。
#[tauri::command]
pub(crate) async fn git_push(root: String) -> Result<String, String> {
    let current_out = run_git(&["-C", &root, "symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !current_out.status.success() {
        return Err("cannot push a detached HEAD".into());
    }
    let current = String::from_utf8_lossy(&current_out.stdout)
        .trim()
        .to_string();
    if current.is_empty() || current.starts_with('-') {
        return Err("invalid current branch".into());
    }

    // bare `git push` は push.default=matching 等で別ブランチまで送り得るため使わない。
    // upstream の remote + 完全な ref を Git 自身に解決させ、現在ブランチだけを明示する。
    let current_ref = format!("refs/heads/{current}");
    let upstream_out = run_git(&[
        "-C",
        &root,
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
        &current_ref,
    ])?;
    let upstream_text = String::from_utf8_lossy(&upstream_out.stdout);
    if let Some((remote, remote_ref)) = upstream_text.trim().split_once('\0') {
        if !remote.is_empty() && !remote.starts_with('-') && remote_ref.starts_with("refs/heads/") {
            let refspec = format!("HEAD:{remote_ref}");
            return git_result(run_git(&["-C", &root, "push", remote, &refspec])?);
        }
    }

    let remotes = git_remotes(&root)?;
    let remote = if remotes.iter().any(|r| r == "origin") {
        "origin"
    } else if remotes.len() == 1 {
        remotes[0].as_str()
    } else if remotes.is_empty() {
        return Err("no Git remote is configured".into());
    } else {
        return Err(
            "no upstream is configured; add an origin remote or set the upstream in the terminal"
                .into(),
        );
    };
    git_result(run_git(&[
        "-C",
        &root,
        "push",
        "--set-upstream",
        remote,
        &current,
    ])?)
}

/// 設定済みのリモート名。`-` 始まりは git のオプションと紛れるので落とす。
/// 「origin を優先し、無ければ唯一のリモートだけを使う」判断は呼び出し側が行う
/// （文脈ごとに案内文が違うため）。
pub(crate) fn git_remotes(root: &str) -> Result<Vec<String>, String> {
    let out = run_git(&["-C", root, "remote"])?;
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('-'))
        .map(String::from)
        .collect())
}

/// 設定済みのすべてのリモートから更新を取得する。ブランチの切替やマージは行わない。
#[tauri::command]
pub(crate) async fn git_fetch(root: String) -> Result<String, String> {
    git_result(run_git(&["-C", &root, "fetch", "--all"])?)
}

/// 選択したリモートブランチを現在のブランチへ取り込む（ブランチ切替はしない）。
/// branch は git_branches が返した "origin/feature/x" 形式のみ受け付ける
#[tauri::command]
pub(crate) async fn git_pull(root: String, branch: String) -> Result<String, String> {
    let Some((remote, name)) = branch.split_once('/') else {
        return Err("bad branch".into());
    };
    if remote.is_empty() || name.is_empty() || remote.starts_with('-') || name.starts_with('-') {
        return Err("bad branch".into());
    }
    // --no-edit でマージコミットのエディタ起動を抑止。コンフリクトは git のメッセージごと Err
    git_result(run_git(&["-C", &root, "pull", "--no-edit", remote, name])?)
}

#[cfg(test)]
mod tests {
    use super::{git_branches, git_fetch, git_switch_branch};
    use crate::testutil::{test_git, TempRepo};
    use std::fs;

    #[tokio::test]
    async fn branches_list_and_switch_existing_local_branches() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        test_git(&repo.0, &["add", "tracked.txt"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        test_git(&repo.0, &["branch", "-M", "main"]);
        test_git(&repo.0, &["branch", "feature/local"]);

        let root = repo.0.to_string_lossy().into_owned();
        let branches = git_branches(root.clone()).await.unwrap();
        assert_eq!(branches.current.as_deref(), Some("main"));
        assert!(branches.local_branches.contains(&"main".into()));
        assert!(branches.local_branches.contains(&"feature/local".into()));

        git_switch_branch(root.clone(), "feature/local".into())
            .await
            .unwrap();
        assert_eq!(
            test_git(&repo.0, &["branch", "--show-current"]),
            "feature/local"
        );
        assert!(git_switch_branch(root, "missing".into()).await.is_err());
    }

    #[tokio::test]
    async fn fetch_updates_remote_tracking_branches_without_merging() {
        let repo = TempRepo::new();
        let remote = repo.0.join("remote.git");
        let seed = repo.0.join("seed");
        let local = repo.0.join("local");
        test_git(&repo.0, &["init", "--bare", "--quiet", "remote.git"]);
        fs::create_dir(&seed).unwrap();
        test_git(&seed, &["init", "--quiet"]);
        test_git(&seed, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &seed,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(seed.join("tracked.txt"), "first\n").unwrap();
        test_git(&seed, &["add", "tracked.txt"]);
        test_git(&seed, &["commit", "--quiet", "-m", "first"]);
        test_git(&seed, &["branch", "-M", "main"]);
        let remote_text = remote.to_string_lossy().into_owned();
        test_git(&seed, &["remote", "add", "origin", &remote_text]);
        test_git(&seed, &["push", "--quiet", "-u", "origin", "main"]);
        test_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        test_git(&repo.0, &["clone", "--quiet", &remote_text, "local"]);
        let before = test_git(&local, &["rev-parse", "origin/main"]);

        fs::write(seed.join("tracked.txt"), "second\n").unwrap();
        test_git(&seed, &["commit", "--quiet", "-am", "second"]);
        test_git(&seed, &["push", "--quiet", "origin", "main"]);
        let remote_head = test_git(&seed, &["rev-parse", "HEAD"]);

        git_fetch(local.to_string_lossy().into_owned())
            .await
            .unwrap();

        assert_ne!(before, remote_head);
        assert_eq!(test_git(&local, &["rev-parse", "origin/main"]), remote_head);
        assert_eq!(test_git(&local, &["rev-parse", "HEAD"]), before);
    }
}
