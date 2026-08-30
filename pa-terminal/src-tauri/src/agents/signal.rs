//! ペアモードの「ターン完了シグナル」。
//!
//! エージェント CLI が公式に持つ完了通知（claude の Stop フック / codex の
//! `notify` = agent-turn-complete）を使い、出力の静止からの推測ではなく
//! **エージェント自身に完了を教えさせる**。フロントは起動コマンドへ
//! `PATERM_PAIR_SIGNAL=<dir>/<token>` と設定注入
//! （claude: `--settings <dir>/claude-stop-hook.json` / codex:
//! `-c notify=["<dir>/notify.sh"]`）を前置し、フック側はそのファイルを
//! 作るだけ。ここで起動する監視スレッドがディレクトリを 500ms 周期で走査し、
//! 見つけたファイル名を `agent:turn { token }` として emit して削除する。
//!
//! - ファイル生成と走査はサブプロセスも IPC バーストも作らない（read_dir のみ）
//! - フックが効かない環境では単にシグナルが来ないだけで、フロントは
//!   手動ボタン / 静止検知へ退化する（このモジュールは fail-open）

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// claude の Stop フックを注入するための追加設定（`--settings` で渡す）。
/// ユーザー設定に追加マージされるので既存フックは壊さない
const CLAUDE_HOOK_FILE: &str = "claude-stop-hook.json";
const CLAUDE_HOOK_JSON: &str = r#"{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ": > \"${PATERM_PAIR_SIGNAL:-/dev/null}\""
          }
        ]
      }
    ]
  }
}
"#;

/// codex の `notify` に指定するプログラム。agent-turn-complete のときだけ
/// シグナルファイルを作る（$1 = codex が付ける JSON ペイロード）
const NOTIFY_SH_FILE: &str = "notify.sh";
const NOTIFY_SH: &str = r#"#!/bin/sh
# PATerminal pair mode: called by codex `notify`. Creates the per-pane signal
# file on agent-turn-complete; the app's watcher thread picks it up and deletes it.
case "$1" in
  *agent-turn-complete*) : > "${PATERM_PAIR_SIGNAL:-/dev/null}" ;;
esac
"#;

const WATCH_INTERVAL: Duration = Duration::from_millis(500);

/// シグナルディレクトリを用意し（フックファイル込み）、監視スレッドを起動して
/// ディレクトリの絶対パスを返す。フロントはこのパスで起動コマンドを組み立てる。
/// 何度呼んでもスレッドは1本だけ
#[tauri::command]
pub(crate) async fn agent_signal_init(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pair-signals");
    let dir_for_thread = dir.clone();
    tokio::task::spawn_blocking(move || write_hook_files(&dir_for_thread))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    start_watcher(app, dir.clone());
    Ok(dir.to_string_lossy().into_owned())
}

/// ディレクトリと注入用のフックファイル2つを（無ければ）作る
fn write_hook_files(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(CLAUDE_HOOK_FILE), CLAUDE_HOOK_JSON)?;
    let notify = dir.join(NOTIFY_SH_FILE);
    fs::write(&notify, NOTIFY_SH)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&notify, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// シグナルファイル（= トークン名の空ファイル）を回収して削除し、トークンを返す。
/// フックファイル自身と、トークンの形（16進 + ハイフン）に合わない名前は無視する
fn drain_signals(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut tokens = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_signal_token(name) {
            continue;
        }
        // 先に消してから通知する（emit 失敗でも二重通知にしない）
        if fs::remove_file(entry.path()).is_ok() {
            tokens.push(name.to_owned());
        }
    }
    tokens
}

/// トークンはフロントが生成する UUID（16進 + ハイフン）だけを受け付ける
fn is_signal_token(name: &str) -> bool {
    (8..=64).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn start_watcher(app: AppHandle, dir: PathBuf) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(move || {
        thread::spawn(move || loop {
            thread::sleep(WATCH_INTERVAL);
            for token in drain_signals(&dir) {
                let _ = app.emit("agent:turn", serde_json::json!({ "token": token }));
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_files_are_written_and_are_not_signals() {
        let dir = std::env::temp_dir().join(format!("pa-signal-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_hook_files(&dir).unwrap();
        assert!(dir.join(CLAUDE_HOOK_FILE).exists());
        assert!(dir.join(NOTIFY_SH_FILE).exists());
        // フックファイルはトークンとして回収されない
        assert!(drain_signals(&dir).is_empty());
        // 二重初期化しても壊れない（既存ファイルの上書きのみ）
        write_hook_files(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_hook_json_is_valid_and_targets_stop() {
        let v: serde_json::Value = serde_json::from_str(CLAUDE_HOOK_JSON).unwrap();
        assert!(v["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("PATERM_PAIR_SIGNAL"));
    }

    #[test]
    fn notify_script_filters_turn_complete() {
        assert!(NOTIFY_SH.contains("agent-turn-complete"));
        assert!(NOTIFY_SH.contains("PATERM_PAIR_SIGNAL"));
    }

    #[test]
    fn drain_picks_up_and_removes_token_files() {
        let dir = std::env::temp_dir().join(format!("pa-signal-drain-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_hook_files(&dir).unwrap();
        let token = "3f9a1b2c-0000-4000-8000-abcdefabcdef";
        fs::write(dir.join(token), b"").unwrap();
        fs::write(dir.join("not a token!"), b"").unwrap();
        let got = drain_signals(&dir);
        assert_eq!(got, vec![token.to_owned()]);
        assert!(!dir.join(token).exists());
        // 変な名前のファイルは残る（消さない）が、次の走査でも拾わない
        assert!(dir.join("not a token!").exists());
        assert!(drain_signals(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_shape_validation() {
        assert!(is_signal_token("3f9a1b2c-0000-4000-8000-abcdefabcdef"));
        assert!(is_signal_token("deadbeef"));
        assert!(!is_signal_token("short"));
        assert!(!is_signal_token(CLAUDE_HOOK_FILE));
        assert!(!is_signal_token(NOTIFY_SH_FILE));
        assert!(!is_signal_token("../escape-attempt-000"));
    }
}
