//! PTY 出力をフロントへ運ぶ2段構成のスレッドと、その途中で行う稼働検知。
//!
//! Channel の配送は macOS では WebView メインスレッドの eval になり、キーボード
//! イベントの処理と同じスレッドを消費する。そのため
//!
//! - 表示中ペイン: 16ms / 64KB 単位でまとめて送る（eval の回数とサイズを抑える）
//! - 非表示ペイン: 一切送らず Rust 側に溜め、表示された時に流す
//!
//! ことで、裏のエージェント出力が打鍵を妨げないようにする。
//!
//! フロントへ出す `pty:*` イベント（busy/idle 遷移・ベル・bracketed paste 遷移・終了）の
//! emit もここに集約する。

use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use super::bell::{scan_bell, BellScan};
use super::paste::PasteScan;
use super::prompt::PromptScan;

/// 送出スレッドへの制御メッセージ
pub(crate) enum PaneMsg {
    Data(Vec<u8>),
    Visible(bool),
    /// 読み出しスレッドが本物のベル（OSC 等の終端でない BEL）を検出した
    Bell,
    /// 子プロセス側が PTY を閉じた。map が保持する制御用 Sender の drop を待たず通知する。
    Exit,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
}

/// 稼働状態の遷移通知（busy になった / 静止した）。遷移時のみ emit する
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActPayload {
    id: String,
    busy: bool,
    /// busy:false のとき、直前の活動が続いていた時間（静止待ち時間は含まない）
    busy_ms: u64,
    /// busy:false のとき、末尾の出力が「ユーザーの応答待ち」に見えるか
    /// （claude / codex の承認ダイアログ、y/n 確認、Enter 待ち等）
    waiting: bool,
}

#[derive(Clone, Serialize)]
struct BellPayload {
    id: String,
}

/// bracketed paste (DECSET/DECRST 2004) の遷移通知。遷移時のみ emit する。
/// 非表示ペインの出力は xterm に届かないため、フロントはこのイベントを正とする
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModePayload {
    id: String,
    bracketed_paste: bool,
}

const DROPPED_MARK: &str =
    "\r\n\u{1b}[2m── 中略（バックグラウンド中の大量出力を省略）──\u{1b}[0m\r\n";

/// 出力が止まってから「静止した」とみなすまでの時間
const ACT_IDLE: Duration = Duration::from_millis(2000);

/// 非表示ペインで溜め込む上限。スクロールバックを大きく超える分は復元結果が変わらない
const HIDDEN_BUFFER_MAX: usize = 2_000_000;

/// pending の先頭から UTF-8 として完結している範囲だけを Channel に流し、
/// 未完成のバイト列は持ち越す。
fn send_valid_utf8(chan: &Channel<String>, pending: &mut Vec<u8>, dropped: &mut bool) {
    let valid_up_to = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) => e.valid_up_to(),
    };
    // UTF-8 の続きは最大4バイト。それ以上溜まったら本当に不正なので捨てて進む。
    let cut = if valid_up_to == 0 && pending.len() > 4 {
        pending.len()
    } else {
        valid_up_to
    };
    if cut == 0 {
        return;
    }
    if *dropped {
        *dropped = false;
        let _ = chan.send(DROPPED_MARK.to_string());
    }
    let chunk = String::from_utf8_lossy(&pending[..cut]).into_owned();
    pending.drain(..cut);
    let _ = chan.send(chunk);
}

/// 溜めたものを（末尾の未完成バイトも含め）全部流す。可視化時と終了時に使う。
fn flush_all(chan: &Channel<String>, pending: &mut Vec<u8>, dropped: &mut bool) {
    if pending.is_empty() {
        return;
    }
    if *dropped {
        *dropped = false;
        let _ = chan.send(DROPPED_MARK.to_string());
    }
    let chunk = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    let _ = chan.send(chunk);
}

/// ブロッキング read の専用スレッド。生バイトをそのまま送出スレッドへ渡し、
/// ついでに本物のベルだけを拾う。
pub(crate) fn spawn_reader(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<PaneMsg>) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut bell_scan = BellScan::Ground;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            // ベルはチャンクあたり最大1通（連打はここで自然に間引かれる）。
            // Data を先に送る = フロントは busy を見てからベルを受け取る
            let bell = scan_bell(&mut bell_scan, &buf[..n]);
            if tx.send(PaneMsg::Data(buf[..n].to_vec())).is_err() {
                break;
            }
            if bell && tx.send(PaneMsg::Bell).is_err() {
                break;
            }
        }
        // Panes.map の Pane も制御用 tx を保持しているため、reader 側の clone を
        // drop するだけでは rx は切断されない。明示的な Exit が無いと、自然終了した
        // シェルは pty:exit を一度も出さず、フロントに入力先の無い画面だけが残る。
        let _ = tx.send(PaneMsg::Exit);
    });
}

