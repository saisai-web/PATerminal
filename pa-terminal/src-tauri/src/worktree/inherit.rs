//! 作成元チェックアウトの gitignore 対象（`.env` / `node_modules` / `.venv` など）を
//! 新しい worktree へコピーする「環境の引き継ぎ」。
//!
//! 対象の列挙は `git ls-files --others --ignored --exclude-standard --directory -z` に任せる。
//! 丸ごと ignore のディレクトリは `node_modules/` の1行に畳まれ、追跡ファイルを含む
//! ディレクトリの中の ignore 対象は個別のファイルとして出る。サブモジュールは出ない。
//!
//! 守るべきこと:
//! - 新ブランチの追跡ファイルは絶対に上書きしない（作成先に既にあるものは飛ばす）
//! - 作成先そのものと、登録済みの worktree（`.worktree/` コンテナごと ignore されている）は
//!   コピーしない。これは再帰の各階層で判定する（`.worktree/` は1行で出て中が見えないため）
//! - symlink は辿らず、symlink のまま作り直す（`node_modules/.bin` や pnpm の配置を保つ）
//! - 個々のファイルの失敗は警告に留めて続行する（worktree はもうできている）
//!
//! macOS の `fs::copy` は APFS の clonefile を先に試すので、大きな `node_modules` でも
//! 時間もディスクもほとんど使わない。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::list::worktree_entries;
use super::path::canonical_or_nearest;
use crate::git::{git_output_text, run_git};

/// 警告として結果に載せる行数の上限（`#git-msg` の帯を溢れさせない）。
const MAX_WARNING_LINES: usize = 5;

#[derive(Debug, Default)]
pub(crate) struct InheritSummary {
    /// コピーした最上位エントリの数（一部失敗したものも含む）
    pub(crate) copied: usize,
    /// 作成先に既にあった / 守るべきパスだったので飛ばした最上位エントリの数
    pub(crate) skipped: usize,
    pub(crate) warnings: Vec<String>,
}

impl InheritSummary {
    pub(crate) fn warning_text(&self) -> Option<String> {
        if self.warnings.is_empty() {
            return None;
        }
        let mut lines: Vec<String> = self
            .warnings
            .iter()
            .take(MAX_WARNING_LINES)
            .cloned()
            .collect();
        if self.warnings.len() > MAX_WARNING_LINES {
            lines.push(format!(
                "... and {} more",
                self.warnings.len() - MAX_WARNING_LINES
            ));
        }
        Some(lines.join("\n"))
    }

    fn warn(&mut self, path: &Path, error: impl std::fmt::Display) {
        self.warnings.push(format!("{}: {error}", path.display()));
    }
}

/// `root` の gitignore 対象を `target`（作成直後の worktree）へコピーする。
/// 列挙自体（git / worktree 一覧）に失敗したときだけ `Err`。ファイル単位の失敗は警告。
pub(crate) fn inherit_ignored(root: &str, target: &Path) -> Result<InheritSummary, String> {
    let root_c = canonical_or_nearest(Path::new(root));
    let protected = protected_paths(root, &root_c, target)?;
    let entries = list_ignored_entries(root)?;
    let mut summary = InheritSummary::default();
    for rel in entries {
        if rel.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        let src = root_c.join(&rel);
        if is_protected(&src, &protected) {
            summary.skipped += 1;
            continue;
        }
        let dst = target.join(&rel);
        if fs::symlink_metadata(&dst).is_ok() {
            summary.skipped += 1;
            continue;
        }
        if copy_entry(&src, &dst, &protected, &mut summary) {
            summary.copied += 1;
        }
    }
    Ok(summary)
}

fn list_ignored_entries(root: &str) -> Result<Vec<PathBuf>, String> {
    let out = run_git(&[
        "-C",
        root,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
    ])?;
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    Ok(parse_ls_files_z(&out.stdout))
}

/// `-z` 出力（NUL 区切り、クォートなし）をルート相対パスにする。ディレクトリの末尾 `/` は落とす。
fn parse_ls_files_z(stdout: &[u8]) -> Vec<PathBuf> {
    stdout
        .split(|b| *b == 0)
        .filter_map(|raw| {
            let raw = raw.strip_suffix(b"/").unwrap_or(raw);
            if raw.is_empty() || raw == b"." {
                return None;
            }
            Some(bytes_to_path(raw))
        })
        .collect()
}

#[cfg(unix)]
fn bytes_to_path(raw: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(raw))
}

#[cfg(not(unix))]
fn bytes_to_path(raw: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(raw).into_owned())
}

