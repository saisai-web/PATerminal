# Keyboard Input Loss Incident (Resolved 2026-08-01)

## Symptoms

Fast typing of printable Latin characters could drop characters, for example turning `claude` into `claue`. Japanese IME input was unaffected. The problem occurred independently of application load or whether an agent process was running. During development of the fix, one intermediate implementation could also duplicate characters.

## Confirmed root cause

Diagnostic logs showed that every printable `keydown` reached the WebView, while some characters never reached xterm.js `onData`. This isolated the primary loss to the interaction between macOS WKWebView keyboard event delivery and xterm.js input handling, rather than the PTY, Rust, IPC, or application workload.

The relevant event behavior was:

1. During fast rollover typing, Shift-modified typing, or key repeat, WKWebView could omit `keypress` and report `keyCode === 229` on the corresponding `keydown`. Although 229 normally indicates IME processing, it also appeared for non-IME printable input in this case.
2. WKWebView could deliver an asynchronous `input` event before the associated `keydown`.
3. xterm.js normally collected printable input from `keypress`, suppressed some `input` handling after a `keydown` through `_keyDownSeen`, and used a textarea-difference fallback for key code 229. Combined with the WKWebView behavior, this could either lose a character or process it twice when an additional listener and xterm.js's fallback both ran.

## Required input implementation

The workaround is implemented in `pa-terminal/src/terminal/pane.ts`. Its following three parts form one input path and must be reviewed and tested together:

1. `attachCustomKeyEventHandler` handles printable, non-composing keys with a key code other than 229 directly on `keydown` by calling `term.input()` and preventing the default behavior. It does not wait for `keypress`.
2. For a printable `keydown` with key code 229, the handler returns `false` so xterm.js does not run its race-prone textarea-difference path. The browser's default behavior inserts the character into xterm.js's hidden textarea, and the textarea `input` listener forwards non-composing `insertText` data through `term.input()` before clearing the textarea. Printable `keypress` events are rejected to prevent duplicates. IME composition remains under the normal composition-event path.
3. `_keyDownSeen` on xterm.js's private core is fixed to `true` with `Object.defineProperty`. This disables xterm.js's competing `input` fallback and makes the explicit textarea listener the only `insertText` path. This is a private API dependency; any xterm.js upgrade requires inspecting the current `_keyDownSeen`, input-event, and key-code-229 implementations before retaining or adapting the workaround.

Do not remove or independently alter one of these parts on the assumption that another part is sufficient.

Keyboard data is also queued in `pane.ts` and sent after a zero-delay task boundary. Calling IPC synchronously from the key handler can compete with WKWebView's keyboard delivery. The queue preserves order and coalesces data before `pty_write`.

## Main-thread and workload safeguards

The primary loss occurred inside the WebView input path, but the investigation also found work that could delay keyboard delivery:

- On macOS, Tauri event and Channel delivery consumed WebView main-thread time through JavaScript evaluation. `pa-terminal/src-tauri/src/pty/stream.rs` therefore coalesces visible PTY output, initially waiting 1 ms for follow-up data and using a 16 ms or 64 KiB window only while output continues. Hidden-pane output remains buffered in Rust, up to 2 MB, until the pane becomes visible.
- Tauri commands on the input and session paths are asynchronous so command execution does not occupy the WebView main thread.
- SerializeAddon snapshotting is synchronous and previously caused pauses of roughly 100 ms when all panes were serialized together. `pa-terminal/src/app/session.ts` now refreshes per-pane cached snapshots one pane at a time across `requestIdleCallback` slices. Do not restore synchronous all-pane serialization during typing.

## Diagnostic procedure

The temporary diagnostic instrumentation remains in `pa-terminal/src/terminal/diag.ts`, with the corresponding `diag_save` command in `pa-terminal/src-tauri/src/system/session.rs`. While input is active, it appends a JSON line to `diag.log` in the application's configuration directory every five seconds.

The input-related fields are:

- `key`: printable keys observed at `keydown`.
- `data`: characters reaching xterm.js `onData`.
- `sent`, `ok`, and `err`: characters submitted to, accepted by, or rejected by `pty_write`.
- `echo`: characters returning from the PTY.
- `events`: recent ordered markers, including `k:` for `keydown`, `d:` for `onData`, and `ta:` for recovery through the textarea `input` listener.

Locate the first counter or event stream that loses a character before changing the implementation. In this incident, complete `k:` events with missing `d:` events identified the WebView/xterm.js boundary and ruled out downstream layers.

## Regression-prevention rules

1. After changing any part of the input path, test a macOS release build with fast typing, Shift-held uppercase typing, key repeat, and Japanese IME composition. Chromium-based Playwright tests do not reproduce WKWebView's event behavior.
2. Evaluate input latency and responsiveness in a release build. `tauri dev` includes debug and development-server overhead and is not representative.
3. Treat every new PTY-to-frontend data path on macOS as WebView main-thread work. Coalesce it in Rust and avoid sending hidden-pane traffic. Choosing an event instead of a Channel, or vice versa, does not by itself remove the cost.
4. Keep Tauri commands on these paths asynchronous.
5. Keep SerializeAddon work, large `JSON.stringify` operations, and large IPC payloads away from the typing path. Use cached state, debouncing, and idle slices.
6. Before upgrading xterm.js, inspect its current keyboard and textarea input internals, especially `_keyDownSeen` and key-code-229 handling, then repeat the native release-build tests.
