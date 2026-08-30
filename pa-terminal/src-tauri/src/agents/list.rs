//! 保存済みの AI エージェント会話（claude / codex）を一覧する。
//! フロントの「会話を引き継ぐ」ピッカー用で、別のターミナル・別のセッション・
//! 過去の起動で行われた会話を新しいセッションとして再開する入口になる。
//!
//! 形式は `agent_session_id`（mod.rs）と同じ非公開実装への依存なので、
//! 少しでも形が合わない行・ファイルは黙って読み飛ばす（エラーにしない）。
//! 走査は明示操作（モーダルを開いた時）だけで呼ばれる前提。ポーリングには使わない。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::{home_dir, parse_codex_meta, valid_session_id};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionEntry {
    /// "claude" / "codex"（フロントの RESUME_COMMANDS と対）
    pub kind: String,
    /// 再開コマンドに載せるセッション ID（valid_session_id を通ったものだけ）
    pub id: String,
    /// 会話が行われたディレクトリ。新規セッションの cwd になる
    pub cwd: String,
    /// 最初のユーザーメッセージ（または CLI 側が付けた要約）の抜粋
    pub summary: Option<String>,
    /// 保存ファイルの最終更新（epoch ミリ秒）。新しい順の並びに使う
    pub updated_ms: f64,
}

/// 1 種類あたりの最大件数。ピッカーは「最近の会話」が対象で全履歴の検索ではない
const MAX_PER_KIND: usize = 20;
/// 要約と cwd を探すために読むファイル先頭の上限
const HEAD_BYTES: usize = 256 * 1024;
/// 要約の最大文字数（超過分は … に畳む）
const SUMMARY_MAX_CHARS: usize = 120;
/// codex の日付ディレクトリを新しい順に辿る上限
const LIST_MAX_DAYS: usize = 30;
/// codex のファイル走査上限（日付上限とは独立の保険）
const LIST_MAX_FILES: usize = 400;

/// 保存済み会話を新しい順で返す。ホームが取れない・ディレクトリが無い等は空配列
#[tauri::command]
pub(crate) async fn agent_session_list() -> Result<Vec<AgentSessionEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let Some(home) = home_dir() else {
            return Vec::new();
        };
        let mut entries = claude_sessions(&home.join(".claude").join("projects"));
        entries.extend(codex_sessions(&home.join(".codex").join("sessions")));
        entries.sort_by(|a, b| {
            b.updated_ms
                .partial_cmp(&a.updated_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        entries
    })
    .await
    .map_err(|e| e.to_string())
}

fn modified_ms(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64)
}

/// ファイル先頭を上限つきで読む（最後の不完全な行ごと返し、パース側で捨てる）
fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD_BYTES];
    let mut filled = 0usize;
    loop {
        let n = file.read(&mut buf[filled..]).ok()?;
        if n == 0 {
            break;
        }
        filled += n;
        if filled == buf.len() {
            break;
        }
    }
    buf.truncate(filled);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 要約として出せる形へ整える。CLI 内部のタグ行（`<command-name>` 等）や
/// 注意書きは要約にしない（None を返して次の候補行に進ませる）
fn clean_summary(text: &str) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() || joined.starts_with('<') || joined.starts_with("Caveat:") {
        return None;
    }
    let mut out: String = joined.chars().take(SUMMARY_MAX_CHARS).collect();
    if joined.chars().count() > SUMMARY_MAX_CHARS {
        out.push('…');
    }
    Some(out)
}

/// claude の message からユーザー入力テキストを取り出す。
/// content は文字列またはブロック配列（{type:"text", text} を拾う）
fn claude_user_text(message: Option<&serde_json::Value>) -> Option<String> {
    let content = message?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    for block in content.as_array()? {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// claude の jsonl 先頭から (cwd, 要約) を拾う。cwd は各メッセージ行に入っている。
/// 要約は CLI が書いた summary 行を優先し、無ければ最初のユーザーメッセージ
fn parse_claude_head(head: &str) -> (Option<String>, Option<String>) {
    let mut cwd = None;
    let mut summary = None;
    for line in head.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            if let Some(c) = value.get("cwd").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if summary.is_none() {
            match value.get("type").and_then(|t| t.as_str()) {
                Some("summary") => {
                    if let Some(s) = value.get("summary").and_then(|s| s.as_str()) {
                        summary = clean_summary(s);
                    }
                }
                Some("user") => {
                    if value.get("isMeta").and_then(|m| m.as_bool()) != Some(true) {
                        if let Some(text) = claude_user_text(value.get("message")) {
                            summary = clean_summary(&text);
                        }
                    }
                }
                _ => {}
            }
        }
        if cwd.is_some() && summary.is_some() {
            break;
        }
    }
    (cwd, summary)
}

fn claude_sessions(projects_dir: &Path) -> Vec<AgentSessionEntry> {
    // まず候補ファイルを (mtime, path, id) で集め、新しい順に必要なぶんだけ中身を読む
    let mut candidates: Vec<(f64, PathBuf, String)> = Vec::new();
    let Ok(dirs) = std::fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    for dir in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            if !valid_session_id(&stem) {
                continue;
            }
            let Some(ms) = modified_ms(&path) else {
                continue;
            };
            candidates.push((ms, path, stem));
        }
    }
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut entries = Vec::new();
    for (updated_ms, path, id) in candidates {
        if entries.len() >= MAX_PER_KIND {
            break;
        }
        let Some(head) = read_head(&path) else {
            continue;
        };
        let (cwd, summary) = parse_claude_head(&head);
        // cwd が読めないファイル（形式違い・空ファイル）は再開先を決められないので出さない
        let Some(cwd) = cwd else { continue };
        entries.push(AgentSessionEntry {
            kind: "claude".into(),
            id,
            cwd,
            summary,
            updated_ms,
        });
    }
    entries
}

