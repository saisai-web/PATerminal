//! Agent rendering policy scoped to PTY children, not the user's global settings.
//! Claude's classic renderer and Codex's inline renderer expose history to xterm,
//! allowing the scrollbar to address the actual first/last line.

use portable_pty::CommandBuilder;

pub(super) fn configure(cmd: &mut CommandBuilder, program: &str, args: Option<&Vec<String>>) {
    // Inherited by Claude started manually from a shell as well as direct launches.
    // Official override takes precedence over a saved fullscreen renderer setting.
    cmd.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1");

    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    if ["codex", "codex.exe", "codex.cmd", "codex.bat"].contains(&name.as_str())
        && !args.is_some_and(|args| {
            args.iter()
                .take_while(|arg| arg.as_str() != "--")
                .any(|arg| arg == "--no-alt-screen")
        })
    {
        cmd.arg("--no-alt-screen");
    }
}

#[cfg(test)]
mod tests {
    use super::configure;
    use portable_pty::CommandBuilder;

    #[test]
    fn claude_policy_is_scoped_to_child_and_overrides_fullscreen() {
        let mut cmd = CommandBuilder::new("zsh");
        cmd.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "0");
        configure(&mut cmd, "zsh", None);
        assert_eq!(
            cmd.get_env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"),
            Some("1".as_ref())
        );
        assert_eq!(cmd.get_argv().len(), 1);
    }

    #[test]
    fn direct_codex_launches_and_resumes_use_native_scrollback() {
        for program in [
            "codex",
            "/opt/tools/codex",
            r"C:\Program Files\Codex\codex.exe",
            "codex.cmd",
        ] {
            let args = vec!["resume".to_string(), "--last".to_string()];
            let mut cmd = CommandBuilder::new(program);
            configure(&mut cmd, program, Some(&args));
            cmd.args(&args);
            let actual: Vec<_> = cmd
                .get_argv()
                .iter()
                .map(|arg| arg.to_string_lossy())
                .collect();
            assert_eq!(actual, vec![program, "--no-alt-screen", "resume", "--last"]);
        }
    }

    #[test]
    fn existing_flag_is_not_duplicated_and_other_programs_keep_their_arguments() {
        for (program, args) in [
            ("codex", vec!["--no-alt-screen", "resume", "--last"]),
            ("claude", vec!["--continue"]),
            ("vim", vec!["file.txt"]),
            ("my-codex", vec!["--help"]),
        ] {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            let mut cmd = CommandBuilder::new(program);
            configure(&mut cmd, program, Some(&args));
            cmd.args(&args);
            assert_eq!(cmd.get_argv().len(), 1 + args.len());
        }
    }
}
