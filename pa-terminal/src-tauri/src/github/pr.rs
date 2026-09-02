//! GitHub Pull Request（PR タブの一覧・PR バッジ・PR オーバーレイ）。

use std::path::PathBuf;

use serde::Serialize;

use super::gh::{gh_json, run_gh, GH_LIST_TIMEOUT_SECS, GH_VIEW_TIMEOUT_SECS};
use crate::git::{limited_git_patch, patch_line_totals, GitCommitDiff};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrComment {
    author: String,
    body: String,
    /// ISO8601（gh の createdAt / submittedAt / created_at をそのまま）
    created_at: String,
    /// "comment"（conversation コメント）| "review"（レビュー本文）| "inline"（diff行コメント）
    kind: String,
    /// review のみ: APPROVED / CHANGES_REQUESTED / COMMENTED
    state: Option<String>,
    /// inline のみ: 対象ファイルパス（リポジトリルート相対）
    path: Option<String>,
    /// inline のみ: 対象行番号（diff上の現在行。無ければ元の行）
    line: Option<i64>,
    /// inline のみ: レビュー時点の対象行コード（diff_hunk から抽出）
    code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrFile {
    /// リポジトリルート相対パス
    path: String,
    /// renamed のみ: 変更前パス
    previous_path: Option<String>,
    /// added / removed / modified / renamed / copied
    status: String,
    additions: i64,
    deletions: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrInfo {
    found: bool,
    number: Option<i64>,
    title: Option<String>,
    /// PR の head ブランチ。PR バッジから開いた詳細でも worktree を作れるよう返す。
    head_ref_name: Option<String>,
    /// OPEN / CLOSED / MERGED
    state: Option<String>,
    url: Option<String>,
    author: Option<String>,
    body: Option<String>,
    additions: i64,
    deletions: i64,
    changed_files: i64,
    files: Vec<PrFile>,
    comments: Vec<PrComment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrSummary {
    number: i64,
    title: String,
    /// OPEN / CLOSED / MERGED
    state: String,
    url: String,
    author: String,
    head_ref_name: String,
    base_ref_name: String,
    is_draft: bool,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrList {
    /// false は gh 不在・未認証・GitHub リポジトリでない等。空一覧と区別して表示する
    available: bool,
    prs: Vec<PrSummary>,
    /// available:false のときの理由（gh の stderr など）。成功時は空文字
    error: String,
}

impl PrList {
    fn failed(error: String) -> Self {
        PrList {
            available: false,
            prs: vec![],
            error,
        }
    }
}

const PR_MAX_COMMENTS: usize = 100;
const PR_MAX_FILES: usize = 100;
const PR_MAX_BODY_CHARS: usize = 20_000;

/// 長大コメントで MB 級 IPC を作らないよう char 境界で切り詰める
fn pr_cap(s: &str) -> String {
    match s.char_indices().nth(PR_MAX_BODY_CHARS) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// gh pr view の files と REST API の整形済み files の両方を読めるようにする。
/// REST が失敗した場合もパスと増減行数だけは gh pr view から表示できる。
fn parse_pr_files(value: &serde_json::Value) -> Vec<PrFile> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(PR_MAX_FILES)
        .filter_map(|f| {
            let path = f["path"]
                .as_str()
                .or_else(|| f["filename"].as_str())?
                .to_string();
            Some(PrFile {
                path,
                previous_path: f["previousPath"]
                    .as_str()
                    .or_else(|| f["previous_filename"].as_str())
                    .map(String::from),
                status: f["status"].as_str().unwrap_or("modified").to_string(),
                additions: f["additions"].as_i64().unwrap_or(0),
                deletions: f["deletions"].as_i64().unwrap_or(0),
            })
        })
        .collect()
}

fn diff_hunk_start(spec: &str, prefix: char) -> Option<i64> {
    spec.strip_prefix(prefix)?.split(',').next()?.parse().ok()
}

/// GitHub の review comment が持つ diff_hunk から、コメント対象の1行を取り出す。
/// ローカルの現在ファイルではなくレビュー時点の hunk を使うため、outdated コメントにも対応する。
fn pr_review_line_code(comment: &serde_json::Value) -> Option<String> {
    let diff_hunk = comment["diff_hunk"].as_str()?;
    let current_line = comment["line"].as_i64();
    let target_line = current_line.or_else(|| comment["original_line"].as_i64())?;
    let side = if current_line.is_some() {
        comment["side"]
            .as_str()
            .or_else(|| comment["original_side"].as_str())
    } else {
        comment["original_side"]
            .as_str()
            .or_else(|| comment["side"].as_str())
    }
    .unwrap_or("RIGHT");

    let mut lines = diff_hunk.lines();
    let header = lines.find(|line| line.starts_with("@@ "))?;
    let mut header_parts = header.split_whitespace();
    if header_parts.next()? != "@@" {
        return None;
    }
    let mut old_line = diff_hunk_start(header_parts.next()?, '-')?;
    let mut new_line = diff_hunk_start(header_parts.next()?, '+')?;

    for line in lines {
        let Some(prefix) = line.chars().next() else {
            continue;
        };
        let code = &line[prefix.len_utf8()..];
        match prefix {
            ' ' => {
                if (side == "LEFT" && old_line == target_line)
                    || (side != "LEFT" && new_line == target_line)
                {
                    return Some(code.to_string());
                }
                old_line += 1;
                new_line += 1;
            }
            '-' => {
                if side == "LEFT" && old_line == target_line {
                    return Some(code.to_string());
                }
                old_line += 1;
            }
            '+' => {
                if side != "LEFT" && new_line == target_line {
                    return Some(code.to_string());
                }
                new_line += 1;
            }
            '\\' => {} // "No newline at end of file" マーカーは行番号を消費しない
            _ => return None,
        }
    }
    None
}

/// gh の一覧 JSON を PrSummary へ。**open な PR だけ**を残す（Issue タブと同じで、
/// もう手を入れない PR は一覧の邪魔になる。MERGED も CLOSED も出さない）。
/// gh 側で `--state open` を指定しているので通常はここで落ちるものは無いが、
/// 一覧の条件はこの関数が最終的な担保になる。
fn parse_pr_summaries(value: &serde_json::Value) -> Vec<PrSummary> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|pr| {
            pr["state"]
                .as_str()
                .unwrap_or("")
                .eq_ignore_ascii_case("OPEN")
        })
        .filter_map(|pr| {
            Some(PrSummary {
                number: pr["number"].as_i64()?,
                title: pr["title"].as_str().unwrap_or("").to_string(),
                state: pr["state"].as_str().unwrap_or("").to_string(),
                url: pr["url"].as_str().unwrap_or("").to_string(),
                author: pr["author"]["login"].as_str().unwrap_or("?").to_string(),
                head_ref_name: pr["headRefName"].as_str().unwrap_or("").to_string(),
                base_ref_name: pr["baseRefName"].as_str().unwrap_or("").to_string(),
                is_draft: pr["isDraft"].as_bool().unwrap_or(false),
                updated_at: pr["updatedAt"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// PR タブ用一覧。タブを開いた時と手動更新時だけ呼ばれる（3秒 poll には乗せない）。
/// 失敗しても Err にはせず available:false + error（gh の生メッセージ）で返す。
/// フロントは「PR が0件」と「取得に失敗」を区別してこの理由をそのまま表示する。
#[tauri::command]
pub(crate) async fn pr_list(root: String) -> Result<PrList, String> {
    if !PathBuf::from(&root).is_dir() {
        return Ok(PrList::failed(format!("directory not found: {root}")));
    }
    let value = gh_json(
        &root,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,state,url,author,headRefName,baseRefName,isDraft,updatedAt",
        ],
        GH_LIST_TIMEOUT_SECS,
    )
    .await;
    match value {
        Ok(value) => Ok(PrList {
            available: true,
            prs: parse_pr_summaries(&value),
            error: String::new(),
        }),
        Err(e) => Ok(PrList::failed(e)),
    }
}

/// PR ファイル一覧は gh pr view でも取れるが、追加・削除・名前変更の種別は REST 側だけが
/// 返す。patch 本文は --jq で落とし、一覧表示に必要な小さいメタデータだけを IPC に載せる。
async fn pr_file_details(root: &str, number: i64) -> Option<Vec<PrFile>> {
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{number}/files");
    let value = gh_json(
        root,
        &[
            "api",
            &endpoint,
            "-X",
            "GET",
            "-f",
            "per_page=100",
            "--jq",
            "[.[] | {path: .filename, previousPath: .previous_filename, status: .status, additions: .additions, deletions: .deletions}]",
        ],
        10,
    )
    .await
    .ok()?;
    Some(parse_pr_files(&value))
}

/// 現在ブランチの GitHub PR（conversation コメント + レビュー本文 + diff行のインラインコメント込み）
/// を gh CLI で取得する。
/// gh 不在・未認証・PR 無し・タイムアウトはすべて found:false（Err にしない）
#[tauri::command]
pub(crate) async fn pr_info(root: String, branch: String) -> Result<PrInfo, String> {
    let none = PrInfo {
        found: false,
        number: None,
        title: None,
        head_ref_name: None,
        state: None,
        url: None,
        author: None,
        body: None,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        files: vec![],
        comments: vec![],
    };
    if branch.is_empty() || branch.starts_with('-') || !PathBuf::from(&root).is_dir() {
        return Ok(none);
    }
    // gh 不在・タイムアウト・PR 無し・未認証・リモート無しはすべて found:false へ退化させる
    // （バッジは「PR が無いだけ」の方が普通なので、pr_list と違い理由は表に出さない）
    let Ok(v) = gh_json(
        &root,
        &[
            "pr",
            "view",
            &branch,
            "--json",
            "number,title,headRefName,state,url,author,body,additions,deletions,changedFiles,files,comments,reviews",
        ],
        10,
    )
    .await else {
        return Ok(none);
    };

    // REST の詳細取得に失敗しても gh pr view の files で一覧自体は表示する。
    let mut files = parse_pr_files(&v["files"]);
    let mut comments: Vec<PrComment> = Vec::new();
    if let Some(arr) = v["comments"].as_array() {
        for c in arr {
            let body = c["body"].as_str().unwrap_or("");
            if body.is_empty() {
                continue;
            }
            comments.push(PrComment {
                author: c["author"]["login"].as_str().unwrap_or("?").to_string(),
                body: pr_cap(body),
                created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
                kind: "comment".into(),
                state: None,
                path: None,
                line: None,
                code: None,
            });
        }
    }
    if let Some(arr) = v["reviews"].as_array() {
        for r in arr {
            let body = r["body"].as_str().unwrap_or("");
            let state = r["state"].as_str().unwrap_or("");
            // 本文なしの COMMENTED（インラインコメントの殻）はノイズなので出さない
            if body.is_empty() && state != "APPROVED" && state != "CHANGES_REQUESTED" {
                continue;
            }
            comments.push(PrComment {
                author: r["author"]["login"].as_str().unwrap_or("?").to_string(),
                body: pr_cap(body),
                created_at: r["submittedAt"].as_str().unwrap_or("").to_string(),
                kind: "review".into(),
                state: Some(state.to_string()),
                path: None,
                line: None,
                code: None,
            });
        }
    }
    // diff 行に付くインラインレビューコメントは comments/reviews に含まれないため別 API で取得
    // （gh pr view --json はこれを返さない）。取れなくても他のコメントは出す（失敗は握り潰す）
    if let Some(number) = v["number"].as_i64() {
        let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments");
        let comment_args = ["api", endpoint.as_str(), "-X", "GET", "-f", "per_page=100"];
        // ファイル種別の取得と行コメント取得は独立しているので並行する。
        let (inline_comments, detailed_files) = tokio::join!(
            gh_json(&root, &comment_args, 10),
            pr_file_details(&root, number),
        );
        if let Some(details) = detailed_files.filter(|x| !x.is_empty()) {
            files = details;
        }
        if let Ok(items) = inline_comments {
            for c in items.as_array().into_iter().flatten() {
                let body = c["body"].as_str().unwrap_or("");
                if body.is_empty() {
                    continue;
                }
                comments.push(PrComment {
                    author: c["user"]["login"].as_str().unwrap_or("?").to_string(),
                    body: pr_cap(body),
                    created_at: c["created_at"].as_str().unwrap_or("").to_string(),
                    kind: "inline".into(),
                    state: None,
                    path: c["path"].as_str().map(String::from),
                    // line は outdated（差分から消えた）だと null なので original_line で補う
                    line: c["line"].as_i64().or_else(|| c["original_line"].as_i64()),
                    code: pr_review_line_code(c).map(|code| pr_cap(&code)),
                });
            }
        }
    }
    // ISO8601 は辞書順 = 時系列
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    comments.truncate(PR_MAX_COMMENTS);

    Ok(PrInfo {
        found: true,
        number: v["number"].as_i64(),
        title: v["title"].as_str().map(String::from),
        head_ref_name: v["headRefName"].as_str().map(String::from),
        state: v["state"].as_str().map(String::from),
        url: v["url"].as_str().map(String::from),
        author: v["author"]["login"].as_str().map(String::from),
        body: v["body"].as_str().map(pr_cap),
        additions: v["additions"].as_i64().unwrap_or(0),
        deletions: v["deletions"].as_i64().unwrap_or(0),
        changed_files: v["changedFiles"].as_i64().unwrap_or(files.len() as i64),
        files,
        comments,
    })
}

/// PR 一覧から選んだ番号の詳細。取得内容と上限は現在ブランチ用 pr_info と共通にする。
#[tauri::command]
pub(crate) async fn pr_detail(root: String, number: i64) -> Result<PrInfo, String> {
    if number <= 0 {
        return pr_info(root, String::new()).await;
    }
    pr_info(root, number.to_string()).await
}

/// PR 全体の unified diff。コミット差分と同じフロント表示へそのまま渡せる形で返す。
#[tauri::command]
pub(crate) async fn pr_diff(root: String, number: i64) -> Result<GitCommitDiff, String> {
    if number <= 0 || !PathBuf::from(&root).is_dir() {
        return Err("bad pull request".into());
    }
    let number_s = number.to_string();
    let stdout = run_gh(
        &root,
        &["pr", "diff", &number_s, "--color", "never"],
        GH_VIEW_TIMEOUT_SECS,
    )
    .await?;
    let full_patch = String::from_utf8_lossy(&stdout).into_owned();
    let (adds, dels) = patch_line_totals(&full_patch);
    let (patch, truncated) = limited_git_patch(stdout);
    Ok(GitCommitDiff {
        patch,
        adds,
        dels,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_pr_files, parse_pr_summaries, pr_review_line_code};

    #[test]
    fn pr_files_keep_status_stats_and_previous_path() {
        let value = serde_json::json!([{
            "path": "src/new.ts",
            "previousPath": "src/old.ts",
            "status": "renamed",
            "additions": 7,
            "deletions": 3
        }]);
        let files = parse_pr_files(&value);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].previous_path.as_deref(), Some("src/old.ts"));
        assert_eq!(files[0].status, "renamed");
        assert_eq!((files[0].additions, files[0].deletions), (7, 3));
    }

    #[test]
    fn pr_review_code_finds_right_and_left_lines_in_diff_hunk() {
        let diff_hunk =
            "@@ -10,3 +20,4 @@ fn example()\n context\n-old value\n+new value\n+review this\n tail";
        let right = serde_json::json!({
            "diff_hunk": diff_hunk,
            "line": 22,
            "side": "RIGHT",
            "original_line": 12,
            "original_side": "RIGHT"
        });
        let left = serde_json::json!({
            "diff_hunk": diff_hunk,
            "line": 11,
            "side": "LEFT",
            "original_line": 11,
            "original_side": "LEFT"
        });

        assert_eq!(pr_review_line_code(&right).as_deref(), Some("review this"));
        assert_eq!(pr_review_line_code(&left).as_deref(), Some("old value"));
    }

    #[test]
    fn pr_review_code_uses_original_location_for_outdated_comment() {
        let comment = serde_json::json!({
            "diff_hunk": "@@ -4,2 +4,2 @@\n-before\n+reviewed then",
            "line": null,
            "side": null,
            "original_line": 4,
            "original_side": "RIGHT"
        });

        assert_eq!(
            pr_review_line_code(&comment).as_deref(),
            Some("reviewed then")
        );
    }

    #[test]
    fn pr_summaries_keep_branches_state_and_draft_status() {
        let value = serde_json::json!([{
            "number": 24,
            "title": "Add PR list",
            "state": "OPEN",
            "url": "https://github.com/o/r/pull/24",
            "author": { "login": "alice" },
            "headRefName": "feat/pr-list",
            "baseRefName": "main",
            "isDraft": true,
            "updatedAt": "2026-08-08T00:00:00Z"
        }]);
        let prs = parse_pr_summaries(&value);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 24);
        assert_eq!(prs[0].head_ref_name, "feat/pr-list");
        assert_eq!(prs[0].base_ref_name, "main");
        assert!(prs[0].is_draft);
    }

    #[test]
    fn pr_summaries_keep_only_open() {
        let value = serde_json::json!([
            { "number": 1, "state": "OPEN" },
            { "number": 2, "state": "CLOSED" },
            { "number": 3, "state": "MERGED" },
        ]);
        let numbers: Vec<i64> = parse_pr_summaries(&value)
            .iter()
            .map(|p| p.number)
            .collect();
        assert_eq!(numbers, vec![1]);
    }
}
