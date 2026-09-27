//! 保存済みの AI エージェント会話（claude / codex）から、ユーザーが送信した
//! 入力（プロンプト）だけを時系列で取り出す。フロントの「入力履歴」ダイアログ用で、
//! セッションに記録された会話 ID（Workspace.agentHistory）をまとめて1回の IPC で渡す。
//!
//! 形式は `list.rs` / `mod.rs` と同じ非公開実装への依存なので、形の合わない行は
//! 黙って読み飛ばし、ファイルが見つからなければ `found: false` を返す（エラーにしない）。
//! 呼び出しはダイアログでセッションを選んだ時だけ。ポーリングには使わない。

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use super::{home_dir, valid_session_id};

#[derive(Deserialize, Debug, Clone)]
pub struct AgentConversationRef {
    pub kind: String,
    pub id: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrompt {
    /// 送信したテキスト（スラッシュコマンドは `/name args` に整形済み）
    pub text: String,
    /// CLI が記録した ISO 8601 の時刻。無い形式では None
    pub timestamp: Option<String>,
    /// 添付した画像の数
    pub images: u32,
    /// スラッシュコマンド（`/clear` 等）か
    pub command: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationPrompts {
    pub kind: String,
    pub id: String,
    /// 保存ファイルが見つかったか（削除済み・別マシン等なら false）
    pub found: bool,
    /// 上限で古い入力を省いた件数
    pub omitted: usize,
    pub prompts: Vec<AgentPrompt>,
}

/// 1回で受け付ける会話数（セッションあたりの記録上限と揃える）
const MAX_REFS: usize = 64;
/// 1会話あたりに返す入力の上限（超えたら新しい側を残す）
const MAX_PROMPTS: usize = 1000;
/// 1入力あたりの最大文字数（巨大な貼り付けで IPC を膨らませない）
const MAX_TEXT_CHARS: usize = 20_000;
/// 読むファイルサイズの上限
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn agent_session_prompts(
    refs: Vec<AgentConversationRef>,
) -> Result<Vec<AgentConversationPrompts>, String> {
    tokio::task::spawn_blocking(move || {
        let home = home_dir();
        refs.into_iter()
            .take(MAX_REFS)
            .map(|r| {
                let path = home.as_deref().and_then(|home| locate(home, &r));
                let parsed = path.and_then(|p| read_prompts(&p, &r.kind));
                let found = parsed.is_some();
                let mut prompts = parsed.unwrap_or_default();
                let omitted = prompts.len().saturating_sub(MAX_PROMPTS);
                prompts.drain(..omitted);
                AgentConversationPrompts { kind: r.kind, id: r.id, found, omitted, prompts }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 会話 ID から保存ファイルを探す。ID は valid_session_id を通ったものだけ
/// （16進 + ハイフンなのでパスに混ぜても階層を越えない）
fn locate(home: &Path, r: &AgentConversationRef) -> Option<PathBuf> {
    if !valid_session_id(&r.id) {
        return None;
    }
    match r.kind.as_str() {
        "claude" => claude_file(&home.join(".claude").join("projects"), &r.id),
        "codex" => codex_file(&home.join(".codex").join("sessions"), &r.id),
        _ => None,
    }
}

fn claude_file(projects_dir: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    std::fs::read_dir(projects_dir)
        .ok()?
        .flatten()
        .map(|dir| dir.path().join(&name))
        .find(|path| path.is_file())
}

/// codex は `YYYY/MM/DD/rollout-<時刻>-<id>.jsonl`。新しい日付から探す
fn codex_file(sessions_dir: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    let sorted_dirs = |dir: &Path| -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|it| it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        out.sort_by(|a, b| b.cmp(a));
        out
    };
    for year in sorted_dirs(sessions_dir) {
        for month in sorted_dirs(&year) {
            for day in sorted_dirs(&month) {
                let Ok(files) = std::fs::read_dir(&day) else { continue };
                for file in files.flatten() {
                    let name = file.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("rollout-") && name.ends_with(&suffix) {
                        return Some(file.path());
                    }
                }
            }
        }
    }
    None
}

fn read_prompts(path: &Path, kind: &str) -> Option<Vec<AgentPrompt>> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file.take(MAX_FILE_BYTES));
    let mut prompts = Vec::new();
    // codex は版によって入力の記録形が違う。同じ入力が複数の形で重複して書かれるため、
    // 形ごとに集めて優先度の高い形だけを使う（CodexShape の順）
    let mut codex: [Vec<AgentPrompt>; 3] = Default::default();
    for line in reader.split(b'\n').map_while(Result::ok) {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else {
            continue;
        };
        match kind {
            "claude" => prompts.extend(claude_prompt(&value)),
            "codex" => {
                if let Some((shape, prompt)) = codex_prompt(&value) {
                    codex[shape as usize].push(prompt);
                }
            }
            _ => {}
        }
    }
    if kind == "codex" {
        prompts = codex.into_iter().find(|list| !list.is_empty()).unwrap_or_default();
    }
    Some(prompts)
}

fn truncate(text: &str) -> String {
    let trimmed = text.trim_matches(|c: char| c == '\n' || c == '\r');
    if trimmed.chars().count() <= MAX_TEXT_CHARS {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(MAX_TEXT_CHARS).collect();
    out.push('…');
    out
}

fn timestamp_of(value: &serde_json::Value) -> Option<String> {
    value.get("timestamp").and_then(|t| t.as_str()).map(String::from)
}

/// `<tag>...</tag>` の中身
fn tag_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&close)?;
    Some(text[start..end].trim())
}

/// claude の user 行 → 入力。ツール結果・メタ行・コマンド出力は入力ではないので捨てる
fn claude_prompt(value: &serde_json::Value) -> Option<AgentPrompt> {
    if value.get("type").and_then(|t| t.as_str()) != Some("user")
        || value.get("isMeta").and_then(|m| m.as_bool()) == Some(true)
        || value.get("isCompactSummary").and_then(|m| m.as_bool()) == Some(true)
    {
        return None;
    }
    let content = value.get("message")?.get("content")?;
    let mut texts: Vec<&str> = Vec::new();
    let mut images = 0u32;
    if let Some(s) = content.as_str() {
        texts.push(s);
    } else {
        for block in content.as_array()? {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                        if !s.trim_start().starts_with("<system-reminder>") {
                            texts.push(s);
                        }
                    }
                }
                Some("image") => images += 1,
                // tool_result はエージェントの作業結果で、ユーザーの入力ではない
                Some("tool_result") => return None,
                _ => {}
            }
        }
    }
    let joined = texts.join("\n");
    let text = joined.trim();
    if text.is_empty() && images == 0 {
        return None;
    }
    if let Some(name) = tag_body(text, "command-name") {
        let args = tag_body(text, "command-args").unwrap_or("");
        let name = if name.starts_with('/') { name.to_string() } else { format!("/{name}") };
        let line = if args.is_empty() { name } else { format!("{name} {args}") };
        return Some(AgentPrompt {
            text: truncate(&line),
            timestamp: timestamp_of(value),
            images,
            command: true,
        });
    }
    if let Some(cmd) = tag_body(text, "bash-input") {
        return Some(AgentPrompt {
            text: truncate(&format!("! {cmd}")),
            timestamp: timestamp_of(value),
            images,
            command: true,
        });
    }
    if text.starts_with("<local-command-")
        || text.starts_with("<bash-std")
        || text.starts_with("Caveat:")
        || text.starts_with("[Request interrupted by user")
    {
        return None;
    }
    Some(AgentPrompt { text: truncate(text), timestamp: timestamp_of(value), images, command: false })
}

