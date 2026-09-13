//! アプリ本体まわりの雑務。
//!
//! - `session` … session.json の保存 / 読み込みと診断ログ
//! - `update`  … GitHub Releases でのアップデート確認
//! - `os`      … 既定ブラウザ / 既定アプリ / ファイルマネージャーへ渡す
//! - `drop`    … OS からのファイルドロップをペインへのパス入力にする（ネイティブ横取り）
//! - `finder`  … Finder から渡されたフォルダの受け取りとクイックアクションの設置（macOS）

pub(crate) mod drop;
pub(crate) mod finder;
pub(crate) mod os;
pub(crate) mod session;
pub(crate) mod update;

/// フロントの UI 出し分け用。"macos" | "windows" | "linux"
#[tauri::command]
pub(crate) async fn host_os() -> &'static str {
    std::env::consts::OS
}
