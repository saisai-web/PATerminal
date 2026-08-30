//! 「入力待ち」判定。非表示ペインの出力は JS へ流れないので、判定は Rust 側でしかできない。
//! PTY 出力からエスケープを除いた末尾テキストを保ち、静止した瞬間にだけ評価する。

use std::collections::VecDeque;

/// 「入力待ち」判定のために保持する末尾テキストの長さ。
/// claude / codex は全画面を何度も塗り直すので、判定に使うのは最後のフレーム相当の
/// ごく末尾だけでよい（長く持つと、答え終えた古い質問が残って誤判定する）
const PROMPT_TAIL_BYTES: usize = 2048;

/// エスケープ除去の状態機械。`scan_bell` と違い「見える文字だけを残す」ためのもの
enum AnsiState {
    Ground,
    Esc,
    /// CSI（ESC [）。パラメータを覚えておき、画面消去なら末尾バッファを捨てる
    Csi,
    /// OSC/DCS/APC/PM/SOS の文字列部（BEL か ST で終わる）
    Str,
    StrEsc,
    /// ESC ( ) * + の直後の1バイト（文字セット指定）
    Charset,
}

/// PTY 出力からエスケープを取り除いた末尾テキストを保持する。
/// read チャンクを跨いで状態を持ち越すので、シーケンスが分断されても壊れない。
pub(crate) struct PromptScan {
    state: AnsiState,
    csi_params: Vec<u8>,
    tail: VecDeque<u8>,
}

impl PromptScan {
    pub(crate) fn new() -> Self {
        PromptScan {
            state: AnsiState::Ground,
            csi_params: Vec::new(),
            tail: VecDeque::new(),
        }
    }

    fn push(&mut self, b: u8) {
        self.tail.push_back(b);
        while self.tail.len() > PROMPT_TAIL_BYTES {
            self.tail.pop_front();
        }
    }

    pub(crate) fn feed(&mut self, chunk: &[u8]) {
        for &b in chunk {
            match self.state {
                AnsiState::Ground => match b {
                    0x1b => self.state = AnsiState::Esc,
                    // \r は行の塗り直しにも使われる。行区切りとして扱うと
                    // 進捗表示が1行に潰れず、行単位の判定が素直になる
                    b'\n' | b'\r' => self.push(b'\n'),
                    b'\t' => self.push(b' '),
                    0x00..=0x1f | 0x7f => {}
                    _ => self.push(b),
                },
                AnsiState::Esc => match b {
                    b'[' => {
                        self.csi_params.clear();
                        self.state = AnsiState::Csi;
                    }
                    b']' | b'P' | b'_' | b'^' | b'X' => self.state = AnsiState::Str,
                    b'(' | b')' | b'*' | b'+' => self.state = AnsiState::Charset,
                    // RIS（端末リセット）は画面ごと消えるので末尾も捨てる
                    b'c' => {
                        self.tail.clear();
                        self.state = AnsiState::Ground;
                    }
                    0x1b => {}
                    _ => self.state = AnsiState::Ground,
                },
                AnsiState::Csi => match b {
                    0x40..=0x7e => {
                        // CSI 2J / 3J = 画面消去。ここより前のフレームは残さない
                        if b == b'J' && matches!(self.csi_params.as_slice(), b"2" | b"3") {
                            self.tail.clear();
                        }
                        self.state = AnsiState::Ground;
                    }
                    _ => {
                        if self.csi_params.len() < 16 {
                            self.csi_params.push(b);
                        }
                    }
                },
                AnsiState::Str => match b {
                    0x07 => self.state = AnsiState::Ground,
                    0x1b => self.state = AnsiState::StrEsc,
                    _ => {}
                },
                AnsiState::StrEsc => match b {
                    b'\\' => self.state = AnsiState::Ground,
                    0x1b => {}
                    _ => self.state = AnsiState::Str,
                },
                AnsiState::Charset => self.state = AnsiState::Ground,
            }
        }
    }

    /// 末尾が「応答しないと進まない」表示か。静止した瞬間にだけ呼ぶ
    pub(crate) fn waiting(&self) -> bool {
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        detect_waiting(&String::from_utf8_lossy(&tail))
    }
}

/// 行頭の枠線・余白を落として本文を取り出す（`│ ❯ 1. Yes` → `❯ 1. Yes`）
fn strip_box_prefix(line: &str) -> &str {
    line.trim_matches(|c: char| c.is_whitespace() || matches!(c, '│' | '┃' | '▌' | '▏' | '|' | '⎜'))
}

/// 「カーソル付きの番号選択肢」か。claude / codex の承認ダイアログは
/// `❯ 1. Yes` の形で選択中の行を示す。地の文の箇条書き（`1. …`）は
/// カーソル記号が無いので拾わない
fn is_selected_choice(line: &str) -> bool {
    let body = strip_box_prefix(line);
    let mut chars = body.chars();
    if !matches!(
        chars.next(),
        Some('❯' | '›' | '▸' | '▶' | '►' | '➤' | '»' | '>' | '*')
    ) {
        return false;
    }
    let rest = chars.as_str().trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let after = &rest[digits..];
    let Some(after) = after.strip_prefix(['.', ')']) else {
        return false;
    };
    after.starts_with(' ') && !after.trim().is_empty()
}

