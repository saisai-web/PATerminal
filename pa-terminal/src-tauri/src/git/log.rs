//! コミット履歴。Git ウィンドウの履歴（コミットグラフ）用。

use std::path::PathBuf;

use serde::Serialize;

use super::run::run_git;
use super::status::git_current_branch;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    /// 表示用の短縮ハッシュ（差分・巻き戻しの引数にもそのまま使う）
    hash: String,
    /// グラフ描画用の完全ハッシュと親（parents と突き合わせる）
    id: String,
    parents: Vec<String>,
    /// コミット時刻（epoch 秒）。相対表記はフロントで i18n する
    time: i64,
    author: String,
    /// デコレーション（"HEAD -> refs/heads/main, refs/remotes/origin/main" 等。無ければ空）
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

/// 1回に取るコミット数。3秒ポーリングに乗るので増やしすぎない
const LOG_LIMIT: &str = "120";

/// Git ウィンドウの履歴用: ブランチ + 直近コミット一覧（コミットグラフの親つき）。
/// ローカル・リモートのブランチとタグ全体を日付順で取る。
/// `--all` は refs/stash まで拾ってしまうので、ブランチ・リモート・タグ・HEAD を明示する
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
    let args = [
        "-C",
        &cwd,
        "log",
        "-n",
        LOG_LIMIT,
        "--date-order",
        // ローカル / リモート / タグをフロントで見分けるため refs/... の完全名で出す
        "--decorate=full",
        "--pretty=format:%h%x1f%H%x1f%P%x1f%ct%x1f%an%x1f%D%x1f%s%x1e",
        "--branches",
        "--remotes",
        "--tags",
        "HEAD",
    ];
    if let Ok(o) = run_git(&args) {
        // unborn HEAD（初回コミット前）は log 自体が失敗する → repo:true + 空一覧のまま
        if o.status.success() {
            for rec in String::from_utf8_lossy(&o.stdout).split('\u{1e}') {
                let mut it = rec.trim_start_matches(['\n', '\r']).splitn(7, '\u{1f}');
                let (Some(h), Some(id), Some(p), Some(t), Some(a), Some(r), Some(s)) = (
                    it.next(),
                    it.next(),
                    it.next(),
                    it.next(),
                    it.next(),
                    it.next(),
                    it.next(),
                ) else {
                    continue;
                };
                commits.push(GitCommit {
                    hash: h.to_string(),
                    id: id.to_string(),
                    parents: p.split_whitespace().map(str::to_string).collect(),
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

#[cfg(test)]
mod tests {
    use super::git_log;
    use crate::testutil::{test_git, TempRepo};
    use std::fs;

    #[tokio::test]
    async fn log_returns_parents_across_all_branches_without_stash() {
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
        test_git(&repo.0, &["tag", "v1"]);
        test_git(&repo.0, &["switch", "--quiet", "-c", "side"]);
        fs::write(repo.0.join("b.txt"), "side\n").unwrap();
        test_git(&repo.0, &["add", "b.txt"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "side work"]);
        test_git(&repo.0, &["switch", "--quiet", "main"]);
        fs::write(repo.0.join("a.txt"), "main\n").unwrap();
        test_git(&repo.0, &["commit", "--quiet", "-am", "main work"]);
        // stash は --all だと拾われる。グラフに出ないことを確かめる
        fs::write(repo.0.join("a.txt"), "dirty\n").unwrap();
        test_git(&repo.0, &["stash", "--quiet"]);

        let cwd = repo.0.to_string_lossy().into_owned();
        let log = git_log(cwd).await.unwrap();
        let subjects: Vec<_> = log.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects.len(), 3, "{subjects:?}");
        assert!(subjects.contains(&"side work"));
        assert!(log.commits.iter().all(|c| !c.refs.contains("stash")));
        let initial = log.commits.iter().find(|c| c.subject == "initial").unwrap();
        assert!(initial.parents.is_empty());
        assert!(initial.refs.contains("tag: refs/tags/v1"));
        let main = log
            .commits
            .iter()
            .find(|c| c.subject == "main work")
            .unwrap();
        assert_eq!(main.parents, [initial.id.as_str()]);
        assert!(main.refs.contains("HEAD -> refs/heads/main"));
    }
}
