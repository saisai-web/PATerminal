export default async function (ctx) {
const { browser, check, MOD, BASE_URL } = ctx;

// ============================================================
// 新規セッションの場所フライアウト（Issue #192）
// メニューの「セッションを作成」はホバー、検索欄横の + と詳細フォームの場所欄はクリックで
// ホーム / フォルダ選択 / 最近使った場所 / お気に入り から作成先を選べる。
// 検索欄横の + には、従来のクリック動作も「表示中ペインと同じ場所」として含める。
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "a",
    groups: [{ id: "g", name: "Grp" }],
    explorer: { favorites: ["/proj/fav1"] },
    settings: { recentDirs: ["/proj/recent1", "/proj/recent2"] },
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a1", cwd: "/proj/alpha" } },
      { id: "c", name: "Charlie", group: "g", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c1" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForTimeout(500);

const spawnCount = () => page.evaluate(() => window.__ptySpawns.length);
const lastSpawn = () => page.evaluate(() => window.__ptySpawns[window.__ptySpawns.length - 1]);
const flyout = page.locator("#loc-flyout");
const flyoutRow = (text) => flyout.locator(".loc-row", { hasText: text });

// --- 検索欄横の + はホバーでは開かず、クリックで場所フライアウトを開く ---
const before = await spawnCount();
const initialCwd = "/proj/alpha";
await page.hover("#ws-new");
await page.waitForTimeout(250);
check("hovering + does not open the location flyout", (await flyout.count()) === 0);
check("hovering + does not create a session", (await spawnCount()) === before);
await page.click("#ws-new");
await page.waitForSelector("#loc-flyout", { timeout: 3000 });
check("clicking + opens the location flyout", await flyout.isVisible());
check("clicking + alone does not create a session", (await spawnCount()) === before);
check("+ flyout includes the old default action and every location entry",
  (await flyoutRow("表示中ペインと同じ場所").count()) === 1 &&
  (await flyoutRow("ホーム").count()) === 1 &&
  (await flyoutRow("Finderから選択…").count()) === 1 &&
  (await flyoutRow("recent1").count()) === 1 &&
  (await flyoutRow("recent2").count()) === 1 &&
  (await flyoutRow("fav1").count()) === 1);
check("flyout shows the section heads",
  (await flyout.locator(".loc-head", { hasText: "最近使った場所" }).count()) === 1 &&
  (await flyout.locator(".loc-head", { hasText: "お気に入り" }).count()) === 1);

// --- 先頭行は従来の + と同じく、表示中ペインの場所で即時作成する ---
await flyoutRow("表示中ペインと同じ場所").click();
await page.waitForFunction((n) => window.__ptySpawns.length > n, before, { timeout: 3000 });
check("the default row runs the old + action at the current pane's directory",
  (await lastSpawn()).cwd === initialCwd, JSON.stringify(await lastSpawn()));
check("flyout closes after picking", (await flyout.count()) === 0);

// --- ホームを選ぶと home ディレクトリで即時作成 ---
const beforeHome = await spawnCount();
await page.click("#ws-new");
await flyoutRow("ホーム").click();
await page.waitForFunction((n) => window.__ptySpawns.length > n, beforeHome, { timeout: 3000 });
check("picking Home from + creates at the home directory",
  (await lastSpawn()).cwd === "/home/user", JSON.stringify(await lastSpawn()));

// --- フォルダ選択（OS ダイアログ）で選んだパスに作成 ---
await page.evaluate(() => { window.__mockPickedDirectory = "/picked/dir"; });
const beforeBrowse = await spawnCount();
await page.click("#ws-new");
await page.waitForSelector("#loc-flyout", { timeout: 3000 });
await flyoutRow("Finderから選択…").click();
await page.waitForFunction((n) => window.__ptySpawns.length > n, beforeBrowse, { timeout: 3000 });
check("browse creates a session at the picked directory",
  (await lastSpawn()).cwd === "/picked/dir", JSON.stringify(await lastSpawn()));

// --- 作成した場所は「最近使った場所」の先頭に入る ---
await page.click("#ws-new");
await page.waitForSelector("#loc-flyout", { timeout: 3000 });
const recentTexts = await flyout.locator(".loc-row .loc-name").allTextContents();
check("picked directory is recorded as the newest recent location",
  recentTexts.includes("dir"), recentTexts.join(","));
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape closes the flyout", (await flyout.count()) === 0);

// --- グループ見出しメニューの「セッションを作成 ▸」から場所を選ぶ ---
const beforeGroup = await spawnCount();
await page.locator('.ws-group[data-group-id="g"]').click({ button: "right" });
await page.waitForSelector("#ctx-menu", { timeout: 3000 });
const createItem = page.locator("#ctx-menu button.ctx-has-sub", { hasText: "セッションを作成" });
check("menu item shows the submenu arrow",
  (await createItem.locator(".ctx-sub-arrow").count()) === 1);
await createItem.hover();
await page.waitForSelector("#loc-flyout", { timeout: 3000 });
await flyoutRow("fav1").click();
await page.waitForFunction((n) => window.__ptySpawns.length > n, beforeGroup, { timeout: 3000 });
check("picking a favorite from the group menu creates at that path",
  (await lastSpawn()).cwd === "/proj/fav1", JSON.stringify(await lastSpawn()));
check("group menu closed after picking", (await page.locator("#ctx-menu").count()) === 0);

// --- 詳細フォーム（Cmd/Ctrl+T）の場所欄 ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForSelector("#ws-new-form:not([hidden])", { timeout: 3000 });
check("form location defaults to the current pane's directory",
  (await page.locator("#ws-new-loc").textContent()) === "表示中ペインと同じ場所");
await page.click("#ws-new-loc");
await page.waitForSelector("#loc-flyout", { timeout: 3000 });
await flyoutRow("recent2").click();
check("picking in the form only updates the location field",
  (await page.locator("#ws-new-loc").textContent()) === "/proj/recent2");
const beforeForm = await spawnCount();
await page.locator("#ws-new-shells button").first().click();
await page.waitForFunction((n) => window.__ptySpawns.length > n, beforeForm, { timeout: 3000 });
check("form creates the session at the picked location",
  (await lastSpawn()).cwd === "/proj/recent2", JSON.stringify(await lastSpawn()));

// --- フォームを開き直すと場所欄は既定に戻る ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForSelector("#ws-new-form:not([hidden])", { timeout: 3000 });
check("reopening the form resets the location to the default",
  (await page.locator("#ws-new-loc").textContent()) === "表示中ペインと同じ場所");
await page.keyboard.press("Escape");

// --- エクスプローラー右下の「新規セッション」にも同じフライアウト ---
const beforeExp = await spawnCount();
await page.click("#exp-reopen");
await page.waitForTimeout(300);
await page.mouse.move(640, 400);
await page.hover("#exp-new-session");
await page.waitForSelector("#loc-flyout", { timeout: 3000 });
await flyoutRow("recent1").click();
await page.waitForFunction((n) => window.__ptySpawns.length > n, beforeExp, { timeout: 3000 });
check("explorer new-session button creates at the picked path",
  (await lastSpawn()).cwd === "/proj/recent1", JSON.stringify(await lastSpawn()));
check("explorer-created session is named after the picked folder",
  (await page.locator(".ws-item", { hasText: "recent1" }).count()) >= 1);

await page.close();
}
