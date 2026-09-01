export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// セッションのアーカイブ: 専用タブ / 行内操作 / active 切替 / 保存・復元
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "archive-a",
    settings: { language: "ja" },
    collapsedGroups: [],
    groups: [{ id: "archive-group", name: "Later" }],
    workspaces: [
      { id: "archive-a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "archive-b", name: "Beta", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "archive-c", name: "Gamma", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c" } },
      { id: "archive-d", name: "Delta", archived: true, group: "archive-group",
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "d" } },
    ],
    deletedWorkspaces: [],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForTimeout(300);

const button = (filter) => page.locator(`#ws-status-filter [data-status-filter="${filter}"]`);
const item = (id) => page.locator(`.ws-item[data-ws-id="${id}"]`);
const visibleNames = () => page.locator(".ws-item:visible .ws-name").allTextContents();
const setFilter = async (filter) => {
  await button(filter).click();
  await page.waitForTimeout(30);
};

check("archive filter is immediately after unseen",
  await button("unseen").evaluate((el) => el.nextElementSibling?.getAttribute("data-status-filter")) ===
    "archived");
check("archive filter uses the session archive icon without a wrapping text label",
  await button("archived").locator("svg").count() === 1 &&
    await button("archived").locator("[data-i18n]").count() === 0 &&
    await button("archived").getAttribute("aria-label") === "アーカイブ" &&
    await button("archived").getAttribute("title") === "アーカイブ");
check("restored archives do not reappear as a new badge",
  !(await page.locator("#ws-archive-badge").isVisible()));
check("all excludes a restored archived session",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta", "Gamma"]) &&
    await page.locator(".ws-whole-head .ws-group-count").textContent() === "3");

await setFilter("done");
check("status filters also exclude archived sessions",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta", "Gamma"]));
await setFilter("archived");
check("archive filter only shows archived sessions across groups",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Delta"]) &&
    await page.locator(".ws-whole-head .ws-group-count").textContent() === "1");
check("archived row exposes an accessible unarchive icon",
  await item("archive-d").locator(".ws-archive").getAttribute("aria-pressed") === "true" &&
    await item("archive-d").locator(".ws-archive").getAttribute("title") ===
      "セッションをアーカイブから戻す");

await item("archive-d").locator(".ws-archive").click();
check("unarchiving removes the session from the archive tab", (await visibleNames()).length === 0);
await setFilter("all");
check("unarchived session returns to all",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta", "Gamma", "Delta"]));

await item("archive-c").locator(".ws-head").click();
const ptyStateBefore = await page.evaluate(() => ({
  spawns: window.__ptySpawns.length,
  kills: (window.__ipcLog ?? []).filter((entry) => entry.cmd === "pty_kill").length,
}));
await item("archive-c").locator(".ws-archive").click();
await page.waitForTimeout(30);
check("archiving the active session selects the next normal session",
  await item("archive-d").getAttribute("class").then((value) => value?.includes("is-active")) === true &&
    JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta", "Delta"]));
check("archiving shows a new-item badge",
  await page.locator("#ws-archive-badge").isVisible() &&
    await page.locator("#ws-archive-badge").textContent() === "1");
check("archiving keeps every PTY alive",
  await page.evaluate((before) =>
    window.__ptySpawns.length === before.spawns &&
      (window.__ipcLog ?? []).filter((entry) => entry.cmd === "pty_kill").length === before.kills,
    ptyStateBefore));

await item("archive-b").locator(".ws-archive").click();
check("archive badge counts newly archived sessions",
  await page.locator("#ws-archive-badge").textContent() === "2");
await setFilter("archived");
check("multiple archived sessions remain available only in archive",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Beta", "Gamma"]));
check("opening archive clears its badge without removing sessions",
  !(await page.locator("#ws-archive-badge").isVisible()));
await item("archive-c").locator(".ws-head").click();

await page.waitForFunction(() => {
  if (!window.__savedSession) return false;
  const saved = JSON.parse(window.__savedSession);
  const byId = Object.fromEntries(saved.workspaces.map((workspace) => [workspace.id, workspace]));
  return saved.activeId === "archive-c" && byId["archive-b"]?.archived === true &&
    byId["archive-c"]?.archived === true && !("archived" in byId["archive-d"]);
}, null, { timeout: 6000 });
const savedRaw = await page.evaluate(() => window.__savedSession ?? "");
await page.close();

const reload = await browser.newPage({ viewport: { width: 1280, height: 820 } });
reload.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await reload.addInitScript((raw) => { window.__mockSessionLoad = raw; }, savedRaw);
await reload.goto(BASE_URL);
await reload.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
check("archive state survives restart and defaults back to all",
  JSON.stringify(await reload.locator(".ws-item:visible .ws-name").allTextContents()) ===
    JSON.stringify(["Alpha", "Delta"]) &&
    await reload.locator('[data-status-filter="all"]').getAttribute("aria-pressed") === "true" &&
    await reload.locator('.ws-item[data-ws-id="archive-a"]').getAttribute("class")
      .then((value) => value?.includes("is-active")) === true);
await reload.locator('[data-status-filter="archived"]').click();
check("restarted archive tab restores every archived session",
  JSON.stringify(await reload.locator(".ws-item:visible .ws-name").allTextContents()) ===
    JSON.stringify(["Beta", "Gamma"]));
await reload.close();

}
