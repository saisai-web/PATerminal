//! セッション永続化（session.json）と入力診断ログ。

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
pub(crate) async fn session_save(app: AppHandle, data: String) -> Result<(), String> {
    let path = session_path(&app)?;
    // 書き込み途中のクラッシュで壊れないよう、一時ファイル経由で置き換える
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn session_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = session_path(&app)?;
    if path.exists() {
        fs::read_to_string(path)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

/// 入力診断ログの追記（打鍵取りこぼし調査用の一時コマンド。解決後に削除してよい）
#[tauri::command]
pub(crate) async fn diag_save(app: AppHandle, line: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("diag.log"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}
