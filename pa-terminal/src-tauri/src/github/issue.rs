//! GitHub Issue（Issue タブの一覧・作成・詳細と、既存ブランチの linked branch 化）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::gh::{gh_json, gh_json_program, gh_program, run_gh_program, GH_VIEW_TIMEOUT_SECS};
use crate::git::{git_output_text, git_remotes, run_git};

const ISSUE_ATTACHMENT_RELEASE_TAG: &str = "paterminal-issue-attachments-v1";
const ISSUE_ATTACHMENT_RELEASE_NAME: &str = "PATerminal Issue Attachments";
const ISSUE_ATTACHMENT_RELEASE_MARKER: &str =
    "Managed by PATerminal. Files linked from issues are stored in this release.";
const MAX_ISSUE_ATTACHMENTS: usize = 10;
const MAX_ISSUE_TITLE_CHARS: usize = 256;
const MAX_ISSUE_BODY_CHARS: usize = 65_536;
const GH_MUTATION_TIMEOUT_SECS: u64 = 60;
const GH_UPLOAD_TIMEOUT_SECS: u64 = 120;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueCreated {
    number: i64,
    url: String,
}

struct AttachmentTempDir(PathBuf);

impl Drop for AttachmentTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct StagedAttachment {
    original_name: String,
    asset_name: String,
    path: PathBuf,
    image: bool,
}

fn sanitize_attachment_name(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len().min(120));
    let mut last_was_separator = false;
    for c in name.chars() {
        if cleaned.len() >= 120 {
            break;
        }
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            cleaned.push(c);
            last_was_separator = false;
        } else if !last_was_separator {
            cleaned.push('_');
            last_was_separator = true;
        }
    }
    let cleaned = cleaned.trim_matches(['.', '_']);
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned.into()
    }
}

fn is_inline_image(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|x| x.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "avif"
    )
}

async fn stage_attachments(
    paths: Vec<String>,
    nonce: u128,
) -> Result<(AttachmentTempDir, Vec<StagedAttachment>), String> {
    if paths.len() > MAX_ISSUE_ATTACHMENTS {
        return Err(format!(
            "at most {MAX_ISSUE_ATTACHMENTS} attachments can be added to one issue"
        ));
    }
    let directory =
        std::env::temp_dir().join(format!("paterminal-issue-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory)
        .map_err(|e| format!("could not prepare issue attachments: {e}"))?;
    let temp = AttachmentTempDir(directory);
    let mut seen = HashSet::new();
    let mut staged = Vec::with_capacity(paths.len());
    for (index, input) in paths.into_iter().enumerate() {
        let canonical = std::fs::canonicalize(&input)
            .map_err(|e| format!("could not read attachment {input}: {e}"))?;
        if !seen.insert(canonical.clone()) {
            return Err(format!("attachment was selected more than once: {input}"));
        }
        let metadata = tokio::fs::metadata(&canonical)
            .await
            .map_err(|e| format!("could not read attachment {input}: {e}"))?;
        if !metadata.is_file() {
            return Err(format!("attachment is not a file: {input}"));
        }
        let original_name = canonical
            .file_name()
            .and_then(|x| x.to_str())
            .filter(|x| !x.is_empty())
            .ok_or_else(|| format!("attachment has no usable file name: {input}"))?
            .to_string();
        let asset_name = format!(
            "issue-{nonce}-{:02}-{}",
            index + 1,
            sanitize_attachment_name(&original_name)
        );
        let destination = temp.0.join(&asset_name);
        tokio::fs::copy(&canonical, &destination)
            .await
            .map_err(|e| format!("could not prepare attachment {original_name}: {e}"))?;
        staged.push(StagedAttachment {
            original_name,
            asset_name,
            path: destination,
            image: is_inline_image(&canonical),
        });
    }
    Ok((temp, staged))
}

fn release_is_missing(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("release not found") || lower.contains("no release found")
}

async fn ensure_attachment_release(program: &str, root: &str) -> Result<(), String> {
    match gh_json_program(
        program,
        root,
        &[
            "release",
            "view",
            ISSUE_ATTACHMENT_RELEASE_TAG,
            "--json",
            "name,body",
        ],
        GH_VIEW_TIMEOUT_SECS,
    )
    .await
    {
        Ok(value) => {
            let name = value["name"].as_str().unwrap_or("");
            let body = value["body"].as_str().unwrap_or("");
            if name != ISSUE_ATTACHMENT_RELEASE_NAME
                || !body.contains(ISSUE_ATTACHMENT_RELEASE_MARKER)
            {
                return Err(format!(
                    "release tag {ISSUE_ATTACHMENT_RELEASE_TAG} is already used by another release"
                ));
            }
            Ok(())
        }
        Err(error) if release_is_missing(&error) => {
            run_gh_program(
                program,
                root,
                &[
                    "release",
                    "create",
                    ISSUE_ATTACHMENT_RELEASE_TAG,
                    "--title",
                    ISSUE_ATTACHMENT_RELEASE_NAME,
                    "--notes",
                    ISSUE_ATTACHMENT_RELEASE_MARKER,
                    "--prerelease",
                    "--latest=false",
                ],
                GH_MUTATION_TIMEOUT_SECS,
            )
            .await?;
            Ok(())
        }
        Err(error) => Err(format!("could not inspect the attachment release: {error}")),
    }
}

async fn cleanup_uploaded_assets(program: &str, root: &str, names: &[String]) {
    for name in names {
        let _ = run_gh_program(
            program,
            root,
            &[
                "release",
                "delete-asset",
                ISSUE_ATTACHMENT_RELEASE_TAG,
                name,
                "--yes",
            ],
            GH_MUTATION_TIMEOUT_SECS,
        )
        .await;
    }
}

async fn upload_attachments(
    program: &str,
    root: &str,
    attachments: &[StagedAttachment],
) -> Result<(Vec<(String, String, bool)>, Vec<String>), String> {
    if attachments.is_empty() {
        return Ok((vec![], vec![]));
    }
    ensure_attachment_release(program, root).await?;
    let mut uploaded = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let path = attachment.path.to_string_lossy().into_owned();
        if let Err(error) = run_gh_program(
            program,
            root,
            &["release", "upload", ISSUE_ATTACHMENT_RELEASE_TAG, &path],
            GH_UPLOAD_TIMEOUT_SECS,
        )
        .await
        {
            cleanup_uploaded_assets(program, root, &uploaded).await;
            return Err(format!(
                "could not upload attachment {}: {error}",
                attachment.original_name
            ));
        }
        uploaded.push(attachment.asset_name.clone());
    }

    let value = match gh_json_program(
        program,
        root,
        &[
            "release",
            "view",
            ISSUE_ATTACHMENT_RELEASE_TAG,
            "--json",
            "assets",
        ],
        GH_VIEW_TIMEOUT_SECS,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            cleanup_uploaded_assets(program, root, &uploaded).await;
            return Err(format!("could not resolve attachment links: {error}"));
        }
    };
    let assets = value["assets"].as_array().cloned().unwrap_or_default();
    let mut links = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let url = assets
            .iter()
            .find(|asset| asset["name"].as_str() == Some(&attachment.asset_name))
            .and_then(|asset| asset["url"].as_str())
            .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
            .ok_or_else(|| {
                format!(
                    "GitHub did not return a link for attachment {}",
                    attachment.original_name
                )
            });
        let url = match url {
            Ok(url) => url,
            Err(error) => {
                cleanup_uploaded_assets(program, root, &uploaded).await;
                return Err(error);
            }
        };
        links.push((
            attachment.original_name.clone(),
            url.to_string(),
            attachment.image,
        ));
    }
    Ok((links, uploaded))
}

