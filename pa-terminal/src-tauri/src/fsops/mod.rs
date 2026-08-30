//! エクスプローラーとファイルビューアのファイル操作。
//!
//! - ここ（`mod`）… ディレクトリ一覧・フォルダ作成・ゴミ箱への削除・DnD 移動
//! - `import`     … Files パネルの選択からファイル / フォルダをコピー
//! - `search`     … 配下を含む名前検索（上限つきの幅優先）
//! - `file`       … ファイルビューアの読み込み / 上書き保存
//!
//! 一覧はエントリ名と種別しか返さない（意図的な制約。巨大ディレクトリでも軽く保つ）。

pub(crate) mod file;
pub(crate) mod import;
pub(crate) mod search;

use std::fs;

use serde::Serialize;

/// 一覧取得ではエントリ名と種別以外を読まず、巨大ディレクトリでも軽く保つ。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsEntry {
    pub(crate) name: String,
    pub(crate) is_dir: bool,
    /// シンボリックリンクか（配下検索で降りない判断に使う。フロントへは送らない）
    #[serde(skip)]
    pub(crate) is_link: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsListing {
    entries: Vec<FsEntry>,
    truncated: bool,
}

/// 巨大ディレクトリ（node_modules 等）でフロントが固まらないよう打ち切る上限
const FS_LIST_MAX: usize = 500;

/// 1ディレクトリを「フォルダが先・名前順」で読む。fs_list と fs_search の共通部分。
pub(crate) fn read_sorted_dir(path: &str) -> std::io::Result<Vec<FsEntry>> {
    let mut entries: Vec<FsEntry> = Vec::new();
    for ent in fs::read_dir(path)? {
        let Ok(ent) = ent else { continue };
        let name = ent.file_name().to_string_lossy().into_owned();
        let (is_dir, is_link) = match ent.file_type() {
            // ディレクトリへのシンボリックリンクは下れるように dir 扱いにする
            Ok(ft) if ft.is_symlink() => (
                fs::metadata(ent.path())
                    .map(|m| m.is_dir())
                    .unwrap_or(false),
                true,
            ),
            Ok(ft) => (ft.is_dir(), false),
            Err(_) => (false, false),
        };
        entries.push(FsEntry {
            name,
            is_dir,
            is_link,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub(crate) async fn fs_list(path: String) -> Result<FsListing, String> {
    let mut entries = read_sorted_dir(&path).map_err(|e| e.to_string())?;
    let truncated = entries.len() > FS_LIST_MAX;
    entries.truncate(FS_LIST_MAX);
    Ok(FsListing { entries, truncated })
}

/// パスが読み取り可能なディレクトリかだけを確認する。内容の列挙はしないので、
/// 新規セッションの作成先検証など巨大なディレクトリにも使える。
#[tauri::command]
pub(crate) async fn fs_is_dir(path: String) -> Result<(), String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        Ok(())
    } else {
        Err("path is not a directory".to_string())
    }
}

/// エクスプローラーの「新しいフォルダ」。親を暗黙作成しないことで入力ミスを局所化する。
#[tauri::command]
pub(crate) async fn fs_create_dir(path: String) -> Result<(), String> {
    fs::create_dir(&path).map_err(|e| e.to_string())
}

/// エクスプローラーの削除。恒久削除ではなく OS のゴミ箱へ移す（Finder と同じ・復元可能）。
/// ファイル操作に確認ダイアログを挟まない方針なので、必ず復元できる経路だけを持つ。
#[tauri::command]
pub(crate) async fn fs_trash(path: String) -> Result<(), String> {
    // ゴミ箱への移動は OS の API 呼び出しでブロックしうるので executor から外す
    tauri::async_runtime::spawn_blocking(move || trash::delete(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// DnD 移動の移動先パスを組み立てる。パスはフロントが "/" 区切りへ正規化した絶対パスで
/// 渡してくる前提。字句的に分かる事故（ルートの移動・自分自身/自分の配下への移動）は
/// ファイルシステムに触る前にここで弾く。
fn move_destination(src: &str, dest_dir: &str) -> Result<String, String> {
    let src_norm = src.trim_end_matches('/');
    let name = src_norm.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name.ends_with(':') {
        // "/" や "C:/"（ドライブルート）は動かせない
        return Err("invalid source path".to_string());
    }
    let dest_trim = dest_dir.trim_end_matches('/');
    if dest_trim == src_norm || dest_trim.starts_with(&format!("{src_norm}/")) {
        return Err("cannot move a folder into itself".to_string());
    }
    Ok(format!("{dest_trim}/{name}"))
}

/// fs_move の本体（同期）。テストから直接呼ぶ。
fn move_entry(src: &str, dest_dir: &str) -> Result<String, String> {
    let dest = move_destination(src, dest_dir)?;
    // rename は空ディレクトリ等を静かに置き換えることがあるので、上書きは先に拒否する
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(format!("already exists: {dest}"));
    }
    fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// エクスプローラーのドラッグ&ドロップ移動。移動先フォルダの中へ同名で rename する。
/// 同一ボリューム内のみ（クロスデバイスは OS のエラーをそのまま表示する）。
#[tauri::command]
pub(crate) async fn fs_move(src: String, dest_dir: String) -> Result<String, String> {
    move_entry(&src, &dest_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempRepo;

    #[test]
    fn move_destination_joins_basename() {
        assert_eq!(
            move_destination("/a/b/file.txt", "/a/c").unwrap(),
            "/a/c/file.txt"
        );
        assert_eq!(move_destination("/a/b", "/").unwrap(), "/b");
        assert_eq!(move_destination("C:/Users/x/doc", "C:/").unwrap(), "C:/doc");
    }

    #[test]
    fn move_destination_rejects_into_itself() {
        assert!(move_destination("/a/b", "/a/b").is_err());
        assert!(move_destination("/a/b", "/a/b/c").is_err());
        // 名前が前方一致するだけの隣のフォルダは弾かない
        assert!(move_destination("/a/b", "/a/bc").is_ok());
    }

    #[test]
    fn move_destination_rejects_roots() {
        assert!(move_destination("/", "/tmp").is_err());
        assert!(move_destination("C:/", "C:/tmp").is_err());
    }

    #[test]
    fn move_entry_renames_into_directory() {
        let tmp = TempRepo::new();
        let root = tmp.0.to_string_lossy().replace('\\', "/");
        fs::write(tmp.0.join("a.txt"), "hello").unwrap();
        fs::create_dir(tmp.0.join("sub")).unwrap();
        let dest = move_entry(&format!("{root}/a.txt"), &format!("{root}/sub")).unwrap();
        assert_eq!(dest, format!("{root}/sub/a.txt"));
        assert!(!tmp.0.join("a.txt").exists());
        assert_eq!(fs::read_to_string(tmp.0.join("sub/a.txt")).unwrap(), "hello");
    }

    #[test]
    fn move_entry_refuses_overwrite() {
        let tmp = TempRepo::new();
        let root = tmp.0.to_string_lossy().replace('\\', "/");
        fs::write(tmp.0.join("a.txt"), "src").unwrap();
        fs::create_dir(tmp.0.join("sub")).unwrap();
        fs::write(tmp.0.join("sub/a.txt"), "existing").unwrap();
        let err = move_entry(&format!("{root}/a.txt"), &format!("{root}/sub")).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // どちらのファイルも無傷のまま
        assert_eq!(fs::read_to_string(tmp.0.join("a.txt")).unwrap(), "src");
        assert_eq!(fs::read_to_string(tmp.0.join("sub/a.txt")).unwrap(), "existing");
    }
}