/// y/n 確認・Enter 待ち・パスワード入力といった、一般的な CLI の応答待ち
fn is_confirm_prompt(line: &str) -> bool {
    let body = strip_box_prefix(line).to_ascii_lowercase();
    if ["[y/", "(y/", "[yes/", "(yes/", "y/n]", "y/n)"]
        .iter()
        .any(|p| body.contains(p))
    {
        return true;
    }
    if body.contains("press enter to continue") || body.contains("press any key to continue") {
        return true;
    }
    body.ends_with("password:") || body.ends_with("passphrase:")
}

/// エスケープ除去済みの末尾テキストが「ユーザーの応答待ち」に見えるか。
/// claude の入力ボックスやシェルプロンプトのような「いつでも入力できる」状態は
/// 出力から区別できないので待ちに含めない（既定は完了のまま）
fn detect_waiting(tail: &str) -> bool {
    let lines: Vec<&str> = tail
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let recent = |n: usize| &lines[lines.len().saturating_sub(n)..];
    // 選択肢の下には枠線やヒント行が続くので、少し広めに見る
    recent(15).iter().any(|l| is_selected_choice(l))
        // 1行プロンプトは本当に末尾にしか出ない
        || recent(4).iter().any(|l| is_confirm_prompt(l))
}

#[cfg(test)]
mod tests {
    use super::PromptScan;

    /// チャンク分割の影響を見るため、1バイトずつ食わせても結果が変わらないことを確認する
    fn waiting_after(chunks: &[&[u8]]) -> bool {
        let mut whole = PromptScan::new();
        for c in chunks {
            whole.feed(c);
        }
        let mut byte_by_byte = PromptScan::new();
        for c in chunks {
            for b in c.iter() {
                byte_by_byte.feed(&[*b]);
            }
        }
        assert_eq!(whole.waiting(), byte_by_byte.waiting());
        whole.waiting()
    }

    #[test]
    fn waiting_detects_claude_approval_dialog() {
        // 色とカーソル移動付きの承認ダイアログ（claude / codex の形）
        let frame = "\x1b[2m╭──────────────────────────╮\x1b[0m\r\n\
             │ Do you want to make this edit to lib.rs? │\r\n\
             │ \x1b[36m❯ 1. Yes\x1b[0m                  │\r\n\
             │   2. No, and tell Claude what to do differently (esc) │\r\n\
             ╰──────────────────────────╯\r\n";
        assert!(waiting_after(&[frame.as_bytes()]));
    }

    #[test]
    fn waiting_detects_yes_no_and_enter_prompts() {
        assert!(waiting_after(&[b"Overwrite existing file? [y/N] "]));
        assert!(waiting_after(&[b"Continue? (yes/no): "]));
        assert!(waiting_after(&[b"-- Press Enter to continue --"]));
        assert!(waiting_after(&[b"Enter passphrase:"]));
    }

    #[test]
    fn waiting_ignores_plain_output_and_numbered_prose() {
        assert!(!waiting_after(&[b"$ ls\r\nCargo.toml  src\r\n$ "]));
        // エージェントの回答に出てくる箇条書きはカーソル記号が無い
        assert!(!waiting_after(&[
            b"Here is the plan:\r\n1. Read the file\r\n2. Patch it\r\n3. Run the tests\r\n"
        ]));
        // 入力ボックスだけの「完了」状態は待ちにしない
        assert!(!waiting_after(&[
            "╭────────────────────╮\r\n│ > Try \"fix the build\" │\r\n╰────────────────────╯\r\n"
                .as_bytes()
        ]));
    }

    #[test]
    fn waiting_forgets_answered_prompts_after_the_screen_is_cleared() {
        // 回答後に画面が消去されれば、古い質問は残らない
        assert!(!waiting_after(&[
            "│ ❯ 1. Yes │\r\n".as_bytes(),
            b"\x1b[2J\x1b[H",
            b"Done.\r\n",
        ]));
    }

    #[test]
    fn waiting_ignores_prompts_scrolled_far_out_of_the_tail() {
        let mut scan = PromptScan::new();
        scan.feed("│ ❯ 1. Yes │\r\n".as_bytes());
        for _ in 0..200 {
            scan.feed(b"building... this line pushes the dialog out of the tail buffer\r\n");
        }
        assert!(!scan.waiting());
    }

    #[test]
    fn waiting_ignores_osc_and_status_line_payloads() {
        // OSC 7 の cwd 通知やタイトル文字列は「見える文字」ではないので判定に混ぜない
        assert!(!waiting_after(&[b"\x1b]0;? [y/n]\x07"]));
        assert!(!waiting_after(&[b"\x1b]7;file:///tmp/x\x1b\\ready\r\n"]));
    }
}
