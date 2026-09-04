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
  for (const token of tokens.slice(index + 1)) {
    if (value(token[0]) === "--") break;
    if (value(token[0]) === "--no-alt-screen") return command;
  }
  const end = executable.index! + executable[0].length;
  return `${command.slice(0, end)} --no-alt-screen${command.slice(end)}`;
}
