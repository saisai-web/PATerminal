//! 差分の取得。フロントの `src/diff-overlay.ts` が扱う3種類:
//! - `git_file_diff`: 変更チップ1件（HEAD 版と作業ツリー版の全文）
//! - `git_commit_diff`: コミット1件（第1親との unified diff）
//! - `git_worktree_diff`: 変更ストリップの見出し（cwd 配下の作業ツリー全体）
//!
//! unified diff の共通処理（上限つき切り詰め・行数集計）は PR 差分（`github`）も使う。

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::run::{git_output_text, run_git};
use super::status::git_changes;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileDiff {
    old_text: String,
    new_text: String,
}

const GIT_DIFF_MAX_BYTES: u64 = 1_048_576;

/// 変更ファイル1件の diff 用に HEAD 版と作業ツリー版の全文を返す。
/// path は git が返したリポジトリ相対パスのみ受け付ける
#[tauri::command]
pub(crate) async fn git_file_diff(root: String, path: String) -> Result<GitFileDiff, String> {
    if !repo_relative(&path) {
        return Err("bad path".into());
    }
    let old_text = run_git(&["-C", &root, "show", &format!("HEAD:{path}")])
        .ok()
        .filter(|o| o.status.success() && o.stdout.len() as u64 <= GIT_DIFF_MAX_BYTES)
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default(); // 未追跡・初回コミット前は空 = 全行追加として表示
    let fp = PathBuf::from(&root).join(&path);
    let new_text = fs::metadata(&fp)
        .ok()
        .filter(|m| m.is_file() && m.len() <= GIT_DIFF_MAX_BYTES)
        .and_then(|_| fs::read(&fp).ok())
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default(); // 削除済みは空 = 全行削除として表示
    Ok(GitFileDiff { old_text, new_text })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitDiff {
    pub(crate) patch: String,
    pub(crate) adds: i64,
    pub(crate) dels: i64,
    pub(crate) truncated: bool,
}

const GIT_COMMIT_DIFF_MAX_BYTES: usize = 1_048_576;

pub(crate) fn valid_git_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// git が返すリポジトリ相対パスとして妥当か。
///
/// 文字列の先頭を見るだけでは Windows の絶対パス（`C:\…` `C:/…` `\\server\share`）や
/// ドライブ相対（`C:foo`）を通してしまう。コンポーネントに分解して `Normal` 以外
/// （`Prefix` / `RootDir` / `ParentDir` / `CurDir`）が1つでもあれば拒否する。
fn repo_relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn git_numstat_totals(bytes: &[u8]) -> (i64, i64) {
    let mut adds = 0;
    let mut dels = 0;
    for line in String::from_utf8_lossy(bytes).lines() {
        let mut fields = line.splitn(3, '\t');
        let (Some(a), Some(d)) = (fields.next(), fields.next()) else {
            continue;
        };
        // バイナリ差分の "-" は0行として扱う
        adds += a.parse::<i64>().unwrap_or(0);
        dels += d.parse::<i64>().unwrap_or(0);
    }
    (adds, dels)
}

pub(crate) fn limited_git_patch(mut bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > GIT_COMMIT_DIFF_MAX_BYTES;
    bytes.truncate(GIT_COMMIT_DIFF_MAX_BYTES);
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

pub(crate) fn patch_line_totals(patch: &str) -> (i64, i64) {
    let mut adds = 0;
    let mut dels = 0;
    let mut in_hunk = false;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            in_hunk = false;
        } else if line.starts_with("@@ ") {
            in_hunk = true;
        } else if in_hunk && line.starts_with('+') {
            adds += 1;
        } else if in_hunk && line.starts_with('-') {
            dels += 1;
        }
    }
    (adds, dels)
}

/// コミット行クリック用: そのコミットを第1親（root commit は空ツリー）と比較した unified diff。
/// merge commit も --first-parent で通常の1本の差分として表示する。
#[tauri::command]
pub(crate) async fn git_commit_diff(root: String, hash: String) -> Result<GitCommitDiff, String> {
    if !PathBuf::from(&root).is_dir() || !valid_git_hash(&hash) {
        return Err("bad commit".into());
    }
    let common = [
        "-C",
        &root,
        "diff-tree",
        "--root",
        "--first-parent",
        "--no-commit-id",
        "-r",
    ];
    let stats_out = run_git(&[
        common[0],
        common[1],
        common[2],
        common[3],
        common[4],
        common[5],
        common[6],
        "--numstat",
        "--find-renames",
        &hash,
        "--",
    ])?;
    if !stats_out.status.success() {
        return Err(git_output_text(&stats_out));
    }
    let (adds, dels) = git_numstat_totals(&stats_out.stdout);

    let patch_out = run_git(&[
        common[0],
        common[1],
        common[2],
        common[3],
        common[4],
        common[5],
        common[6],
        "-p",
        "--find-renames",
        "--no-color",
        "--unified=3",
        &hash,
        "--",
    ])?;
    if !patch_out.status.success() {
        return Err(git_output_text(&patch_out));
    }
    let (patch, truncated) = limited_git_patch(patch_out.stdout);
    Ok(GitCommitDiff {
        patch,
        adds,
        dels,
        truncated,
    })
}

