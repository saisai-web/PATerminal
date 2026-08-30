//! 実行ファイルの探索先（GUI 起動で痩せた PATH の補完）。
//!
//! Finder / Dock から起動した GUI アプリは、シェルで設定した PATH を引き継がない。
//! 特定シェルの rc 構文には依存せず、ユーザーが CLI を置く代表的な場所を足すことで
//! zsh / bash / fish / PowerShell のどれでも同じ CLI を使えるようにする。

use std::path::PathBuf;

fn push_search_dir(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

/// GUI 起動時にもユーザーが CLI を置く代表的な場所を探索できる PATH。
/// 特定シェルの rc 構文には依存しないので zsh / bash / fish / PowerShell で共用できる。
fn executable_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = super::home_dir() {
        for rel in [
            ".local/bin",
            ".volta/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".pyenv/shims",
            ".local/share/pnpm",
            "Library/pnpm",
            // Windows のユーザー導入 CLI
            "scoop/shims",
        ] {
            // 区切りごとに join する（Windows で `C:\Users\me\.cargo/bin` のような
            // 混在区切りを $PATH に出さない）
            push_search_dir(
                &mut dirs,
                rel.split('/').fold(home.clone(), |acc, part| acc.join(part)),
            );
        }
    }
    if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
        push_search_dir(&mut dirs, app_data.join("npm"));
    }
    // 以下の環境変数は Windows にしか無いので cfg で囲わなくてよい
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        // Store / winget が置くシム
        push_search_dir(&mut dirs, local.join("Microsoft").join("WindowsApps"));
        push_search_dir(&mut dirs, local.join("Microsoft").join("WinGet").join("Links"));
    }
    if let Some(program_data) = std::env::var_os("ProgramData").map(PathBuf::from) {
        push_search_dir(&mut dirs, program_data.join("chocolatey").join("bin"));
        push_search_dir(&mut dirs, program_data.join("scoop").join("shims"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        push_search_dir(&mut dirs, program_files.join("Git").join("cmd"));
        push_search_dir(&mut dirs, program_files.join("GitHub CLI"));
        push_search_dir(&mut dirs, program_files.join("nodejs"));
        push_search_dir(&mut dirs, program_files.join("PowerShell").join("7"));
    }
    if cfg!(target_os = "macos") {
        push_search_dir(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
    }
    if !cfg!(windows) {
        push_search_dir(&mut dirs, PathBuf::from("/usr/local/bin"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            push_search_dir(&mut dirs, dir);
        }
    }
    // GUI の環境変数自体が空でも、OS 標準コマンドは失わない。
    if !cfg!(windows) {
        for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            push_search_dir(&mut dirs, PathBuf::from(dir));
        }
    } else if let Some(system_root) = std::env::var_os("SystemRoot").map(PathBuf::from) {
        // これが無いと PATH の壊れたユーザーは powershell.exe すら起動できない
        let system32 = system_root.join("System32");
        push_search_dir(&mut dirs, system32.clone());
        push_search_dir(&mut dirs, system_root.clone());
        push_search_dir(&mut dirs, system32.join("Wbem"));
        push_search_dir(&mut dirs, system32.join("WindowsPowerShell").join("v1.0"));
    }
    dirs
}

/// PTY / gh などの子プロセスへ渡す PATH。
pub(crate) fn terminal_path() -> Option<std::ffi::OsString> {
    std::env::join_paths(executable_search_dirs()).ok()
}

/// Windows で実行ファイル名に付けて試す拡張子。
///
/// **`PATHEXT` をそのまま列挙しない**: 既定値には `.VBS` `.JS` `.WSF` `.MSC` `.PS1` が含まれ、
/// これらは `CreateProcess` が直接起動できない。npm / scoop が実体の隣に置く `gh.ps1` を
/// 掴んでしまうと、今の「素の `gh` に退化して OS に解決させる」挙動より悪くなる。
/// `PATHEXT` を尊重しつつ「プロセスとして起動できる形」だけに絞る
/// （`.bat` / `.cmd` は Rust の `Command` が cmd.exe 経由で起動する）。
fn windows_exe_extensions(pathext: Option<&str>) -> Vec<String> {
    const RUNNABLE: [&str; 4] = ["exe", "com", "cmd", "bat"];
    let Some(pathext) = pathext.filter(|p| !p.trim().is_empty()) else {
        return RUNNABLE.iter().map(|e| (*e).to_string()).collect();
    };
    let mut out = Vec::new();
    for ext in pathext.split(';') {
        let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if RUNNABLE.contains(&ext.as_str()) && !out.contains(&ext) {
            out.push(ext);
        }
    }
    if out.is_empty() {
        return RUNNABLE.iter().map(|e| (*e).to_string()).collect();
    }
    out
}

/// 実行ファイル名から「ありそうな絶対パス」を並べる（存在確認は呼び出し側）。
pub(crate) fn executable_candidates(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let exts = if cfg!(windows) {
        windows_exe_extensions(std::env::var("PATHEXT").ok().as_deref())
    } else {
        Vec::new()
    };
    for dir in executable_search_dirs() {
        out.push(dir.join(name));
        for ext in &exts {
            out.push(dir.join(format!("{name}.{ext}")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{executable_search_dirs, terminal_path, windows_exe_extensions};

    #[test]
    fn terminal_path_adds_user_cli_directories_without_duplicates() {
        let dirs = executable_search_dirs();
        if let Some(home) = crate::env::home_dir() {
            assert!(dirs.contains(&home.join(".local").join("bin")));
            assert!(dirs.contains(&home.join(".volta").join("bin")));
            // HOME だけを見ていると Windows でここが丸ごと落ちる（USERPROFILE 退避の確認）
            assert!(dirs.contains(&home.join(".cargo").join("bin")));
        }
        for (i, dir) in dirs.iter().enumerate() {
            assert!(!dirs[..i].contains(dir), "duplicate PATH entry: {dir:?}");
        }
        let joined = terminal_path().expect("search directories should form a valid PATH");
        assert_eq!(std::env::split_paths(&joined).collect::<Vec<_>>(), dirs);
    }

    /// PATH が壊れていても OS 標準コマンドを見失わないための下限。
    #[cfg(windows)]
    #[test]
    fn windows_search_dirs_include_system_floor() {
        let dirs = executable_search_dirs();
        let system_root =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"));
        assert!(dirs.contains(&system_root.join("System32")));
        assert!(dirs.contains(&system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")));
    }

    #[test]
    fn exe_extensions_keep_only_directly_runnable_ones() {
        // 既定の PATHEXT。.PS1 / .VBS などは CreateProcess で起動できないので落とす
        assert_eq!(
            windows_exe_extensions(Some(".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC;.PS1")),
            vec!["com", "exe", "bat", "cmd"]
        );
        // 未設定・空・実行できない拡張子だけ → 組み込みの既定へ退避
        for empty in [None, Some(""), Some("   "), Some(".PS1;.VBS")] {
            assert_eq!(
                windows_exe_extensions(empty),
                vec!["exe", "com", "cmd", "bat"],
                "input={empty:?}"
            );
        }
        // 重複は畳む
        assert_eq!(windows_exe_extensions(Some(".EXE;.exe")), vec!["exe"]);
    }
}
