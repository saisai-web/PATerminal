import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/terminal/agent-launch.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { withTerminalScrollback } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

for (const [input, expected] of [
  ["codex", "codex --no-alt-screen"],
  ["codex resume --last", "codex --no-alt-screen resume --last"],
  ["codex resume deadbeef-1234", "codex --no-alt-screen resume deadbeef-1234"],
  ["codex --no-alt-screen resume --last", "codex --no-alt-screen resume --last"],
  ["  codex  -m model", "  codex --no-alt-screen  -m model"],
  ["'/path with spaces/codex' resume --last", "'/path with spaces/codex' --no-alt-screen resume --last"],
  ['& "C:\\Program Files\\Codex\\codex.exe" resume --last', '& "C:\\Program Files\\Codex\\codex.exe" --no-alt-screen resume --last'],
  ["env PATERM_PAIR_SIGNAL='/tmp/pair signal' codex -c 'notify=[\"/tmp/notify.sh\"]'", "env PATERM_PAIR_SIGNAL='/tmp/pair signal' codex --no-alt-screen -c 'notify=[\"/tmp/notify.sh\"]'"],
  ["VAR=one command codex", "VAR=one command codex --no-alt-screen"],
  ["exec /usr/local/bin/codex resume --last", "exec /usr/local/bin/codex --no-alt-screen resume --last"],
  ['codex -- "--no-alt-screen"', 'codex --no-alt-screen -- "--no-alt-screen"'],
  ['codex "explain codex and shell quoting"', 'codex --no-alt-screen "explain codex and shell quoting"'],
  ["claude --continue", "claude --continue"],
  ["vim file", "vim file"],
  ["echo codex", "echo codex"],
  ["my-codex", "my-codex"],
  ["sh -c 'codex'", "sh -c 'codex'"],
  ["command -v codex", "command -v codex"],
]) {
  test(`launch: ${input}`, () => assert.equal(withTerminalScrollback(input), expected));
}
