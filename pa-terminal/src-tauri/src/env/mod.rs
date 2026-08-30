//! PTY と外部 CLI を起動するための実行環境。GUI 起動（Finder / Dock）では
//! シェルの設定が何も引き継がれないので、ここで補う:
//!
//! - `path`   … 実行ファイルの探索先と子プロセスへ渡す PATH
//! - `locale` … UTF-8 ロケール（未設定だと日本語が化ける）
//!
//! 既定シェルとホームディレクトリの解決も、PTY が直接利用する下位のこの層に置く。

use std::ffi::OsString;
use std::path::PathBuf;

mod locale;
mod path;

pub(crate) use locale::locale_env_override;
pub(crate) use path::{executable_candidates, terminal_path};

/// **Windows: 子プロセスのコンソールウィンドウを出さない。**
///
/// `windows_subsystem = "windows"` のアプリ（= コンソールを持たない GUI プロセス）から
/// コンソールアプリを起こすと、既定で新しいコンソールが割り当てられ、一瞬ウィンドウが開く。
/// このアプリは git を3秒ごと（変更ストリップ）+ セッション×ペインごとに5秒ごと
/// （サイドバーの git バッジ）に叩き、gh も定期的に走るので、放置すると画面上で
/// 黒い窓が開閉し続ける。**Windows で走り得る子プロセスの起動は必ずこれを通すこと**
/// （`git` = `git/run.rs`、`gh` = `github/gh.rs`、OS 連携 = `system/os.rs`）。
///
/// 対象外: PTY（ConPTY の conhost は擬似コンソール用でウィンドウを持たない）と、
/// `env/locale.rs` / `pty/agent.rs` の `locale` / `ps`（どちらも非 Windows 専用の経路）。
pub(crate) trait HideConsole {
    fn hide_console(&mut self) -> &mut Self;
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl HideConsole for std::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl HideConsole for tokio::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

/// ユーザーのホームディレクトリ。`~` 展開・CLI 探索先・エージェントの保存ファイル探索が
/// すべてここを通る。
pub(crate) fn home_dir() -> Option<PathBuf> {
    pick_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

/// `HOME` / `USERPROFILE` からホームを選ぶ純粋関数（どの OS でもテストできるよう値で受ける）。
///
/// Windows では **Git Bash / MSYS から起動されると `HOME=/c/Users/name` が入ってくる**。
/// この形はドライブ接頭辞が無いので Windows API では開けず、そのまま使うと
/// エージェントのセッション解決や CLI 探索が黙って失敗する。絶対パスでない `HOME` は
/// 捨てて `USERPROFILE` へ退避する。
fn pick_home(home: Option<OsString>, user_profile: Option<OsString>) -> Option<PathBuf> {
    home.map(PathBuf::from)
        // POSIX では `HOME` が絶対でないことは無く、Windows だけがこの防御を必要とする
        .filter(|path| !cfg!(windows) || path.is_absolute())
        .or_else(|| user_profile.map(PathBuf::from))
}

#[cfg(windows)]
pub(crate) fn default_shell() -> String {
    // powershell.exe は Windows 10/11 に必ず入っている。
    // PowerShell 7 を使う場合はフロントから shell: "pwsh.exe" を渡す。
    "powershell.exe".to_string()
}

#[cfg(not(windows))]
pub(crate) fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

#[cfg(test)]
mod tests {
    use super::pick_home;
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn home_wins_when_absolute() {
        let home = if cfg!(windows) {
            r"C:\Users\me"
        } else {
            "/home/me"
        };
        assert_eq!(
            pick_home(Some(OsString::from(home)), Some(OsString::from("/other"))),
            Some(PathBuf::from(home))
        );
    }

    #[test]
    fn windows_rejects_msys_style_home() {
        // Git Bash が渡してくる `/c/Users/me` は Windows では開けない
        let picked = pick_home(
            Some(OsString::from("/c/Users/me")),
            Some(OsString::from(r"C:\Users\me")),
        );
        if cfg!(windows) {
            assert_eq!(picked, Some(PathBuf::from(r"C:\Users\me")));
        } else {
            assert_eq!(picked, Some(PathBuf::from("/c/Users/me")));
        }
    }

    #[test]
    fn falls_back_to_user_profile_and_then_none() {
        assert_eq!(
            pick_home(None, Some(OsString::from(r"C:\Users\me"))),
            Some(PathBuf::from(r"C:\Users\me"))
        );
        assert_eq!(pick_home(None, None), None);
    }
}
