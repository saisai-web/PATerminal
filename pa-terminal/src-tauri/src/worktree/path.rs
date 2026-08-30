//! worktree の格納先パスの解決。ユーザーが打った文字列を、実際に `worktree add` へ
//! 渡してよい絶対パスへ落とすところまでを引き受ける（Git は一切呼ばない）。
//!
//! 「リポジトリ配下」と「リポジトリ外」で許す形が正反対なので、入口を2つに分けてある:
//! - `normalized_worktree_directory` … ルート相対のみ。`..` も絶対パスも `.git` も拒否
//! - `resolved_external_directory`  … 絶対パスへ解決し、リポジトリ配下を指す指定を拒否

use std::fs;
use std::path::{Component, Path, PathBuf};

/// ブランチ名をディレクトリ名1つに平坦化する（`issue/42-fix` → `issue-42-fix`）
pub(crate) fn worktree_dir_name(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    let mut dash = false;
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches(['.', '-', '_'])
        .chars()
        .take(100)
        .collect()
}

/// worktree の格納先はリポジトリルートからの相対パスだけを許可する。
/// `.git` 直下を指定すると Git の管理領域を壊し得るため明示的に拒否する。
pub(crate) fn normalized_worktree_directory(directory: &str) -> Result<String, String> {
    let directory = directory.trim();
    if directory.is_empty() || directory.len() > 512 || directory.chars().any(char::is_control) {
        return Err("invalid worktree directory".into());
    }
    let mut parts: Vec<String> = Vec::new();
    for component in Path::new(directory).components() {
        let Component::Normal(part) = component else {
            return Err("worktree directory must be relative to the repository".into());
        };
        let part = part
            .to_str()
            .ok_or("worktree directory must be valid UTF-8")?;
        if parts.is_empty() && part.eq_ignore_ascii_case(".git") {
            return Err("worktree directory cannot be inside .git".into());
        }
        parts.push(part.to_string());
    }
    if parts.is_empty() {
        return Err("invalid worktree directory".into());
    }
    Ok(parts.join("/"))
}

/// 存在する最深の祖先まで canonicalize し、残りを字句的に足したパスを返す。
/// まだ作られていない格納先でも「実体としてどこを指すか」を比較できるようにする
/// （macOS の `/tmp` → `/private/tmp` のようなリンクを跨ぐ指定があるため必須）。
pub(crate) fn canonical_or_nearest(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = fs::canonicalize(&current) {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        let Some(name) = current.file_name().map(|n| n.to_os_string()) else {
            return path.to_path_buf();
        };
        tail.push(name);
        if !current.pop() {
            return path.to_path_buf();
        }
    }
}

/// リポジトリ外の格納先を絶対パスへ解決する。`~` 展開と `.` / `..` の字句的な畳み込みだけを行い、
/// まだ存在しない最終パスを canonicalize しようとはしない。
/// リポジトリ配下を指す指定は「リポジトリ配下」モードの領分なので拒否する。
pub(crate) fn resolved_external_directory(root: &Path, directory: &str) -> Result<PathBuf, String> {
    let directory = directory.trim();
    if directory.is_empty() || directory.len() > 512 || directory.chars().any(char::is_control) {
        return Err("invalid worktree directory".into());
    }
    let expanded: PathBuf =
        if directory == "~" || directory.starts_with("~/") || directory.starts_with("~\\") {
            let mut path = crate::env::home_dir().ok_or("home directory is unknown")?;
            let rest = directory[1..].trim_start_matches(['/', '\\']);
            if !rest.is_empty() {
                path.push(rest);
            }
            path
        } else {
            let path = PathBuf::from(directory);
            // 相対指定はリポジトリルート基準（`../worktrees` を素直に書けるようにする）
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        };

    let mut normalized = PathBuf::new();
    for component in expanded.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("invalid worktree directory".into());
                }
            }
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or("worktree directory must be valid UTF-8")?;
                if part.eq_ignore_ascii_case(".git") {
                    return Err("worktree directory cannot be inside .git".into());
                }
                normalized.push(part);
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.is_absolute() {
        return Err("worktree directory must resolve to an absolute path".into());
    }
    if canonical_or_nearest(&normalized).starts_with(canonical_or_nearest(root)) {
        return Err("this path is inside the repository; use the in-repository option".into());
    }
    Ok(normalized)
}

/// 既存の格納先が symlink を経由してリポジトリ外へ抜けないことを確認する。
pub(crate) fn worktree_parent_path(root: &Path, directory: &str) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in Path::new(directory).components() {
        let Component::Normal(part) = component else {
            return Err("invalid worktree directory".into());
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("worktree directory cannot contain symlinks".into());
            }
            Ok(meta) if !meta.is_dir() => {
                return Err(format!(
                    "worktree directory is not a directory: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(root.join(directory))
}

#[cfg(test)]
mod tests {
    use super::{normalized_worktree_directory, resolved_external_directory, worktree_dir_name};
    use crate::testutil::TempRepo;

    #[test]
    fn worktree_directory_name_flattens_branch_paths() {
        assert_eq!(
            worktree_dir_name("issue/42-fix quoted/value"),
            "issue-42-fix-quoted-value"
        );
        assert_eq!(worktree_dir_name("...///"), "");
    }

    #[test]
    fn worktree_directory_must_stay_below_repository() {
        assert_eq!(
            normalized_worktree_directory(".worktree").unwrap(),
            ".worktree"
        );
        assert_eq!(
            normalized_worktree_directory("tools/worktrees").unwrap(),
            "tools/worktrees"
        );
        assert!(normalized_worktree_directory("../outside").is_err());
        assert!(normalized_worktree_directory("/tmp/worktrees").is_err());
        assert!(normalized_worktree_directory(".git/worktrees").is_err());
    }

    #[test]
    fn external_worktree_directory_resolves_outside_repo() {
        let repo = TempRepo::new();
        let root = &repo.0;
        // 相対指定はリポジトリルート基準で解決する
        assert_eq!(
            resolved_external_directory(root, "../worktrees").unwrap(),
            root.parent().unwrap().join("worktrees")
        );
        // 絶対指定はそのまま。`.` / `..` は字句的に畳む
        let outside = root.parent().unwrap().join("elsewhere");
        assert_eq!(
            resolved_external_directory(root, &format!("{}/./sub/..", outside.display())).unwrap(),
            outside
        );
        // `~` はホームへ展開する
        let home = crate::env::home_dir().expect("home directory");
        assert_eq!(
            resolved_external_directory(root, "~/worktrees").unwrap(),
            home.join("worktrees")
        );
    }

    #[test]
    fn external_worktree_directory_rejects_paths_inside_repo() {
        let repo = TempRepo::new();
        let root = &repo.0;
        assert!(resolved_external_directory(root, ".worktree").is_err());
        assert!(resolved_external_directory(root, "../").is_ok());
        assert!(resolved_external_directory(root, &root.join("trees").to_string_lossy()).is_err());
        assert!(resolved_external_directory(root, "../.git/worktrees").is_err());
        assert!(resolved_external_directory(root, "   ").is_err());
    }
}
