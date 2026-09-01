export default async function (ctx) {
const { page, check, MOD, pAfter } = ctx;

// ============================================================
// セッションサイドバー
// ============================================================

// --- 9. 検索欄横の + は即時作成せず、場所フライアウトを開く ---
const countBeforePlus = await page.locator(".ws-item").count();
await page.click("#ws-new");
await page.waitForTimeout(200);
check("+ opens the location flyout", await page.locator("#loc-flyout").isVisible());
check("+ does not create a session before choosing an action",
  (await page.locator(".ws-item").count()) === countBeforePlus);
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(400);
const plusCreatedName = await page.locator(".ws-item.is-active .ws-name").textContent();
check("+ default action creates an auto-numbered session", plusCreatedName === "Session 2",
  `active="${plusCreatedName}"`);
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(400);
const plusNextName = await page.locator(".ws-item.is-active .ws-name").textContent();
check("+ default action advances the automatic session number", plusNextName === "Session 3",
  `active="${plusNextName}"`);
// 作る位置は「表示中セッションの直後」。末尾へ積まない
// 行中央には常設メモ input があるため、行の中央ではなく名前を明示して切り替える。
await page.locator(".ws-item", { hasText: "Session 1" }).locator(".ws-name").click();
await page.waitForTimeout(300);
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(400);
const plusOrder = await page.locator(".ws-item .ws-name").allTextContents();
check("+ default action inserts the new session right after the active one",
  plusOrder.join(",") === "Session 1,Session 4,Session 2,Session 3",
  `order=${JSON.stringify(plusOrder)}`);
for (const name of ["Session 4", "Session 2", "Session 3"]) {
  const plusCreated = page.locator(".ws-item", { hasText: name });
  await plusCreated.hover();
  await plusCreated.locator(".ws-close").click();
  await page.waitForTimeout(300);
}

// --- 10. ⌘T で詳細作成フォーム。macOS モックでは cmd が出ない（2択） ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForTimeout(200);
const formVisible = await page.locator("#ws-new-form").isVisible();
const shellBtns = await page.locator("#ws-new-shells button").count();
check("Cmd+T opens new-session form", formVisible);
check("shell choices exclude cmd on macos", shellBtns === 2, `choices=${shellBtns}`);

// --- 11. 名前を入れてシェルを選ぶ → セッション2が作られアクティブに ---
await page.fill("#ws-new-name", "Debug");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
const wsCount1 = await page.locator(".ws-item").count();
const visiblePanes = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const hiddenPanes = await page.locator(".workspace-layer[hidden] .pane").count();
check("new session created", wsCount1 === 2, `items=${wsCount1}`);
check("new session has 1 pane visible", visiblePanes === 1, `visible=${visiblePanes}`);
check("old session panes kept alive in hidden layer", hiddenPanes === pAfter, `hidden=${hiddenPanes}`);
const activeName = await page.locator(".ws-item.is-active .ws-name").textContent();
check("new session is active in sidebar", activeName === "Debug", `active="${activeName}"`);

// --- 12. ブロードキャストはアクティブセッション内に閉じる ---
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
await page.click("#broadcast");
await page.waitForSelector("#broadcast-overlay:not([hidden])", { timeout: 3000 });
await page.click("#broadcast-start"); // 送信先を足さない = セッション内で閉じる
await page.waitForTimeout(100);
const b2Before = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("z");
await page.waitForTimeout(100);
const b2Writes = await page.evaluate((n) => window.__ptyWrites.slice(n), b2Before);
const b2Ids = new Set(b2Writes.filter((w) => w.data === "z").map((w) => w.id));
check("broadcast stays inside active session", b2Ids.size === 1, `panes hit=${b2Ids.size}`);

// --- 13. ⌘1 でセッション1へ切替。broadcast 状態はセッション別 ---
await page.keyboard.press(`${MOD}+Digit1`);
await page.waitForTimeout(300);
const backPanes = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const bcastLabel1 = await page.locator("#broadcast").textContent();
check("Cmd+1 switches back to session 1", backPanes === pAfter, `visible=${backPanes}`);
check("broadcast state is per-session (ws1 off)", bcastLabel1 === "一斉入力", `label="${bcastLabel1}"`);
await page.keyboard.press(`${MOD}+Digit2`);
await page.waitForTimeout(300);
const bcastLabel2 = await page.locator("#broadcast").textContent();
check("broadcast state restored on ws2 (on)", bcastLabel2 === "一斉入力中", `label="${bcastLabel2}"`);
await page.click("#broadcast"); // off に戻す

// --- 13. 切替後もキーボード入力が生きている ---
const swBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
await page.keyboard.type("after-switch", { delay: 20 });
const swWrites = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""),
  swBefore,
);
check("typing works after session switch", swWrites.includes("after-switch"), `writes="${swWrites}"`);

// --- 14. ダブルクリック → インライン編集でリネーム ---
await page.locator(".ws-item.is-active .ws-name").dblclick();
await page.waitForTimeout(150);
const editCount = await page.locator(".ws-item .inline-edit").count();
check("dblclick opens inline editor (no dialog)", editCount === 1, `editors=${editCount}`);
await page.locator(".ws-item .inline-edit").fill("Renamed");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const renamed = await page.locator(".ws-item.is-active .ws-name").textContent();
const renamedAvatar = await page.locator(".ws-item.is-active .ws-avatar").textContent();
check("rename via inline edit", renamed === "Renamed", `name="${renamed}"`);
check("avatar initial follows rename", renamedAvatar === "R", `avatar="${renamedAvatar}"`);

// --- 15. 検索フィルタ ---
await page.fill("#ws-search", "renam");
await page.waitForTimeout(200);
const filtered = await page.locator(".ws-item").count();
check("search filters sessions", filtered === 1, `items=${filtered}`);
await page.fill("#ws-search", "");
await page.waitForTimeout(200);

// --- 16. × でセッションを閉じる → 残りがアクティブに ---
const item2 = page.locator(".ws-item", { hasText: "Renamed" });
await item2.hover();
await item2.locator(".ws-close").click();
await page.waitForTimeout(400);
const wsCount2 = await page.locator(".ws-item").count();
const visAfterClose = await page.locator(".workspace-layer:not([hidden]) .pane").count();
check("close session via ×", wsCount2 === 1, `items=${wsCount2}`);
check("remaining session becomes active", visAfterClose === pAfter, `visible=${visAfterClose}`);

// --- 17. アバターは頭文字（画像やロゴを使っていない） ---
const avatarText = await page.locator(".ws-item .ws-avatar").first().textContent();
const avatarImgs = await page.locator(".ws-item img, .ws-item svg").count();
check("avatar is initial letter, no logo images", avatarText?.length === 1 && avatarImgs === 0,
  `avatar="${avatarText}" imgs=${avatarImgs}`);

}
