export default async function ({ browser, check, BASE_URL }) {
  const fixture = {
    version: 5, activeId: "a", groups: [],
    view: { mode: "row", root: { kind: "split", dir: "row", ratio: 0.37,
      a: { kind: "leaf", workspaceId: "a", color: 2 },
      b: { kind: "leaf", workspaceId: "b", color: 4 } } },
    workspaces: ["a", "b", "c", "d"].map((id) => {
      const leaf = (title) => ({ kind: "leaf", title, cwd: `/tmp/${id}` });
      return { id, name: id.toUpperCase(), shellKind: "default", broadcast: false,
        root: id === "a" || id === "d"
          ? { kind: "split", dir: "col", ratio: 0.6, a: leaf(`${id}1`), b: leaf(`${id}2`) }
          : leaf(id) };
    }),
  };
  const errors = [];
  async function open(data) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((value) => { window.__mockSessionLoad = JSON.stringify(value); }, data);
    await page.goto(BASE_URL);
    await page.waitForSelector(".pane.is-focused .xterm");
    await page.waitForTimeout(400);
    return page;
  }
  async function select(page, id) {
    await page.locator(`.ws-item[data-ws-id="${id}"] .ws-head`).click();
    await page.waitForTimeout(200);
  }
  async function state(page) {
    return page.evaluate(async () => {
      const { getActiveWs, workspaces } = await import("/src/workspace/state.ts");
      const { getWorkspaceView } = await import("/src/workspace/view.ts");
      return {
        active: getActiveWs()?.id,
        shown: workspaces.filter((w) => !w.layer.hidden).map((w) => w.id),
        panes: Object.fromEntries(workspaces.map((w) => [w.id, [...w.panes.keys()]])),
        view: getWorkspaceView(),
      };
    });
  }
  const originalView = JSON.stringify(fixture.view);
  const kept = (current) => JSON.stringify(current.view) === originalView;
  async function standalone(page, id) {
    const current = await state(page);
    const fullSize = await page.locator(`.workspace-layer[data-ws-id="${id}"]`).evaluate((el) => {
      const r = el.getBoundingClientRect(), grid = document.querySelector("#grid").getBoundingClientRect();
      return r.x === grid.x && r.y === grid.y && r.width === grid.width && r.height === grid.height;
    });
    return current.active === id && current.shown.join(",") === id && fullSize && kept(current) &&
      await page.locator(".workspace-view-header, .workspace-divider").count() === 0 &&
      await page.locator("#session-view-solo").isHidden();
  }
  async function save(page) {
    return page.evaluate(async () => {
      const { flushSessionSave } = await import("/src/app/session.ts");
      await flushSessionSave();
      return JSON.parse(window.__savedSession);
    });
  }
  const page = await open(fixture);
  const initial = await state(page);
  check("saved split members open together with the original arrangement", initial.shown.join(",") === "a,b" && kept(initial));
  await select(page, "c");
  check("an unrelated sidebar session opens alone at full size without replacing a member", await standalone(page, "c"));
  check("saved member colors remain identifiable in the sidebar while another session is open",
    await page.locator('.ws-item[data-ws-id="a"].has-session-color, .ws-item[data-ws-id="b"].has-session-color').count() === 2 &&
    await page.locator('.ws-item[data-ws-id="c"].has-session-color').count() === 0);
  await page.click("#session-view-open");
  check("the split picker on a standalone session starts with only that session selected",
    (await page.locator('#session-view-list input:checked').evaluateAll((els) => els.map((el) => el.closest("[data-ws-id]").dataset.wsId))).join(",") === "c");
  await page.click("#session-view-cancel");
  await page.evaluate(() => { window.__ptyWrites.length = 0; });
  await page.keyboard.type("soloABC");
  await page.waitForTimeout(100);
  check("standalone input reaches only the selected session exactly once", await page.evaluate((id) =>
    window.__ptyWrites.every((w) => w.id === id) && window.__ptyWrites.map((w) => w.data).join("") === "soloABC", initial.panes.c[0]));
  await select(page, "d");
  check("an unrelated session retains its own internal panes in standalone display", await standalone(page, "d") &&
    await page.locator('.workspace-layer[data-ws-id="d"] .pane').count() === 2);
  for (const id of ["a", "b"]) {
    await select(page, id);
    const current = await state(page);
    check(`selecting member ${id} restores the original members, colors, ratios and terminals`,
      current.active === id && current.shown.join(",") === "a,b" && kept(current) &&
      JSON.stringify(current.panes) === JSON.stringify(initial.panes) &&
      Number(await page.locator(".workspace-divider").getAttribute("aria-valuenow")) === 37);
    if (id === "a") await select(page, "c");
  }
  const spawns = await page.evaluate(() => window.__ptySpawns.length);
  await page.click("#ws-new");
  await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
  if (await page.locator("#ws-new-form").isVisible()) await page.locator("#ws-new-shells button").first().click();
  await page.waitForFunction((count) => window.__ptySpawns.length > count, spawns);
  await page.waitForTimeout(300);
  const created = await state(page);
  check("creating a session from a split view opens one new standalone terminal", !initial.panes[created.active] &&
    created.panes[created.active].length === 1 && await standalone(page, created.active) &&
    await page.evaluate((count) => window.__ptySpawns.length === count + 1, spawns));
  await select(page, "a");
  const returned = await state(page);
  check("returning after session creation restores the original split without inserting the new session",
    returned.shown.join(",") === "a,b" && kept(returned));
  await select(page, "c");
  const saved = await save(page);
  check("saving from a standalone session keeps its active selection and the dormant split", saved.activeId === "c" && kept(saved));

  const restored = await open(saved);
  check("restart while outside the split restores the standalone session", await standalone(restored, "c"));
  await select(restored, "b");
  const resumed = await state(restored);
  check("a saved split remains reachable through either member after restart", resumed.shown.join(",") === "a,b" && kept(resumed));
  await select(restored, "c");
  await restored.locator('.ws-item[data-ws-id="a"] .ws-archive').click({ force: true });
  await select(restored, "b");
  check("archiving a member while its split is hidden cannot reopen the archived session",
    (await state(restored)).shown.join(",") === "b" && !(await state(restored)).view);
  await restored.close();

  await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    const { setActive } = await import("/src/workspace/workspace.ts");
    for (const id of ["a", "c", "b", "d", "a", "c"]) setActive(workspaces.find((w) => w.id === id));
  });
  await page.waitForTimeout(300);
  check("rapid navigation preserves the split and only releases output to the final standalone session",
    await standalone(page, "c") && await page.evaluate(async () => {
      const { workspaces } = await import("/src/workspace/state.ts");
      return workspaces.every((w) => [...w.panes.keys()].every((id) =>
        window.__ptyVisible.filter((e) => e.ids.includes(id)).at(-1)?.visible === !w.layer.hidden));
    }));
  await page.locator('.ws-item[data-ws-id="a"] .ws-close').click({ force: true });
  await page.waitForTimeout(300);
  check("closing a hidden member leaves the unrelated active session open", (await state(page)).shown.join(",") === "c");
  await select(page, "b");
  check("closing a hidden member collapses the saved split to its surviving session", (await state(page)).shown.join(",") === "b" && !(await state(page)).view);

  // A drop outside a saved view must start from the visible target, never its hidden tree.
  const dropped = await open(fixture);
  await select(dropped, "c");
  await dropped.locator('.ws-item[data-ws-id="d"] .ws-name').dragTo(
    dropped.locator('.workspace-layer[data-ws-id="c"]'), { targetPosition: { x: 10, y: 120 } });
  await dropped.waitForTimeout(300);
  check("dragging onto an unrelated standalone session splits the visible target", (await state(dropped)).shown.join(",") === "c,d" &&
    await dropped.locator('.workspace-layer[data-ws-id="d"] .pane').count() === 2);
  await dropped.close();
  check("split navigation produces no frontend errors", errors.length === 0, errors.join("; "));
  await page.close();
}
