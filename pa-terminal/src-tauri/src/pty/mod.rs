//! PTY。1ペイン = 1 PTY + 1子プロセスで、その状態と Tauri コマンドをここに置く。
//!
//! - `stream` … 読み出し / 送出スレッド・コアレス・`pty:act` / `pty:bell` / `pty:mode` /
//!   `pty:exit` の emit
//! - `bell`   … 本物の BEL の検出（OSC 等の終端 BEL を除外）
//! - `paste`  … bracketed paste (DECSET/DECRST 2004) の追跡（ペアモードの貼り付け判定用）
//! - `prompt` … 静止時の「入力待ち」判定（ANSI 除去 + 末尾テキスト）
//! - `cwd`    … シェルプロセスの実 cwd を OS から読む（macOS / Linux / Windows）
//! - `shell`  … Windows の PowerShell へ OSC 7 プロンプトを注入する起動引数
//!
//! **各コマンドは async にしてネイティブのメインスレッドで実行させない。**
//! 同期コマンドはメインスレッドで走るため、PTY への書き込み待ちやセッション保存の
//! ファイル I/O がキーボードイベントの配送を塞いでしまう。

mod agent;
mod bell;
mod cwd;
mod paste;
mod prompt;
mod scrollback;
mod shell;
mod stream;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::env::{default_shell, locale_env_override, terminal_path};
use stream::PaneMsg;

/// 1ペイン = 1 PTY + 1子プロセス。
pub(crate) struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// 送出スレッドへ可視状態を通知するチャネル
    tx: mpsc::Sender<PaneMsg>,
    /// 最後に適用した (cols, rows)。同じ値の再送は捨てる
    size: (u16, u16),
}

#[derive(Default)]
pub(crate) struct Panes {
    map: Mutex<HashMap<String, Pane>>,
    /// spawn 完了前に届いたリサイズ。spawn 側が拾って初期サイズにする。
    /// フロントは要素が DOM に入る前に spawn するので、実サイズが決まるのは
    /// spawn の await が解ける前になりうる（この経路が無いとサイズを取りこぼす）
    pending_sizes: Mutex<HashMap<String, (u16, u16)>>,
}

/// pending_sizes の上限。ここに溜まるのは「spawn が来なかった id」だけなので
/// 普通は 0〜数件。異常時に無制限へ育てない
const MAX_PENDING_SIZES: usize = 256;

/// 親プロセス側だけで使う色出力ポリシー。
///
/// Codex などがコマンド出力を読みやすくするため `NO_COLOR=1` を設定した状態で
/// `tauri dev` を起動すると、その値がアプリ → PTY → シェルへ伝播して Claude Code / Codex
/// まで白黒になる。PATerminal 自身は truecolor 対応なので、親の方針は持ち込まず端末能力から
/// 各 CLI に判定させる。
const COLOR_POLICY_ENV: [&str; 5] = [
    "NO_COLOR",
    "NODE_DISABLE_COLORS",
    "FORCE_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
];

