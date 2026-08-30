//! license.json の読み書き。session.json とは別ファイル（フロントが session_save で
//! 丸ごと上書きするため、ライセンスデータは Rust 所有に分離する）。
//! 書き込みは session.rs と同じ tmp 書き → rename の原子的置き換え。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub(crate) struct LicenseStore {
    /// 明示同意した EULA の版。公式ビルドは現行版との完全一致を起動前に確認する。
    pub accepted_eula_version: Option<String>,
    /// EULA へ明示同意した時刻（unix 秒）。監査用で、ライセンス判定には使わない。
    pub eula_accepted_at: Option<u64>,
    /// トライアル開始（unix 秒）。OS 側の二重記録と min 合成する（trial.rs）
    pub trial_start: Option<u64>,
    /// 最後に見た時刻。時計巻き戻し対策（effective_now = max(now, last_seen)）
    pub last_seen: u64,
    /// 登録済みライセンスキーの原文
    pub key: Option<String>,
    /// Polar 検証が最後に成功した時刻。Grace 30日の起点
    pub last_validation_ok: Option<u64>,
    /// Polar のアクティベーション ID（デバイス解除・再検証に使う）
    pub activation_id: Option<String>,
    /// Win-back の7日再トライアルを使用済みか（一度きり）
    pub retrial_used: bool,
    /// 再トライアル開始時刻
    pub retrial_start: Option<u64>,
    /// Locked へ遷移した時刻。Win-back 30日カウントの起点
    pub locked_since: Option<u64>,
    /// 表示済みバナー ID（"trial7" / "trial3" / "trial1" / "lockedOnce"）
    pub banners_shown: Vec<String>,
    /// 初回ガイドを閉じたか（閉じたら二度と自動表示しない）
    pub guide_dismissed: bool,
    /// 自ビルドの新バージョン通知をオフにしたか
    pub update_notify_off: bool,
    /// 自ビルドの新バージョン通知を最後に出した時刻（1日1回制限）
    pub last_update_notify: Option<u64>,
}

fn license_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("license.json"))
}

pub(crate) fn load(app: &AppHandle) -> Result<LicenseStore, String> {
    let path = license_path(app)?;
    if !path.exists() {
        return Ok(LicenseStore::default());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    // 壊れたファイルで起動不能にしない（トライアル記録は OS 側の二重化が拾う）
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

pub(crate) fn save(app: &AppHandle, store: &LicenseStore) -> Result<(), String> {
    let path = license_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string(store).map_err(|e| e.to_string())?;
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
