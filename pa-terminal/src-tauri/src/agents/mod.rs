//! 外部 AI エージェント CLI（claude / codex）のセッション保存ファイルから、
//! そのペインの会話を厳密に再開するためのセッション ID を解決する。
//!
//! - claude: `~/.claude/projects/<cwd の非英数字を '-' にしたディレクトリ>/<uuid>.jsonl`。
//!   ファイル名の stem がそのままセッション ID
//! - codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。先頭行の `session_meta` に
//!   `payload.cwd` と `payload.id` が入っている
//!
//! どちらも「エージェントの起動を検知した時刻（since）以後に**作成**されたファイル」
//! だけを対象にし、その中で最初に作られたものを選ぶ。mtime は追記のたびに動くため、
//! 同じリポジトリで複数ペインのエージェントが並走していても、他ペインの追記中
//! セッションを誤って掴まない（作成時刻は不変）。解決できなければ None を返し、
//! フロントは `--continue` / `resume --last` へ退化する。
//!
//! CLI の保存パス・形式は非公開実装への依存なので、少しでも形が合わなければ
//! 黙って None に退化させる（エラーにしない）。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) mod list;
pub(crate) mod signal;

/// kind（"claude" / "codex"）と cwd から、since_ms（epoch ミリ秒）以後に作成された
/// セッションのIDを返す。見つからなければ null
#[tauri::command]
pub(crate) async fn agent_session_id(
    kind: String,
    cwd: String,
    since_ms: f64,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let home = home_dir()?;
        let since = UNIX_EPOCH + Duration::from_millis(since_ms.max(0.0) as u64);
        match kind.as_str() {
            "claude" => claude_session_id(&home.join(".claude").join("projects"), &cwd, since),
            "codex" => codex_session_id(&home.join(".codex").join("sessions"), &cwd, since),
            _ => None,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

// ホームの解決は実行環境層（`env`）に一本化してある。Git Bash 由来の `HOME=/c/...` を
// 弾くのもそちらの責務。
pub(crate) use crate::env::home_dir;

/// claude の projects ディレクトリ名: cwd の ASCII 英数字以外を '-' に置き換えたもの
/// （claude 側の実装 `replace(/[^a-zA-Z0-9]/g, "-")` と同じ）
fn munge_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// セッション ID として妥当な形（uuid 系: 16進 + ハイフン）か。
/// この ID はフロントで再開コマンドの一部としてシェルへ入力されるため、
/// 形式を通ったものしか返さない
pub(crate) fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && id.chars().any(|c| c.is_ascii_hexdigit())
}

/// ファイルの作成時刻。作成時刻を持たないファイルシステムでは mtime に退化する
fn created_at(path: &Path) -> Option<SystemTime> {
    let meta = std::fs::metadata(path).ok()?;
    meta.created().or_else(|_| meta.modified()).ok()
}

fn claude_session_id(projects_dir: &Path, cwd: &str, since: SystemTime) -> Option<String> {
    let dir = projects_dir.join(munge_cwd(cwd));
    let mut best: Option<(SystemTime, String)> = None;
    for entry in std::fs::read_dir(dir).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_session_id(stem) {
            continue;
        }
        let Some(created) = created_at(&path) else { continue };
        if created < since {
            continue;
        }
        // since 以後で最初に作られた = このペインのエージェント開始直後のセッション
        if best.as_ref().map_or(true, |(t, _)| created < *t) {
            best = Some((created, stem.to_string()));
        }
    }
    best.map(|(_, id)| id)
}

/// 走査上限。日付ディレクトリを新しい順に辿るので、実際にはごく少数で足りる
const CODEX_MAX_FILES: usize = 200;
const CODEX_MAX_DAYS: usize = 7;

