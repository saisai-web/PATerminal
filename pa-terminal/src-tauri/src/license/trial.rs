//! トライアル開始時刻の OS 別二重記録。
//!
//! license.json（アプリのデータディレクトリ）を消すだけの素朴なリセットを防ぐため、
//! OS ごとの別の場所に**も**開始時刻を残す。読み合わせは min 合成（早い方を採用）で、
//! 欠けている側には書き戻す。大原則どおり、これを突破する人は追わない
//! （失敗はすべて無視。記録できなくても起動を妨げない）。
//!
//! - macOS: `/usr/bin/defaults`（env/locale.rs と同じ絶対パス実行）で
//!   `~/Library/Preferences/com.paralellterminal.app.license.plist` に書く
//! - Windows: `reg.exe` で HKCU\Software\PATerminal に書く。
//!   コンソールアプリなので必ず `.hide_console()` を付ける（再発防止ルール9）
//! - Linux: `~/.local/state/.paterminal-first-run` の隠しファイル

#[cfg(target_os = "linux")]
use crate::env::home_dir;
#[cfg(windows)]
use crate::env::HideConsole;

#[cfg(target_os = "macos")]
const DEFAULTS_DOMAIN: &str = "com.paralellterminal.app.license";
#[cfg(windows)]
const REG_KEY: &str = r"HKCU\Software\PATerminal";

/// file 側と OS 側の記録を合成する。両方あれば早い方（リセット防止が目的なので min）
pub(crate) fn merge_trial_start(file: Option<u64>, os: Option<u64>) -> Option<u64> {
    match (file, os) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn os_trial_start_read() -> Option<u64> {
    let out = std::process::Command::new("/usr/bin/defaults")
        .args(["read", DEFAULTS_DOMAIN, "firstRun"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn os_trial_start_write(ts: u64) {
    let _ = std::process::Command::new("/usr/bin/defaults")
        .args(["write", DEFAULTS_DOMAIN, "firstRun", &ts.to_string()])
        .output();
}

#[cfg(windows)]
pub(crate) fn os_trial_start_read() -> Option<u64> {
    let reg = reg_exe();
    let out = std::process::Command::new(reg)
        .args(["query", REG_KEY, "/v", "FirstRun"])
        .hide_console()
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    // 出力例: "    FirstRun    REG_SZ    1755212345" — 最後のトークンを拾う
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains("FirstRun"))
        .and_then(|l| l.split_whitespace().last())
        .and_then(|v| v.parse().ok())
}

#[cfg(windows)]
pub(crate) fn os_trial_start_write(ts: u64) {
    let reg = reg_exe();
    let _ = std::process::Command::new(reg)
        .args(["add", REG_KEY, "/v", "FirstRun", "/t", "REG_SZ", "/d", &ts.to_string(), "/f"])
        .hide_console()
        .output();
}

/// Git Bash 由来の PATH で reg が見つからない事態を避けるため絶対パスを優先する
#[cfg(windows)]
fn reg_exe() -> std::path::PathBuf {
    let system32 = std::env::var_os("SystemRoot")
        .map(|r| std::path::PathBuf::from(r).join("System32").join("reg.exe"));
    match system32 {
        Some(p) if p.exists() => p,
        _ => std::path::PathBuf::from("reg.exe"),
    }
}

#[cfg(target_os = "linux")]
fn state_file() -> Option<std::path::PathBuf> {
    Some(home_dir()?.join(".local").join("state").join(".paterminal-first-run"))
}

#[cfg(target_os = "linux")]
pub(crate) fn os_trial_start_read() -> Option<u64> {
    std::fs::read_to_string(state_file()?)
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
pub(crate) fn os_trial_start_write(ts: u64) {
    let Some(path) = state_file() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, ts.to_string());
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn os_trial_start_read() -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn os_trial_start_write(_ts: u64) {}

#[cfg(test)]
mod tests {
    use super::merge_trial_start;

    #[test]
    fn merge_prefers_earlier_record() {
        assert_eq!(merge_trial_start(Some(100), Some(50)), Some(50));
        assert_eq!(merge_trial_start(Some(50), Some(100)), Some(50));
        assert_eq!(merge_trial_start(Some(100), None), Some(100));
        assert_eq!(merge_trial_start(None, Some(100)), Some(100));
        assert_eq!(merge_trial_start(None, None), None);
    }
}
