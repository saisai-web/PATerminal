//! ファイルビューア / 簡易編集（エクスプローラーのファイルクリックで開くモーダル用）。

use std::fs;
use std::io::Read;

use serde::Serialize;
use tauri::ipc::Response;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsFile {
    text: String,
    truncated: bool,
    binary: bool,
}

/// ビューアで扱う上限。超過分は読まず、先頭のみ表示（読み取り専用扱い）
const FS_READ_MAX: u64 = 1_048_576;
/// プレビューで WebView へ一度に渡す画像の上限。高解像度写真を許容しつつ、
/// 誤って巨大なバイナリを読み込んで UI メモリを圧迫しないようにする。
const FS_IMAGE_READ_MAX: u64 = 50 * 1_048_576;

#[tauri::command]
pub(crate) async fn fs_read(path: String) -> Result<FsFile, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let truncated = meta.len() > FS_READ_MAX;
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(FS_READ_MAX)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    // NUL 入り = バイナリ扱い（表示も編集もしない）
    if bytes.contains(&0) {
        return Ok(FsFile {
            text: String::new(),
            truncated,
            binary: true,
        });
    }
    Ok(FsFile {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        binary: false,
    })
}

/// 画像プレビュー用。JSON の数値配列に展開せず、Tauri IPC の raw response で返す。
/// 画像形式の判定とデコードは WebView の <img> に任せる。
#[tauri::command]
pub(crate) async fn fs_read_image(path: String) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".to_string());
        }
        if meta.len() > FS_IMAGE_READ_MAX {
            return Err("image is larger than 50 MB".to_string());
        }
        fs::read(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// ビューアからの上書き保存。truncated / binary のファイルはフロント側で
/// 読み取り専用にして呼ばせない
#[tauri::command]
pub(crate) async fn fs_write(path: String, text: String) -> Result<(), String> {
    fs::write(&path, text).map_err(|e| e.to_string())
}