/// codex の jsonl 先頭から最初のユーザーメッセージを拾う。
/// event_msg(user_message) と response_item(message/user) の両方の形を見る
fn parse_codex_summary(head: &str) -> Option<String> {
    for line in head.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("event_msg") => {
                if payload.get("type").and_then(|t| t.as_str()) == Some("user_message") {
                    if let Some(s) = payload.get("message").and_then(|m| m.as_str()) {
                        if let Some(summary) = clean_summary(s) {
                            return Some(summary);
                        }
                    }
                }
            }
            Some("response_item") => {
                if payload.get("type").and_then(|t| t.as_str()) == Some("message")
                    && payload.get("role").and_then(|r| r.as_str()) == Some("user")
                {
                    if let Some(blocks) = payload.get("content").and_then(|c| c.as_array()) {
                        for block in blocks {
                            if block.get("type").and_then(|t| t.as_str()) == Some("input_text") {
                                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                                    if let Some(summary) = clean_summary(s) {
                                        return Some(summary);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn codex_sessions(sessions_dir: &Path) -> Vec<AgentSessionEntry> {
    // YYYY/MM/DD を新しい順に辿る（mod.rs の codex_session_id と同じ構造）
    let mut day_dirs: Vec<(i64, i64, i64, PathBuf)> = Vec::new();
    let Ok(years) = std::fs::read_dir(sessions_dir) else {
        return Vec::new();
    };
    for year_entry in years.flatten() {
        let Ok(year) = year_entry.file_name().to_string_lossy().parse::<i64>() else {
            continue;
        };
        let Ok(months) = std::fs::read_dir(year_entry.path()) else {
            continue;
        };
        for month_entry in months.flatten() {
            let Ok(month) = month_entry.file_name().to_string_lossy().parse::<i64>() else {
                continue;
            };
            let Ok(days) = std::fs::read_dir(month_entry.path()) else {
                continue;
            };
            for day_entry in days.flatten() {
                let Ok(day) = day_entry.file_name().to_string_lossy().parse::<i64>() else {
                    continue;
                };
                day_dirs.push((year, month, day, day_entry.path()));
            }
        }
    }
    day_dirs.sort_by_key(|(y, m, d, _)| std::cmp::Reverse((*y, *m, *d)));
    day_dirs.truncate(LIST_MAX_DAYS);

    let mut candidates: Vec<(f64, PathBuf)> = Vec::new();
    for (_, _, _, dir) in day_dirs {
        let Ok(files) = std::fs::read_dir(dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let name = file.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let Some(ms) = modified_ms(&path) else {
                continue;
            };
            candidates.push((ms, path));
            if candidates.len() >= LIST_MAX_FILES {
                break;
            }
        }
        if candidates.len() >= LIST_MAX_FILES {
            break;
        }
    }
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut entries = Vec::new();
    for (updated_ms, path) in candidates {
        if entries.len() >= MAX_PER_KIND {
            break;
        }
        let Some(head) = read_head(&path) else {
            continue;
        };
        // 先頭行の session_meta で id / cwd が決まる。無い・不正なら読み飛ばす
        let Some((id, cwd)) = head.lines().next().and_then(parse_codex_meta) else {
            continue;
        };
        if !valid_session_id(&id) || cwd.is_empty() {
            continue;
        }
        entries.push(AgentSessionEntry {
            kind: "codex".into(),
            id,
            cwd,
            summary: parse_codex_summary(&head),
            updated_ms,
        });
    }
    entries
}

/// SystemTime を「今より少し前」にずらしてファイルの mtime に使う（テスト用）
#[cfg(test)]
fn set_mtime(path: &Path, when: std::time::SystemTime) {
    let file = std::fs::File::options().append(true).open(path).expect("open");
    file.set_modified(when).expect("set mtime");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, SystemTime};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pa-agent-list-test-{}-{}-{}",
            tag,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn claude_line(cwd: &str, text: &str) -> String {
        format!(
            r#"{{"cwd":"{cwd}","type":"user","message":{{"role":"user","content":"{text}"}}}}"#,
        ) + "\n"
    }

    #[test]
    fn cleans_summaries() {
        assert_eq!(clean_summary("  hello \n world "), Some("hello world".into()));
        assert_eq!(clean_summary(""), None);
        assert_eq!(clean_summary("<command-name>/clear</command-name>"), None);
        assert_eq!(clean_summary("Caveat: the messages below..."), None);
        let long = "x".repeat(200);
        let cleaned = clean_summary(&long).unwrap();
        assert_eq!(cleaned.chars().count(), SUMMARY_MAX_CHARS + 1); // +1 = 末尾の …
        assert!(cleaned.ends_with('…'));
    }

    #[test]
    fn parses_claude_head_with_summary_line() {
        let head = concat!(
            r#"{"type":"summary","summary":"Fix the login bug"}"#,
            "\n",
            r#"{"cwd":"/Users/me/app","type":"user","message":{"role":"user","content":"hello"}}"#,
            "\n",
        );
        let (cwd, summary) = parse_claude_head(head);
        assert_eq!(cwd.as_deref(), Some("/Users/me/app"));
        assert_eq!(summary.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parses_claude_head_from_first_user_message() {
        let head = concat!(
            r#"{"cwd":"/Users/me/app","type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}"#,
            "\n",
            r#"{"cwd":"/Users/me/app","type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            "\n",
            r#"{"cwd":"/Users/me/app","type":"user","message":{"role":"user","content":[{"type":"text","text":"real question"}]}}"#,
            "\n",
        );
        let (cwd, summary) = parse_claude_head(head);
        assert_eq!(cwd.as_deref(), Some("/Users/me/app"));
        assert_eq!(summary.as_deref(), Some("real question"));
    }

    #[test]
    fn parses_codex_summaries() {
        let head = concat!(
            r#"{"type":"session_meta","payload":{"id":"11111111-1111-7111-1111-111111111111","cwd":"/a"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"<environment_context>x</environment_context>"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do the thing"}]}}"#,
            "\n",
        );
        assert_eq!(parse_codex_summary(head).as_deref(), Some("do the thing"));
        assert_eq!(parse_codex_summary("not json\n"), None);
    }

    #[test]
    fn lists_claude_sessions_newest_first_and_skips_invalid() {
        let projects = temp_dir("claude-list");
        let dir = projects.join("-Users-me-app");
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        std::fs::write(&old, claude_line("/Users/me/app", "old question")).unwrap();
        set_mtime(&old, SystemTime::now() - Duration::from_secs(3600));
        let new = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&new, claude_line("/Users/me/app", "new question")).unwrap();
        // ID の形式でないファイル名・cwd が読めないファイルは出さない
        std::fs::write(dir.join("not-a-session.jsonl"), "{}\n").unwrap();
        std::fs::write(
            dir.join("33333333-3333-4333-8333-333333333333.jsonl"),
            "{\"type\":\"other\"}\n",
        )
        .unwrap();

        let got = claude_sessions(&projects);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, "22222222-2222-4222-8222-222222222222");
        assert_eq!(got[0].cwd, "/Users/me/app");
        assert_eq!(got[0].summary.as_deref(), Some("new question"));
        assert_eq!(got[1].summary.as_deref(), Some("old question"));
        assert!(got[0].updated_ms >= got[1].updated_ms);
        std::fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn lists_codex_sessions_from_meta() {
        let sessions = temp_dir("codex-list");
        let day = sessions.join("2026").join("08").join("13");
        std::fs::create_dir_all(&day).unwrap();
        let meta = |id: &str, cwd: &str| {
            format!(r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}"}}}}"#) + "\n"
        };
        std::fs::write(
            day.join("rollout-2026-08-13T00-00-01-aaaa.jsonl"),
            meta("44444444-4444-7444-8444-444444444444", "/Users/me/app")
                + r#"{"type":"event_msg","payload":{"type":"user_message","message":"codex task"}}"#
                + "\n",
        )
        .unwrap();
        // 不正 ID・空 cwd は出さない
        std::fs::write(day.join("rollout-2026-08-13T00-00-02-bbbb.jsonl"), meta("bad; id", "/x"))
            .unwrap();
        std::fs::write(day.join("not-a-rollout.jsonl"), "{}\n").unwrap();

        let got = codex_sessions(&sessions);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "codex");
        assert_eq!(got[0].id, "44444444-4444-7444-8444-444444444444");
        assert_eq!(got[0].cwd, "/Users/me/app");
        assert_eq!(got[0].summary.as_deref(), Some("codex task"));
        std::fs::remove_dir_all(&sessions).ok();
    }

    #[test]
    fn missing_directories_return_empty() {
        assert!(claude_sessions(Path::new("/nowhere-at-all")).is_empty());
        assert!(codex_sessions(Path::new("/nowhere-at-all")).is_empty());
    }
}
