# PATerminal Development Guide

PATerminal is a multi-session terminal built with Tauri v2 and xterm.js. The application itself is in `pa-terminal/`.
This document covers only regression prevention for fragile areas and Windows-specific handling.

## Regression Prevention

### Missing and Duplicate Keyboard Input Incident (Resolved 2026-08-01)

Fast typing could drop characters, turning `claude` into `claue`, and an intermediate fix
caused each keystroke to produce two characters. The cause was not load or PTY writes, but
the interaction between the WKWebView and xterm.js input paths.

- WKWebView may omit `keypress` and set the `keydown` key code to 229 during fast rollover,
  Shift-modified typing, or key repeat.
- A textarea `input` event may also arrive before its corresponding `keydown`.
- xterm takes printable input from `keypress`, ignores `input` after `keydown` via
  `_keyDownSeen`, and also recovers key code 229 through textarea differences. Adding only a
  custom input listener to this default path causes both the built-in fallback and the custom
  listener to send the same character, duplicating input.

The input handling in `src/terminal/pane.ts` consists of the following three interdependent
parts. Do not remove or change any one of them in isolation.

1. `attachCustomKeyEventHandler`: feeds printable keys from `keydown` directly into
   `term.input()`. It prevents xterm from processing key code 229 and always suppresses
   `keypress` to prevent duplicate input.
2. The textarea `input` listener: recovers non-composing `insertText` input and clears the
   textarea value.
3. The xterm private API `_keyDownSeen` is kept at true to disable xterm's built-in input path.

Leave IME input to composition handling. When upgrading xterm, re-examine `_keyDownSeen`,
`_inputEvent`, and `_handleAnyTextareaChanges`. After touching the input path, test fast
typing, repeated Shift presses, key repeat, and Japanese IME on actual macOS and Windows
machines.

Do not fix missing or duplicate input by guesswork; inspect `src/terminal/diag.ts`. `key` is
keydown, `data` is xterm onData, `sent` is PTY transmission, and `echo` is data returned from
the PTY. An event prefixed with `ta:` came through the textarea input path. Identify the first
layer where counts increase or decrease before making a change.

### Copy and Paste

Treat `clipboardShortcut()` and the textarea paste listener as a pair.
Paste handling stops xterm but does not call `preventDefault`, allowing the WebView's paste
event to reach xterm's built-in handling. Use `copyText()` only when there is a selection;
Ctrl+C with no selection must remain SIGINT. macOS uses the WebView defaults for Cmd
shortcuts, Windows supports Ctrl+C/V and Ctrl+Shift+C/V, and Linux supports only
Ctrl+Shift+C/V. Also verify changes on actual machines.

### PTY and Performance

- Tauri commands must be `async fn`. Do not run synchronous commands on the main thread.
- Coalesce PTY output on the Rust side, and retain output for hidden panes in Rust by using
  `pty_set_visible`.
- Keep SerializeAddon, large JSON, and megabyte-scale IPC away from keystroke timing.
- Capture saved snapshots one pane at a time in idle slices, and preserve
  `excludeModes: true` / `excludeAltBuffer: true`.
- Do not add per-pane parallel invokes or periodic subprocesses. Serialize them or use batch
  commands instead.

### Layout and Scrolling

- The order is **show -> `layout()` -> `refit()` -> resize -> `pty_set_visible`**.
- Always route `pty_resize` through `src/terminal/resize.ts`.
- Do not fit degenerate sizes. The lower bounds are `MIN_FIT_COLS` / `MIN_FIT_ROWS`.
- Apply padding to `.pane-body .xterm`, not `.pane-body`.
- During dragging, call only `place()`, then refit once after the drag is finalized.
- `Pane` owns the scroll position policy (`scrollAnchor`): follow the newest output, or stay
  on the history line the user chose. Do not scatter scroll fixes across individual paths for
  opening or closing Files/the sidebar or redisplaying sessions.

Run `ui-tests/31-resize.mjs` after changes, and verify `stty size` and bottom-scroll retention
on actual machines.

### Scroll Position Jumping Up Incident (Resolved 2026-09-09)

Switching sessions, or merely touching the trackpad while watching output, sometimes scrolled a
pane up by a full screen and stopped it from following new output. The cause was not focus
handling but xterm 5.x's Viewport: it drives the buffer from the DOM `scrollTop` (wheel included)
and recomputes the scroll-area height only when the buffer grows or the size changes, using the
viewport element's `offsetHeight`. Output that reaches a `display:none` session (in-flight data
right after switching away, or a refresh queued in the same frame) computes that height as 0, so
after reopening the DOM sits one screen above the buffer position. The first DOM scroll event
(a 1px wheel tick, a layout clamp) then makes xterm scroll the buffer up by a screen and set
`isUserScrolling`, so output no longer follows. `src/terminal/pane.ts` keeps three parts:

- `syncViewport()` asks xterm's private `viewport.syncScrollArea(true)` to re-measure with the
  live layout from `refit()`, `focus()`, and `scrollToBottom()`. Never call it, or write to
  xterm, expecting a hidden or 0px pane to measure correctly.
