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
    if !["codex", "codex.exe", "codex.cmd", "codex.bat"].contains(&name.as_str()) {
        return;
    }
    if !args.is_some_and(|args| {
        args.iter()
            .take_while(|arg| arg.as_str() != "--")
            .any(|arg| arg == "--no-alt-screen")
    }) {
        cmd.arg("--no-alt-screen");
    }
    // Astra's idle composer sparkle prevents output-silence completion detection.
    // Scope this to the child; keep actual work spinners and the user's config.
    if !args.is_some_and(|args| {
        args.windows(2)
            .take_while(|pair| pair[0] != "--")
            .any(|pair| {
                matches!(pair[0].as_str(), "-c" | "--config") && pair[1] == "tui.whimsy=false"
            })
    }) {
        cmd.args(["-c", "tui.whimsy=false"]);
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
            assert_eq!(
                actual,
                vec![
                    program,
                    "--no-alt-screen",
                    "-c",
                    "tui.whimsy=false",
                    "resume",
                    "--last"
                ]
            );
        }
    }

    #[test]
    fn existing_flag_is_not_duplicated_and_other_programs_keep_their_arguments() {
        for (program, args) in [
            (
                "codex",
                vec![
                    "--no-alt-screen",
                    "-c",
                    "tui.whimsy=false",
                    "resume",
                    "--last",
                ],
            ),
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

    #[test]
    fn prompt_text_does_not_disable_the_whimsy_override() {
        for args in [vec!["tui.whimsy=false"], vec!["--", "tui.whimsy=false"]] {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            let mut cmd = CommandBuilder::new("codex");
            configure(&mut cmd, "codex", Some(&args));
            cmd.args(&args);
            assert_eq!(cmd.get_argv()[2], "-c");
            assert_eq!(cmd.get_argv()[3], "tui.whimsy=false");
            assert_eq!(cmd.get_argv().len(), 4 + args.len());
        }
    }

    #[test]
    fn explicit_config_options_keep_their_precedence() {
        for flag in ["-c", "--config"] {
            let args = vec![flag.to_owned(), "tui.whimsy=false".to_owned()];
            let mut cmd = CommandBuilder::new("codex");
            configure(&mut cmd, "codex", Some(&args));
            assert_eq!(cmd.get_argv().len(), 2);
        }
        let args = vec!["-c".to_owned(), "tui.whimsy=true".to_owned()];
        let mut cmd = CommandBuilder::new("codex");
        configure(&mut cmd, "codex", Some(&args));
        cmd.args(&args);
        assert_eq!(cmd.get_argv().last().unwrap(), "tui.whimsy=true");
    }
}
