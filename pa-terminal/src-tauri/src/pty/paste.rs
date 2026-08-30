//! bracketed paste (DECSET/DECRST 2004) の追跡。送出スレッドが生バイトを流しながら走査する。
//!
//! フロントの xterm は非表示ペインの出力を受け取らない（stream.rs のバッファリング）ため、
//! `term.modes.bracketedPasteMode` は裏セッションでは常に古い。ペアモードの貼り付けが
//! マーカーで包むべきかはここ（Rust 側）で判定するしかない。

/// CSI のパラメータとして保持する最大バイト数。超えたら不正な列として無効化する
/// （`?1049;2004` 程度が収まれば十分）
const PARAM_MAX: usize = 16;

enum State {
    Ground,
    Esc,
    Csi,
    /// OSC/DCS/APC/PM/SOS 文字列の中。CSI 風のバイト列を誤検知しないため読み飛ばす
    Str,
    StrEsc,
}

/// DECSET/DECRST 2004 検出の状態機械。read チャンクを跨いで状態を持ち越す。
pub(crate) struct PasteScan {
    state: State,
    params: Vec<u8>,
    /// パラメータ超過や中間バイトを見た（= この CSI 列は判定対象にしない）
    invalid: bool,
}

impl PasteScan {
    pub(crate) fn new() -> Self {
        Self {
            state: State::Ground,
            params: Vec::new(),
            invalid: false,
        }
    }

    /// chunk を走査し、bracketed paste の有効/無効が確定したら返す。
    /// 同一チャンク内に複数の遷移があれば最後のものが勝つ。
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Option<bool> {
        let mut result = None;
        for &b in chunk {
            match self.state {
                State::Ground => match b {
                    0x1b => self.state = State::Esc,
                    _ => {}
                },
                State::Esc => match b {
                    b'[' => {
                        self.state = State::Csi;
                        self.params.clear();
                        self.invalid = false;
                    }
                    b']' | b'P' | b'_' | b'^' | b'X' => self.state = State::Str,
                    0x1b => {}
                    _ => self.state = State::Ground,
                },
                State::Csi => match b {
                    0x30..=0x3f => {
                        // パラメータバイト（数字・`;`・`?` 等）
                        if self.params.len() < PARAM_MAX {
                            self.params.push(b);
                        } else {
                            self.invalid = true;
                        }
                    }
                    0x20..=0x2f => self.invalid = true, // 中間バイト。DECSET には現れない
                    b'h' | b'l' => {
                        if !self.invalid && Self::is_2004(&self.params) {
                            result = Some(b == b'h');
                        }
                        self.state = State::Ground;
                    }
                    0x40..=0x7e => self.state = State::Ground, // その他の final byte
                    0x1b => self.state = State::Esc,
                    _ => {} // CSI 内の C0 制御文字は読み飛ばす
                },
                State::Str => match b {
                    0x07 => self.state = State::Ground,
                    0x1b => self.state = State::StrEsc,
                    _ => {}
                },
                State::StrEsc => match b {
                    b'\\' => self.state = State::Ground,
                    0x1b => {}
                    _ => self.state = State::Str,
                },
            }
        }
        result
    }

    /// `?` 始まりの `;` 区切りパラメータに 2004 が含まれるか
    fn is_2004(params: &[u8]) -> bool {
        let Some(rest) = params.strip_prefix(b"?") else {
            return false;
        };
        rest.split(|&b| b == b';').any(|p| p == b"2004")
    }
}

#[cfg(test)]
mod tests {
    use super::PasteScan;

    fn scan(chunks: &[&[u8]]) -> Vec<Option<bool>> {
        let mut st = PasteScan::new();
        chunks.iter().map(|c| st.feed(c)).collect()
    }

    #[test]
    fn decset_2004_is_detected() {
        assert_eq!(scan(&[b"\x1b[?2004h"]), vec![Some(true)]);
        assert_eq!(scan(&[b"\x1b[?2004l"]), vec![Some(false)]);
    }

    #[test]
    fn sequence_survives_chunk_boundary() {
        assert_eq!(scan(&[b"abc\x1b[?20", b"04hdef"]), vec![None, Some(true)]);
        assert_eq!(scan(&[b"\x1b", b"[", b"?2004", b"l"]), vec![None, None, None, Some(false)]);
    }

    #[test]
    fn without_private_marker_is_ignored() {
        // `?` の無い SM/RM (ESC[2004h) は別のモード
        assert_eq!(scan(&[b"\x1b[2004h"]), vec![None]);
    }

    #[test]
    fn multi_param_is_detected() {
        assert_eq!(scan(&[b"\x1b[?1049;2004h"]), vec![Some(true)]);
        assert_eq!(scan(&[b"\x1b[?2004;1004l"]), vec![Some(false)]);
        // 2004 を含まない複合は無視
        assert_eq!(scan(&[b"\x1b[?1049;1004h"]), vec![None]);
        // 部分一致（12004 / 20042）は拾わない
        assert_eq!(scan(&[b"\x1b[?12004h"]), vec![None]);
    }

    #[test]
    fn last_transition_wins_within_chunk() {
        assert_eq!(scan(&[b"\x1b[?2004h...\x1b[?2004l"]), vec![Some(false)]);
    }

    #[test]
    fn csi_inside_osc_string_is_ignored() {
        // OSC 文字列の中に CSI 風のバイト列があっても拾わない（BEL / ST 終端の両方）
        assert_eq!(scan(&[b"\x1b]0;\x1b[?2004h\x07"]), vec![None]);
        assert_eq!(scan(&[b"\x1bPdata\x1b[?2004h\x1b\\"]), vec![None]);
        // 文字列が終われば通常どおり検出する
        assert_eq!(scan(&[b"\x1b]0;title\x07\x1b[?2004h"]), vec![Some(true)]);
    }

    #[test]
    fn overlong_params_are_discarded() {
        assert_eq!(scan(&[b"\x1b[?111111111111111112004h"]), vec![None]);
    }

    #[test]
    fn other_csi_does_not_confuse_state() {
        assert_eq!(scan(&[b"\x1b[31m\x1b[2J\x1b[?2004h"]), vec![Some(true)]);
    }
}
