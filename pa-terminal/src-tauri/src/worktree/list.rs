//! 登録済み worktree の一覧と削除（Worktree タブ / 作成モーダル下部の一覧）。

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::path::canonical_or_nearest;
use crate::git::{git_output_text, run_git};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeEntry {
    pub(crate) path: String,
    /// 短縮ブランチ名。detached / bare のときは空
    pub(crate) branch: String,
    /// 短縮 SHA
    pub(crate) head: String,
    /// porcelain の先頭レコード = メイン worktree
    pub(crate) is_main: bool,
    /// 監視中のリポジトリルートそのもの = いま開いている worktree
    pub(crate) is_current: bool,
    pub(crate) detached: bool,
    bare: bool,
    pub(crate) locked: bool,
    pub(crate) lock_reason: String,
    /// ディレクトリが消えている（prune 対象）
    pub(crate) missing: bool,
}

#[derive(Serialize)]
pub(crate) struct WorktreeList {
    pub(crate) entries: Vec<WorktreeEntry>,
}

/// `git worktree list --porcelain` の解析。レコードは空行区切りで、先頭がメイン worktree。
/// `missing` はここでは `prunable` 行だけを見る（ディレクトリの実在確認は呼び出し側）。
fn parse_worktree_list(stdout: &str, root: &str) -> Vec<WorktreeEntry> {
    fn trim_sep(s: &str) -> &str {
        let trimmed = s.trim_end_matches(['/', '\\']);
        if trimmed.is_empty() {
            s
        } else {
            trimmed
        }
    }
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in stdout.lines().chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(WorktreeEntry {
                path: path.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: entries.is_empty(),
                is_current: trim_sep(path) == trim_sep(root),
                detached: false,
                bare: false,
                locked: false,
                lock_reason: String::new(),
                missing: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = head.chars().take(7).collect();
        } else if let Some(reference) = line.strip_prefix("branch ") {
            entry.branch = reference
                .strip_prefix("refs/heads/")
                .unwrap_or(reference)
                .to_string();
        } else if line == "detached" {
            entry.detached = true;
        } else if line == "bare" {
            entry.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            entry.locked = true;
            entry.lock_reason = line["locked".len()..].trim().to_string();
        } else if line == "prunable" || line.starts_with("prunable ") {
            entry.missing = true;
        } else if line.is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
        }
    }
    entries
}

pub(crate) fn worktree_entries(root: &str) -> Result<Vec<WorktreeEntry>, String> {
    if !PathBuf::from(root).is_dir() {
        return Err("repository not found".into());
    }
    let out = run_git(&["-C", root, "worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    let mut entries = parse_worktree_list(&String::from_utf8_lossy(&out.stdout), root);
    // git が返すのは実体パスなので、渡された root がリンク経由でも同じ worktree だと分かるようにする
    let real_root = canonical_or_nearest(Path::new(root));
    for entry in &mut entries {
        if !entry.is_current {
            entry.is_current = canonical_or_nearest(Path::new(&entry.path)) == real_root;
        }
        if !entry.missing && !entry.bare {
            entry.missing = !PathBuf::from(&entry.path).is_dir();
        }
    }
    Ok(entries)
}

/// リポジトリに登録されている worktree の一覧。
#[tauri::command]
pub(crate) async fn git_worktree_list(root: String) -> Result<WorktreeList, String> {
    Ok(WorktreeList {
        entries: worktree_entries(&root)?,
    })
}

/// 登録済みの worktree を1つ削除する。**ブランチは残す**（`git worktree remove` の既定どおり）。
/// 一覧に無いパス・メイン・いま開いている worktree は拒否して、任意パス削除にはしない。
#[tauri::command]
pub(crate) async fn git_worktree_remove(
    root: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    let entries = worktree_entries(&root)?;
    let target = canonical_or_nearest(Path::new(&path));
    let Some(entry) = entries
        .into_iter()
        .find(|e| e.path == path || canonical_or_nearest(Path::new(&e.path)) == target)
    else {
        return Err("unknown worktree".into());
    };
    if entry.is_main {
        return Err("cannot remove the main worktree".into());
    }
    if entry.is_current {
        return Err("cannot remove the worktree you are in".into());
    }
    if entry.missing {
        // ディレクトリが消えている登録は remove では消せないので prune で片付ける
        let out = run_git(&["-C", &root, "worktree", "prune"])?;
        if !out.status.success() {
            return Err(git_output_text(&out));
        }
        return Ok(());
    }
    let mut args = vec!["-C", &root, "worktree", "remove"];
    if force {
        args.push("--force");
        // ロック済みの worktree は --force 2回でないと外れない
        if entry.locked {
            args.push("--force");
        }
    }
    args.push(&entry.path);
    let out = run_git(&args)?;
    if !out.status.success() {
        return Err(git_output_text(&out));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_worktree_list;

    #[test]
    fn worktree_list_parses_porcelain_records() {
        let stdout = concat!(
            "worktree /repo\n",
            "HEAD abcdef1234567890\n",
            "branch refs/heads/main\n",
            "\n",
            "worktree /repo/.worktree/feat-a\n",
            "HEAD 1234567890abcdef\n",
            "branch refs/heads/feat/a\n",
            "locked reason here\n",
            "\n",
            "worktree /elsewhere/detached\n",
            "HEAD fedcba0987654321\n",
            "detached\n",
            "prunable gitdir file points to non-existent location\n",
            "\n",
        );
        let entries = parse_worktree_list(stdout, "/repo/");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "/repo");
        assert_eq!(entries[0].branch, "main");
        assert_eq!(entries[0].head, "abcdef1");
        assert!(entries[0].is_main && entries[0].is_current);
        assert_eq!(entries[1].branch, "feat/a");
        assert!(!entries[1].is_main && !entries[1].is_current);
        assert!(entries[1].locked);
        assert_eq!(entries[1].lock_reason, "reason here");
        assert_eq!(entries[2].branch, "");
        assert!(entries[2].detached && entries[2].missing);
    }
}
