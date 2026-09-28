//! git 変更検出。
//! 変更ストリップの「変更ファイル」自動表示（`git_changes`）と、サイドバーの
//! セッションバッジ用の軽量集計（`git_summary`）。どちらもフォーカス中ペインの
//! cwd を定期ポーリングし、HEAD との差分 + 未追跡ファイルを同じ数え方で返す。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use super::refs::parse_track;
use super::run::run_git;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFile {
    pub(crate) path: String,
    pub(crate) adds: i64,
    pub(crate) dels: i64,
    pub(crate) status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitChanges {
    pub(crate) repo: bool,
    pub(crate) root: Option<String>,
    pub(crate) files: Vec<GitFile>,
}

pub(crate) const GIT_MAX_FILES: usize = 200;

#[tauri::command]
pub(crate) async fn git_changes(cwd: String) -> Result<GitChanges, String> {
    let none = GitChanges {
        repo: false,
        root: None,
        files: vec![],
    };
    if !PathBuf::from(&cwd).is_dir() {
        return Ok(none);
    }
    let Ok(out) = run_git(&["-C", &cwd, "rev-parse", "--show-toplevel"]) else {
        return Ok(none); // git 未インストールでも壊さない
    };
    if !out.status.success() {
        return Ok(none); // リポジトリ外
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();

    let mut files: Vec<GitFile> = Vec::new();
    // 追加 / 削除 / 変更の区別（A / D / M）。リネームは削除 + 追加として扱う
    // （"old => new" 形式のパスはコミット対象の指定にそのまま使えないため）
    let mut kinds: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(o) = run_git(&[
        "-C",
        &cwd,
        "diff",
        "HEAD",
        "--name-status",
        "--no-renames",
        "--",
        ".",
    ]) {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if let Some((kind, p)) = line.split_once('\t') {
                    let kind = match kind.chars().next() {
                        Some('A') => "A",
                        Some('D') => "D",
                        _ => "M",
                    };
                    kinds.insert(p.trim_matches('"').to_string(), kind.into());
                }
            }
        }
    }
    // HEAD との差分（ステージ済みも含める）。初回コミット前は HEAD が無いのでスキップ。
    // "-- ." で cwd 配下に限定する（リポジトリ全体は見ない）。パス自体はルート相対で返る
    if let Ok(o) = run_git(&[
        "-C",
        &cwd,
        "diff",
        "HEAD",
        "--numstat",
        "--no-renames",
        "--",
        ".",
    ]) {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let mut it = line.splitn(3, '\t');
                let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else {
                    continue;
                };
                // 非 ASCII パスは "..." で囲まれて返る。表示用に外すだけ（エスケープ解釈まではしない）
                let path = p.trim_matches('"').to_string();
                let status = kinds.get(&path).cloned().unwrap_or_else(|| "M".into());
                files.push(GitFile {
                    path,
                    adds: a.parse().unwrap_or(0), // バイナリは "-" → 0
                    dels: d.parse().unwrap_or(0),
                    status,
                });
            }
        }
    }
    // 未追跡ファイル（.gitignore 対象は除外される）。cwd 配下のみ・ルート相対パスで
    // 取得（--full-name）。行数は小さいファイルだけ数える
    if let Ok(o) = run_git(&[
        "-C",
        &cwd,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
    ]) {
        if o.status.success() {
            for p in String::from_utf8_lossy(&o.stdout).lines() {
                if files.len() >= GIT_MAX_FILES {
                    break;
                }
                let fp = PathBuf::from(&root).join(p);
                let adds = fs::metadata(&fp)
                    .ok()
                    .filter(|m| m.is_file() && m.len() <= 262_144)
                    .and_then(|_| fs::read_to_string(&fp).ok())
                    .map(|s| s.lines().count() as i64)
                    .unwrap_or(0);
                files.push(GitFile {
                    path: p.to_string(),
                    adds,
                    dels: 0,
                    status: "A".into(),
                });
            }
        }
    }
    files.truncate(GIT_MAX_FILES);
    Ok(GitChanges {
        repo: true,
        root: Some(root),
        files,
    })
}