/// codex の入力の記録形（優先度順）
#[derive(Clone, Copy, Debug, PartialEq)]
enum CodexShape {
    /// `event_msg` / `user_message`（〜0.15x）
    UserMessageEvent = 0,
    /// `event_msg` / `item_completed` の `UserMessage` 項目（0.154〜）
    CompletedItem = 1,
    /// `response_item` / `message` role=user（モデルへの入力。環境情報も混ざる最後の手段）
    ResponseItem = 2,
}

/// CLI が差し込む環境情報・指示ブロック（ユーザーの入力ではない）
fn codex_injected(text: &str) -> bool {
    (text.starts_with('<') && text.ends_with('>')) || text.starts_with("# AGENTS.md instructions")
}

fn codex_entry(text: &str, images: u32, value: &serde_json::Value) -> Option<AgentPrompt> {
    let text = text.trim();
    if (text.is_empty() && images == 0) || codex_injected(text) {
        return None;
    }
    Some(AgentPrompt {
        text: truncate(text),
        timestamp: timestamp_of(value),
        images,
        command: text.starts_with('/'),
    })
}

/// content ブロック配列から (テキスト, 画像数)。テキスト種別は形ごとに違う
fn codex_blocks(blocks: &[serde_json::Value], text_type: &str) -> (String, u32) {
    let mut texts = Vec::new();
    let mut images = 0u32;
    for block in blocks {
        let ty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty == text_type {
            if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                if !codex_injected(s.trim()) {
                    texts.push(s);
                }
            }
        } else if ty.contains("image") {
            images += 1;
        }
    }
    (texts.join("\n"), images)
}

