export default async function ({ browser, check, BASE_URL }) {
  const sessionId = "aaaaaaaa-1111-4111-8111-222222222222";
  const createPage = async (os = "macos") => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.addInitScript((hostOs) => { window.__mockHostOs = hostOs; }, os);
    await page.goto(BASE_URL);
    await page.waitForSelector(".pane .xterm-helper-textarea");
    await page.waitForFunction(() => window.__ptySpawns.length > 0);
    return page;
  };
  const detect = (page, kind, id = sessionId) => page.evaluate(({ kind, id }) => {
    const pane = window.__ptySpawns[0].id;
    window.__mockPtyAgents = { [pane]: kind };
    window.__mockAgentSessionId = id;
  }, { kind, id });
  const open = async (page, path = "/tmp") => {
    await page.locator("#pane-change-directory").click();
    await page.locator("#move-directory-path").fill(path);
  };
  const unchanged = (page) => page.evaluate(() =>
    window.__ptySpawns.length === 1 && !window.__ipcLog.some((event) => event.cmd === "pty_kill") &&
    window.__ptyWrites.every((entry) => !/cd |Set-Location|resume|continue/.test(entry.data)));

  for (const [kind, os, destination] of [["claude", "macos", "/tmp"], ["codex", "macos", "/home/user/proj/src"], ["codex", "windows", "C:/Users"]]) {
    const page = await createPage(os);
    await detect(page, kind);
    await open(page, destination);
    check(`${kind}/${os}: detects a CLI started between periodic sweeps`,
      (await page.locator("#move-directory-description").textContent()).includes(kind));
    await page.keyboard.press("Escape");
    check(`${kind}/${os}: cancel leaves the original PTY and CLI untouched`, await unchanged(page));

    await open(page, "/missing-folder");
    await page.locator("#move-directory-submit").click();
    await page.waitForFunction(() => document.querySelector("#move-directory-error")?.textContent);
    check(`${kind}/${os}: an invalid destination leaves the CLI running`, await unchanged(page));
    await page.locator("#move-directory-path").fill(destination);
    await page.evaluate(() => window.__ptyPushAll("\r\ndirectory-switch-history\r\n"));
    await page.locator("#move-directory-submit").click();
    await page.waitForFunction(() => window.__ptySpawns.length === 2);
    const expected = kind === "codex" ? `codex --no-alt-screen resume ${sessionId} --cd .\r` : `claude --resume ${sessionId}\r`;
    await page.waitForFunction((command) => window.__ptyWrites.some((entry) => entry.data === command), expected);
    const state = await page.evaluate(async () => {
      const { panes } = await import("/src/workspace/state.ts");
      const pane = [...panes.values()][0];
      const text = Array.from({ length: pane.term.buffer.normal.length }, (_, index) =>
        pane.term.buffer.normal.getLine(index).translateToString()).join("\n");
      return { spawns: window.__ptySpawns, writes: window.__ptyWrites, log: window.__ipcLog,
        count: document.querySelectorAll(".pane").length, text, agent: pane.spec.agent,
        focused: document.activeElement === pane.term.textarea };
    });
    check(`${kind}/${os}: resumes in the selected directory in the same pane position`,
      state.count === 1 && state.spawns[1].cwd === destination && state.spawns[1].shell === null &&
      state.agent.sessionId === sessionId && state.focused, JSON.stringify(state.spawns));
    check(`${kind}/${os}: stops the old PTY before spawning its replacement`,
      state.log.findIndex((event) => event.cmd === "pty_kill") < state.log.findIndex((event) => event.cmd === "pty_spawn" && event.id === state.spawns[1].id));
    check(`${kind}/${os}: sends the resume command only to the replacement shell`,
      state.writes.filter((entry) => entry.data === expected).length === 1 &&
      state.writes.find((entry) => entry.data === expected).id === state.spawns[1].id &&
      !state.writes.some((entry) => /^(cd |Set-Location)/.test(entry.data)));
    check(`${kind}/${os}: preserves display history without carrying TUI modes`, state.text.includes("directory-switch-history"));
    // A different transcript appears in the destination. An inherited exact ID
    // must remain pinned after the replacement gets detected and persisted.
    await page.evaluate(async () => {
      const { panes } = await import("/src/workspace/state.ts");
      const { agentForDirectoryChange } = await import("/src/features/agents/watch.ts");
      const pane = [...panes.values()][0];
      window.__mockPtyAgents = { [pane.id]: pane.spec.agent.kind };
      window.__mockAgentSessionId = "bbbbbbbb-1111-4111-8111-222222222222";
      await agentForDirectoryChange(pane);
    });
    await page.waitForFunction((id) => {
      const saved = JSON.parse(window.__savedSession ?? "null");
      return saved?.workspaces?.[0]?.root?.agent?.sessionId === id && saved.workspaces[0].root.agent.useCurrentCwd === true;
    }, sessionId);
    check(`${kind}/${os}: keeps the original conversation and directory override when saved`, true);
    if (kind === "codex" && os === "macos") {
      const saved = await page.evaluate(() => window.__savedSession);
      const restored = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await restored.addInitScript((session) => { window.__mockSessionLoad = session; }, saved);
      await restored.goto(BASE_URL);
      await restored.waitForFunction((command) => window.__ptyWrites.some((entry) => entry.data === command), expected);
      check("app restart retains the chosen Codex working folder", await restored.evaluate((dir) => window.__ptySpawns[0].cwd === dir, destination));
      await restored.close();
    }
    await page.close();
  }

  const page = await createPage();
  await detect(page, "claude", null);
  await open(page);
  await page.locator("#move-directory-submit").click();
  await page.waitForFunction(() => document.querySelector("#move-directory-error")?.textContent.includes("会話ID"));
  check("missing conversation ID never falls back to a different conversation", await unchanged(page));
  await page.evaluate(() => { window.__mockAgentSessionId = "aaaaaaaa; echo unsafe"; });
  await page.locator("#move-directory-submit").click();
  await page.waitForFunction(() => document.querySelector("#move-directory-error")?.textContent.includes("会話ID"));
  check("malformed conversation ID cannot stop the CLI or become a shell command", await unchanged(page));
  await page.evaluate((id) => { window.__mockAgentSessionId = id; }, sessionId);
  await page.locator("#move-directory-submit").click();
  await page.waitForFunction(() => window.__ptySpawns.length === 2);
  check("an unresolved conversation can be retried once its ID is saved", true);
  await page.close();

  const shell = await createPage();
  await open(shell);
  await shell.locator("#move-directory-submit").click();
  await shell.waitForFunction(() => window.__ptyWrites.some((entry) => entry.data === "cd '/tmp'\r"));
  check("ordinary shells change directory without restarting", await shell.evaluate(() => window.__ptySpawns.length === 1));
  await shell.close();

  const explorer = await createPage();
  await detect(explorer, "codex");
  await explorer.evaluate(async () => {
    const { terminalCdTo } = await import("/src/features/explorer/explorer-menu.ts");
    terminalCdTo("/tmp");
  });
  await explorer.waitForSelector("#move-directory-panel");
  check("explorer movement opens the same confirmation instead of sending cd to an AI", await unchanged(explorer));
  await explorer.keyboard.press("Escape");
  await explorer.close();

  const failure = await createPage();
  await failure.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args, options) => command === "pty_agents"
      ? Promise.reject(new Error("agent detection unavailable")) : invoke(command, args, options);
  });
  await open(failure);
  await failure.locator("#move-directory-submit").click();
  await failure.waitForFunction(() => document.querySelector("#move-directory-error")?.textContent.includes("unavailable"));
  check("detection failure never injects cd or restarts a potentially running AI", await unchanged(failure));
  await failure.close();

  const split = await createPage();
  await split.locator("#split-right").click();
  const splitState = await split.evaluate(async () => {
    const { getActiveWs, getFocusedId, panes } = await import("/src/workspace/state.ts");
    const ws = getActiveWs();
    const target = panes.get(getFocusedId());
    const sibling = [...panes.values()].find((pane) => pane !== target);
    window.__mockPtyAgents = { [target.id]: "codex" };
    window.__mockAgentSessionId = "aaaaaaaa-1111-4111-8111-222222222222";
    return { target: target.id, sibling: sibling.id, ratio: ws.root.ratio };
  });
  await open(split);
  await split.locator("#move-directory-submit").click();
  await split.waitForFunction(() => window.__ptySpawns.length === 3);
  check("moving a split pane preserves its sibling and split ratio", await split.evaluate(async (before) => {
    const { getActiveWs, panes } = await import("/src/workspace/state.ts");
    const ws = getActiveWs();
    return panes.has(before.sibling) && !panes.has(before.target) && ws.panes.size === 2 &&
      ws.root.ratio === before.ratio && ws.root.b.pane.cwd === "/tmp";
  }, splitState));
  await split.locator(".pane-cwd").first().click();
  await split.waitForSelector("#move-directory-panel");
  check("clicking an unfocused pane's folder name opens its own working folder",
    await split.locator("#move-directory-path").inputValue() === "/home/user");
  await split.keyboard.press("Escape");
  // Keyboard activation does not fire mousedown/setFocused: the folder action
  // must still address its own pane instead of using the global focused ID.
  const destinationFolder = split.locator(".pane-cwd").last();
  await destinationFolder.focus();
  await destinationFolder.press("Enter");
  await split.waitForSelector("#move-directory-panel");
  check("folder names support keyboard activation and target the correct pane",
    await split.locator("#move-directory-path").inputValue() === "/tmp");
  await split.keyboard.press("Escape");
  await split.close();

  const special = await createPage();
  await detect(special, "codex");
  const specialPath = "/tmp/日本語 folder ' $literal `name`";
  await special.evaluate((path) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args, options) => command === "fs_is_dir" && args.path === path
      ? Promise.resolve(null) : invoke(command, args, options);
  }, specialPath);
  await open(special, specialPath);
  await special.locator("#move-directory-submit").click();
  await special.waitForFunction(() => window.__ptyWrites.some((entry) => entry.data.includes("resume")));
  check("Unicode, spaces and shell metacharacters in the destination never enter a command", await special.evaluate((path) =>
    window.__ptySpawns[1].cwd === path && window.__ptyWrites.every((entry) => !entry.data.includes(path)), specialPath));
  await special.close();

  const spawnFailure = await createPage();
  await detect(spawnFailure, "codex");
  await open(spawnFailure);
  await spawnFailure.evaluate(() => { window.__mockPtySpawnFailUntil = 1; });
  await spawnFailure.locator("#move-directory-submit").click();
  await spawnFailure.waitForFunction(() => window.__ptySpawns.length === 3);
  await spawnFailure.keyboard.type("after-move-failure");
  await spawnFailure.waitForFunction(() => window.__ptyWrites.map((entry) => entry.data).join("").includes("after-move-failure"));
  check("spawn failure leaves an interactive shell and does not resume in a fallback directory", await spawnFailure.evaluate(() =>
    window.__ptySpawns[1].id === window.__ptySpawns[2].id && !window.__ptyWrites.some((entry) => entry.data.includes("resume"))));
  await spawnFailure.close();

  const race = await createPage();
  await detect(race, "codex");
  await open(race);
  await race.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      if (command === "pty_kill" && !window.__releaseDirectoryKill) {
        await new Promise((resolve) => { window.__releaseDirectoryKill = resolve; });
      }
      return invoke(command, args, options);
    };
  });
  await race.locator("#move-directory-submit").click();
  await race.waitForFunction(() => typeof window.__releaseDirectoryKill === "function");
  await race.evaluate(async () => {
    const { getActiveWs } = await import("/src/workspace/state.ts");
    const { closeWorkspace } = await import("/src/workspace/workspace.ts");
    const ws = getActiveWs();
    window.__directoryClosedWorkspace = ws;
    const closing = closeWorkspace(ws);
    window.__releaseDirectoryKill();
    await closing;
  });
  check("closing a session during the move cannot resurrect an orphan pane", await race.evaluate(() =>
    window.__directoryClosedWorkspace.panes.size === 0 && window.__ptySpawns.every((spawn) => spawn.cwd !== "/tmp")));
  await race.close();
}
