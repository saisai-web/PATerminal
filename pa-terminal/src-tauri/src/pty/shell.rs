//! Windows でシェルへ前置する起動引数。2つのことを仕込む:
//!
//! 1. **cwd 追従**: PowerShell は `Set-Location` してもプロセスの CWD を変えないため、
//!    `cwd::pid_cwd`（PEB 読み取り）でも cd を追えない。起動時に OSC 7 を吐く
//!    プロンプトを仕込んで macOS / Linux と同じ追従を確保する
//! 2. **UTF-8**: ConPTY のホストするコンソールの出力コードページは既定でシステムの
//!    OEM コードページ（日本語環境なら 932）。conhost は子プロセスが書いたバイト列を
//!    そのコードページで解釈してからテキストバッファへ入れるので、**UTF-8 で出力する側**
//!    （git / node / cargo / claude など）が化ける。コードページはコンソール単位の属性なので、
//!    シェル起動時に一度 65001 にすればそのペインの全子孫に効く。
//!    ※ 代償として Shift_JIS を吐く古いコンソールアプリは化ける
//!
//! 注入は `#[cfg(windows)]` の呼び出し側に閉じてあり、ここは純粋関数なので
//! どの OS でもテストできる。

/// 起動プログラムの「名前」（パス・`.exe`・大文字小文字を無視した stem）。
#[cfg_attr(not(windows), allow(dead_code))]
fn program_stem(program: &str) -> String {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

/// パス・拡張子・大文字小文字を無視して powershell / pwsh か判定する。
/// Windows 以外でもテストできるよう、区切りは自前で見る
#[cfg_attr(not(windows), allow(dead_code))]
fn is_powershell_shell(program: &str) -> bool {
    let stem = program_stem(program);
    stem == "powershell" || stem == "pwsh"
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_cmd_shell(program: &str) -> bool {
    program_stem(program) == "cmd"
}

/// PowerShell に仕込む起動スクリプト。
///
/// **UTF-8**: `[Console]::OutputEncoding` の setter が `SetConsoleOutputCP(65001)` を呼ぶので、
/// このコンソール（= このペイン）の全子孫が UTF-8 として解釈される。`$OutputEncoding` は
/// PowerShell がネイティブアプリの stdin へ送るときの符号化。
/// `InputEncoding` は**あえて触らない**（PSReadLine / node はワイド文字 API で読むので
/// 利得が無く、入力を壊す実績のある部分）。
///
/// **OSC 7**: cd（Set-Location）のたびに現在地を吐かせる。
/// - プロファイル読み込みは従来どおり先に走るので、そこで定義された prompt は
///   保存して呼び直す（oh-my-posh 等を壊さない）
/// - FileSystem プロバイダ以外（HKLM: など）に居るときは最後のファイルシステム位置を使う
/// - パスは区切りごとに EscapeDataString する。フロントの OSC 7 ハンドラは
///   `new URL()` → `decodeURIComponent()` なので、空白や `#` `%` を含むパスでも壊れない
/// - **ホストは空にする**（`file:///…`）。マシン名を入れると非 ASCII のコンピュータ名で
///   フロントの `new URL()` が throw し、cwd 追従が黙って止まる
#[cfg_attr(not(windows), allow(dead_code))]
const POWERSHELL_OSC7_SCRIPT: &str = r#"if (-not $global:__paTerminalOsc7) {
  $global:__paTerminalOsc7 = $true
  try {
    $enc = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $enc
    $global:OutputEncoding = $enc
  } catch { }
  $global:__paTerminalPrompt = $function:prompt
  function global:prompt {
    try {
      $loc = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation
      if ($loc) {
        $enc = (($loc.Path -replace '\\', '/') -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
        [Console]::Write([char]27 + ']7;file:///' + $enc + [char]7)
      }
    } catch { }
    if ($global:__paTerminalPrompt) { & $global:__paTerminalPrompt } else { 'PS ' + $PWD.Path + '> ' }
  }
}"#;

/// 標準 base64（PowerShell の -EncodedCommand 用。依存を増やさないための最小実装）
#[cfg_attr(not(windows), allow(dead_code))]
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// PowerShell 系シェルに前置する起動引数。`-EncodedCommand`（UTF-16LE + base64）で
/// 渡すので、コマンドラインの引用符も ExecutionPolicy も関係しない。
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_bootstrap_args(program: &str) -> Option<Vec<String>> {
    if !is_powershell_shell(program) {
        return None;
    }
    let mut utf16 = Vec::with_capacity(POWERSHELL_OSC7_SCRIPT.len() * 2);
    for unit in POWERSHELL_OSC7_SCRIPT.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    Some(vec![
        "-NoExit".to_string(),
        "-EncodedCommand".to_string(),
        base64_encode(&utf16),
    ])
}

/// cmd.exe に前置する起動引数。cwd 追従は `pid_cwd`（PEB）が見てくれるので、
/// ここで足すのは UTF-8 化だけ。`/K` は「コマンドを実行して対話を続ける」。
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_bootstrap_args(program: &str) -> Option<Vec<String>> {
    if !is_cmd_shell(program) {
        return None;
    }
    Some(vec!["/K".to_string(), "chcp 65001>nul".to_string()])
}

/// Windows で既知のシェルに前置する起動引数。呼び出し側が args を指定している場合
/// （復元時の再開コマンドなど）は意図を優先して何も足さない。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn bootstrap_args(program: &str, args: Option<&Vec<String>>) -> Option<Vec<String>> {
    if args.is_some_and(|a| !a.is_empty()) {
        return None;
    }
    powershell_bootstrap_args(program).or_else(|| cmd_bootstrap_args(program))
}

#[cfg(test)]
mod tests {
    use super::{base64_encode, bootstrap_args, is_powershell_shell, POWERSHELL_OSC7_SCRIPT};

    /// テスト用の最小 base64 デコーダ（round trip 検証用）
    fn base64_decode(text: &str) -> Vec<u8> {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32;
        let mut have = 0u32;
        let mut out = Vec::new();
        for ch in text.bytes() {
            if ch == b'=' {
                break;
            }
            let v = TABLE.iter().position(|&t| t == ch).expect("base64 の文字") as u32;
            bits = (bits << 6) | v;
            have += 6;
            if have >= 8 {
                have -= 8;
                out.push((bits >> have) as u8);
            }
        }
        out
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (raw, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(raw.as_bytes()), want, "input={raw:?}");
        }
    }

    #[test]
    fn powershell_shell_detection_ignores_path_and_case() {
        for yes in [
            "powershell.exe",
            "PowerShell.EXE",
            "pwsh",
            "pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "/usr/local/bin/pwsh",
        ] {
            assert!(is_powershell_shell(yes), "{yes} は PowerShell と判定したい");
        }
        for no in [
            "cmd.exe",
            "bash",
            "/bin/zsh",
            r"C:\Program Files\Git\bin\bash.exe",
            "powershell-ise.exe",
            "claude",
        ] {
            assert!(!is_powershell_shell(no), "{no} は PowerShell 扱いしない");
        }
    }

    #[test]
    fn powershell_bootstrap_encodes_prompt_hook_and_utf8() {
        let args = bootstrap_args("powershell.exe", None).expect("引数を足す");
        assert_eq!(args[0], "-NoExit");
        assert_eq!(args[1], "-EncodedCommand");
        // -EncodedCommand は UTF-16LE + base64。復号してスクリプトに戻れること
        let raw = base64_decode(&args[2]);
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let script = String::from_utf16(&units).expect("UTF-16");
        assert_eq!(script, POWERSHELL_OSC7_SCRIPT);
        // 2つの仕込みが両方入っていること
        assert!(script.contains("[Console]::OutputEncoding = $enc"));
        assert!(script.contains("$global:OutputEncoding = $enc"));
        assert!(script.contains("]7;file:///"));
        // 入力側は触らない（PSReadLine / node を壊さないため）
        assert!(!script.contains("InputEncoding"));
        // OSC 7 のホストは空にする（非 ASCII のマシン名で new URL() が throw するため）
        assert!(!script.contains("MachineName"));
        // 引用符を含まない = コマンドライン組み立てで壊れない
        assert!(!args[2].contains(['"', '\'', ' ']));
    }

    #[test]
    fn cmd_bootstrap_switches_code_page() {
        assert_eq!(
            bootstrap_args(r"C:\Windows\System32\cmd.exe", None),
            Some(vec!["/K".to_string(), "chcp 65001>nul".to_string()])
        );
    }

    #[test]
    fn bootstrap_skips_unknown_shells_and_explicit_args() {
        assert!(bootstrap_args("bash", None).is_none());
        assert!(bootstrap_args("claude", None).is_none());
        // 明示された起動引数は呼び出し側の意図を尊重する
        let explicit = vec!["-File".to_string(), "run.ps1".to_string()];
        assert!(bootstrap_args("pwsh", Some(&explicit)).is_none());
        assert!(bootstrap_args("cmd.exe", Some(&explicit)).is_none());
        // 空配列は「指定なし」と同じ扱い
        assert!(bootstrap_args("pwsh", Some(&Vec::new())).is_some());
        assert!(bootstrap_args("cmd.exe", Some(&Vec::new())).is_some());
    }
}