fn markdown_label(name: &str) -> String {
    name.replace('\\', "\\\\").replace(']', "\\]")
}

fn append_attachment_links(body: &str, links: &[(String, String, bool)]) -> String {
    if links.is_empty() {
        return body.to_string();
    }
    let mut result = body.trim_end().to_string();
    if !result.is_empty() {
        result.push_str("\n\n");
    }
    result.push_str("## Attachments\n\n");
    for (name, url, image) in links {
        let label = markdown_label(name);
        if *image {
            result.push_str(&format!("![{label}]({url})\n\n"));
        } else {
            result.push_str(&format!("- [{label}]({url})\n"));
        }
    }
    result
}

fn parse_issue_created(stdout: &[u8]) -> IssueCreated {
    let text = String::from_utf8_lossy(stdout);
    let url = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    IssueCreated { number, url }
}

async fn issue_create_with_program(
    program: &str,
    root: String,
    title: String,
    body: String,
    attachment_paths: Vec<String>,
    nonce: u128,
) -> Result<IssueCreated, String> {
    if !PathBuf::from(&root).is_dir() {
        return Err("repository directory does not exist".into());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("issue title is required".into());
    }
    if title.chars().count() > MAX_ISSUE_TITLE_CHARS {
        return Err(format!(
            "issue title must be at most {MAX_ISSUE_TITLE_CHARS} characters"
        ));
    }
    if body.chars().count() > MAX_ISSUE_BODY_CHARS {
        return Err(format!(
            "issue body must be at most {MAX_ISSUE_BODY_CHARS} characters"
        ));
    }

    let (temp, staged) = stage_attachments(attachment_paths, nonce).await?;
    let (links, uploaded) = upload_attachments(program, &root, &staged).await?;
    let body = append_attachment_links(&body, &links);
    if body.chars().count() > MAX_ISSUE_BODY_CHARS {
        cleanup_uploaded_assets(program, &root, &uploaded).await;
        return Err(format!(
            "issue body and attachment links exceed {MAX_ISSUE_BODY_CHARS} characters"
        ));
    }
    let body_path = temp.0.join("issue-body.md");
    tokio::fs::write(&body_path, body.as_bytes())
        .await
        .map_err(|e| format!("could not prepare the issue body: {e}"))?;
    let body_path = body_path.to_string_lossy().into_owned();
    let created = run_gh_program(
        program,
        &root,
        &[
            "issue",
            "create",
            "--title",
            title,
            "--body-file",
            &body_path,
        ],
        GH_MUTATION_TIMEOUT_SECS,
    )
    .await;
    match created {
        Ok(stdout) => Ok(parse_issue_created(&stdout)),
        Err(error) => {
            cleanup_uploaded_assets(program, &root, &uploaded).await;
            Err(error)
        }
    }
}

