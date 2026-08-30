//! git 変更検出。
//! 変更ストリップの「変更ファイル」自動表示（`git_changes`）と、サイドバーの
//! セッションバッジ用の軽量集計（`git_summary`）。どちらもフォーカス中ペインの
//! cwd を定期ポーリングし、HEAD との差分 + 未追跡ファイルを同じ数え方で返す。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

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
    // HEAD との差分（ステージ済みも含める）。初回コミット前は HEAD が無いのでスキップ。
    // "-- ." で cwd 配下に限定する（リポジトリ全体は見ない）。パス自体はルート相対で返る
    if let Ok(o) = run_git(&["-C", &cwd, "diff", "HEAD", "--numstat", "--", "."]) {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let mut it = line.splitn(3, '\t');
                let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else {
                    continue;
                };
                files.push(GitFile {
                    // 非 ASCII パスは "..." で囲まれて返る。表示用に外すだけ（エスケープ解釈まではしない）
                    path: p.trim_matches('"').to_string(),
                    adds: a.parse().unwrap_or(0), // バイナリは "-" → 0
                    dels: d.parse().unwrap_or(0),
                    status: "M".into(),
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
    file_count: i64,
    adds: i64,
    dels: i64,
}

/// サイドバーのセッションバッジ用。git_changes と同じ数え方で集計だけ返す
/// （全セッション × 定期ポーリングで呼ばれるため、ファイル一覧は IPC に流さない）
#[tauri::command]
pub(crate) async fn git_summary(cwd: String) -> Result<GitSummary, String> {
    let none = GitSummary {
        repo: false,
        root: None,
        branch: None,
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

    let (branch, _) = git_current_branch(&cwd);

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
        file_count,
        adds,
        dels,
    })
}
