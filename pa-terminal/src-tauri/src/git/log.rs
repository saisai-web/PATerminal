//! コミット履歴。エクスプローラー下部の git セクション（Branch タブ）用。

use std::path::PathBuf;

use serde::Serialize;

use super::run::run_git;
use super::status::git_current_branch;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    /// コミット時刻（epoch 秒）。相対表記はフロントで i18n する
    time: i64,
    author: String,
    /// デコレーション（"HEAD -> main, origin/main" 等。無ければ空）
    refs: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLog {
    repo: bool,
    root: Option<String>,
    branch: Option<String>,
    /// detached HEAD（フロントは PR 照会をスキップする）
    detached: bool,
    commits: Vec<GitCommit>,
}

/// エクスプローラー下部の git セクション用: ブランチ + 直近コミット一覧
#[tauri::command]
pub(crate) async fn git_log(cwd: String) -> Result<GitLog, String> {
    let none = GitLog {
        repo: false,
        root: None,
        branch: None,
        detached: false,
        commits: vec![],
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

    let mut commits: Vec<GitCommit> = Vec::new();
    // 区切りは \x1f（フィールド）/ \x1e（レコード）。subject 中のタブで壊れないように
    if let Ok(o) = run_git(&[
        "-C",
        &cwd,
        "log",
        "-n",
        "50",
        "--pretty=format:%h%x1f%ct%x1f%an%x1f%D%x1f%s%x1e",
    ]) {
        // unborn HEAD（初回コミット前）は log 自体が失敗する → repo:true + 空一覧のまま
        if o.status.success() {
            for rec in String::from_utf8_lossy(&o.stdout).split('\u{1e}') {
                let mut it = rec.trim_start_matches(['\n', '\r']).splitn(5, '\u{1f}');
                let (Some(h), Some(t), Some(a), Some(r), Some(s)) =
                    (it.next(), it.next(), it.next(), it.next(), it.next())
                else {
                    continue;
                };
                commits.push(GitCommit {
                    hash: h.to_string(),
                    time: t.parse().unwrap_or(0),
                    author: a.to_string(),
                    refs: r.to_string(),
                    subject: s.to_string(),
                });
            }
        }
    }
    Ok(GitLog {
        repo: true,
        root: Some(root),
        branch,
        detached,
        commits,
    })
}
