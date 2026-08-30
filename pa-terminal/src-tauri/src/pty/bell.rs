//! BEL（ベル）検出。読み出しスレッドが生バイトを流しながら走査する。

/// BEL 検出の状態機械。OSC/DCS/APC/PM/SOS 文字列の終端 BEL（OSC 7 の cwd 通知や
/// タイトル設定で頻発）を本物のベルと区別する。read チャンクを跨いで状態を持ち越す。
pub(crate) enum BellScan {
    Ground,
    Esc,
    InString,
    InStringEsc,
}

/// chunk を走査して本物の BEL があったかを返す
pub(crate) fn scan_bell(state: &mut BellScan, chunk: &[u8]) -> bool {
    let mut bell = false;
    for &b in chunk {
        *state = match state {
            BellScan::Ground => match b {
                0x07 => {
                    bell = true;
                    BellScan::Ground
                }
                0x1b => BellScan::Esc,
                _ => BellScan::Ground,
            },
            BellScan::Esc => match b {
                b']' | b'P' | b'_' | b'^' | b'X' => BellScan::InString,
                0x1b => BellScan::Esc,
                _ => BellScan::Ground,
            },
            BellScan::InString => match b {
                0x07 => BellScan::Ground,
                0x1b => BellScan::InStringEsc,
                _ => BellScan::InString,
            },
            BellScan::InStringEsc => match b {
                b'\\' => BellScan::Ground,
                0x1b => BellScan::InStringEsc,
                _ => BellScan::InString,
            },
        };
    }
    bell
}

#[cfg(test)]
mod tests {
    use super::{scan_bell, BellScan};

    fn scan(chunks: &[&[u8]]) -> Vec<bool> {
        let mut st = BellScan::Ground;
        chunks.iter().map(|c| scan_bell(&mut st, c)).collect()
    }

    #[test]
    fn bell_plain_is_detected() {
        assert_eq!(scan(&[b"hello\x07world"]), vec![true]);
    }

    #[test]
    fn bell_as_osc_terminator_is_ignored() {
        // OSC 7 (cwd 通知) の BEL 終端と ST 終端はどちらもベル扱いしない
        assert_eq!(scan(&[b"\x1b]7;file:///tmp\x07"]), vec![false]);
        assert_eq!(scan(&[b"\x1b]0;title\x1b\\"]), vec![false]);
    }

    #[test]
    fn bell_after_osc_is_detected() {
        assert_eq!(scan(&[b"\x1b]0;t\x07\x07"]), vec![true]);
    }

    #[test]
    fn osc_state_survives_chunk_boundary() {
        // OSC がチャンク境界で分断されても終端 BEL を誤検知しない
        assert_eq!(
            scan(&[b"\x1b]7;file://", b"/tmp\x07 then \x07"]),
            vec![false, true]
        );
    }

    #[test]
    fn dcs_string_bel_is_ignored_until_st() {
        // DCS(ESC P)〜ST の中の BEL もベルではない
        assert_eq!(scan(&[b"\x1bPdata\x07more\x1b\\\x07"]), vec![true]); // 最後の素の BEL のみ
        assert_eq!(scan(&[b"\x1bPdata\x07more\x1b\\"]), vec![false]);
    }

    #[test]
    fn csi_does_not_eat_following_bell() {
        // ESC [ (CSI) は文字列モードに入らないので直後の BEL は本物
        assert_eq!(scan(&[b"\x1b[31m\x07"]), vec![true]);
    }
}
