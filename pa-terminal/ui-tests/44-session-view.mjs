export default async function ({ browser, check, BASE_URL }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const leaf = (title) => ({ kind: "leaf", title, cwd: `/tmp/${title}`,
      scrollback: Array.from({ length: 150 }, (_, n) => `${title}-${n}`).join("\r\n") + "\r\n" });
    window.__mockSessionLoad = JSON.stringify({ version: 5, activeId: "a", groups: [],
      workspaces: [
        { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
          root: { kind: "split", dir: "row", ratio: 0.5, a: leaf("a1"), b: leaf("a2") } },
        ...["b", "c", "d"].map((id) => ({ id, name: id.toUpperCase(), shellKind: "default", broadcast: false, root: leaf(id) })),
      ] });
  });
  await page.goto(BASE_URL);
  await page.waitForSelector('.workspace-layer[data-ws-id="a"] .xterm');
  await page.waitForFunction(() => window.__ptySpawns?.length === 5);
  await page.waitForTimeout(500);
  const layer = (id) => page.locator(`.workspace-layer[data-ws-id="${id}"]`);
  const shownIds = () => page.locator('.workspace-layer:not([hidden])').evaluateAll((els) => els.map((el) => el.dataset.wsId));
  const paneIds = await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    return Object.fromEntries(workspaces.map((w) => [w.id, [...w.panes.keys()]]));
  });
  async function arrange(ids, mode = "grid") {
    await page.click("#session-view-open");
    await page.fill("#session-view-search", "");
    for (const id of ["a", "b", "c", "d"]) {
      const box = page.locator(`#session-view-list [data-ws-id="${id}"] input`);
      if (await box.count()) await box.setChecked(ids.includes(id));
    }
    await page.click(`#session-view-modes [data-mode="${mode}"]`);
    await page.click("#session-view-apply");
    await page.waitForTimeout(300);
  }
  async function sizesMatch() {
    return page.evaluate(async () => {
      const { workspaces } = await import("/src/workspace/state.ts");
      return workspaces.filter((w) => !w.layer.hidden).every((w) => [...w.panes.values()].every((p) => {
        const sent = window.__ptyResizes.filter((r) => r.id === p.id).at(-1);
        const rect = p.el.getBoundingClientRect(), parent = w.layer.getBoundingClientRect();
        return sent?.cols === p.term.cols && sent?.rows === p.term.rows && p.term.cols >= 10 && p.term.rows >= 3 &&
          rect.left >= parent.left && rect.right <= parent.right + 1 && rect.bottom <= parent.bottom + 1;
      }));
    });
  }
  await page.click("#session-view-open");
  check("session view requires at least two sessions", await page.locator("#session-view-apply").isDisabled());
  await page.locator("#session-view-search").press("Escape");
  check("cancel returns keyboard focus to the terminal", await page.locator(".is-focused .xterm-helper-textarea").evaluate((el) => el === document.activeElement));
  const dragSession = async (source, target, edge) => {
    const from = await page.locator(`.ws-item[data-ws-id="${source}"] .ws-name`).boundingBox();
    const to = await layer(target).boundingBox();
    const x = edge === "left" ? to.x + 10 : edge === "right" ? to.x + to.width - 10 : to.x + to.width / 2;
    const y = edge === "top" ? to.y + 10 : edge === "bottom" ? to.y + to.height - 10 : to.y + to.height / 2;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.move(x, y + 1);
    const preview = await page.locator("#session-view-drop-preview").isVisible();
    await page.mouse.up();
    await page.waitForTimeout(250);
    return preview;
  };
  check("sidebar drag previews a new session split", await dragSession("b", "a", "right"));
  let aBox = await layer("a").boundingBox(), bBox = await layer("b").boundingBox();
  check("dropping on the right displays another session without changing the original panes", (await shownIds()).length === 2 && bBox.x > aBox.x && await layer("a").locator(".pane").count() === 2);
  await dragSession("c", "b", "top");
  const cBox = await layer("c").boundingBox();
  bBox = await layer("b").boundingBox();
  check("dropping on an existing tile splits only that tile in the chosen direction", (await shownIds()).length === 3 && cBox.x === bBox.x && cBox.y < bBox.y && (await layer("a").boundingBox()).width === aBox.width);
  const writesBeforeDuplicate = await page.evaluate(() => window.__ptyWrites.length);
  check("dragging an already displayed session does not offer a duplicate", !await dragSession("a", "c", "right"));
  check("rejected session drops never type an ID into the terminal", (await shownIds()).length === 3 && await page.evaluate(() => window.__ptyWrites.length) === writesBeforeDuplicate);
  check("session drops leave sidebar order and processes intact", (await page.locator(".ws-item").evaluateAll((els) => els.map((el) => el.dataset.wsId))).join(",") === "a,b,c,d" && await page.evaluate(() => window.__ptySpawns.length === 5));
  check("drop preview and sidebar drag state are cleaned up", !await page.locator("#session-view-drop-preview").isVisible() && await page.locator(".is-drag-src").count() === 0);
  await page.locator(".ws-recent-sort").click();
  check("recent-sort sessions can also be dragged onto terminals", await dragSession("d", "b", "bottom") && (await shownIds()).length === 4);
  await page.locator(".ws-recent-sort").click();
  await layer("d").locator(".workspace-view-remove").click();
  await layer("a").locator(".workspace-view-solo").click();
  await arrange(["a", "b", "c", "d"]);
  check("four sessions are displayed with their existing pane trees", (await shownIds()).length === 4 && await layer("a").locator(".pane").count() === 2);
  check("arranging sessions does not create or kill PTYs", await page.evaluate(() => window.__ptySpawns.length === 5 && !window.__ipcLog.some((e) => e.cmd === "pty_kill")));
  const boxes = await Promise.all(["a", "b", "c", "d"].map((id) => layer(id).boundingBox()));
  check("grid fills a two by two layout", boxes[0].x === boxes[1].x && boxes[1].y > boxes[0].y && boxes[2].x > boxes[0].x && boxes[2].y === boxes[0].y && boxes[3].y === boxes[1].y);
  check("all displayed terminals receive their fitted size", await sizesMatch());
  check("every displayed pane is released after resizing", await page.evaluate((ids) => ids.every((id) => {
    const shown = window.__ptyVisible.filter((e) => e.ids.includes(id)).at(-1);
    const size = window.__ptyResizes.filter((e) => e.id === id).at(-1);
    return shown?.visible && size && shown.t >= size.t;
  }), Object.values(paneIds).flat()));

  await layer("b").locator(".pane-body").click();
  await page.evaluate(() => { window.__ptyWrites.length = 0; window.dispatchEvent(new Event("focus")); });
  await page.keyboard.type("claudeABC");
  await page.waitForTimeout(120);
  const input = await page.evaluate(async () => {
    const { getActiveWs, getFocusedId } = await import("/src/workspace/state.ts");
    return { ws: getActiveWs()?.id, focused: getFocusedId(), writes: window.__ptyWrites };
  });
  check("clicking another tile switches the input session without hiding peers", input.ws === "b" && input.focused === paneIds.b[0] && (await shownIds()).length === 4);
  check("typing reaches only the clicked session, once per character", input.writes.every((w) => w.id === paneIds.b[0]) && input.writes.map((w) => w.data).join("") === "claudeABC");
  check("only one terminal has the focused border", await page.locator(".pane.is-focused").count() === 1);

  // A visible but unfocused session is still being watched; completion must stay quiet.
  await layer("c").locator(".pane-body").click();
  await page.evaluate((id) => window.__emit("pty:act", { id, busy: false, busyMs: 100 }), paneIds.b[0]);
  await page.waitForTimeout(100);
  check("completion in a visible unfocused session does not notify", await page.evaluate(() => window.__notifications.length === 0));

  // Keep a history anchor in a tile while another tile receives focus and the layout changes.
  await page.evaluate(async (id) => {
    const { panes } = await import("/src/workspace/state.ts");
    panes.get(id).term.scrollToLine(20);
  }, paneIds.a[1]);
  const historyLine = () => page.evaluate(async (id) => {
    const { panes } = await import("/src/workspace/state.ts"); return panes.get(id).term.buffer.active.viewportY;
  }, paneIds.a[1]);
  const anchor = await historyLine();
  await layer("d").locator(".pane-body").click();
  await page.click("#exp-reopen");
  await page.waitForTimeout(300);
  check("history survives focus changes and opening Files in another session", await historyLine() === anchor && await sizesMatch());
  await page.click("#exp-close");
  await page.waitForTimeout(300);

  const divider = page.locator("#grid > .workspace-divider.dir-row");
  const rect = await divider.boundingBox();
  await page.evaluate(() => { window.__ptyResizes.length = 0; });
  await page.mouse.move(rect.x + 2, rect.y + 30);
  await page.mouse.down();
  await page.mouse.move(rect.x - 70, rect.y + 30, { steps: 5 });
  await page.waitForTimeout(450);
  check("dragging session boundaries does not resize PTYs mid-drag", await page.evaluate(() => window.__ptyResizes.length === 0));
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("drag completion refits all sessions and clears capture state", !await page.locator("body").evaluate((el) => el.classList.contains("dragging")) && await sizesMatch());
  const saved = await page.evaluate(async () => {
    const { flushSessionSave } = await import("/src/app/session.ts");
    await flushSessionSave(); return JSON.parse(window.__savedSession);
  });
  check("session view and adjusted boundaries are saved beside the original pane trees", saved.view?.root.ratio < 0.5 && saved.workspaces[0].root.kind === "split" && saved.view.mode === "grid");

  const restored = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await restored.addInitScript((data) => { window.__mockSessionLoad = JSON.stringify(data); }, saved);
  await restored.goto(BASE_URL);
  await restored.waitForSelector("#grid.multi-session");
  check("restart restores all selected sessions and the resized divider", await restored.locator('.workspace-layer:not([hidden])').count() === 4 &&
    Number(await restored.locator("#grid > .workspace-divider.dir-row").getAttribute("aria-valuenow")) === Math.round(saved.view.root.ratio * 100));
  await restored.close();

  for (const mode of ["row", "col"]) {
    await arrange(["a", "b", "c"], mode);
    const rects = await Promise.all(["a", "b", "c"].map((id) => layer(id).boundingBox()));
    check(`${mode} arrangement uses the requested direction`, mode === "row"
      ? rects.every((r) => r.y === rects[0].y && r.height === rects[0].height) && rects[0].x < rects[1].x && rects[1].x < rects[2].x
      : rects.every((r) => r.x === rects[0].x && r.width === rects[0].width) && rects[0].y < rects[1].y && rects[1].y < rects[2].y);
  }
  await layer("b").locator(".pane-body").click();
  await page.click("#split-right");
  await page.waitForTimeout(300);
  check("splitting within a session preserves all other session tiles", await layer("b").locator(".pane").count() === 2 && await layer("a").locator(".pane").count() === 2 && (await shownIds()).length === 3);
  await page.locator('.ws-item[data-ws-id="d"] .ws-head').click();
  check("sidebar navigation opens an unrelated session alone", JSON.stringify(await shownIds()) === JSON.stringify(["d"]));
  await page.locator('.ws-item[data-ws-id="b"] .ws-head').click();
  check("returning to a member restores the selected sessions", JSON.stringify(await shownIds()) === JSON.stringify(["a", "b", "c"]));
  const killedBefore = await page.evaluate(() => window.__ipcLog.filter((e) => e.cmd === "pty_kill").length);
  await layer("c").locator(".workspace-view-remove").click();
  check("removing a tile keeps its session and process running", (await shownIds()).length === 2 && await page.locator('.ws-item[data-ws-id="c"]').count() === 1 && await page.evaluate(() => window.__ipcLog.filter((e) => e.cmd === "pty_kill").length) === killedBefore);

  // Fast navigation must not let an older asynchronous visibility update win.
  await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    const { setActive } = await import("/src/workspace/workspace.ts");
    for (const id of ["b", "c", "d"]) setActive(workspaces.find((w) => w.id === id));
  });
  await page.waitForTimeout(250);
  check("rapid switches leave exactly the displayed PTYs visible", await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    return workspaces.every((w) => [...w.panes.keys()].every((id) =>
      window.__ptyVisible.filter((e) => e.ids.includes(id)).at(-1)?.visible === !w.layer.hidden));
  }));

  // Broadcast remains a separate opt-in, scoped to its selected sessions.
  await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    const { startBroadcast } = await import("/src/terminal/focus.ts");
    startBroadcast(workspaces.find((w) => w.id === "d"));
  });
  check("broadcast borders identify only actual recipients", await layer("d").evaluate((el) => el.classList.contains("is-broadcast-target")) &&
    !await layer("a").evaluate((el) => el.classList.contains("is-broadcast-target")));
  await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    const { stopBroadcast } = await import("/src/terminal/focus.ts");
    stopBroadcast(workspaces.find((w) => w.id === "d"));
  });

  // Close a displayed, unfocused session: the remaining tile expands without losing its terminal.
  await page.locator('.ws-item[data-ws-id="b"] .ws-head').click();
  await page.locator('.ws-item[data-ws-id="a"] .ws-close').click({ force: true });
  await page.waitForTimeout(350);
  check("closing a displayed session collapses the view to its surviving session", JSON.stringify(await shownIds()) === JSON.stringify(["b"]) && !await page.locator("#grid").evaluate((el) => el.classList.contains("multi-session")));
  await arrange(["b", "c", "d"]);
  await page.locator('.ws-item[data-ws-id="c"] .ws-archive').click({ force: true });
  check("archiving a visible session removes its tile", JSON.stringify(await shownIds()) === JSON.stringify(["b", "d"]));
  await layer("b").locator(".workspace-view-solo").click();
  check("single-session view keeps all existing sessions alive", JSON.stringify(await shownIds()) === JSON.stringify(["b"]) && await page.locator(".workspace-layer").count() === 3);
  await page.evaluate(async () => { const { flushSessionSave } = await import("/src/app/session.ts"); await flushSessionSave(); });
  check("returning to a single session clears the persisted view", await page.evaluate(() => !JSON.parse(window.__savedSession).view));
  check("session view produces no frontend errors", errors.length === 0, errors.join("; "));
  await page.close();

  // Malformed layouts must not hide valid sessions or render duplicate copies of a terminal.
  const invalid = await browser.newPage();
  await invalid.addInitScript((data) => {
    data.view = { mode: "grid", root: { kind: "split", dir: "row", ratio: 20,
      a: { kind: "leaf", workspaceId: "a" }, b: { kind: "split", dir: "col", ratio: 0.5,
        a: { kind: "leaf", workspaceId: "a" }, b: { kind: "leaf", workspaceId: "missing" } } } };
    window.__mockSessionLoad = JSON.stringify(data);
  }, saved);
  await invalid.goto(BASE_URL);
  await invalid.waitForSelector(".pane.is-focused");
  check("invalid or duplicate view references fall back to a usable single session", await invalid.locator('.workspace-layer:not([hidden])').count() === 1 && !await invalid.locator("#grid").evaluate((el) => el.classList.contains("multi-session")));
  await invalid.close();
}
