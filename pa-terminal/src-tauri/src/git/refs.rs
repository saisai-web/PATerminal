//! ブランチ・リモート・タグの一覧（Git ウィンドウのサイドバー用）と、
//! リモートブランチからのチェックアウト。

use serde::Serialize;

use super::run::{git_result, run_git};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRef {
    /// 表示名（"main" / "origin/main" / "v1.0"）
    name: String,
    /// 先端コミットの短縮ハッシュ（注釈付きタグはタグが指すコミット）
    hash: String,
    /// ローカルブランチの upstream（"origin/main"）。無ければ空
    upstream: String,
    ahead: u32,
    behind: u32,
    /// upstream が削除済み（"[gone]"）
    gone: bool,
    /// 別の worktree でチェックアウト中ならそのパス（このリポジトリ自身も含む）
    worktree: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRefs {
    /// 現在のブランチ（detached HEAD なら None）
    head: Option<String>,
    local: Vec<GitRef>,
    remote: Vec<GitRef>,
    tags: Vec<GitRef>,
}

const SEP: char = '\u{1f}';

/// "ahead 2, behind 1" / "gone" / "" を数に分解する
pub(crate) fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, track.trim() == "gone")
}

fn for_each_ref(root: &str, with_worktree: bool) -> Option<String> {
    let format = if with_worktree {
        "--format=%(refname)%1f%(objectname:short)%1f%(*objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(worktreepath)"
    } else {
        "--format=%(refname)%1f%(objectname:short)%1f%(*objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f"
    };
    let out = run_git(&[
        "-C",
        root,
        "for-each-ref",
        format,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ])
    .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub(crate) async fn git_refs(root: String) -> Result<GitRefs, String> {
    let head = run_git(&["-C", &root, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    // %(worktreepath) は Git 2.23 以降。古い Git では無しで取り直す
    let Some(text) = for_each_ref(&root, true).or_else(|| for_each_ref(&root, false)) else {
        return Err("git for-each-ref failed".into());
    };
    let mut refs = GitRefs {
        head,
        local: vec![],
        remote: vec![],
        tags: vec![],
    };
    for line in text.lines() {
        let f: Vec<&str> = line.split(SEP).collect();
        if f.len() < 6 {
            continue;
        }
        let (ahead, behind, gone) = parse_track(f[4]);
        let hash = if f[2].is_empty() { f[1] } else { f[2] };
        let make = |name: &str| GitRef {
            name: name.to_string(),
            hash: hash.to_string(),
            upstream: f[3].to_string(),
            ahead,
            behind,
            gone,
            worktree: f[5].to_string(),
        };
        if let Some(name) = f[0].strip_prefix("refs/heads/") {
            refs.local.push(make(name));
        } else if let Some(name) = f[0].strip_prefix("refs/remotes/") {
            // origin/HEAD は既定ブランチの別名なので出さない
            if !name.ends_with("/HEAD") && name.contains('/') {
                refs.remote.push(make(name));
            }
        } else if let Some(name) = f[0].strip_prefix("refs/tags/") {
            refs.tags.push(make(name));
        }
    }
    Ok(refs)
}

/// リモートブランチ（"origin/feature/x"）をチェックアウトする。同名のローカルブランチが
/// あればそれへ切り替え、無ければ追跡ブランチを作って切り替える。
/// 未コミット変更との競合や別 worktree で使用中の場合は Git 自身に拒否させる。
#[tauri::command]
pub(crate) async fn git_checkout_remote(root: String, branch: String) -> Result<String, String> {
    if branch.is_empty() || branch.len() > 1024 || branch.starts_with('-') {
        return Err("invalid branch name".into());
    }
    let Some((_, local)) = branch.split_once('/') else {
        return Err("invalid remote branch".into());
    };
    let remote_ref = format!("refs/remotes/{branch}");
    let exists = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &remote_ref])?;
    if !exists.status.success() {
        return Err("remote branch not found".into());
    }
    let local_ref = format!("refs/heads/{local}");
    let valid = run_git(&["check-ref-format", &local_ref])?;
    if !valid.status.success() {
        return Err("invalid branch name".into());
    }
    let has_local = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &local_ref])?;
    if has_local.status.success() {
        return git_result(run_git(&["-C", &root, "switch", "--no-guess", local])?);
    }
    git_result(run_git(&[
        "-C",
        &root,
        "switch",
        "--no-guess",
        "--track",
        "-c",
        local,
        &branch,
    ])?)
}

#[cfg(test)]
mod tests {
    use super::{git_checkout_remote, git_refs, parse_track};
    use crate::testutil::{test_git, TempRepo};
    use std::fs;

    #[test]
    fn track_is_parsed() {
        assert_eq!(parse_track("ahead 2, behind 1"), (2, 1, false));
        assert_eq!(parse_track("behind 3"), (0, 3, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }

    #[tokio::test]
    async fn refs_list_branches_remotes_tags_and_checkout_remote_tracks() {
        let remote = TempRepo::new();
        test_git(&remote.0, &["init", "--quiet", "--bare"]);
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("a.txt"), "base\n").unwrap();
        test_git(&repo.0, &["add", "a.txt"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        test_git(&repo.0, &["branch", "-M", "main"]);
        test_git(&repo.0, &["tag", "-a", "v1", "-m", "release"]);
        let remote_path = remote.0.to_string_lossy().into_owned();
        test_git(&repo.0, &["remote", "add", "origin", &remote_path]);
        test_git(&repo.0, &["push", "--quiet", "-u", "origin", "main"]);
        test_git(
            &repo.0,
            &["push", "--quiet", "origin", "main:feature/remote-only"],
        );
        test_git(&repo.0, &["fetch", "--quiet", "origin"]);
        fs::write(repo.0.join("a.txt"), "ahead\n").unwrap();
        test_git(&repo.0, &["commit", "--quiet", "-am", "ahead"]);

        let root = repo.0.to_string_lossy().into_owned();
        let refs = git_refs(root.clone()).await.unwrap();
        assert_eq!(refs.head.as_deref(), Some("main"));
        let main = refs.local.iter().find(|r| r.name == "main").unwrap();
        assert_eq!(
            (main.upstream.as_str(), main.ahead, main.behind),
            ("origin/main", 1, 0)
        );
        assert!(!main.worktree.is_empty());
        let remotes: Vec<_> = refs.remote.iter().map(|r| r.name.as_str()).collect();
        assert!(remotes.contains(&"origin/main"));
        assert!(remotes.contains(&"origin/feature/remote-only"));
        let tag = refs.tags.iter().find(|r| r.name == "v1").unwrap();
        // 注釈付きタグはタグオブジェクトではなく、指しているコミットを返す
        assert_eq!(
            tag.hash,
            test_git(&repo.0, &["rev-parse", "--short", "v1^{commit}"])
        );

        git_checkout_remote(root.clone(), "origin/feature/remote-only".into())
            .await
            .unwrap();
        assert_eq!(
            test_git(&repo.0, &["branch", "--show-current"]),
            "feature/remote-only"
        );
        assert_eq!(
            test_git(&repo.0, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/feature/remote-only"
        );
        // 既存のローカルブランチがあればそちらへ切り替える
        git_checkout_remote(root.clone(), "origin/main".into())
            .await
            .unwrap();
        assert_eq!(test_git(&repo.0, &["branch", "--show-current"]), "main");
        assert!(git_checkout_remote(root, "origin/missing".into())
            .await
            .is_err());
    }
}
