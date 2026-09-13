/** Apply only to app-managed launch commands, never to terminal keystrokes or prompts. */
export function withTerminalScrollback(command: string): string {
  // Keep the original quoting and arguments verbatim. Recognize only a leading
  // executable (possibly following env assignments / command / exec / PowerShell &).
  // Do not search and replace "codex" inside arbitrary shell scripts or prompts.
  const tokens = [...command.matchAll(/(?:[^\s'"\\]|\\.|'[^']*'|"[^"]*")+/g)];
  let index = 0;
  const value = (token: string) => {
    if ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))) return token.slice(1, -1);
    return token;
  };
  while (index < tokens.length) {
    const token = tokens[index][0];
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(token) ||
      ["env", "command", "exec", "&"].includes(token)) {
      index++;
      continue;
    }
    break;
  }
  const executable = tokens[index];
  if (!executable) return command;
  const name = value(executable[0]).split(/[\\/]/).pop()?.toLowerCase();
  if (!name || !["codex", "codex.exe", "codex.cmd", "codex.bat"].includes(name)) return command;
  let hasInline = false;
  let hasWhimsy = false;
  let previous = "";
  for (const token of tokens.slice(index + 1)) {
    const arg = value(token[0]);
    if (arg === "--") break;
    if (arg === "--no-alt-screen") hasInline = true;
    if ((previous === "-c" || previous === "--config") && arg === "tui.whimsy=false") {
      hasWhimsy = true;
    }
    previous = arg;
  }
  // Codex 0.154.0's Astra composer sparkle redraws even while idle. Disable
  // decorative effects for app-managed launches so PTY silence can signal done.
  // Keep work spinners (tui.animations) enabled and preserve user config on disk.
  const flags = `${hasInline ? "" : " --no-alt-screen"}${hasWhimsy ? "" : " -c tui.whimsy=false"}`;
  const end = executable.index! + executable[0].length;
  return `${command.slice(0, end)}${flags}${command.slice(end)}`;
}
