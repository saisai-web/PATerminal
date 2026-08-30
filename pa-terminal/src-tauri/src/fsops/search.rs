//! エクスプローラーの配下検索。打鍵ごとに走るので「返ってこない検索」を作らないことを優先し、
//! 件数 / 走査数 / 深さ / 時間のどれかに触れたら `truncated` を立てて打ち切る。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{read_sorted_dir, FsEntry};

/// 検索ヒット1件。フロントは path でそのまま開き、parent を文脈表示に使う。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsMatch {
    path: String,
    name: String,
    is_dir: bool,
    parent: String,
    /// 検索起点からの階層（1 = 直下）。フロントは 2 以上を「配下」として別枠に出す
    depth: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsSearchResult {
    matches: Vec<FsMatch>,
    /// 上限（件数 / 走査数 / 時間 / 深さ）で打ち切った = 全件ではない
    truncated: bool,
}

/// 打ち切り上限。打鍵ごとに走るので「返ってこない検索」を作らないことを優先する
const FS_SEARCH_MAX_MATCHES: usize = 300;
const FS_SEARCH_MAX_SCANNED: usize = 50_000;
const FS_SEARCH_MAX_DEPTH: usize = 12;
const FS_SEARCH_TIME_LIMIT: Duration = Duration::from_millis(3000);

/// 配下を含む名前検索。幅優先なので浅い階層のヒットが先に並ぶ。
/// シンボリックリンクのディレクトリへは降りない（循環と重複を避ける）。
/// `.git` は常に除外し、それ以外の隠しディレクトリは include_hidden に従う。
#[tauri::command]
pub(crate) async fn fs_search(
    path: String,
    query: String,
    include_hidden: bool,
) -> Result<FsSearchResult, String> {
    // ディレクトリ走査は重い同期処理なので非同期ランタイムのワーカーを塞がない
    tauri::async_runtime::spawn_blocking(move || fs_search_blocking(&path, &query, include_hidden))
        .await
        .map_err(|e| e.to_string())?
}

fn fs_search_blocking(
    root: &str,
    query: &str,
    include_hidden: bool,
) -> Result<FsSearchResult, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(FsSearchResult {
            matches: Vec::new(),
            truncated: false,
        });
    }
    let needle = needle.as_str();
    // 起点が読めないときだけエラー。途中の読めないディレクトリは飛ばして続ける
    let first = read_sorted_dir(root).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut matches: Vec<FsMatch> = Vec::new();
    let mut queue: VecDeque<(String, Vec<FsEntry>, usize)> = VecDeque::new();
    // 末尾の区切りは `/` `\` の両方を落とす。POSIX のルート `/` は空文字になり、
    // Windows のドライブルート `C:/` `C:\` は `C:` になる（どちらも下で `{parent}/{name}` に繋ぐ）
    queue.push_back((root.trim_end_matches(['/', '\\']).to_string(), first, 1));
    let mut scanned = 0usize;
    let mut truncated = false;
    let mut stop = false;
    while let Some((parent, entries, depth)) = queue.pop_front() {
        for ent in entries {
            scanned += 1;
            if scanned > FS_SEARCH_MAX_SCANNED || started.elapsed() > FS_SEARCH_TIME_LIMIT {
                truncated = true;
                stop = true;
                break;
            }
            let hidden = ent.name.starts_with('.');
            if hidden && !include_hidden {
                continue;
            }
            let full = format!("{}/{}", parent, ent.name);
            if ent.name.to_lowercase().contains(needle) {
                if matches.len() >= FS_SEARCH_MAX_MATCHES {
                    truncated = true;
                    stop = true;
                    break;
                }
                matches.push(FsMatch {
                    path: full.clone(),
                    name: ent.name.clone(),
                    is_dir: ent.is_dir,
                    parent: parent.clone(),
                    depth,
                });
            }
            if !ent.is_dir || ent.name == ".git" || ent.is_link {
                continue;
            }
            if depth >= FS_SEARCH_MAX_DEPTH {
                truncated = true;
                continue;
            }
            if let Ok(children) = read_sorted_dir(&full) {
                queue.push_back((full, children, depth + 1));
            }
        }
        if stop {
            break;
        }
    }
    Ok(FsSearchResult { matches, truncated })
}

#[cfg(test)]
mod tests {
    use super::fs_search_blocking;
    use crate::testutil::TempRepo;
    use std::fs;

    #[test]
    fn fs_search_finds_nested_entries() {
        let repo = TempRepo::new();
        let root = repo.0.clone();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("target.txt"), "a").unwrap();
        fs::write(root.join("src/deep/target-deep.txt"), "b").unwrap();
        fs::write(root.join(".git/objects/target-git.txt"), "c").unwrap();
        fs::write(root.join(".hidden/target-hidden.txt"), "d").unwrap();

        let hits = fs_search_blocking(root.to_str().unwrap(), "target", true).unwrap();
        let names: Vec<&str> = hits.matches.iter().map(|m| m.name.as_str()).collect();
        // 直下も配下も拾い、.git の中だけは常に除外する
        assert!(names.contains(&"target.txt"), "{names:?}");
        assert!(names.contains(&"target-deep.txt"), "{names:?}");
        assert!(names.contains(&"target-hidden.txt"), "{names:?}");
        assert!(!names.contains(&"target-git.txt"), "{names:?}");
        assert!(!hits.truncated);
        // 幅優先なので浅い順（直下 = depth 1 が先頭）
        assert_eq!(hits.matches[0].name, "target.txt");
        assert_eq!(hits.matches[0].depth, 1);
        let deep = hits
            .matches
            .iter()
            .find(|m| m.name == "target-deep.txt")
            .unwrap();
        assert_eq!(deep.depth, 3);
        assert_eq!(deep.parent, format!("{}/src/deep", root.to_str().unwrap()));

        // 隠しファイル非表示のときは隠しディレクトリの中も走査しない
        let visible = fs_search_blocking(root.to_str().unwrap(), "TARGET", false).unwrap();
        let names: Vec<&str> = visible.matches.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"target-deep.txt"), "{names:?}"); // 大文字小文字は無視
        assert!(!names.contains(&"target-hidden.txt"), "{names:?}");

        // 空クエリは走査しない
        let empty = fs_search_blocking(root.to_str().unwrap(), "", true).unwrap();
        assert!(empty.matches.is_empty());
    }
}