fn codex_session_id(sessions_dir: &Path, cwd: &str, since: SystemTime) -> Option<String> {
    // YYYY/MM/DD の3階層を新しい順に。since より前の日（ローカル時刻とのずれ分 -1日の
    // 余裕つき）は読まない
    let since_days = since
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0);
    let mut day_dirs: Vec<(i64, PathBuf)> = Vec::new();
    for year_entry in std::fs::read_dir(sessions_dir).ok()? {
        let Ok(year_entry) = year_entry else { continue };
        let Ok(year) = year_entry.file_name().to_string_lossy().parse::<i64>() else {
            continue;
        };
        let Ok(months) = std::fs::read_dir(year_entry.path()) else { continue };
        for month_entry in months {
            let Ok(month_entry) = month_entry else { continue };
            let Ok(month) = month_entry.file_name().to_string_lossy().parse::<i64>() else {
                continue;
            };
            let Ok(days) = std::fs::read_dir(month_entry.path()) else { continue };
            for day_entry in days {
                let Ok(day_entry) = day_entry else { continue };
                let Ok(day) = day_entry.file_name().to_string_lossy().parse::<i64>() else {
                    continue;
                };
                let days = days_from_civil(year, month, day);
                if days >= since_days - 1 {
                    day_dirs.push((days, day_entry.path()));
                }
            }
        }
    }
    day_dirs.sort_by_key(|(days, _)| std::cmp::Reverse(*days));
    day_dirs.truncate(CODEX_MAX_DAYS);

    let mut best: Option<(SystemTime, String)> = None;
    let mut examined = 0usize;
    for (_, dir) in day_dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            examined += 1;
            if examined > CODEX_MAX_FILES {
                return best.map(|(_, id)| id);
            }
            let Some(created) = created_at(&path) else { continue };
            if created < since {
                continue;
            }
            let Some((id, meta_cwd)) = read_codex_meta(&path) else {
                continue;
            };
            if meta_cwd != cwd || !valid_session_id(&id) {
                continue;
            }
            if best.as_ref().map_or(true, |(t, _)| created < *t) {
                best = Some((created, id));
            }
        }
    }
    best.map(|(_, id)| id)
}

/// rollout ファイル先頭行の session_meta から (id, cwd) を読む。
/// 先頭行は base_instructions を含んで長いことがあるため上限つきで読む
fn read_codex_meta(path: &Path) -> Option<(String, String)> {
    use std::io::Read;
    const MAX_META_BYTES: usize = 256 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; MAX_META_BYTES];
    let mut filled = 0usize;
    loop {
        let n = file.read(&mut buf[filled..]).ok()?;
        if n == 0 {
            break;
        }
        filled += n;
        if buf[..filled].contains(&b'\n') || filled == buf.len() {
            break;
        }
    }
    let first_line = buf[..filled].split(|&b| b == b'\n').next()?;
    parse_codex_meta(std::str::from_utf8(first_line).ok()?)
}

pub(crate) fn parse_codex_meta(line: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))
        .and_then(|v| v.as_str())?;
    let cwd = payload.get("cwd").and_then(|v| v.as_str())?;
    Some((id.to_string(), cwd.to_string()))
}

