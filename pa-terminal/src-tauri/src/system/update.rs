//! アップデート確認（GitHub Releases）。バージョン比較は設定パネル側で行う。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// アップデート確認先のリポジトリ。公開リポジトリ名を変えたらここを更新する
const UPDATE_REPO: &str = "saisai-web/PATerminal";

#[derive(Serialize)]
pub(crate) struct UpdateInfo {
    current: String,
    latest: Option<String>,
    url: Option<String>,
}

#[derive(Default)]
pub(crate) struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficialUpdateInfo {
    current_version: String,
    version: String,
    body: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

#[tauri::command]
pub(crate) async fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub(crate) async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let resp = reqwest::Client::new()
        .get(format!(
            "https://api.github.com/repos/{UPDATE_REPO}/releases/latest"
        ))
        // GitHub API は User-Agent 必須
        .header("User-Agent", format!("PATerminal/{current}"))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        // リポジトリ未公開の 404 やレート制限の 403 はフロントで「確認できませんでした」表示
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(UpdateInfo {
        current,
        latest: v["tag_name"].as_str().map(String::from),
        url: v["html_url"].as_str().map(String::from),
    })
}

/// 公式ビルドだけが署名付き updater を使う。selfbuild の通知は update_check のまま。
#[tauri::command]
pub(crate) async fn official_update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<OfficialUpdateInfo>, String> {
    if !crate::license::IS_OFFICIAL {
        return Err("signed updater is available only in official builds".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|value| OfficialUpdateInfo {
        current_version: value.current_version.clone(),
        version: value.version.clone(),
        body: value.body.clone(),
    });
    *pending.0.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

/// 保留中の署名付き成果物を取得・検証・インストールし、macOSでは再起動する。
/// Windowsはインストーラ制約により install 内でアプリが終了する。
#[tauri::command]
pub(crate) async fn official_update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    if !crate::license::IS_OFFICIAL {
        return Err("signed updater is available only in official builds".into());
    }
    let update = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("there is no pending update")?;
    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
