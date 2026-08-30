export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 最近削除したセッション: 履歴つき退避 / 復元 / v5 永続化
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });

await page.locator(".ws-item.is-active .ws-name").dblclick();
await page.locator(".ws-item.is-active .inline-edit").fill("Recover me");
await page.keyboard.press("Enter");
await page.evaluate(() => window.__ptyPushAll("archived-history-line\r\n"));
await page.waitForTimeout(250);
await page.locator(".ws-item.is-active .ws-close").click();
await page.waitForTimeout(1200);

const archived = await page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
check("closing a session saves it in v5 recently-deleted history",
  archived?.version === 5 && archived.deletedWorkspaces?.[0]?.name === "Recover me");
check("recently-deleted history captures terminal scrollback",
  archived?.deletedWorkspaces?.[0]?.root?.scrollback?.includes("archived-history-line") === true);

await page.click("#session-trash-open");
check("pane history button opens the shared dialog on the recently-deleted tab",
  (await page.locator("#history-tab-trash").getAttribute("aria-selected")) === "true" &&
    await page.locator("#session-trash-panel").isVisible() &&
    await page.locator("#takeover-panel").isHidden() &&
    (await page.evaluate(() => (window.__agentSessionListCalls ?? []).length)) === 0);
check("recently-deleted dialog lists the closed session",
  await page.locator(".session-trash-row", { hasText: "Recover me" }).count() === 1);
await page.click("#history-tab-takeover");
await page.waitForFunction(() => (window.__agentSessionListCalls ?? []).length === 1);
check("the shared dialog exposes conversation history from the pane entry",
  (await page.locator("#history-tab-takeover").getAttribute("aria-selected")) === "true" &&
    await page.locator("#takeover-panel").isVisible());
await page.click("#history-tab-trash");
await page.click("#history-close");

// 別セッションを消しても、既に見た分と合わせて履歴に積み上がる
await page.click("#ws-new");
await page.waitForTimeout(150);
await page.locator(".ws-item.is-active .ws-name").dblclick();
await page.locator(".ws-item.is-active .inline-edit").fill("Second delete");
await page.keyboard.press("Enter");
await page.locator(".ws-item.is-active .ws-close").click();
await page.waitForTimeout(400);

await page.click("#session-trash-open");
check("recently-deleted dialog lists both closed sessions after reopening",
  await page.locator(".session-trash-row").count() === 2);
await page.locator(".session-trash-row", { hasText: "Recover me" })
  .locator(".session-trash-restore").click();
await page.waitForTimeout(1200);

const activeName = await page.locator(".ws-item.is-active .ws-name").textContent();
const restoredSave = await page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
const restoredWorkspace = restoredSave?.workspaces?.find((w) => w.name === "Recover me");
check("restore reopens and activates the deleted session", activeName === "Recover me",
  `active=${JSON.stringify(activeName)}`);
check("restore keeps terminal history in the live session snapshot",
  restoredWorkspace?.root?.scrollback?.includes("archived-history-line") === true);
check("restoring one entry leaves the other deleted session in history",
  restoredSave?.deletedWorkspaces?.length === 1);
await page.close();

// v5 の削除履歴はアプリ再起動後も残り、同じ復元経路を使える
const pageV5 = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageV5.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageV5.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "current",
    groups: [],
    workspaces: [{
      id: "current", name: "Current", shellKind: "default", broadcast: false,
      root: { kind: "leaf", title: "current" },
    }],
    deletedWorkspaces: [{
      id: "deleted", name: "Persisted deleted", shellKind: "default", broadcast: false,
      deletedAt: 1700000000000, originalIndex: 0,
      root: { kind: "leaf", title: "restored", cwd: "/tmp", scrollback: "persisted-history\r\n" },
    }],
  });
});
await pageV5.goto(BASE_URL);
await pageV5.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageV5.click("#session-trash-open");
check("v5 restores recently-deleted entries after app restart",
  await pageV5.locator(".session-trash-row", { hasText: "Persisted deleted" }).count() === 1);
await pageV5.locator(".session-trash-row .session-trash-restore").click();
await pageV5.waitForTimeout(400);
check("a persisted deleted session can be restored",
  await pageV5.locator(".ws-item.is-active .ws-name").textContent() === "Persisted deleted");
await pageV5.close();

}