/// 年月日 → epoch からの日数（Howard Hinnant の civil_from_days の逆関数）。
/// 日付ディレクトリの新旧比較にだけ使う
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// テスト用の一時ディレクトリ（プロセス ID + 連番で衝突しない）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pa-agents-test-{}-{}-{}",
            tag,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn munges_cwd_like_claude() {
        assert_eq!(
            munge_cwd("/Users/me/git/pararellAIterm"),
            "-Users-me-git-pararellAIterm",
        );
        assert_eq!(
            munge_cwd("/Users/me/git/app/.worktree/feat_x"),
            "-Users-me-git-app--worktree-feat-x",
        );
        assert_eq!(munge_cwd("C:\\Users\\me\\proj"), "C--Users-me-proj");
        assert_eq!(munge_cwd("/Users/me/日本語 dir"), "-Users-me-----dir");
    }

    #[test]
    fn validates_session_ids() {
        assert!(valid_session_id("df816fd0-359e-4780-9a50-5807eb61af4d"));
        assert!(valid_session_id("019ff6a1-a25d-7272-b4c9-a17095fbd278"));
        assert!(!valid_session_id("abc"));
        assert!(!valid_session_id("----------"));
        assert!(!valid_session_id("df816fd0; rm -rf /"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn days_from_civil_matches_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(2026, 8, 13), 20_678);
        assert!(days_from_civil(2026, 8, 13) > days_from_civil(2026, 8, 12));
    }

    #[test]
    fn parses_codex_meta_line() {
        let line = r#"{"timestamp":"2026-08-12T15:41:30.999Z","type":"session_meta","payload":{"session_id":"019ff6a1-a25d-7272-b4c9-a17095fbd278","id":"019ff6a1-a25d-7272-b4c9-a17095fbd278","cwd":"/Users/me/git/app","originator":"codex-tui"}}"#;
        let (id, cwd) = parse_codex_meta(line).expect("meta");
        assert_eq!(id, "019ff6a1-a25d-7272-b4c9-a17095fbd278");
        assert_eq!(cwd, "/Users/me/git/app");
        assert!(parse_codex_meta(r#"{"type":"other"}"#).is_none());
        assert!(parse_codex_meta("not json").is_none());
    }

    #[test]
    fn claude_session_picks_first_created_after_since() {
        let projects = temp_dir("claude");
        let dir = projects.join(munge_cwd("/Users/me/git/app"));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str| {
            std::fs::write(dir.join(name), "{}\n").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        };
        write("11111111-1111-1111-1111-111111111111.jsonl"); // since より前（旧セッション）
        let since = SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(15));
        write("22222222-2222-2222-2222-222222222222.jsonl"); // since 以後の最初 = このペイン
        write("33333333-3333-3333-3333-333333333333.jsonl"); // 後から始まった別セッション
        std::fs::write(dir.join("not-a-session.txt"), "x").unwrap();

        let got = claude_session_id(&projects, "/Users/me/git/app", since);
        assert_eq!(got.as_deref(), Some("22222222-2222-2222-2222-222222222222"));
        // since 以後のファイルが無ければ None（--continue へ退化）
        let got = claude_session_id(&projects, "/Users/me/git/app", SystemTime::now());
        assert_eq!(got, None);
        // 対象 cwd のディレクトリが無ければ None
        let got = claude_session_id(&projects, "/nowhere", since);
        assert_eq!(got, None);
        std::fs::remove_dir_all(&projects).ok();
    }

    /// unix 日数 → (年, 月, 日)。days_from_civil の逆（Howard Hinnant の civil_from_days）
    fn civil_from_days(z: i64) -> (i64, i64, i64) {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
        (y, m, d)
    }

    #[test]
    fn codex_session_matches_cwd_from_meta() {
        let sessions = temp_dir("codex");
        // 実装は「since より前の日（-1日の余裕つき）のディレクトリを読まない」ため、
        // 日付を固定するとその日を過ぎた途端に落ちる。必ず今日（UTC）の日付で作る
        let today = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            / 86_400;
        let (y, m, d) = civil_from_days(today);
        let day = sessions
            .join(format!("{y:04}"))
            .join(format!("{m:02}"))
            .join(format!("{d:02}"));
        std::fs::create_dir_all(&day).unwrap();
        let meta = |id: &str, cwd: &str| {
            format!(
                r#"{{"timestamp":"{y:04}-{m:02}-{d:02}T00:00:00Z","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}"}}}}"#,
            ) + "\n"
        };
        let since = SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(15));
        std::fs::write(
            day.join(format!(
                "rollout-{y:04}-{m:02}-{d:02}T00-00-01-11111111-1111-7111-1111-111111111111.jsonl"
            )),
            meta("11111111-1111-7111-1111-111111111111", "/other/dir"),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        std::fs::write(
            day.join(format!(
                "rollout-{y:04}-{m:02}-{d:02}T00-00-02-22222222-2222-7222-2222-222222222222.jsonl"
            )),
            meta("22222222-2222-7222-2222-222222222222", "/Users/me/git/app"),
        )
        .unwrap();

        let got = codex_session_id(&sessions, "/Users/me/git/app", since);
        assert_eq!(got.as_deref(), Some("22222222-2222-7222-2222-222222222222"));
        // cwd が一致しなければ None
        let got = codex_session_id(&sessions, "/no/match", since);
        assert_eq!(got, None);
        std::fs::remove_dir_all(&sessions).ok();
    }
}
