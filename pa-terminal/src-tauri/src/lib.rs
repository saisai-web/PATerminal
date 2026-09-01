//! Tauri のエントリ。**配線だけ**を持つ（フロントの `src/main.ts` と同じ役割）。
//! 状態も型もコマンドの実装も各機能モジュールが所有する。
//!
//! `#[tauri::command]` は**定義したモジュールのパス**で登録する。コマンド登録は
//! 関数だけでなく同名の補助マクロも辿るため、`mod.rs` での再エクスポートは使えない。
//!
//! Rust → フロントのイベントは `pty` モジュールが出す3種類だけ:
//! `pty:exit`（プロセス終了）/ `pty:act`（busy/idle 遷移 + 静止時の入力待ち判定）/
//! `pty:bell`（本物の BEL）。

mod agents;
mod env;
mod fsops;
mod git;
mod github;
mod license;
mod pty;
mod system;
#[cfg(test)]
mod testutil;
mod worktree;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());

    // The base config intentionally has no signed-updater settings. Only official
    // release builds receive tauri.ci.conf.json with the public key and endpoint.
    #[cfg(feature = "official")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(pty::Panes::default())
        .manage(license::LicenseState::default())
        .manage(system::update::PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            // ターミナル
            crate::pty::pty_spawn,
            crate::pty::pty_write,
            crate::pty::pty_broadcast,
            crate::pty::pty_set_visible,
            crate::pty::pty_resize,
            crate::pty::pty_kill,
            crate::pty::pty_cwd,
            crate::pty::pty_agents,
            // AI エージェントのセッション再開情報
            crate::agents::agent_session_id,
            crate::agents::list::agent_session_list,
            crate::agents::signal::agent_signal_init,
            // エクスプローラー / ファイルビューア
            crate::fsops::fs_list,
            crate::fsops::fs_is_dir,
            crate::fsops::fs_create_dir,
            crate::fsops::fs_trash,
            crate::fsops::fs_move,
            crate::fsops::import::fs_import,
            crate::fsops::search::fs_search,
            crate::fsops::file::fs_read,
            crate::fsops::file::fs_read_image,
            crate::fsops::file::fs_write,
            // git: 変更検出 / 差分 / 作業ツリー操作 / ブランチ / 履歴
            crate::git::status::git_changes,
            crate::git::status::git_summary,
            crate::git::diff::git_file_diff,
            crate::git::diff::git_commit_diff,
            crate::git::diff::git_worktree_diff,
            crate::git::commit::git_reset_to_commit,
            crate::git::commit::git_stash,
            crate::git::commit::git_commit,
            crate::git::branch::git_branches,
            crate::git::branch::git_switch_branch,
            crate::git::branch::git_push,
            crate::git::branch::git_fetch,
            crate::git::branch::git_pull,
            crate::git::log::git_log,
            // git worktree
            crate::worktree::create::git_worktree_branches,
            crate::worktree::create::git_worktree_create,
            crate::worktree::create::git_worktree_from_pr,
            crate::worktree::list::git_worktree_list,
            crate::worktree::list::git_worktree_remove,
            // GitHub（gh CLI）
            crate::github::pr::pr_list,
            crate::github::pr::pr_info,
            crate::github::pr::pr_detail,
            crate::github::pr::pr_diff,
            crate::github::issue::issue_list,
            crate::github::issue::issue_info,
            crate::github::issue::issue_create,
            crate::github::issue::issue_link_branch,
            // ライセンス / トライアル / ソフトロック
            crate::license::eula_status,
            crate::license::eula_accept,
            crate::license::eula_decline,
            crate::license::third_party_notices,
            crate::license::license_status,
            crate::license::license_activate,
            crate::license::license_deactivate,
            crate::license::license_devices,
            crate::license::license_device_remove,
            crate::license::license_retrial,
            crate::license::license_banner_seen,
            crate::license::license_guide_dismiss,
            crate::license::license_update_notify,
            // 実行環境 / OS 連携 / 永続化
            crate::system::host_os,
            crate::system::session::session_save,
            crate::system::session::session_load,
            crate::system::session::diag_save,
            crate::system::update::app_version,
            crate::system::update::update_check,
            crate::system::update::official_update_check,
            crate::system::update::official_update_install,
            crate::system::os::open_url,
            crate::system::os::open_terminal_url,
            crate::system::os::reveal_path,
            crate::system::os::open_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to start app");
}