/// Issue 作成。添付は gh にネイティブ API が無いため、PATerminal 管理用の prerelease へ
/// release asset として保存し、生成した GitHub URL を本文末尾へ追記する。
#[tauri::command]
pub(crate) async fn issue_create(
    root: String,
    title: String,
    body: String,
    attachment_paths: Vec<String>,
) -> Result<IssueCreated, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {e}"))?
        .as_millis();
    let gh = gh_program();
    issue_create_with_program(&gh, root, title, body, attachment_paths, nonce).await
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
    use super::{
        append_attachment_links, issue_create_with_program, issue_link_branch_with_program,
        parse_issue_created, sanitize_attachment_name,
    };
    use crate::testutil::{gh_stub, test_git, TempRepo};
    use std::fs;

    #[test]
    fn attachment_names_and_markdown_are_safe() {
        assert_eq!(sanitize_attachment_name("画面 shot].png"), "shot_.png");
        assert_eq!(sanitize_attachment_name("..."), "attachment");
        let body = append_attachment_links(
            "Details\n\n",
            &[
                (
                    "screen].png".into(),
                    "https://github.com/o/r/releases/download/assets/screen.png".into(),
                    true,
                ),
                (
                    "trace.log".into(),
                    "https://github.com/o/r/releases/download/assets/trace.log".into(),
                    false,
                ),
            ],
        );
        assert!(body.starts_with("Details\n\n## Attachments\n\n"));
        assert!(body.contains(
            "![screen\\].png](https://github.com/o/r/releases/download/assets/screen.png)"
        ));
        assert!(body
            .contains("- [trace.log](https://github.com/o/r/releases/download/assets/trace.log)"));
    }

    #[test]
    fn parses_created_issue_url_without_treating_output_as_shell_text() {
        let created = parse_issue_created(
            b"Creating issue in acme/app\nhttps://github.example/acme/app/issues/73\n",
        );
        assert_eq!(created.number, 73);
        assert_eq!(created.url, "https://github.example/acme/app/issues/73");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn issue_create_uploads_files_and_links_them_from_the_body() {
        use std::os::unix::fs::PermissionsExt;

        let repo = TempRepo::new();
        let tools = TempRepo::new();
        let attachment = repo.0.join("screen shot].png");
        fs::write(&attachment, b"not-a-real-png").unwrap();
        let command_log = tools.0.join("commands.log");
        let body_log = tools.0.join("body.md");
        let gh = tools.0.join("gh");
        let script = format!(
            r#"#!/bin/sh
printf '<%s>\n' "$@" >> '{}'
if [ "$1" = release ] && [ "$2" = view ]; then
  if [ "$5" = name,body ]; then
    printf '%s\n' '{{"name":"PATerminal Issue Attachments","body":"Managed by PATerminal. Files linked from issues are stored in this release."}}'
  else
    printf '%s\n' '{{"assets":[{{"name":"issue-42-01-screen_shot_.png","url":"https://github.com/acme/app/releases/download/assets/screen.png"}}]}}'
  fi
  exit 0
fi
if [ "$1" = release ] && [ "$2" = upload ]; then
  exit 0
fi
if [ "$1" = issue ] && [ "$2" = create ]; then
  cp "$6" '{}'
  printf '%s\n' 'https://github.com/acme/app/issues/73'
  exit 0
fi
exit 1
"#,
            command_log.display(),
            body_log.display(),
        );
        fs::write(&gh, script).unwrap();
        let mut permissions = fs::metadata(&gh).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&gh, permissions).unwrap();

        let created = issue_create_with_program(
            &gh.to_string_lossy(),
            repo.0.to_string_lossy().into_owned(),
            "  UI is broken  ".into(),
            "Steps to reproduce".into(),
            vec![attachment.to_string_lossy().into_owned()],
            42,
        )
        .await
        .unwrap();

        assert_eq!(created.number, 73);
        let commands = fs::read_to_string(command_log).unwrap();
        assert!(commands.contains("<release>\n<upload>"), "{commands}");
        assert!(
            commands.contains("issue-42-01-screen_shot_.png"),
            "{commands}"
        );
        assert!(commands.contains("<issue>\n<create>"), "{commands}");
        let body = fs::read_to_string(body_log).unwrap();
        assert!(body.starts_with("Steps to reproduce\n\n## Attachments"));
        assert!(body.contains("![screen shot\\].png]"), "{body}");
        assert!(body.contains("https://github.com/acme/app/releases/download/assets/screen.png"));
        assert!(!body.contains(&attachment.to_string_lossy().to_string()));
    }

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
