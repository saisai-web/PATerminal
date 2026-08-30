export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 復元表示が残っていても、入力先 PTY を失ったペインを作らない
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  // 旧版の SerializeAddon が保存した入力モードを含む表示履歴を再現する。
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "restored-input",
    groups: [],
    workspaces: [{
      id: "restored-input",
      name: "Restored input",
      shellKind: "default",
      broadcast: false,
      root: {
        kind: "leaf",
        title: "restored",
        resumeShell: "/missing/saved-process",
        resumeArgs: ["--resume"],
        scrollback: "previous-session-content\r\n\x1b[?1h\x1b[?2004h\x1b[?1003h",
      },
    }],
    deletedWorkspaces: [],
  });
  // 保存済みプロセスの初回 spawn だけを失敗させる。
  window.__mockPtySpawnFailUntil = 1;
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
try {
  await page.waitForFunction(() => window.__ptySpawns?.length >= 2, undefined, { timeout: 10000 });
} catch (error) {
  const state = await page.evaluate(() => ({
    spawns: window.__ptySpawns,
    failLeft: window.__mockPtySpawnFailUntil,
    restoredName: document.querySelector(".ws-item.is-active .ws-name")?.textContent,
    hasSpawnFailureMock: String(window.__TAURI_INTERNALS__?.invoke).includes("mock pty_spawn failure"),
  }));
  throw new Error(`terminal recovery did not reach fallback spawn: ${JSON.stringify(state)}`, { cause: error });
}

const bootSpawns = await page.evaluate(() => window.__ptySpawns.map((spawn) => ({
  id: spawn.id,
  shell: spawn.shell,
  args: spawn.args,
})));
check("failed restored process falls back to an interactive shell in the same pane",
  bootSpawns.length >= 2 &&
    bootSpawns[0].shell === "/missing/saved-process" &&
    bootSpawns[1].id === bootSpawns[0].id &&
    bootSpawns[1].shell === null &&
    bootSpawns[1].args === null,
  `spawns=${JSON.stringify(bootSpawns)}`);

const body = page.locator(".workspace-layer:not([hidden]) .pane-body");
await body.click();
const writesAtBoot = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("ArrowUp");
await page.keyboard.type("after-restored-spawn");
await page.waitForFunction(
  (from) => window.__ptyWrites.slice(from).map((entry) => entry.data).join("").includes("after-restored-spawn"),
  writesAtBoot,
  { timeout: 5000 },
);
const restoredWrites = await page.evaluate(
  (from) => window.__ptyWrites.slice(from).map((entry) => entry.data),
  writesAtBoot,
);
check("legacy restored terminal modes are reset before accepting keyboard input",
  restoredWrites.join("").startsWith("\x1b[A") && !restoredWrites.join("").includes("\x1bOA"),
  `writes=${JSON.stringify(restoredWrites)}`);
check("typing reaches the fallback PTY after restored spawn failure",
  restoredWrites.join("").includes("after-restored-spawn"),
  `writes=${JSON.stringify(restoredWrites)}`);

// ライブ TUI が入力モードと alternate buffer を有効にしている最中に保存しても、
// session.json は表示履歴だけを持ち、次回のシェルへモードを持ち越さない。
await page.evaluate(() => {
  window.__ptyPushAll("\x1b[?1h\x1b[?2004h\x1b[?1049h\x1b[Halternate-screen");
});
await page.locator(".ws-item.is-active .ws-name").dblclick();
await page.locator(".ws-item.is-active .inline-edit").fill("Restored input saved");
await page.keyboard.press("Enter");
await page.waitForFunction(() => {
  const saved = JSON.parse(window.__savedSession ?? "null");
  return saved?.workspaces?.[0]?.name === "Restored input saved";
}, undefined, { timeout: 5000 });
const savedScrollback = await page.evaluate(() => {
  const saved = JSON.parse(window.__savedSession ?? "null");
  return saved?.workspaces?.[0]?.root?.scrollback ?? "";
});
check("saved display history excludes TUI modes and the alternate buffer",
  !savedScrollback.includes("\x1b[?1h") &&
    !savedScrollback.includes("\x1b[?2004h") &&
    !savedScrollback.includes("\x1b[?1049h"),
  `scrollback=${JSON.stringify(savedScrollback.slice(-160))}`);

// シェル自身が終了しても dead な表示へ固定せず、同じペイン ID で自動復旧する。
const beforeExitSpawns = await page.evaluate(() => window.__ptySpawns.length);
const paneId = bootSpawns[bootSpawns.length - 1].id;
await page.evaluate((id) => window.__emit("pty:exit", { id }), paneId);
await page.waitForFunction(
  (count) => window.__ptySpawns.length > count,
  beforeExitSpawns,
  { timeout: 5000 },
);
const recovered = await page.evaluate((id) => ({
  spawn: window.__ptySpawns.at(-1),
  dead: document.querySelector(".workspace-layer:not([hidden]) .pane")?.classList.contains("is-dead"),
  focused: document.activeElement?.classList.contains("xterm-helper-textarea") ?? false,
  sameId: window.__ptySpawns.at(-1)?.id === id,
}), paneId);
check("exited PTY automatically restarts an interactive shell",
  recovered.sameId && recovered.spawn?.shell === null && recovered.dead === false,
  `state=${JSON.stringify(recovered)}`);
check("terminal focus is retained after automatic shell recovery", recovered.focused === true,
  `state=${JSON.stringify(recovered)}`);

const writesAfterExit = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.type("after-process-exit");
await page.waitForFunction(
  (from) => window.__ptyWrites.slice(from).map((entry) => entry.data).join("").includes("after-process-exit"),
  writesAfterExit,
  { timeout: 5000 },
);
check("typing reaches the automatically restarted PTY",
  await page.evaluate(
    (from) => window.__ptyWrites.slice(from).map((entry) => entry.data).join("").includes("after-process-exit"),
    writesAfterExit,
  ));

await page.close();
}
