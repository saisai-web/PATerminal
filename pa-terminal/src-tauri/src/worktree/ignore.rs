//! 「リポジトリ配下」モードでだけ使う `.gitignore` の追記。
//! 作業ツリーがリポジトリの中に増える形なので、通常のソース変更として残す。

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::git::{git_output_text, run_git};

fn gitignore_directory_pattern(directory: &str) -> String {
    let mut pattern = String::from("/");
    for ch in directory.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '#' | '!' | ' ') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('/');
    pattern
}

fn git_path_is_ignored(root: &str, relative_path: &str) -> Result<bool, String> {
    let out = run_git(&[
        "-C",
        root,
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        relative_path,
    ])?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_output_text(&out)),
    }
}

/// 作成先がまだ ignore 対象でなければ、リポジトリルートの `.gitignore` へ
/// 格納ディレクトリを追記する。Git 操作とは別の通常のソース変更として残す。
pub(crate) fn ensure_worktree_ignored(
    root: &Path,
    root_arg: &str,
    directory: &str,
    relative_target: &str,
) -> Result<(), String> {
    if git_path_is_ignored(root_arg, relative_target)? {
        return Ok(());
    }
    let ignore_path = root.join(".gitignore");
    let existing = match fs::read(&ignore_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ignore_path)
        .map_err(|e| e.to_string())?;
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        file.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    let pattern = gitignore_directory_pattern(directory);
    file.write_all(pattern.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| e.to_string())?;
    Ok(())
}
