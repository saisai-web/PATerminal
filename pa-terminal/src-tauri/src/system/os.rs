//! OS 連携（既定ブラウザ / 既定アプリ / ファイルマネージャーへ渡す）。

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::env::HideConsole;

/// OS の「既定のハンドラで開く」。Windows はパス区切りを変換済みの文字列を渡すこと
/// （URL はスラッシュのままでよいので、変換は呼び出し側の責任にしてある）。
fn spawn_os_open(target: &str) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(target);
        c
    } else if cfg!(target_os = "windows") {
        // start の第1引数はウィンドウタイトル扱いなので空文字を挟む
        let mut c = Command::new("cmd");
        c.args(["/c", "start", "", target]);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };
    // Windows の `cmd /c start` はコンソールアプリなので、隠さないと黒い窓が一瞬出る
    cmd.hide_console()
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 既定ブラウザで開いてよい URL か。任意 URL の起動に使われないよう、
/// GitHub のリリースページとライセンス購入ページ（完全一致）だけに限定する
fn url_allowed(url: &str) -> bool {
    url.starts_with("https://github.com/")
        || url == crate::license::polar::CHECKOUT_URL
        || url == crate::license::EULA_URL
        || url == "https://paralellterminal.com/ja/eula"
}

/// リリースページ / 購入ページを既定ブラウザで開く（許可 URL は `url_allowed`）
#[tauri::command]
pub(crate) async fn open_url(url: String) -> Result<(), String> {
    if !url_allowed(&url) {
        return Err("blocked url".into());
    }
    spawn_os_open(&url)
}

/// ターミナル出力上のリンク（Cmd/Ctrl+クリック）として開いてよい URL か。
/// 任意スキームの起動（file: / カスタムスキーム経由のアプリ実行）を避けるため
/// http / https に限定し、空白・制御文字入りと極端に長いものは弾く
fn terminal_url_allowed(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 2048
        && !url.bytes().any(|b| b <= b' ' || b == 0x7f)
}

/// ターミナル出力中の URL を既定ブラウザで開く（xterm のリンク検出から呼ばれる）。
/// Windows は `cmd /c start` を使わない: URL に普通に含まれる `&`（クエリ区切り）や
/// `%`（パーセントエンコード）を cmd.exe がメタ文字 / 変数展開として解釈してしまう。
/// rundll32 の FileProtocolHandler なら URL が argv のまま渡り、既定ブラウザで開く
#[tauri::command]
pub(crate) async fn open_terminal_url(url: String) -> Result<(), String> {
    if !terminal_url_allowed(&url) {
        return Err("blocked url".into());
    }
    if cfg!(target_os = "windows") {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .hide_console()
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        spawn_os_open(&url)
    }
}

/// パスを OS の既定アプリで開く（エクスプローラーのファイル右クリック「開く」）
#[tauri::command]
pub(crate) async fn open_path(path: String) -> Result<(), String> {
    fs::metadata(&path).map_err(|e| e.to_string())?;
    if cfg!(target_os = "windows") {
        spawn_os_open(&path.replace('/', "\\"))
    } else {
        spawn_os_open(&path)
    }
}

/// パスを OS のファイルマネージャー（Finder / Explorer 等）で表示する。
/// ファイルは選択状態で親フォルダを開く（コンテキストメニューの「Finder で表示」）
#[tauri::command]
pub(crate) async fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let is_dir = meta.is_dir();
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        if is_dir {
            c.arg(&path);
        } else {
            c.arg("-R").arg(&path); // -R = Finder で選択表示
        }
        c
    } else if cfg!(target_os = "windows") {
        // explorer はパス区切りに \ が必要。/select, でファイルを選択状態にする
        let win = path.replace('/', "\\");
        let mut c = Command::new("explorer");
        if is_dir {
            c.arg(win);
        } else {
            c.arg(format!("/select,{win}"));
        }
        c
    } else {
        // Linux: xdg-open に選択表示は無いので、ファイルは親ディレクトリを開く
        let target = if is_dir {
            p.clone()
        } else {
            p.parent().map(PathBuf::from).unwrap_or_else(|| p.clone())
        };
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };
    cmd.hide_console()
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{terminal_url_allowed, url_allowed};

    #[test]
    fn url_allowed_permits_github_and_checkout_only() {
        assert!(url_allowed("https://github.com/owner/repo/releases"));
        assert!(url_allowed(crate::license::polar::CHECKOUT_URL));
        assert!(url_allowed(crate::license::EULA_URL));
        assert!(url_allowed("https://paralellterminal.com/ja/eula"));
        assert!(!url_allowed("https://paralellterminal.com/eula/evil"));
        assert!(!url_allowed("https://example.com/"));
        assert!(!url_allowed("http://github.com/owner/repo")); // 平文は不可
        assert!(!url_allowed("https://github.com.evil.example/"));
    }

    #[test]
    fn terminal_url_allowed_permits_http_https_only() {
        assert!(terminal_url_allowed("https://example.com/a?b=1&c=%20"));
        assert!(terminal_url_allowed("http://localhost:1420/path"));
        assert!(!terminal_url_allowed("file:///etc/passwd"));
        assert!(!terminal_url_allowed("javascript:alert(1)"));
        assert!(!terminal_url_allowed("ssh://host/repo"));
        assert!(!terminal_url_allowed("https://a.com/b c")); // 空白入り
        assert!(!terminal_url_allowed("https://a.com/\x1b]0;x\x07")); // 制御文字入り
        let long = format!("https://a.com/{}", "x".repeat(2048));
        assert!(!terminal_url_allowed(&long));
    }
}