/// 変更ストリップの見出しクリック用: cwd 配下の作業ツリー差分を一つの unified diff で返す。
/// 通常の `git diff HEAD` に出ない未追跡ファイルも `/dev/null` との差分として追加する。
#[tauri::command]
pub(crate) async fn git_worktree_diff(cwd: String) -> Result<GitCommitDiff, String> {
    let changes = git_changes(cwd.clone()).await?;
    if !changes.repo {
        return Err("not a git repository".into());
    }
    let root = changes
        .root
        .ok_or_else(|| "missing repository root".to_string())?;
    let adds = changes.files.iter().map(|file| file.adds).sum();
    let dels = changes.files.iter().map(|file| file.dels).sum();
    let untracked: Vec<&str> = changes
        .files
        .iter()
        .filter(|file| file.status == "A")
        .map(|file| file.path.as_str())
        .collect();

    let mut bytes = Vec::new();
    let has_head = run_git(&["-C", &cwd, "rev-parse", "--verify", "HEAD"])
        .ok()
        .is_some_and(|out| out.status.success());
    if has_head {
        let tracked = run_git(&[
            "-C",
            &cwd,
            "diff",
            "HEAD",
            "-p",
            "--find-renames",
            "--no-color",
            "--unified=3",
            "--",
            ".",
        ])?;
        if !tracked.status.success() {
            return Err(git_output_text(&tracked));
        }
        bytes.extend_from_slice(&tracked.stdout);
    }

    let mut omitted = false;
    for path in untracked {
        if bytes.len() >= GIT_COMMIT_DIFF_MAX_BYTES {
            omitted = true;
            break;
        }
        // `git diff --no-index` は差分ありを exit code 1 で返す。2以上だけが実エラー。
        let out = run_git(&[
            "-C",
            &root,
            "diff",
            "--no-index",
            "-p",
            "--no-color",
            "--unified=3",
            "--",
            "/dev/null",
            path,
        ])?;
        if !out.status.success() && out.status.code() != Some(1) {
            return Err(git_output_text(&out));
        }
        bytes.extend_from_slice(&out.stdout);
    }

    let (patch, truncated) = limited_git_patch(bytes);
    Ok(GitCommitDiff {
        patch,
        adds,
        dels,
        truncated: truncated || omitted,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        git_numstat_totals, git_worktree_diff, patch_line_totals, repo_relative, valid_git_hash,
    };
    use crate::testutil::{test_git, TempRepo};
    use std::fs;

    #[test]
    fn repo_relative_rejects_absolute_and_traversal_paths() {
        assert!(repo_relative("src/main.rs"));
        assert!(repo_relative("README.md"));
        assert!(repo_relative("a/b/c.txt"));
        for bad in [
            "",
            "/etc/passwd",
            "../secret",
            "src/../../secret",
            "./src/main.rs",
        ] {
            assert!(!repo_relative(bad), "{bad:?} は拒否したい");
        }
        // Windows の絶対パス・ドライブ相対・UNC。Windows でのみ区切りとして解釈される
        for bad in [r"C:\Windows\win.ini", "C:/Windows/win.ini", r"\\server\share"] {
            if cfg!(windows) {
                assert!(!repo_relative(bad), "{bad:?} は Windows で拒否したい");
            }
        }
    }

    #[test]
    fn commit_hash_validation_rejects_git_options_and_revisions() {
        assert!(valid_git_hash("abc1234"));
        assert!(valid_git_hash("0123456789abcdef0123456789abcdef01234567"));
        assert!(!valid_git_hash("--help"));
        assert!(!valid_git_hash("HEAD~1"));
        assert!(!valid_git_hash("abc"));
    }

    #[test]
    fn commit_numstat_totals_ignore_binary_counts() {
        assert_eq!(
            git_numstat_totals(b"3\t1\tsrc/main.rs\n-\t-\timage.png\n2\t0\tREADME.md\n"),
            (5, 1)
        );
    }

    #[test]
    fn pr_patch_totals_count_only_hunk_lines() {
        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n-old\n+new\n+added\n context\n";
        assert_eq!(patch_line_totals(patch), (2, 1));
    }

    #[tokio::test]
    async fn worktree_diff_includes_tracked_and_untracked_files_in_cwd() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::create_dir(repo.0.join("sub")).unwrap();
        fs::write(repo.0.join("sub/tracked.txt"), "before\n").unwrap();
        fs::write(repo.0.join("outside.txt"), "before\n").unwrap();
        test_git(&repo.0, &["add", "."]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);

        fs::write(repo.0.join("sub/tracked.txt"), "after\n").unwrap();
        fs::write(repo.0.join("sub/new file.txt"), "one\ntwo\n").unwrap();
        fs::write(repo.0.join("outside.txt"), "outside change\n").unwrap();

        let diff = git_worktree_diff(repo.0.join("sub").to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!((diff.adds, diff.dels), (3, 1));
        assert!(diff.patch.contains("sub/tracked.txt"));
        assert!(diff.patch.contains("sub/new file.txt"));
        assert!(!diff.patch.contains("outside.txt"));
        assert!(!diff.truncated);
    }
}
