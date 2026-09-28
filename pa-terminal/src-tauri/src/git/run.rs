//! git プロセスの実行と、結果を UI の1行目に載せるための要約。
//! git モジュール全体（と github / worktree）が使う共通の土台。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::env::{executable_candidates, terminal_path, HideConsole};

/// 解決済みの git 実行パス。ポーリングのたびに探索先を stat し直さないよう覚えておき、
/// 起動できなかったら捨てて次回探し直す（アンインストール・後から導入に追従する）
static GIT_PROGRAM: Mutex<Option<PathBuf>> = Mutex::new(None);

/// git の実行パス。Finder 起動の .app は PATH が最小構成（/usr/bin 等のみ）なので、
/// pty と同じ探索先を先に見る（ターミナルで使っている git と揃える）。
/// macOS では Homebrew の git が /usr/bin/git（xcrun のシム）より先に見つかり、
/// Xcode ライセンス未同意でも動く。Windows は PATH に無い Git for Windows も拾う
fn git_program() -> PathBuf {
    let mut cached = GIT_PROGRAM.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = cached.as_ref() {
        return p.clone();
    }
    let found = executable_candidates("git")
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("git"));
    *cached = Some(found.clone());
    found
}

fn remember_git_program(program: Option<PathBuf>) {
    *GIT_PROGRAM.lock().unwrap_or_else(|e| e.into_inner()) = program;
}

fn spawn_git(program: &PathBuf, args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        // pull 等のネットワーク系が認証プロンプトで固まらないよう対話を禁止
        // （output() は stdin が null なので TTY 経由のプロンプトも起きない）
        .env("GIT_TERMINAL_PROMPT", "0")
        // 3秒ごとのポーリングなので、Windows でコンソールが点滅しないよう必ず隠す
        .hide_console();
    // フック・認証ヘルパー（gh auth git-credential 等）も GUI 起動の痩せた PATH で探さない
    if let Some(path) = terminal_path() {
        cmd.env("PATH", path);
    }
    cmd.output()
}

/// macOS: Xcode ライセンス未同意（Xcode 更新直後に起きる）だと /usr/bin/git の
/// シムは何もせずに失敗する。Command Line Tools の git は別に導入時の同意で済んで
/// いるので、入っていればそちらで続ける。ライセンスの同意自体は促し続ける
/// （`GitProblem::XcodeLicense`）が、同意するまで Git 画面が空になるのは避ける
#[cfg(target_os = "macos")]
fn command_line_tools_git() -> Option<PathBuf> {
    let p = PathBuf::from("/Library/Developer/CommandLineTools/usr/bin/git");
    p.is_file().then_some(p)
}

pub(crate) fn run_git(args: &[&str]) -> Result<std::process::Output, String> {
    let program = git_program();
    let out = match spawn_git(&program, args) {
        Ok(out) => out,
        Err(e) => {
            remember_git_program(None);
            return Err(if e.kind() == std::io::ErrorKind::NotFound {
                GitProblem::NotInstalled.headline()
            } else {
                e.to_string()
            });
        }
    };
    #[cfg(target_os = "macos")]
    if !out.status.success()
        && classify_git_failure(&String::from_utf8_lossy(&out.stderr))
            == Some(GitProblem::XcodeLicense)
    {
        if let Some(clt) = command_line_tools_git().filter(|p| *p != program) {
            if let Ok(retry) = spawn_git(&clt, args) {
                let still = classify_git_failure(&String::from_utf8_lossy(&retry.stderr));
                if still != Some(GitProblem::XcodeLicense) {
                    remember_git_program(Some(clt));
                    return Ok(retry);
                }
            }
        }
    }
    Ok(out)
}

/// git が「リポジトリの問題」ではなく「この PC の環境」のせいで動かない状態。
/// Git 画面が黙って空になる（リポジトリ外と区別できない）のを避け、復旧コマンドを案内する
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GitProblem {
    /// macOS: Xcode のライセンスに未同意。/usr/bin/git ごと動かない
    XcodeLicense,
    /// macOS: Command Line Tools が無い / 壊れている（xcrun: invalid active developer path）
    DeveloperTools,
    /// git が見つからない（Windows の Git for Windows 未導入など）
    NotInstalled,
    /// safe.directory: 別ユーザー所有のフォルダー（Windows の別ドライブ・外付けで多い）。
    /// 中身は git が案内する `git config --global --add safe.directory ...` そのもの
    DubiousOwnership(String),
    /// Windows: MAX_PATH（260文字）超えのパスを扱えない（node_modules の深い階層で多い）
    LongPaths,
}

/// UI へ渡す形。文言はフロントが kind ごとに訳す（コマンドは訳さない）
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitProblemInfo {
    pub(crate) kind: &'static str,
    pub(crate) command: Option<String>,
}

impl GitProblem {
    fn command(&self) -> Option<String> {
        match self {
            Self::XcodeLicense => Some("sudo xcodebuild -license accept".into()),
            Self::DeveloperTools => Some("xcode-select --install".into()),
            Self::NotInstalled => {
                if cfg!(windows) {
                    Some("winget install --id Git.Git -e --source winget".into())
                } else if cfg!(target_os = "macos") {
                    Some("xcode-select --install".into())
                } else {
                    None
                }
            }
            Self::DubiousOwnership(cmd) => Some(cmd.clone()),
            Self::LongPaths => Some("git config --global core.longpaths true".into()),
        }
    }

    pub(crate) fn info(&self) -> GitProblemInfo {
        let kind = match self {
            Self::XcodeLicense => "xcodeLicense",
            Self::DeveloperTools => "developerTools",
            Self::NotInstalled => "notInstalled",
            Self::DubiousOwnership(_) => "dubiousOwnership",
            Self::LongPaths => "longPaths",
        };
        GitProblemInfo {
            kind,
            command: self.command(),
        }
    }

