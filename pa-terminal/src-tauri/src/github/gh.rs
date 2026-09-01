//! gh CLI の実行。**gh を起動するのはここだけ**にして、実行パスの解決・
//! GUI 起動向けの環境変数・タイムアウト・失敗理由の文言を1か所に閉じ込める。

use std::time::Duration;

use crate::env::{executable_candidates, terminal_path, HideConsole};

/// gh CLI の実行パス。Finder 起動の .app は PATH が最小構成（/usr/bin 等のみ）で
/// Homebrew や ~/.local/bin の gh が見つからないため、pty_spawn と同じ探索先を先に確認する
pub(crate) fn gh_program() -> String {
    for p in executable_candidates("gh") {
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    "gh".into()
}

fn configure_gh(cmd: &mut tokio::process::Command, root: &str) {
    cmd.current_dir(root)
        // GUI 起動でも gh がプロンプト・ページャ・更新通知で固まらないようにする
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // gh は内部で git を呼ぶ。GUI 起動の PATH は最小構成なので pty と同じ補完を渡す
    if let Some(path) = terminal_path() {
        cmd.env("PATH", path);
    }
}

/// 一覧系 gh コマンドの上限。open だけでも API 往復で秒単位かかることがあり、
/// 短すぎる打ち切りは「PR 無し」に見えてしまう
pub(crate) const GH_LIST_TIMEOUT_SECS: u64 = 30;
/// 単一の PR / Issue を引くだけのコマンド。UI の待ち時間として許せる範囲に留める
pub(crate) const GH_VIEW_TIMEOUT_SECS: u64 = 15;
/// 失敗理由は UI の1〜2行に出すだけなので、MB 級の stderr は IPC に載せない
const GH_ERROR_MAX_CHARS: usize = 400;

/// gh の失敗メッセージ。stderr を優先し（gh はエラーをこちらに出す）、char 境界で切り詰める
fn gh_error_text(stdout: &[u8], stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let text = if err.trim().is_empty() {
        String::from_utf8_lossy(stdout).trim().to_string()
    } else {
        err.trim().to_string()
    };
    if text.chars().count() <= GH_ERROR_MAX_CHARS {
        return text;
    }
    let cut: String = text.chars().take(GH_ERROR_MAX_CHARS).collect();
    format!("{cut}…")
}

/// gh を実行し、成功なら stdout・失敗なら「そのまま画面に出せる理由」を返す。
/// gh 不在 / タイムアウト / 非0終了をすべて別々の文言にするのが目的（従来は全部同じ
/// 「取得できませんでした」に潰れていて、未認証なのか gh 不在なのか分からなかった）
pub(crate) async fn run_gh(
    root: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<Vec<u8>, String> {
    run_gh_program(&gh_program(), root, args, timeout_secs).await
}

/// 実行ファイルを明示する版。テストが gh をスタブに差し替えるためだけに分けてある。
pub(crate) async fn run_gh_program(
    program: &str,
    root: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).hide_console();
    configure_gh(&mut cmd, root);
    let label = args
        .iter()
        .take_while(|a| !a.starts_with('-'))
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    match tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await {
        Err(_) => Err(format!("gh {label} timed out after {timeout_secs}s")),
        Ok(Err(e)) => Err(format!("could not run {program}: {e}")),
        Ok(Ok(out)) if !out.status.success() => {
            let text = gh_error_text(&out.stdout, &out.stderr);
            Err(if text.is_empty() {
                format!("gh {label} failed ({})", out.status)
            } else {
                text
            })
        }
        Ok(Ok(out)) => Ok(out.stdout),
    }
}

/// gh の JSON 出力。取得も解析も失敗したら理由つきで返す。
pub(crate) async fn gh_json(
    root: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    gh_json_program(&gh_program(), root, args, timeout_secs).await
}

/// 実行ファイルを明示する JSON 版。Issue 作成の単体テストでも、gh の起動・エラー整形を
/// 本番と同じ経路のままスタブへ差し替えられるようにする。
pub(crate) async fn gh_json_program(
    program: &str,
    root: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let stdout = run_gh_program(program, root, args, timeout_secs).await?;
    serde_json::from_slice(&stdout).map_err(|e| format!("could not parse gh output: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{gh_error_text, GH_ERROR_MAX_CHARS};

    #[test]
    fn gh_error_prefers_stderr_and_falls_back_to_stdout() {
        assert_eq!(
            gh_error_text(
                b"",
                b"gh: To get started with GitHub CLI, please run: gh auth login\n"
            ),
            "gh: To get started with GitHub CLI, please run: gh auth login"
        );
        // stderr が空でも stdout に理由が出る gh サブコマンドがある
        assert_eq!(
            gh_error_text(b" no default remote \n", b"  "),
            "no default remote"
        );
    }

    #[test]
    fn gh_error_truncates_on_char_boundary() {
        // マルチバイトの途中で切ると panic するので char 単位で数える
        let long = "エラー".repeat(400);
        let text = gh_error_text(b"", long.as_bytes());
        assert_eq!(text.chars().count(), GH_ERROR_MAX_CHARS + 1); // 末尾の … を含む
        assert!(text.ends_with('…'));
    }
}