/// コピーしてはいけない実体パス: 作成先と、登録済みの worktree（root 自身は除く）。
fn protected_paths(root: &str, root_c: &Path, target: &Path) -> Result<Vec<PathBuf>, String> {
    let mut protected = vec![canonical_or_nearest(target)];
    for entry in worktree_entries(root)? {
        let path = canonical_or_nearest(Path::new(&entry.path));
        if path != root_c && !protected.contains(&path) {
            protected.push(path);
        }
    }
    Ok(protected)
}

/// `cur` が守るべきパスそのもの / その中、または守るべきパスの直接の親（コンテナ）か。
/// コンテナを飛ばすのは、作成先に空の `.worktree/` を作らないため。
fn is_protected(cur: &Path, protected: &[PathBuf]) -> bool {
    protected
        .iter()
        .any(|p| cur.starts_with(p) || p.parent() == Some(cur))
}

/// 最上位エントリ1つのコピー。何か1つでも書けたら true。
fn copy_entry(src: &Path, dst: &Path, protected: &[PathBuf], summary: &mut InheritSummary) -> bool {
    let meta = match fs::symlink_metadata(src) {
        Ok(meta) => meta,
        Err(e) => {
            summary.warn(src, e);
            return false;
        }
    };
    let file_type = meta.file_type();
    if let Some(parent) = dst.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            summary.warn(dst, e);
            return false;
        }
    }
    if file_type.is_symlink() {
        match copy_symlink(src, dst) {
            Ok(()) => true,
            Err(e) => {
                summary.warn(src, e);
                false
            }
        }
    } else if file_type.is_dir() {
        copy_tree(src, dst, protected, summary)
    } else if file_type.is_file() {
        match fs::copy(src, dst) {
            Ok(_) => true,
            Err(e) => {
                summary.warn(src, e);
                false
            }
        }
    } else {
        summary.warn(src, "unsupported file type");
        false
    }
}

/// ディレクトリの再帰コピー。作成先に既にあるサブツリーは飛ばし、`.git` と
/// 守るべきパスは中に入らない。エラーは警告にして続ける。
fn copy_tree(src: &Path, dst: &Path, protected: &[PathBuf], summary: &mut InheritSummary) -> bool {
    match fs::create_dir(dst) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return false,
        Err(e) => {
            summary.warn(dst, e);
            return false;
        }
    }
    let entries = match fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) => {
            summary.warn(src, e);
            return true;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                summary.warn(src, e);
                continue;
            }
        };
        if entry.file_name() == ".git" {
            continue;
        }
        let child_src = entry.path();
        let child_dst = dst.join(entry.file_name());
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                summary.warn(&child_src, e);
                continue;
            }
        };
        if file_type.is_symlink() {
            if let Err(e) = copy_symlink(&child_src, &child_dst) {
                summary.warn(&child_src, e);
            }
        } else if file_type.is_dir() {
            if is_protected(&child_src, protected) {
                continue;
            }
            copy_tree(&child_src, &child_dst, protected, summary);
        } else if file_type.is_file() {
            if let Err(e) = fs::copy(&child_src, &child_dst) {
                summary.warn(&child_src, e);
            }
        } else {
            summary.warn(&child_src, "unsupported file type");
        }
    }
    true
}