    /// 操作結果の帯（1行目）に出す英語の要約。直し方のコマンドまで1行に収める
    pub(crate) fn headline(&self) -> String {
        let reason = match self {
            Self::XcodeLicense => "Git can't run until the Xcode license is accepted",
            Self::DeveloperTools => "Git needs the Xcode Command Line Tools",
            Self::NotInstalled => "Git is not installed",
            Self::DubiousOwnership(_) => "Git refuses this folder because another user owns it",
            Self::LongPaths => "A path is too long for Windows",
        };
        match self.command() {
            Some(cmd) => format!("{reason}. Run in a terminal: {cmd}"),
            None => format!("{reason}. Install Git with your package manager."),
        }
    }
}

/// git の stderr から環境起因の失敗を見分ける。リポジトリ外・競合などは None
pub(crate) fn classify_git_failure(text: &str) -> Option<GitProblem> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("xcode license") || lower.contains("xcodebuild -license") {
        return Some(GitProblem::XcodeLicense);
    }
    if lower.contains("invalid active developer path")
        || lower.contains("no developer tools were found")
        || lower.contains("requires the command line developer tools")
    {
        return Some(GitProblem::DeveloperTools);
    }
    if lower.contains("detected dubious ownership") {
        // git 自身が案内する1行（パスのクォートも git 任せ）をそのまま使う
        let cmd = text
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("git config --global --add safe.directory"))
            .map(str::to_string)?;
        return Some(GitProblem::DubiousOwnership(cmd));
    }
    // Windows 版 git だけが出す（core.longpaths 未設定で MAX_PATH を超えた）
    if cfg!(windows) && lower.contains("filename too long") {
        return Some(GitProblem::LongPaths);
    }
    None
}

/// 起動自体に失敗したときの `run_git` のエラー文字列から問題を復元する
pub(crate) fn classify_git_error(err: &str) -> Option<GitProblem> {
    if err == GitProblem::NotInstalled.headline() {
        return Some(GitProblem::NotInstalled);
    }
    classify_git_failure(err)
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
    // 環境起因（Xcode ライセンス・safe.directory 等）は何をしても失敗するので最優先で案内する。
    // stdout（コミットメッセージ等）の文言で誤判定しないよう、失敗時の stderr だけを見る
    let problem = if out.status.success() {
        None
    } else {
        classify_git_failure(&String::from_utf8_lossy(&out.stderr))
    };
    let text = match problem
        .map(|p| p.headline())
        .or_else(|| git_headline(&text))
    {
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
    use super::{classify_git_error, classify_git_failure, git_headline, git_result, GitProblem};

    fn failed(stdout: &str, stderr: &str) -> std::process::Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    // Xcode 更新直後の /usr/bin/git。リポジトリ外と同じ「空」にせず案内する
    #[test]
    fn xcode_license_is_an_environment_problem() {
        let err = "You have not agreed to the Xcode license agreements. Please run \
             'sudo xcodebuild -license' from within a Terminal window to review and \
             agree to the Xcode and Apple SDKs license.\n";
        let problem = classify_git_failure(err).expect("problem");
        assert_eq!(problem, GitProblem::XcodeLicense);
        assert_eq!(
            problem.info().command.as_deref(),
            Some("sudo xcodebuild -license accept")
        );
        let msg = git_result(failed("", err)).unwrap_err();
        assert!(msg
            .lines()
            .next()
            .unwrap()
            .ends_with("Run in a terminal: sudo xcodebuild -license accept"));
    }

    #[test]
    fn missing_developer_tools_points_at_xcode_select() {
        let err =
            "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), \
             missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n";
        assert_eq!(classify_git_failure(err), Some(GitProblem::DeveloperTools));
    }

    // 復旧コマンドは git 自身が出す1行をそのまま使う（パスのクォートを自作しない）
    #[test]
    fn dubious_ownership_reuses_the_command_git_suggests() {
        let err = "fatal: detected dubious ownership in repository at 'D:/work/repo'\n\
             'D:/work/repo' is owned by:\n\t'S-1-5-32-544'\n\
             but the current user is:\n\t'DESKTOP\\me'\n\
             To add an exception for this directory, call:\n\n\
             \tgit config --global --add safe.directory D:/work/repo\n";
        let problem = classify_git_failure(err).expect("problem");
        assert_eq!(problem.info().kind, "dubiousOwnership");
        assert_eq!(
            problem.info().command.as_deref(),
            Some("git config --global --add safe.directory D:/work/repo")
        );
    }

    #[test]
    fn spawn_failure_is_reported_as_not_installed() {
        let err = GitProblem::NotInstalled.headline();
        assert_eq!(classify_git_error(&err), Some(GitProblem::NotInstalled));
    }

    // リポジトリ外や通常の失敗は案内しない（Git 画面が「未導入」と誤って騒がない）
    #[test]
    fn ordinary_failures_are_not_environment_problems() {
        assert_eq!(
            classify_git_failure(
                "fatal: not a git repository (or any of the parent directories): .git\n"
            ),
            None
        );
        assert_eq!(
            classify_git_failure("CONFLICT (content): Merge conflict in a.txt\n"),
            None
        );
    }

    // 成功した出力（コミットメッセージ等）の文言では判定しない
    #[test]
    fn stdout_mentioning_the_license_is_not_misread() {
        let out = failed(
            "[main 1234567] docs: xcodebuild -license accept\n",
            "error: something\n",
        );
        assert!(!git_result(out).unwrap_err().starts_with("Git can't run"));
    }

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