- `term.onScroll` (output, keystrokes, Shift+PageUp, the scrollbar, selection auto-scroll)
  always adopts the buffer position as the anchor. A DOM `scroll` event is the user's only
  when its `scrollTop` is the value xterm's wheel/touch handler just wrote (`userScrollTop`);
  any other DOM scroll is a phantom and is reverted to the anchor. Do not replace this with
  a time window.
- `refit()` keeps the anchor instead of forcing the bottom, so reading history survives
  layout changes. Reopening a session still goes to the bottom via `Pane.scrollToBottom()`.

When upgrading xterm, re-examine `Viewport.syncScrollArea`, `_innerRefresh`, `_handleScroll`,
and `BufferService.isUserScrolling` (6.0 rewrote the Viewport). Verify with
`ui-tests/43-scroll-anchor.mjs` and `ui-tests/31-resize.mjs`, then confirm on a real machine that
switching to a session that was producing output and nudging the trackpad keeps the newest
output visible.

### Restoration and Process Termination

- The scrollback in session.json is display history only. Do not carry TUI mode into a new
  shell.
- After restoration failure, spawn failure, or child-process termination, always attach an
  interactive shell to every pane that remains on screen.
- Retain input received during recovery through `writeChain`.
- Do not leave orphaned PTYs when close, restart, and automatic recovery race.
- Verify regressions with `ui-tests/36-terminal-recovery.mjs`.

### Activity Status and Notifications

Rust emits `pty:act busy` on the first byte of output, but claude / codex redraw on session
switches (focus reports, resize) and query the terminal on startup. Treating that output as work
made a session show "running" when it was only opened, and every idle afterwards scheduled a
"done" notification. `src/app/activity.ts` and `src/terminal/pane.ts` keep three gates:

- Terminal replies (CPR, DA, DECRQM, OSC color, DCS), focus reports, mouse reports, and plain
  arrow keys are not user activity (`isUnsolicitedTerminalData`). Keystrokes still mark a pane
  busy immediately.
- Output without a keystroke becomes "running" only after it has continued for
  `OUTPUT_BUSY_MS`; a short burst never changes the label, attention dot, or timers.
- An idle counts as a completion only if the pane was actually busy or a BEL arrived during
  output. Only completions set attention and send the notification, which goes out
  immediately; there is no extra idle wait, so do not add one back to hide false completions.

Verify with `ui-tests/21-activity.mjs` and `ui-tests/38-session-status-filter.mjs`, then
confirm on a real machine that opening a claude / codex pane and switching sessions neither
shows "running" nor produces a notification.

Codex 0.154.0's Astra input composer adds idle sparkle dots (`chat_composer/sparkle.rs`),
redrawing every 150ms even without a task. App-managed Codex launches pass
`-c tui.whimsy=false` in `src/terminal/agent-launch.ts` and `src-tauri/src/pty/scrollback.rs`
so output can become idle. Keep work animations enabled; do not filter arbitrary braille dots
or change Claude's activity detection. Apply this policy to startup, restoration, direct
launches, and the resume banner. Manual shell commands bypass these helpers, so
`agents/codex_config.rs` also saves `[tui] whimsy = false` in the user-level Codex
config before the app opens any terminals. Honor `CODEX_HOME`, preserve other
settings/comments and symlinks, and replace the file atomically. This deliberately
affects Codex outside PATerminal too. Do not overwrite invalid configs; report
failures. Already-running Codex must restart, and explicit CLI/project overrides
can still take precedence.
Verify `scripts/agent-launch.test.mjs`, the Rust scrollback tests, and agent restore/takeover
UI tests. With truecolor and OSC foreground/background replies, idle Codex emits continual
sparkle output by default and becomes silent with `tui.whimsy=false`.

### Terminal Colors

`pty_spawn` must always pass through `configure_terminal_color()`.
Remove inherited `NO_COLOR` / `NODE_DISABLE_COLORS` / `FORCE_COLOR` / `CLICOLOR*`, and set
`TERM=xterm-256color` and `COLORTERM=truecolor`. Do not duplicate this logic in each spawn
path. For color issues, first check the environment variables of a new pane and
`codex doctor --json`.

## Windows Support

### Environment and Shells

- Obtain the home directory from `env::home_dir()`. `HOME` may be unset or use a path such as
  `/c/Users/...`.
- Use the shared completion logic in `env/path.rs` for the GUI launch PATH. Do not add search
  locations in individual commands.
- For PowerShell, use `-NoExit -EncodedCommand` to configure UTF-8 and inject the OSC 7 prompt.
- For cmd.exe, use `/K chcp 65001>nul` to set the ConPTY code page to UTF-8.
- Do not add bootstrap arguments when the caller explicitly provides non-empty arguments.
- Do not change `[Console]::InputEncoding`; doing so breaks PSReadLine and node input.

### CWD Tracking

`pty/cwd.rs` reads PEB -> `RTL_USER_PROCESS_PARAMETERS` -> `CurrentDirectory`.
When changing an internal offset, also update the immediately following `#[cfg(windows)]`
compile-time assertion. cmd.exe and Git Bash use the PEB; PowerShell uses the OSC 7 prompt in
`pty/shell.rs`. Escape each path segment in the OSC 7 path with `EscapeDataString`.

Treat the CommandLine reading in `pty/agent.rs` as a pair with its PEB offsets and assertions.
On actual Windows machines, verify CWD tracking in cmd.exe, PowerShell, and Git Bash.
