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
    Number.isFinite(byId["archive-b"]?.archivedAt) &&
    byId["archive-c"]?.archived === true && Number.isFinite(byId["archive-c"]?.archivedAt) &&
    !("archived" in byId["archive-d"]) && !("archivedAt" in byId["archive-d"]);
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

// 期限切れは復元コマンドやPTYを起動せず削除履歴へ移し、旧データには初回起動時刻を補う。
// 起動中に60日へ達した項目も同じ削除経路を通る。
const retentionPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
retentionPage.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const retentionNow = Date.UTC(2026, 8, 5, 12, 0, 0);
const dayMs = 24 * 60 * 60 * 1000;
await retentionPage.clock.install({ time: retentionNow });
await retentionPage.addInitScript(({ now, day }) => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "retention-current",
    settings: { language: "ja" },
    collapsedGroups: [],
    groups: [],
    workspaces: [
      { id: "retention-current", name: "Current", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "current" } },
      { id: "retention-fresh", name: "Fresh archive", archived: true,
        archivedAt: now - 59 * day, shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "fresh" } },
      { id: "retention-expired", name: "Expired archive", archived: true,
        archivedAt: now - 60 * day, shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "expired", resumeRun: "must-not-run" } },
      { id: "retention-legacy", name: "Legacy archive", archived: true,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "legacy" } },
    ],
    deletedWorkspaces: [],
  });
}, { now: retentionNow, day: dayMs });
await retentionPage.goto(BASE_URL);
await retentionPage.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await retentionPage.locator('[data-status-filter="archived"]').click();
check("expired archives are removed before their PTY or resume command starts",
  await retentionPage.locator('.ws-item[data-ws-id="retention-expired"]').count() === 0 &&
    await retentionPage.evaluate(() => window.__ptySpawns.length) === 3 &&
    JSON.stringify(await retentionPage.locator(".ws-item:visible .ws-name").allTextContents()) ===
      JSON.stringify(["Fresh archive", "Legacy archive"]));
await retentionPage.click("#session-trash-open");
check("startup cleanup keeps an expired archive recoverable in recently deleted",
  await retentionPage.locator(".session-trash-row", { hasText: "Expired archive" }).count() === 1);
await retentionPage.clock.runFor(1000);
const migratedRetention = await retentionPage.evaluate(() =>
  JSON.parse(window.__savedSession ?? "null"));
const legacyArchivedAt = migratedRetention?.workspaces
  ?.find((w) => w.id === "retention-legacy")?.archivedAt;
check("legacy archives start their 60-day period when the timestamp is first migrated",
  Number.isFinite(legacyArchivedAt) && legacyArchivedAt >= retentionNow &&
    legacyArchivedAt < retentionNow + 10_000 &&
    !migratedRetention?.workspaces?.some((w) => w.id === "retention-expired"),
  `archivedAt=${legacyArchivedAt}`);
await retentionPage.click("#history-close");

// Fresh archive は開始時点で59日経過しているため、さらに1日で自動削除される。
await retentionPage.clock.fastForward(dayMs + 1);
await retentionPage.clock.runFor(1000);
await retentionPage.waitForFunction(() =>
  !document.querySelector('.ws-item[data-ws-id="retention-fresh"]'));
await retentionPage.click("#session-trash-open");
check("an archive is automatically deleted when it reaches 60 days while the app is open",
  await retentionPage.locator(".session-trash-row", { hasText: "Fresh archive" }).count() === 1 &&
    await retentionPage.locator('.ws-item[data-ws-id="retention-legacy"]').count() === 1);
await retentionPage.close();

}
