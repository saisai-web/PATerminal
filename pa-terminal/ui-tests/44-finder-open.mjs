export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Finder 側から PATerminal で開く
// 「このアプリケーションで開く」/ Dock へのドロップ / クイックアクションで渡されたフォルダは
// Rust が溜めて app:open-dirs を出し、フロントが take_pending_open_dirs で取り出して
// 新規セッションにする。起動前に渡された分は復元完了後に流す。
// 設定の「Finder 連携」からクイックアクションを ~/Library/Services に設置できる（macOS のみ）。
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "a",
    groups: [],
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a1", cwd: "/proj/alpha" } },
    ],
  });
  // アプリ未起動のときに Finder から渡された分（フロント準備前に Opened が来る）
  window.__mockPendingOpenDirs = ["/proj/from-finder"];
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll(".ws-item").length >= 2, null, { timeout: 5000 });
await page.waitForTimeout(300);

const spawns = () => page.evaluate(() => window.__ptySpawns.map((s) => s.cwd));
const wsNames = () => page.locator(".ws-item .ws-name").allTextContents();

// --- 起動前に渡されたフォルダは復元後にセッションになる ---
check("folder passed before launch becomes a session after restore",
  (await wsNames()).includes("from-finder") && (await spawns()).includes("/proj/from-finder"),
  JSON.stringify(await wsNames()));
check("pending folders are drained once",
  (await page.evaluate(() => window.__mockPendingOpenDirs.length)) === 0);
check("the Finder-opened session becomes active",
  (await page.locator(".ws-item.is-active .ws-name").textContent()) === "from-finder");

// --- 起動中に渡された分は app:open-dirs で取り出す ---
await page.evaluate(() => {
  window.__mockPendingOpenDirs = ["/proj/second", "/proj/third"];
  window.__emit("app:open-dirs", null);
});
await page.waitForFunction(() => document.querySelectorAll(".ws-item").length >= 4, null, { timeout: 5000 });
const names = await wsNames();
check("folders passed while running become sessions",
  names.includes("second") && names.includes("third"), JSON.stringify(names));
const cwds = await spawns();
check("each folder becomes the session's working directory",
  cwds.includes("/proj/second") && cwds.includes("/proj/third"), JSON.stringify(cwds));
check("the newest Finder-opened session is placed beside the previous active one",
  names.indexOf("second") === names.indexOf("from-finder") + 1 &&
  names.indexOf("third") === names.indexOf("second") + 1, JSON.stringify(names));

// --- 空のイベントでは何も作らない ---
const before = await page.locator(".ws-item").count();
await page.evaluate(() => window.__emit("app:open-dirs", null));
await page.waitForTimeout(200);
check("an event with nothing pending creates nothing", (await page.locator(".ws-item").count()) === before);

// --- 設定 → Finder 連携 → クイックアクションをインストール ---
await page.click("#settings-open");
const finderNav = page.locator('[data-section="finder"].settings-nav-item');
check("settings shows the Finder section on macOS", await finderNav.isVisible());
await finderNav.click();
await page.waitForSelector('section[data-section="finder"]:not([hidden])', { timeout: 3000 });
check("install button offers a fresh install",
  (await page.textContent("#settings-finder-install")) === "クイックアクションをインストール");
check("result area starts empty", (await page.textContent("#settings-finder-result")) === "");
await page.click("#settings-finder-install");
await page.waitForFunction(
  () => (document.querySelector("#settings-finder-result")?.textContent ?? "").includes("PATerminalで開く.workflow"),
  null, { timeout: 3000 },
);
check("install invokes the Rust command once",
  (await page.evaluate(() => window.__quickActionInstalls.length)) === 1);
check("result explains where the quick action appears",
  (await page.textContent("#settings-finder-result")).includes("クイックアクション"));
check("button switches to reinstall after success",
  (await page.textContent("#settings-finder-install")) === "クイックアクションを再インストール");
check("install button is enabled again", await page.locator("#settings-finder-install").isEnabled());

// --- 失敗はエラー表示 ---
await page.evaluate(() => { window.__mockQuickActionInstallError = "disk full"; });
await page.click("#settings-finder-install");
await page.waitForFunction(
  () => (document.querySelector("#settings-finder-result")?.textContent ?? "").includes("disk full"),
  null, { timeout: 3000 },
);
check("failure shows the error in the result area",
  await page.locator("#settings-finder-result.is-error").count() === 1);

// --- 開き直すと設置済みとして「再インストール」から始まり、前回の結果は消える ---
await page.click("#settings-close");
await page.click("#settings-open");
await finderNav.click();
await page.waitForFunction(
  () => document.querySelector("#settings-finder-install")?.textContent === "クイックアクションを再インストール",
  null, { timeout: 3000 },
);
check("reopening settings reflects the installed state", true);
check("reopening settings clears the previous result", (await page.textContent("#settings-finder-result")) === "");
await page.click("#settings-close");
await page.close();

// --- Windows では Finder 連携のセクションを出さない ---
const win = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await win.addInitScript(() => { window.__mockHostOs = "windows"; });
await win.goto(BASE_URL);
await win.waitForSelector(".pane", { timeout: 10000 });
await win.click("#settings-open");
check("Windows hides the Finder section nav",
  await win.locator('[data-section="finder"].settings-nav-item').isHidden());
check("Windows keeps the Finder section hidden",
  await win.locator('section[data-section="finder"]').isHidden());
await win.close();
}