/// 送出スレッド。適応コアレス（表示中）/ バッファリング（非表示）と、
/// busy / idle 遷移の emit・静止時の入力待ち判定を担う。
pub(crate) fn spawn_forwarder(
    app: AppHandle,
    id: String,
    rx: mpsc::Receiver<PaneMsg>,
    on_data: Channel<String>,
    mut visible: bool,
) {
    thread::spawn(move || {
        // read() の切れ目でマルチバイト文字が分断されると日本語が化ける。
        // 未完成のバイト列は次回に持ち越す。
        let mut pending: Vec<u8> = Vec::new();
        let mut dropped = false;
        // 稼働検知: 出力が流れ始めたら busy、ACT_IDLE 静止したら idle を1回ずつ emit。
        // idle 中はブロッキング recv のまま（定常時に余分な wakeup を作らない）。
        // busy 中だけ recv_timeout にして静止判定のタイマーを回す
        let mut busy = false;
        let mut busy_since = Instant::now();
        let mut last_data = Instant::now();
        // 静止した瞬間の画面末尾から「応答待ち」を見分けるための走査。
        // 非表示ペインの出力は JS へ流れないので、判定はここ（Rust 側）でしかできない
        let mut prompt = PromptScan::new();
        // bracketed paste (2004) の追跡も同じ理由で Rust 側が正。遷移時のみ emit する
        let mut paste = PasteScan::new();
        let mut bracketed = false;

        'outer: loop {
            let msg = if busy {
                let deadline = last_data + ACT_IDLE;
                let now = Instant::now();
                if now >= deadline {
                    busy = false;
                    let busy_ms = last_data.duration_since(busy_since).as_millis() as u64;
                    let _ = app.emit(
                        "pty:act",
                        ActPayload {
                            id: id.clone(),
                            busy: false,
                            busy_ms,
                            waiting: prompt.waiting(),
                        },
                    );
                    continue; // 次周回からブロッキング recv に戻る
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(m) => m,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue, // 次周回で idle 遷移
                    Err(mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                }
            } else {
                match rx.recv() {
                    Ok(m) => m,
                    Err(_) => break 'outer,
                }
            };

            match msg {
                PaneMsg::Data(chunk) => {
                    if !busy {
                        busy = true;
                        busy_since = Instant::now();
                        let _ = app.emit(
                            "pty:act",
                            ActPayload {
                                id: id.clone(),
                                busy: true,
                                busy_ms: 0,
                                waiting: false,
                            },
                        );
                    }
                    last_data = Instant::now();
                    prompt.feed(&chunk);
                    if let Some(v) = paste.feed(&chunk) {
                        if v != bracketed {
                            bracketed = v;
                            let _ = app.emit(
                                "pty:mode",
                                ModePayload {
                                    id: id.clone(),
                                    bracketed_paste: v,
                                },
                            );
                        }
                    }
                    pending.extend_from_slice(&chunk);
                }
                PaneMsg::Bell => {
                    let _ = app.emit("pty:bell", BellPayload { id: id.clone() });
                    continue;
                }
                PaneMsg::Visible(v) => {
                    visible = v;
                    if visible {
                        flush_all(&on_data, &mut pending, &mut dropped);
                    }
                    continue;
                }
                PaneMsg::Exit => break 'outer,
            }

            if visible {
                // 追い読み: まず 1ms だけ様子を見て、続きが無い小さな出力
                // （打鍵エコー等）は即座に送る。続きが来ている（大量出力が
                // 流れている）ときだけ 16ms / 64KB まで束ねて eval 回数を抑える。
                let start = Instant::now();
                let mut window = Duration::from_millis(1);
                while pending.len() < 65_536 {
                    let elapsed = start.elapsed();
                    if elapsed >= window {
                        break;
                    }
                    match rx.recv_timeout(window - elapsed) {
                        Ok(PaneMsg::Data(chunk)) => {
                            last_data = Instant::now();
                            prompt.feed(&chunk);
                            if let Some(v) = paste.feed(&chunk) {
                                if v != bracketed {
                                    bracketed = v;
                                    let _ = app.emit(
                                        "pty:mode",
                                        ModePayload {
                                            id: id.clone(),
                                            bracketed_paste: v,
                                        },
                                    );
                                }
                            }
                            pending.extend_from_slice(&chunk);
                            window = Duration::from_millis(16);
                        }
                        Ok(PaneMsg::Bell) => {
                            // コアレス窓は壊さない（emit のみ）
                            let _ = app.emit("pty:bell", BellPayload { id: id.clone() });
                        }
                        Ok(PaneMsg::Visible(v)) => {
                            visible = v;
                            if !visible {
                                break;
                            }
                        }
                        Ok(PaneMsg::Exit) => break 'outer,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            send_valid_utf8(&on_data, &mut pending, &mut dropped);
                            break 'outer;
                        }
                    }
                }
                if visible {
                    send_valid_utf8(&on_data, &mut pending, &mut dropped);
                }
            } else {
                // 非表示: 送らずに溜める。スクロールバックを大きく超える分は
                // 復元結果が変わらないので先頭から捨てる
                if pending.len() > HIDDEN_BUFFER_MAX {
                    let cut = pending.len() - HIDDEN_BUFFER_MAX;
                    pending.drain(..cut);
                    dropped = true;
                }
            }
        }

        // 終了時は表示状態に関わらず残りを吐き切ってから通知
        flush_all(&on_data, &mut pending, &mut dropped);
        let _ = app.emit("pty:exit", ExitPayload { id });
    });
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::{spawn_reader, PaneMsg};

    #[test]
    fn reader_explicitly_reports_exit_while_control_sender_is_still_held() {
        let (tx, rx) = mpsc::channel();
        // 実際の Panes.map と同じく、reader とは別の Sender を保持し続ける。
        // EOF が Sender の切断だけに依存していると、このテストは timeout する。
        let _control_tx = tx.clone();
        spawn_reader(Box::new(Cursor::new(b"done".to_vec())), tx);

        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(PaneMsg::Data(data)) => assert_eq!(data, b"done"),
            _ => panic!("reader did not forward data"),
        }
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(1)),
            Ok(PaneMsg::Exit)
        ));
    }
}
