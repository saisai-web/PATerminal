//! git プロセスの実行と、結果を UI の1行目に載せるための要約。
//! git モジュール全体（と github / worktree）が使う共通の土台。

use crate::env::HideConsole;

pub(crate) fn run_git(args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .args(args)
        // pull 等のネットワーク系が認証プロンプトで固まらないよう対話を禁止
        // （output() は stdin が null なので TTY 経由のプロンプトも起きない）
        .env("GIT_TERMINAL_PROMPT", "0")
        // 3秒ごとのポーリングなので、Windows でコンソールが点滅しないよう必ず隠す
        .hide_console()
        .output()
        .map_err(|e| e.to_string())
}

pub(crate) fn git_output_text(out: &std::process::Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string()
}

/// 帯（`#git-msg`）は結果の**1行目**を要約として読ませるが、push の出力は
/// 1行目が `To <url>` で何も分からず、拒否理由（`! [rejected] ... (fetch first)`）は
/// 後ろの行にある。原因が分かる行を先頭へ持ち上げるための要約を返す。
/// 持ち上げる必要が無い（1行目が既に原因を語っている）ときは None。
fn git_headline(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    // 非 fast-forward の拒否は「Pull してから Push」で必ず解ける。git の hint は
    // 5行あって帯に収まらないので、操作バーのボタン名でやることだけを1行にする
    if lower.contains("[rejected]")
        && (lower.contains("fetch first") || lower.contains("non-fast-forward"))
    {
        return Some(
            "Push rejected: the remote has commits you don't have yet. Pull first, then Push again."
                .into(),
        );
    }
    // GUI 起動なので認証プロンプトは出せない（run_git は GIT_TERMINAL_PROMPT=0）。
    // 「対話が禁止されている」だけ言われても直し方が分からないので誘導する
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("permission denied (publickey)")
    {
        return Some(
            "Git authentication failed: set up credentials (e.g. `gh auth setup-git`) or run the command in the terminal."
                .into(),
        );
    }
    // それ以外の push 出力（成功も含む）は `To <url>` の次の行が本題
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    if !lines.next()?.starts_with("To ") {
        return None;
    }
    lines
        .find(|l| !l.starts_with("hint:") && !l.starts_with("remote:"))
        .map(str::to_string)
}

/// git の実行結果を「成功なら出力文字列 / 失敗ならエラー」に畳む。
/// どちらも先頭に要約行を足す（帯は1行目しか出さないため）
pub(crate) fn git_result(out: std::process::Output) -> Result<String, String> {
    let text = git_output_text(&out);
    let text = match git_headline(&text) {
        Some(head) => format!("{head}\n{text}"),
        None => text,
    };
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            "git failed".into()
        } else {
            text
        })
    }
}

#[cfg(test)]
mod tests {
    use super::git_headline;

    // 帯は1行目しか出さないので、push の "To <url>" で終わらせない
    #[test]
    fn push_rejection_headline_tells_the_user_to_pull() {
        let out = "To https://github.com/o/r.git\n \
             ! [rejected]        HEAD -> main (fetch first)\n\
             error: failed to push some refs to 'https://github.com/o/r.git'\n\
             hint: Updates were rejected because the remote contains work that you do\n\
             hint: not have locally.\n";
        assert_eq!(
            git_headline(out).as_deref(),
            Some("Push rejected: the remote has commits you don't have yet. Pull first, then Push again.")
        );
    }

    #[test]
    fn auth_failure_headline_points_at_credentials() {
        let out = "fatal: could not read Username for 'https://github.com': \
             terminal prompts disabled\n";
        assert!(git_headline(out)
            .expect("headline")
            .starts_with("Git authentication failed"));
    }

    #[test]
    fn push_success_headline_shows_the_ref_update_not_the_url() {
        let out = "To https://github.com/o/r.git\n   325a74c..0e17c89  main -> main\n";
        assert_eq!(
            git_headline(out).as_deref(),
            Some("325a74c..0e17c89  main -> main")
        );
    }

    // すでに1行目が原因を語っているものは触らない（二重に出さない）
    #[test]
    fn informative_first_line_needs_no_headline() {
        assert_eq!(git_headline("Everything up-to-date\n"), None);
        assert_eq!(git_headline("fatal: not a git repository\n"), None);
        assert_eq!(git_headline(""), None);
    }
}
