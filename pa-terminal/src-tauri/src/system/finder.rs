//! Finder 連携（macOS）。
//!
//! - Finder の「このアプリケーションで開く」/ Dock へのフォルダドロップ / クイックアクション
//!   （いずれも `open -a PATerminal <folder>` 相当）で渡されたフォルダを `RunEvent::Opened` で
//!   受け取り、溜めておいてフロントに取り出させる。フロントは起動直後（復元完了後）と
//!   `app:open-dirs` イベントの両方で同じコマンドを呼ぶので、アプリ未起動時に渡された分も
//!   起動中に渡された分も一本の経路で新規セッションになる。
//! - 「PATerminalで開く」クイックアクション（`~/Library/Services/*.workflow`）の設置。
//!   Finder の右クリック →「クイックアクション」に出る Automator ワークフローで、中身は
//!   選択したフォルダごとに `open -a PATerminal` を呼ぶシェルスクリプト 1 つ。
//!   アプリ本体の署名や拡張機能の追加が要らないので、自ビルドでもそのまま使える。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, Url};

use crate::env::{home_dir, HideConsole};

/// フロントがまだ取り出していない「開いてほしいフォルダ」
#[derive(Default)]
pub(crate) struct PendingOpenDirs(Mutex<Vec<String>>);

/// Rust → フロント。ペイロードは持たず、フロントは `take_pending_open_dirs` で取り出す
pub(crate) const OPEN_DIRS_EVENT: &str = "app:open-dirs";

/// クイックアクションの表示名（Finder の右クリックにそのまま出る）
pub(crate) const QUICK_ACTION_NAME: &str = "PATerminalで開く";

/// `RunEvent::Opened` から呼ぶ。file URL をディレクトリに解決して溜め、フロントへ通知し、
/// ウィンドウを前面に出す。ファイルが渡された場合はその親ディレクトリにする
pub(crate) fn handle_opened(app: &AppHandle, urls: &[Url]) {
    let dirs: Vec<String> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .filter_map(|p| dir_for_path(&p))
        .collect();
    if dirs.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingOpenDirs>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.extend(dirs);
        }
    }
    let _ = app.emit(OPEN_DIRS_EVENT, ());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 存在するパスをセッションの作業ディレクトリに解決する（ファイルは親フォルダ）
fn dir_for_path(p: &Path) -> Option<String> {
    let meta = fs::metadata(p).ok()?;
    let dir = if meta.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()?.to_path_buf()
    };
    Some(dir.to_string_lossy().into_owned())
}

/// 溜まっているフォルダを取り出して空にする
#[tauri::command]
pub(crate) async fn take_pending_open_dirs(
    state: State<'_, PendingOpenDirs>,
) -> Result<Vec<String>, String> {
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut *pending))
}

fn quick_action_dir() -> Option<PathBuf> {
    home_dir().map(|h| {
        h.join("Library")
            .join("Services")
            .join(format!("{QUICK_ACTION_NAME}.workflow"))
    })
}

/// クイックアクションが設置済みか（設定画面のボタン文言用）
#[tauri::command]
pub(crate) async fn finder_quick_action_installed() -> bool {
    cfg!(target_os = "macos")
        && quick_action_dir()
            .map(|d| d.join("Contents").join("document.wflow").is_file())
            .unwrap_or(false)
}

/// クイックアクションを `~/Library/Services` に設置（上書き）し、設置先のパスを返す
#[tauri::command]
pub(crate) async fn install_finder_quick_action() -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("Finder quick actions are available only on macOS".to_string());
    }
    let dir = quick_action_dir().ok_or_else(|| "home directory not found".to_string())?;
    write_quick_action(&dir)?;
    // Services の一覧を更新する（無くても Finder / ログインのやり直しで反映される）
    let pbs = Path::new("/System/Library/CoreServices/pbs");
    if pbs.exists() {
        let _ = Command::new(pbs).arg("-update").hide_console().spawn();
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// `<dir>/Contents/{Info.plist, document.wflow}` を書く（テストから一時ディレクトリで呼ぶ）
pub(crate) fn write_quick_action(dir: &Path) -> Result<(), String> {
    let contents = dir.join("Contents");
    fs::create_dir_all(&contents).map_err(|e| e.to_string())?;
    fs::write(contents.join("Info.plist"), quick_action_info_plist()).map_err(|e| e.to_string())?;
    fs::write(contents.join("document.wflow"), QUICK_ACTION_DOCUMENT).map_err(|e| e.to_string())
}

/// Services 登録（Finder のフォルダ選択時だけ出す）。表示名は QUICK_ACTION_NAME
fn quick_action_info_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSBackgroundColorName</key>
			<string>background</string>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>{QUICK_ACTION_NAME}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
"#
    )
}

/// Automator の「シェルスクリプトを実行」（入力を引数として渡す）1 アクションだけのワークフロー。
/// `open -a PATerminal` はアプリ側の `public.folder` 関連付け経由で `RunEvent::Opened` に届く
const QUICK_ACTION_DOCUMENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>521</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>for f in "$@"; do open -a PATerminal "$f"; done</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>6B2D6A2E-3C1F-4E6A-9E1B-5B2F0D8C1A01</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>6B2D6A2E-3C1F-4E6A-9E1B-5B2F0D8C1A02</string>
				<key>UUID</key>
				<string>6B2D6A2E-3C1F-4E6A-9E1B-5B2F0D8C1A03</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:253.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict/>
		<key>applicationPaths</key>
		<array/>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.folder</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<integer>0</integer>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_for_path_uses_parent_for_files() {
        let tmp = std::env::temp_dir().join(format!("paterminal-finder-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("a.txt");
        fs::write(&file, "x").unwrap();
        assert_eq!(dir_for_path(&tmp), Some(tmp.to_string_lossy().into_owned()));
        assert_eq!(dir_for_path(&file), Some(tmp.to_string_lossy().into_owned()));
        assert_eq!(dir_for_path(&tmp.join("missing")), None);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_quick_action_creates_valid_plists() {
        let tmp = std::env::temp_dir().join(format!("paterminal-qa-{}.workflow", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        write_quick_action(&tmp).unwrap();
        let info = fs::read_to_string(tmp.join("Contents/Info.plist")).unwrap();
        assert!(info.contains(QUICK_ACTION_NAME));
        assert!(info.contains("com.apple.finder"));
        let doc = fs::read_to_string(tmp.join("Contents/document.wflow")).unwrap();
        assert!(doc.contains("open -a PATerminal"));
        // macOS では plist としての妥当性も確認する（他 OS には plutil が無い）
        let plutil = Path::new("/usr/bin/plutil");
        if plutil.exists() {
            for name in ["Info.plist", "document.wflow"] {
                let status = Command::new(plutil)
                    .arg("-lint")
                    .arg(tmp.join("Contents").join(name))
                    .status()
                    .unwrap();
                assert!(status.success(), "{name} is not a valid plist");
            }
        }
        let _ = fs::remove_dir_all(&tmp);
    }
}
