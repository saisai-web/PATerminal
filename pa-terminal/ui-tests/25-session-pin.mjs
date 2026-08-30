export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// セッションのピン留めと背景色: 表示 / 操作 / 保存 / 削除履歴 / 再起動復元
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "a",
    collapsedGroups: [],
    groups: [{ id: "g", name: "Team" }],
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "b", name: "Bravo", pinned: true, shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "c", name: "Charlie", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c" } },
      { id: "d", name: "Delta", group: "g", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "d" } },
      { id: "e", name: "Echo", group: "g", pinned: true,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "e" } },
    ],
    deletedWorkspaces: [],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForTimeout(400);

const item = (name) => page.locator(".ws-item", {
  has: page.locator(".ws-name", { hasText: new RegExp(`^${name}$`) }),
});
const names = () => page.locator(".ws-item .ws-name").allTextContents();
const isPinned = async (locator) =>
  (await locator.getAttribute("class"))?.split(/\s+/).includes("is-pinned") === true;

const initialNames = await names();
check("pinned sessions lead their ungrouped or grouped scope",
  initialNames.join(",") === "Bravo,Alpha,Charlie,Echo,Delta",
  `order=${JSON.stringify(initialNames)}`);
check("pinned session has a visible pressed pin control",
  await isPinned(item("Bravo")) &&
    await item("Bravo").locator(".ws-pin").getAttribute("aria-pressed") === "true" &&
    await item("Bravo").locator(".ws-pin").getAttribute("title") === "ピン留めを解除");
check("unpinned sessions do not show a pin control",
  await item("Alpha").locator(".ws-pin").count() === 0);

await item("Alpha").click({ button: "right" });
check("pinning is offered from the session context menu",
  await page.locator("#ctx-menu button", { hasText: "セッションをピン留め" }).count() === 1);
check("context menu shows the default background and six color choices",
  await page.locator("#ctx-menu .ctx-color-option").count() === 7 &&
    await page.locator('#ctx-menu .ctx-color-option[data-ws-color="default"]')
      .getAttribute("aria-pressed") === "true");
await page.locator("#ctx-menu button", { hasText: "セッションをピン留め" }).click();
const afterPin = await names();
check("context-menu pinning moves the session and reveals its pin control",
  afterPin.join(",") === "Alpha,Bravo,Charlie,Echo,Delta" &&
    await item("Alpha").locator(".ws-pin").count() === 1,
  `order=${JSON.stringify(afterPin)}`);

const defaultAlphaBg = await item("Alpha").evaluate((el) => getComputedStyle(el).backgroundColor);
await item("Alpha").click({ button: "right" });
await page.locator('#ctx-menu .ctx-color-option[data-ws-color="purple"]').click();
const purpleAlphaBg = await item("Alpha").evaluate((el) => getComputedStyle(el).backgroundColor);
check("background swatch applies a visible themed color",
  await item("Alpha").getAttribute("data-ws-color") === "purple" &&
    purpleAlphaBg !== defaultAlphaBg,
  `default=${defaultAlphaBg} purple=${purpleAlphaBg}`);

await item("Alpha").click({ button: "right" });
check("selected background swatch is marked",
  await page.locator('#ctx-menu .ctx-color-option[data-ws-color="purple"]')
    .getAttribute("aria-pressed") === "true");
await page.locator('#ctx-menu .ctx-color-option[data-ws-color="default"]').click();
check("default swatch clears the custom background",
  await item("Alpha").getAttribute("data-ws-color") === null);
await item("Alpha").click({ button: "right" });
await page.locator('#ctx-menu .ctx-color-option[data-ws-color="purple"]').click();

await item("Bravo").click({ button: "right" });
check("session context menu offers unpinning",
  await page.locator("#ctx-menu button", { hasText: "ピン留めを解除" }).count() === 1);
await page.locator("#ctx-menu button", { hasText: "ピン留めを解除" }).click();
const afterUnpin = await names();
check("unpinning returns a session to the unpinned section",
  afterUnpin.join(",") === "Alpha,Bravo,Charlie,Echo,Delta" &&
    !await isPinned(item("Bravo")) && await item("Bravo").locator(".ws-pin").count() === 0,
  `order=${JSON.stringify(afterUnpin)}`);

// 5セッション分のスナップショットをアイドルスライスで順番に採るため、保存完了を待つ
await page.waitForFunction(() => !!window.__savedSession, null, { timeout: 6000 });
const saved = await page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
const savedAlpha = saved?.workspaces?.find((workspace) => workspace.id === "a");
const savedBravo = saved?.workspaces?.find((workspace) => workspace.id === "b");
const savedEcho = saved?.workspaces?.find((workspace) => workspace.id === "e");
check("pin and background state are saved without changing group membership",
  savedAlpha?.pinned === true && savedAlpha?.backgroundColor === "purple" &&
    !("pinned" in savedBravo) &&
    savedEcho?.pinned === true && savedEcho?.group === "g",
  JSON.stringify({ savedAlpha, savedBravo, savedEcho }));

await item("Alpha").hover();
await item("Alpha").locator(".ws-close").click();
await page.waitForTimeout(1100);
const archived = await page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
check("recently-deleted sessions retain their pin and background styling",
  archived?.deletedWorkspaces?.[0]?.id === "a" &&
    archived?.deletedWorkspaces?.[0]?.pinned === true &&
    archived?.deletedWorkspaces?.[0]?.backgroundColor === "purple");

await page.click("#session-trash-open");
await page.locator(".session-trash-row", { hasText: "Alpha" })
  .locator(".session-trash-restore").click();
await page.waitForTimeout(1100);
check("restoring a deleted styled session restores its pin, color, and order",
  await isPinned(item("Alpha")) && (await names())[0] === "Alpha" &&
    await item("Alpha").getAttribute("data-ws-color") === "purple");

const restoredRaw = await page.evaluate(() => window.__savedSession ?? "");
await page.close();

const reload = await browser.newPage({ viewport: { width: 1280, height: 820 } });
reload.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await reload.addInitScript((raw) => { window.__mockSessionLoad = raw; }, restoredRaw);
await reload.goto(BASE_URL);
await reload.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
check("pin and background styling remain after app restart",
  (await reload.locator('.ws-item[data-ws-id="a"]').getAttribute("class"))
    ?.split(/\s+/).includes("is-pinned") === true &&
    await reload.locator('.ws-item[data-ws-id="a"]').getAttribute("data-ws-color") === "purple" &&
    await reload.locator(".ws-item .ws-name").first().textContent() === "Alpha");
await reload.close();

}