/// symlink をリンク先の文字列そのままで作り直す（相対リンクは新しい場所でもそのまま効く）。
fn copy_symlink(src: &Path, dst: &Path) -> io::Result<()> {
    let link = fs::read_link(src)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link, dst)
    }
    #[cfg(windows)]
    {
        // リンク先の種類でディレクトリリンクかファイルリンクかを選ぶ（辿れなければファイル）
        let points_to_dir = fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false);
        if points_to_dir {
            std::os::windows::fs::symlink_dir(&link, dst)
        } else {
            std::os::windows::fs::symlink_file(&link, dst)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{inherit_ignored, parse_ls_files_z};
    use crate::testutil::{test_git, TempRepo};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn init_repo(root: &Path, gitignore: &str) {
        test_git(root, &["init", "--quiet"]);
        test_git(root, &["config", "user.name", "PATerminal Test"]);
        test_git(
            root,
            &["config", "user.email", "paterminal@example.invalid"],
        );
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.js"), "app\n").unwrap();
        fs::write(root.join(".gitignore"), gitignore).unwrap();
        test_git(root, &["add", "src/app.js", ".gitignore"]);
        test_git(root, &["commit", "--quiet", "-m", "initial"]);
        test_git(root, &["branch", "-M", "main"]);
    }

    fn add_worktree(root: &Path, target: &Path, branch: &str) {
        let target_s = target.to_string_lossy().into_owned();
        test_git(
            root,
            &[
                "worktree", "add", "--quiet", "-b", branch, &target_s, "main",
            ],
        );
    }

    #[test]
    fn parses_nul_separated_entries_and_strips_directory_slash() {
        let parsed = parse_ls_files_z(b"node_modules/\0.env\0src/gen.js\0");
        assert_eq!(
            parsed,
            vec![
                PathBuf::from("node_modules"),
                PathBuf::from(".env"),
                PathBuf::from("src/gen.js")
            ]
        );
        assert!(parse_ls_files_z(b"").is_empty());
        assert!(parse_ls_files_z(b"./\0").is_empty());
    }

    #[test]
    fn copies_files_dirs_and_symlinks_but_not_tracked_or_plain_untracked() {
        let repo = TempRepo::new();
        let root = repo.0.join("repo");
        fs::create_dir(&root).unwrap();
        init_repo(&root, "node_modules/\n.env\n*.log\n");
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "pkg\n").unwrap();
        fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("../pkg/index.js", root.join("node_modules/.bin/pkg")).unwrap();
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join("logs/a.log"), "log\n").unwrap();
        fs::write(root.join("notes.txt"), "untracked but not ignored\n").unwrap();

        let target = repo.0.join("trees/feature");
        add_worktree(&root, &target, "feature");
        let summary = inherit_ignored(&root.to_string_lossy(), &target).unwrap();

        assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
        assert_eq!(summary.copied, 3, "{summary:?}");
        assert_eq!(
            fs::read_to_string(target.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        assert_eq!(
            fs::read_to_string(target.join("node_modules/pkg/index.js")).unwrap(),
            "pkg\n"
        );
        assert_eq!(
            fs::read_to_string(target.join("logs/a.log")).unwrap(),
            "log\n"
        );
        assert!(!target.join("notes.txt").exists());
        assert_eq!(
            fs::read_to_string(target.join("src/app.js")).unwrap(),
            "app\n"
        );
        #[cfg(unix)]
        {
            let link = target.join("node_modules/.bin/pkg");
            assert!(fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                fs::read_link(&link).unwrap(),
                PathBuf::from("../pkg/index.js")
            );
            assert_eq!(fs::read_to_string(&link).unwrap(), "pkg\n");
        }
        // 作成元は触らない
        assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "SECRET=1\n");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TempRepo::new();
        let root = repo.0.join("repo");
        fs::create_dir(&root).unwrap();
        init_repo(&root, ".venv/\n");
        fs::create_dir_all(root.join(".venv/bin")).unwrap();
        let tool = root.join(".venv/bin/tool");
        fs::write(&tool, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();

        let target = repo.0.join("trees/feature");
        add_worktree(&root, &target, "feature");
        inherit_ignored(&root.to_string_lossy(), &target).unwrap();

        let mode = fs::metadata(target.join(".venv/bin/tool"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0, "mode={mode:o}");
    }

    #[test]
    fn skips_worktree_container_registered_worktrees_and_nested_git() {
        let repo = TempRepo::new();
        let root = repo.0.join("repo");
        fs::create_dir(&root).unwrap();
        init_repo(&root, ".worktree/\nvendor/\n");
        fs::create_dir_all(root.join("vendor/.git")).unwrap();
        fs::write(root.join("vendor/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(root.join("vendor/lib.js"), "lib\n").unwrap();
        let other = root.join(".worktree/other");
        add_worktree(&root, &other, "other");
        fs::write(other.join("stale.txt"), "should not be copied\n").unwrap();

        let target = root.join(".worktree/new");
        add_worktree(&root, &target, "new");
        let summary = inherit_ignored(&root.to_string_lossy(), &target).unwrap();

        assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
        assert!(!target.join(".worktree").exists());
        assert_eq!(
            fs::read_to_string(target.join("vendor/lib.js")).unwrap(),
            "lib\n"
        );
        assert!(!target.join("vendor/.git").exists());
        assert_eq!(summary.copied, 1);
        assert_eq!(summary.skipped, 1);
    }

    #[test]
    fn never_overwrites_an_existing_destination() {
        let repo = TempRepo::new();
        let root = repo.0.join("repo");
        fs::create_dir(&root).unwrap();
        init_repo(&root, ".env\n");
        fs::write(root.join(".env"), "SOURCE\n").unwrap();

        let target = repo.0.join("trees/feature");
        add_worktree(&root, &target, "feature");
        fs::write(target.join(".env"), "keep\n").unwrap();
        let summary = inherit_ignored(&root.to_string_lossy(), &target).unwrap();

        assert_eq!(fs::read_to_string(target.join(".env")).unwrap(), "keep\n");
        assert_eq!(summary.copied, 0);
        assert_eq!(summary.skipped, 1);
    }
}