fn configure_terminal_color(cmd: &mut CommandBuilder) {
    for key in COLOR_POLICY_ENV {
        cmd.env_remove(key);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
}

/// 適用すべきサイズ。同じなら None（no-op の SIGWINCH でも Ink は再描画するので、
/// 重複を捨てること自体に意味がある）
fn next_size(prev: (u16, u16), req: (u16, u16)) -> Option<(u16, u16)> {
    (prev != req).then_some(req)
}

// 引数はフロントの PaneSpec をそのまま受ける IPC の形。まとめると invoke 側の
// 呼び出しが読みにくくなるので、ここは平らなままにしておく
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn pty_spawn(
    app: AppHandle,
    panes: State<'_, Panes>,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    visible: Option<bool>,
    on_data: Channel<String>,
) -> Result<(), String> {
    // spawn の await 中に fit が決めたサイズが先に届いていることがある。
    // それが本当の表示サイズなので、初期サイズとして採用する
    let (cols, rows) = panes
        .pending_sizes
        .lock()
        .unwrap()
        .remove(&id)
        .unwrap_or((cols, rows));
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let program = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&program);
    scrollback::configure(&mut cmd, &program, args.as_ref());
    // Windows の PowerShell は Set-Location でプロセスの CWD を変えないため、
    // pid_cwd（PEB 読み取り）だけでは cd に追従できない。起動時に OSC 7 を吐く
    // プロンプトを仕込んで macOS / Linux と同じ追従を確保する。
    // 併せて ConPTY のコンソールを UTF-8（65001）にする（既定は OEM コードページなので
    // UTF-8 で出力する git / node / claude などが化ける）
    #[cfg(windows)]
    {
        if let Some(extra) = shell::bootstrap_args(&program, args.as_ref()) {
            for a in extra {
                cmd.arg(a);
            }
        }
    }
    if let Some(args) = args {
        for a in args {
            cmd.arg(a);
        }
    }
    if let Some(dir) = cwd {
        // 保存された cwd が消えていても起動は失敗させない
        if PathBuf::from(&dir).is_dir() {
            cmd.cwd(dir);
        }
    }
    configure_terminal_color(&mut cmd);
    // Finder / Explorer 等から起動した GUI アプリは、シェルで設定した PATH を
    // 引き継がない。~/.local/bin などを補完し、既定シェル以外でも同じ CLI を使えるようにする。
    if let Some(path) = terminal_path() {
        cmd.env("PATH", path);
    }
    // 同じ理由で LANG も引き継がない。ロケール未設定のシェルは C ロケールになり、
    // 定型文の貼り込みや IME 入力の日本語が `<0081>` のようなバイト表示に化ける。
    if let Some((key, value)) = locale_env_override() {
        cmd.env(key, value);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // slave を持ち続けると子プロセス終了時に EOF が来ず、読み出しスレッドが永久ブロックする
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel::<PaneMsg>();
    stream::spawn_reader(reader, tx.clone());
    stream::spawn_forwarder(app, id.clone(), rx, on_data, visible.unwrap_or(true));

    panes.map.lock().unwrap().insert(
        id,
        Pane {
            master: pair.master,
            writer,
            child,
            tx,
            size: (cols, rows),
        },
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn pty_write(
    panes: State<'_, Panes>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = panes.map.lock().unwrap();
    let pane = map.get_mut(&id).ok_or_else(|| format!("no pane: {id}"))?;
    pane.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    pane.writer.flush().map_err(|e| e.to_string())
}

/// ブロードキャスト入力。1回のIPCで複数ペインに同じキーを流す。
#[tauri::command]
pub(crate) async fn pty_broadcast(
    panes: State<'_, Panes>,
    ids: Vec<String>,
    data: String,
) -> Result<(), String> {
    let mut map = panes.map.lock().unwrap();
    for id in ids {
        if let Some(pane) = map.get_mut(&id) {
            let _ = pane.writer.write_all(data.as_bytes());
            let _ = pane.writer.flush();
        }
    }
    Ok(())
}

/// ペインの可視状態を送出スレッドに伝える。非表示中は出力を Rust 側に溜め、
/// 可視化された瞬間にまとめて流す。
#[tauri::command]
pub(crate) async fn pty_set_visible(
    panes: State<'_, Panes>,
    ids: Vec<String>,
    visible: bool,
) -> Result<(), String> {
    let map = panes.map.lock().unwrap();
    for id in ids {
        if let Some(pane) = map.get(&id) {
            let _ = pane.tx.send(PaneMsg::Visible(visible));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn pty_resize(
    panes: State<'_, Panes>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut map = panes.map.lock().unwrap();
    let Some(pane) = map.get_mut(&id) else {
        // spawn がまだ完了していない。エラーにするとフロントはこのサイズを捨ててしまい、
        // fit は変化時しか発火しないので二度と送られてこない。預かっておく
        drop(map);
        let mut pending = panes.pending_sizes.lock().unwrap();
        if pending.len() >= MAX_PENDING_SIZES && !pending.contains_key(&id) {
            return Ok(()); // 異常時に無制限へ育てない（次の変化で再送される）
        }
        pending.insert(id, (cols, rows));
        return Ok(());
    };
    let Some(size) = next_size(pane.size, (cols, rows)) else {
        return Ok(());
    };
    pane.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    pane.size = size;
    Ok(())
}

#[tauri::command]
pub(crate) async fn pty_kill(panes: State<'_, Panes>, id: String) -> Result<(), String> {
    // spawn まで辿り着かなかったペインの預かりサイズを残さない
    panes.pending_sizes.lock().unwrap().remove(&id);
    if let Some(mut pane) = panes.map.lock().unwrap().remove(&id) {
        let _ = pane.child.kill();
    }
    Ok(())
}

/// ペインのシェルプロセスの現在ディレクトリ。取れなければ None
#[tauri::command]
pub(crate) async fn pty_cwd(panes: State<'_, Panes>, id: String) -> Result<Option<String>, String> {
    let pid = {
        let map = panes.map.lock().unwrap();
        let pane = map.get(&id).ok_or_else(|| format!("no pane: {id}"))?;
        pane.child.process_id()
    };
    Ok(pid.and_then(|p| cwd::pid_cwd(p as i32)))
}

/// 各ペインで実行中の AI エージェント CLI（claude / codex）を検知する。
/// 1回の呼び出し = 1回のプロセステーブル取得で全ペイン分を返す
/// （5秒スイープ×ペイン数のサブプロセスを作らない）。
/// 見つからないペイン・終了済みペインは null / 欠落になる
#[tauri::command]
pub(crate) async fn pty_agents(
    panes: State<'_, Panes>,
    ids: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let shell_pids: Vec<(String, i32)> = {
        let map = panes.map.lock().unwrap();
        ids.into_iter()
            .filter_map(|id| {
                let pid = map.get(&id)?.child.process_id()?;
                Some((id, pid as i32))
            })
            .collect()
    };
    tokio::task::spawn_blocking(move || agent::scan_agents(&shell_pids))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use portable_pty::CommandBuilder;

    use super::{configure_terminal_color, next_size, Panes, COLOR_POLICY_ENV, MAX_PENDING_SIZES};

    #[test]
    fn terminal_color_ignores_parent_process_opt_outs() {
        let mut cmd = CommandBuilder::new("ignored");
        for key in COLOR_POLICY_ENV {
            cmd.env(key, "1");
        }
        cmd.env("TERM", "dumb");
        cmd.env("COLORTERM", "");

        configure_terminal_color(&mut cmd);

        assert_eq!(cmd.get_env("TERM"), Some("xterm-256color".as_ref()));
        assert_eq!(cmd.get_env("COLORTERM"), Some("truecolor".as_ref()));
        for key in COLOR_POLICY_ENV {
            assert_eq!(cmd.get_env(key), None, "{key} must not reach the PTY");
        }
    }

    #[test]
    fn same_size_is_not_reapplied() {
        assert_eq!(next_size((80, 24), (80, 24)), None);
        assert_eq!(next_size((80, 24), (120, 24)), Some((120, 24)));
        assert_eq!(next_size((80, 24), (80, 30)), Some((80, 30)));
    }

    /// spawn 前に届いたサイズは捨てずに預かり、spawn 側が取り出して初期サイズにする。
    /// ここを取りこぼすと fit は変化時しか発火しないので二度と送られてこない
    #[test]
    fn pending_size_is_kept_until_spawn_takes_it() {
        let panes = Panes::default();
        {
            let mut pending = panes.pending_sizes.lock().unwrap();
            pending.insert("p1".into(), (120, 30));
            pending.insert("p1".into(), (100, 28)); // 後勝ち
        }
        let taken = panes.pending_sizes.lock().unwrap().remove("p1");
        assert_eq!(taken, Some((100, 28)));
        assert!(panes.pending_sizes.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_sizes_do_not_grow_without_bound() {
        let panes = Panes::default();
        let mut pending = panes.pending_sizes.lock().unwrap();
        for i in 0..MAX_PENDING_SIZES {
            pending.insert(format!("p{i}"), (80, 24));
        }
        // 上限に達したら新しい id は受け付けない（既知の id の更新は通す）
        assert_eq!(pending.len(), MAX_PENDING_SIZES);
        assert!(pending.contains_key("p0"));
    }
}
