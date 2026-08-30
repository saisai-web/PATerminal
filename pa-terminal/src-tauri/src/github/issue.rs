//! GitHub Issue（Issue タブの一覧・詳細と、既存ブランチの linked branch 化）。

use std::path::PathBuf;

use serde::Serialize;

use super::gh::{gh_json, gh_program, run_gh_program, GH_VIEW_TIMEOUT_SECS};
use crate::git::{git_output_text, git_remotes, run_git};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueSummary {
    number: i64,
    title: String,
    state: String,
    url: String,
    author: String,
    assignees: Vec<String>,
    labels: Vec<String>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueList {
    /// false は gh 不在・未認証・GitHub リポジトリでない等。空一覧と区別して表示する
    available: bool,
    issues: Vec<IssueSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueComment {
    author: String,
    body: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueInfo {
    found: bool,
    number: Option<i64>,
    title: Option<String>,
    state: Option<String>,
    url: Option<String>,
    author: Option<String>,
    body: Option<String>,
    labels: Vec<String>,
    comments: Vec<IssueComment>,
}

fn json_labels(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x["name"].as_str().map(String::from))
        .collect()
}

fn json_logins(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x["login"].as_str().map(String::from))
        .collect()
}

/// GitHub Issue 一覧。Issue タブを開いた時と手動更新時だけ呼ばれる（3秒 poll には乗せない）。
#[tauri::command]
pub(crate) async fn issue_list(root: String) -> Result<IssueList, String> {
    let none = || IssueList {
        available: false,
        issues: vec![],
    };
    if !PathBuf::from(&root).is_dir() {
        return Ok(none());
    }
    let Ok(v) = gh_json(
        &root,
        &[
            "issue",
            "list",
            // クローズ済みは一覧に出さない（作業対象は open だけ）
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,state,url,author,assignees,labels,updatedAt",
        ],
        GH_VIEW_TIMEOUT_SECS,
    )
    .await
    else {
        return Ok(none());
    };
    let Some(arr) = v.as_array() else {
        return Ok(none());
    };
    let issues = arr
        .iter()
        .filter_map(|x| {
            Some(IssueSummary {
                number: x["number"].as_i64()?,
                title: x["title"].as_str().unwrap_or("").to_string(),
                state: x["state"].as_str().unwrap_or("").to_string(),
                url: x["url"].as_str().unwrap_or("").to_string(),
                author: x["author"]["login"].as_str().unwrap_or("?").to_string(),
                assignees: json_logins(&x["assignees"]),
                labels: json_labels(&x["labels"]),
                updated_at: x["updatedAt"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect();
    Ok(IssueList {
        available: true,
        issues,
    })
}

/// Issue 本文と全コメント。実行プロンプトにもこの結果をそのまま使う。
#[tauri::command]
pub(crate) async fn issue_info(root: String, number: i64) -> Result<IssueInfo, String> {
    let none = || IssueInfo {
        found: false,
        number: None,
        title: None,
        state: None,
        url: None,
        author: None,
        body: None,
        labels: vec![],
        comments: vec![],
    };
    if number <= 0 || !PathBuf::from(&root).is_dir() {
        return Ok(none());
    }
    let number_s = number.to_string();
    let Ok(v) = gh_json(
        &root,
        &[
            "issue",
            "view",
            &number_s,
            "--json",
            "number,title,state,url,author,body,labels,comments",
        ],
        GH_VIEW_TIMEOUT_SECS,
    )
    .await
    else {
        return Ok(none());
    };
    let comments = v["comments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| IssueComment {
            author: c["author"]["login"].as_str().unwrap_or("?").to_string(),
            body: c["body"].as_str().unwrap_or("").to_string(),
            created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    Ok(IssueInfo {
        found: true,
        number: v["number"].as_i64(),
        title: v["title"].as_str().map(String::from),
        state: v["state"].as_str().map(String::from),
        url: v["url"].as_str().map(String::from),
        author: v["author"]["login"].as_str().map(String::from),
        body: v["body"].as_str().map(String::from),
        labels: json_labels(&v["labels"]),
        comments,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueBranchLink {
    branch: String,
    remote: String,
}

/// 選択したローカルブランチの push 先。既存 upstream を優先し、未設定なら git_push と
/// 同じく origin（または唯一のリモート）へ限定する。
fn issue_branch_remote(root: &str, full_branch: &str) -> Result<String, String> {
    let upstream = run_git(&[
        "-C",
        root,
        "for-each-ref",
        "--format=%(upstream:remotename)",
        full_branch,
    ])?;
    if upstream.status.success() {
        let remote = String::from_utf8_lossy(&upstream.stdout).trim().to_string();
        if !remote.is_empty() && !remote.starts_with('-') {
            return Ok(remote);
        }
    }

    let names = git_remotes(root)?;
    if names.iter().any(|n| n == "origin") {
        Ok("origin".into())
    } else if names.len() == 1 {
        Ok(names[0].clone())
    } else if names.is_empty() {
        Err("no Git remote is configured".into())
    } else {
        Err("no upstream is configured; add an origin remote or set the branch upstream".into())
    }
}

/// 既存のローカルブランチを GitHub Issue の linked branch にし、そのブランチだけを push する。
/// gh issue develop は未公開ブランチの作成と既存 linked branch の再利用を安全に処理する。
async fn issue_link_branch_with_program(
    gh: &str,
    root: String,
    number: i64,
    branch: String,
) -> Result<IssueBranchLink, String> {
    if number <= 0 || !PathBuf::from(&root).is_dir() || branch.trim() != branch {
        return Err("bad repository, issue number, or branch".into());
    }
    let full_branch = format!("refs/heads/{branch}");
    let valid = run_git(&["check-ref-format", &full_branch])?;
    if !valid.status.success() || branch.is_empty() || branch.starts_with('-') {
        return Err("invalid local branch".into());
    }
    let exists = run_git(&["-C", &root, "show-ref", "--verify", "--quiet", &full_branch])?;
    if !exists.status.success() {
        return Err(format!("local branch not found: {branch}"));
    }

    let remote = issue_branch_remote(&root, &full_branch)?;
    let remote_url_out = run_git(&["-C", &root, "remote", "get-url", &remote])?;
    if !remote_url_out.status.success() {
        return Err(git_output_text(&remote_url_out));
    }
    let remote_url = String::from_utf8_lossy(&remote_url_out.stdout)
        .trim()
        .to_string();
    if remote_url.is_empty() || remote_url.starts_with('-') {
        return Err("invalid Git remote URL".into());
    }

    // linked branch を先に作る。既にこの Issue に同名ブランチが紐付いている場合は gh が再利用する。
    let number_s = number.to_string();
    run_gh_program(
        gh,
        &root,
        &[
            "issue",
            "develop",
            &number_s,
            "--name",
            &branch,
            "--branch-repo",
            &remote_url,
        ],
        30,
    )
    .await?;

    // bare push や force は使わず、選択されたローカル ref だけを同名の linked branch へ送る。
    let refspec = format!("{full_branch}:{full_branch}");
    let pushed = run_git(&["-C", &root, "push", "--set-upstream", &remote, &refspec])?;
    if !pushed.status.success() {
        let detail = git_output_text(&pushed);
        return Err(format!(
            "GitHub linked branch was created, but pushing {branch} failed: {detail}"
        ));
    }
    Ok(IssueBranchLink { branch, remote })
}

#[tauri::command]
pub(crate) async fn issue_link_branch(
    root: String,
    number: i64,
    branch: String,
) -> Result<IssueBranchLink, String> {
    let gh = gh_program();
    issue_link_branch_with_program(&gh, root, number, branch).await
}

#[cfg(test)]
mod tests {
    use super::issue_link_branch_with_program;
    use crate::testutil::{gh_stub, test_git, TempRepo};
    use std::fs;

    #[tokio::test]
    async fn issue_link_pushes_only_the_selected_local_branch() {
        let repo = TempRepo::new();
        let remote = TempRepo::new();
        let tools = TempRepo::new();
        test_git(&remote.0, &["init", "--bare", "--quiet"]);
        test_git(&repo.0, &["init", "--quiet"]);
        test_git(&repo.0, &["config", "user.name", "PATerminal Test"]);
        test_git(
            &repo.0,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::write(repo.0.join("tracked.txt"), "main\n").unwrap();
        test_git(&repo.0, &["add", "tracked.txt"]);
        test_git(&repo.0, &["commit", "--quiet", "-m", "initial"]);
        test_git(&repo.0, &["branch", "-M", "main"]);
        let remote_s = remote.0.to_string_lossy().into_owned();
        test_git(&repo.0, &["remote", "add", "origin", &remote_s]);
        test_git(
            &repo.0,
            &["push", "--quiet", "--set-upstream", "origin", "main"],
        );

        test_git(&repo.0, &["checkout", "--quiet", "-b", "feat/linked"]);
        fs::write(repo.0.join("tracked.txt"), "feature\n").unwrap();
        test_git(&repo.0, &["commit", "--quiet", "-am", "feature"]);
        let feature_head = test_git(&repo.0, &["rev-parse", "feat/linked"]);
        test_git(&repo.0, &["checkout", "--quiet", "main"]);

        // GitHub への linked branch 作成だけを成功させる gh スタブ。push は本物の bare remote で検証する。
        let gh = gh_stub(&tools.0);

        let result = issue_link_branch_with_program(
            &gh.to_string_lossy(),
            repo.0.to_string_lossy().into_owned(),
            42,
            "feat/linked".into(),
        )
        .await
        .unwrap();

        assert_eq!(result.branch, "feat/linked");
        assert_eq!(result.remote, "origin");
        assert_eq!(
            test_git(&remote.0, &["rev-parse", "refs/heads/feat/linked"]),
            feature_head
        );
        assert_eq!(test_git(&repo.0, &["branch", "--show-current"]), "main");
        assert_eq!(
            test_git(
                &repo.0,
                &[
                    "for-each-ref",
                    "--format=%(upstream:short)",
                    "refs/heads/feat/linked",
                ],
            ),
            "origin/feat/linked"
        );
    }
}