fn codex_prompt(value: &serde_json::Value) -> Option<(CodexShape, AgentPrompt)> {
    let payload = value.get("payload")?;
    let payload_type = payload.get("type").and_then(|t| t.as_str());
    match (value.get("type").and_then(|t| t.as_str())?, payload_type?) {
        ("event_msg", "user_message") => {
            let text = payload.get("message").and_then(|m| m.as_str()).unwrap_or("");
            let images = payload
                .get("images")
                .and_then(|i| i.as_array())
                .map_or(0, |a| a.len() as u32);
            Some((CodexShape::UserMessageEvent, codex_entry(text, images, value)?))
        }
        ("event_msg", "item_completed") => {
            let item = payload.get("item")?;
            if item.get("type").and_then(|t| t.as_str()) != Some("UserMessage") {
                return None;
            }
            let (text, images) = codex_blocks(item.get("content")?.as_array()?, "text");
            Some((CodexShape::CompletedItem, codex_entry(&text, images, value)?))
        }
        ("response_item", "message")
            if payload.get("role").and_then(|r| r.as_str()) == Some("user") =>
        {
            let (text, images) = codex_blocks(payload.get("content")?.as_array()?, "input_text");
            Some((CodexShape::ResponseItem, codex_entry(&text, images, value)?))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pa-agent-prompts-test-{}-{}-{}",
            tag,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn extracts_claude_user_prompts_only() {
        let plain = json(
            r#"{"type":"user","timestamp":"2026-09-27T01:02:03Z","message":{"role":"user","content":"fix the bug"}}"#,
        );
        assert_eq!(
            claude_prompt(&plain),
            Some(AgentPrompt {
                text: "fix the bug".into(),
                timestamp: Some("2026-09-27T01:02:03Z".into()),
                images: 0,
                command: false,
            })
        );
        let blocks = json(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"look"},{"type":"image","source":{}},{"type":"text","text":"<system-reminder>x</system-reminder>"}]}}"#,
        );
        let got = claude_prompt(&blocks).unwrap();
        assert_eq!(got.text, "look");
        assert_eq!(got.images, 1);

        for skipped in [
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"user","isCompactSummary":true,"message":{"content":"summary"}}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>done</local-command-stdout>"}}"#,
            r#"{"type":"user","message":{"content":"Caveat: the messages below"}}"#,
            r#"{"type":"user","message":{"content":"[Request interrupted by user]"}}"#,
            r#"{"type":"assistant","message":{"content":"hi"}}"#,
        ] {
            assert_eq!(claude_prompt(&json(skipped)), None, "{skipped}");
        }
    }

    #[test]
    fn formats_claude_commands() {
        let cmd = json(
            r#"{"type":"user","message":{"content":"<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>"}}"#,
        );
        let got = claude_prompt(&cmd).unwrap();
        assert_eq!(got.text, "/model opus");
        assert!(got.command);
        let bash = json(r#"{"type":"user","message":{"content":"<bash-input>ls -la</bash-input>"}}"#);
        assert_eq!(claude_prompt(&bash).unwrap().text, "! ls -la");
    }

    #[test]
    fn extracts_codex_user_messages() {
        let msg = json(
            r#"{"timestamp":"2026-09-27T01:02:03Z","type":"event_msg","payload":{"type":"user_message","message":"add tests","images":["a"]}}"#,
        );
        let (shape, got) = codex_prompt(&msg).unwrap();
        assert_eq!(shape, CodexShape::UserMessageEvent);
        assert_eq!(got.text, "add tests");
        assert_eq!(got.images, 1);
        assert_eq!(got.timestamp.as_deref(), Some("2026-09-27T01:02:03Z"));
        let env = json(
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"<environment_context>x</environment_context>"}}"#,
        );
        assert_eq!(codex_prompt(&env), None);

        let item = json(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"fix CI"},{"type":"local_image","path":"/a.png"}]}}}"#,
        );
        let (shape, got) = codex_prompt(&item).unwrap();
        assert_eq!(shape, CodexShape::CompletedItem);
        assert_eq!((got.text.as_str(), got.images), ("fix CI", 1));
        let other = json(r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[]}}}"#);
        assert_eq!(codex_prompt(&other), None);

        let response = json(
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /x"},{"type":"input_text","text":"<environment_context>x</environment_context>"},{"type":"input_text","text":"do it"}]}}"##,
        );
        let (shape, got) = codex_prompt(&response).unwrap();
        assert_eq!(shape, CodexShape::ResponseItem);
        assert_eq!(got.text, "do it");
    }

    #[test]
    fn codex_uses_the_best_recorded_shape_only() {
        let dir = temp_dir("codex-shapes");
        let path = dir.join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"hello"}]}}}"#,
                "\n",
            ),
        )
        .unwrap();
        let got = read_prompts(&path, "codex").unwrap();
        assert_eq!(got.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["hello"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncates_long_text() {
        let long = "x".repeat(MAX_TEXT_CHARS + 10);
        let got = truncate(&long);
        assert_eq!(got.chars().count(), MAX_TEXT_CHARS + 1);
        assert!(got.ends_with('…'));
    }

    #[test]
    fn locates_and_reads_files() {
        let home = temp_dir("home");
        let claude_id = "11111111-1111-4111-8111-111111111111";
        let project = home.join(".claude").join("projects").join("-Users-me-app");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{claude_id}.jsonl")),
            concat!(
                r#"{"type":"user","message":{"content":"first"}}"#,
                "\nnot json\n",
                r#"{"type":"assistant","message":{"content":"answer"}}"#,
                "\n",
                r#"{"type":"user","message":{"content":"second"}}"#,
                "\n",
            ),
        )
        .unwrap();
        let codex_id = "22222222-2222-7222-8222-222222222222";
        let day = home.join(".codex").join("sessions").join("2026").join("09").join("27");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-09-27T00-00-00-{codex_id}.jsonl")),
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"codex task"}}"#,
        )
        .unwrap();

        let claude_ref = AgentConversationRef { kind: "claude".into(), id: claude_id.into() };
        let path = locate(&home, &claude_ref).expect("claude file");
        let prompts = read_prompts(&path, "claude").unwrap();
        assert_eq!(
            prompts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
        let codex_ref = AgentConversationRef { kind: "codex".into(), id: codex_id.into() };
        let path = locate(&home, &codex_ref).expect("codex file");
        assert_eq!(read_prompts(&path, "codex").unwrap()[0].text, "codex task");

        // 不正な ID・未知の種別・存在しない会話は None
        let bad = AgentConversationRef { kind: "claude".into(), id: "../../etc".into() };
        assert!(locate(&home, &bad).is_none());
        let unknown = AgentConversationRef { kind: "other".into(), id: claude_id.into() };
        assert!(locate(&home, &unknown).is_none());
        let missing = AgentConversationRef {
            kind: "codex".into(),
            id: "33333333-3333-7333-8333-333333333333".into(),
        };
        assert!(locate(&home, &missing).is_none());
        std::fs::remove_dir_all(&home).ok();
    }
}