/// 現在ブランチ名。detached HEAD は (短縮SHA, true)、
/// unborn HEAD（初回コミット前）は (シンボリック名, false)
pub(crate) fn git_current_branch(cwd: &str) -> (Option<String>, bool) {
    if let Ok(o) = run_git(&["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]) {
        if o.status.success() {
            let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if b == "HEAD" {
                // detached HEAD → 短縮 SHA で表示
                let sha = run_git(&["-C", cwd, "rev-parse", "--short", "HEAD"])
                    .ok()
                    .filter(|o| o.status.success())
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
                return (sha, true);
            }
            if !b.is_empty() {
                return (Some(b), false);
            }
        } else {
            // unborn HEAD（初回コミット前）は abbrev-ref が失敗する
            let b = run_git(&["-C", cwd, "symbolic-ref", "--short", "HEAD"])
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            return (b, false);
        }
    }
    (None, false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitSummary {
    repo: bool,
    root: Option<String>,
    /// detached HEAD は短縮 SHA。unborn HEAD（初回コミット前）はシンボリック名
    branch: Option<String>,
    /// detached HEAD（branch は短縮 SHA）
    detached: bool,
    /// 現在ブランチの upstream（"origin/main"）。無ければ None
    upstream: Option<String>,
    /// upstream に対して Push / Pull が必要なコミット数（ペインバーの同期表示）
    ahead: u32,
    behind: u32,
    file_count: i64,
    adds: i64,
    dels: i64,
}

/// 現在ブランチの upstream と ahead / behind。for-each-ref 1回で済ませる
/// （全ペインの定期ポーリングで呼ばれるため rev-list は使わない）
fn git_upstream_track(cwd: &str, branch: &str) -> (Option<String>, u32, u32) {
    let full_ref = format!("refs/heads/{branch}");
    let Ok(o) = run_git(&[
        "-C",
        cwd,
        "for-each-ref",
        "--format=%(upstream:short)%1f%(upstream:track,nobracket)",
        &full_ref,
    ]) else {
        return (None, 0, 0);
    };
    if !o.status.success() {
        return (None, 0, 0);
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let Some((upstream, track)) = text.trim_end_matches(['\n', '\r']).split_once('\u{1f}') else {
        return (None, 0, 0);
    };
    if upstream.is_empty() {
        return (None, 0, 0);
    }
    let (ahead, behind, gone) = parse_track(track);
    if gone {
        return (None, 0, 0);
    }
    (Some(upstream.to_string()), ahead, behind)
}

/// サイドバーのセッションバッジ用。git_changes と同じ数え方で集計だけ返す
/// （全セッション × 定期ポーリングで呼ばれるため、ファイル一覧は IPC に流さない）
#[tauri::command]
pub(crate) async fn git_summary(cwd: String) -> Result<GitSummary, String> {
    let none = GitSummary {
        repo: false,
        root: None,
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        file_count: 0,
        adds: 0,
        dels: 0,
    };
    if !PathBuf::from(&cwd).is_dir() {
        return Ok(none);
    }
    let Ok(out) = run_git(&["-C", &cwd, "rev-parse", "--show-toplevel"]) else {
        return Ok(none); // git 未インストールでも壊さない
    };
    if !out.status.success() {
        return Ok(none); // リポジトリ外
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();

    let (branch, detached) = git_current_branch(&cwd);
    let (upstream, ahead, behind) = match branch.as_deref() {
        Some(b) if !detached => git_upstream_track(&cwd, b),
        _ => (None, 0, 0),
    };

    // 集計は git_changes と同じソース（diff HEAD --numstat + 未追跡）で数を合わせる
    let mut file_count: i64 = 0;
    let mut adds: i64 = 0;
    let mut dels: i64 = 0;
    if let Ok(o) = run_git(&["-C", &cwd, "diff", "HEAD", "--numstat", "--", "."]) {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let mut it = line.splitn(3, '\t');
                let (Some(a), Some(d), Some(_)) = (it.next(), it.next(), it.next()) else {
                    continue;
                };
                file_count += 1;
                adds += a.parse::<i64>().unwrap_or(0); // バイナリは "-" → 0
                dels += d.parse::<i64>().unwrap_or(0);
            }
        }
    }
    if let Ok(o) = run_git(&[
        "-C",
        &cwd,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
    ]) {
        if o.status.success() {
            for p in String::from_utf8_lossy(&o.stdout).lines() {
                file_count += 1;
                let fp = PathBuf::from(&root).join(p);
                adds += fs::metadata(&fp)
                    .ok()
                    .filter(|m| m.is_file() && m.len() <= 262_144)
                    .and_then(|_| fs::read_to_string(&fp).ok())
                    .map(|s| s.lines().count() as i64)
                    .unwrap_or(0);
            }
        }
    }
    Ok(GitSummary {
        repo: true,
        root: Some(root),
        branch,
        detached,
        upstream,
        ahead,
        behind,
        file_count,
        adds,
        dels,
    })
}

#[cfg(test)]
mod tests {
    use super::git_changes;
    use crate::testutil::{test_git, TempRepo};
    use std::fs;

    #[tokio::test]
    async fn changes_report_added_deleted_modified_and_untracked_without_renames() {
        let repo = TempRepo::new();
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("keep.txt"), "a\n").unwrap();
        fs::write(repo.0.join("gone.txt"), "b\n").unwrap();
        fs::write(repo.0.join("moved.txt"), "c\nc\nc\n").unwrap();
        test_git(&repo.0, &["add", "."]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        fs::write(repo.0.join("keep.txt"), "a2\n").unwrap();
        fs::remove_file(repo.0.join("gone.txt")).unwrap();
        test_git(&repo.0, &["mv", "moved.txt", "renamed.txt"]);
        fs::write(repo.0.join("staged.txt"), "s\n").unwrap();
        test_git(&repo.0, &["add", "staged.txt"]);
        fs::write(repo.0.join("new.txt"), "n\n").unwrap();

        let res = git_changes(repo.0.to_string_lossy().into_owned())
            .await
            .unwrap();
        let mut got: Vec<(String, String)> = res
            .files
            .iter()
            .map(|f| (f.path.clone(), f.status.clone()))
            .collect();
        got.sort();
        let want = [
            ("gone.txt", "D"),
            ("keep.txt", "M"),
            ("moved.txt", "D"),
            ("new.txt", "A"),
            ("renamed.txt", "A"),
            ("staged.txt", "A"),
        ];
        assert_eq!(
            got,
            want.map(|(p, s)| (p.to_string(), s.to_string())).to_vec()
        );
    }
}
