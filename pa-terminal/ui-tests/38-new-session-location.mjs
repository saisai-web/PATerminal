export default async function (ctx) {
const { browser, check, MOD, BASE_URL } = ctx;

// ============================================================
// 新規セッションの作成場所（Issue #192）
// 検索欄横の +・グループ見出しの +・右クリックの「セッションを作成」は、場所を尋ねずに
// ルート（ホーム）へ即作成し、作ったペインのパスバーのフォルダーブラウザーを開いた状態で
// 始める（「ここへ移動」で作業フォルダーへ移る）。
// 詳細フォーム（Cmd/Ctrl+T）の場所欄だけは、同じブラウザーで場所を選ぶ。
// セッションのコピーはブラウザーを開かない（worktree からの作成は 19-git-panel で確認）。
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
const waitSpawn = (n) => page.waitForFunction((n) => window.__ptySpawns.length > n, n, { timeout: 3000 });
const pop = page.locator(".pathbar-pop");
/** 開いたブラウザーが、作ったばかりのセッション（表示中・フォーカス中のペイン）のものか */
const browserOnNewPane = () => page.evaluate(() => {
  const bar = document.querySelector(".workspace-layer:not([hidden]) .pane.is-focused .pane-pathbar");
  return bar?.dataset.open === "true" && bar.dataset.cwd === "/home/user";
});

// --- サイドバーに Finder / エクスプローラーのアイコンボタンは無い ---
check("the sidebar has no Finder icon buttons",
  (await page.locator("#ws-new-finder, .ws-group-finder").count()) === 0);

// --- 検索欄横の +: ホバーでは何もせず、クリックでルートに即作成してブラウザーを開く ---
const before = await spawnCount();
await page.hover("#ws-new");
await page.waitForTimeout(250);
check("hovering + does nothing", (await pop.count()) === 0 && (await spawnCount()) === before);
await page.click("#ws-new");
await waitSpawn(before);
check("+ creates a session at the root (home) right away",
  (await lastSpawn()).cwd === "/home/user", JSON.stringify(await lastSpawn()));
await pop.waitFor({ timeout: 3000 });
check("the new session starts with its folder browser open for moving",
  await browserOnNewPane() &&
    (await page.locator(".pathbar-pop.is-pick").count()) === 0 &&
    (await pop.locator(".pathbar-action.is-primary span").textContent()) === "ここへ移動");
check("the browser has the filter focused", await page.evaluate(() =>
  document.activeElement === document.querySelector(".pathbar-filter input")));
check("the auto-opened browser tells the user to choose a folder to open",
  (await pop.locator(".pathbar-intro strong").textContent()) === "ターミナルで開きたいフォルダーを選択してください" &&
    (await pop.locator(".pathbar-intro span").textContent()).includes("「ここへ移動」"));

// --- そのまま「ここへ移動」で、作ったシェルが作業フォルダーへ cd する ---
await pop.locator(".pathbar-row", { hasText: "proj" }).click();
await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
const newPaneId = (await lastSpawn()).id;
await pop.locator(".pathbar-action.is-primary").click();
await page.waitForFunction((id) =>
  window.__ptyWrites.some((w) => w.id === id && w.data === "cd '/home/user/proj'\r"), newPaneId);
check("Move here cds the new session to the chosen folder", (await pop.count()) === 0);

// --- Esc で閉じればホームのまま使える ---
const beforeEsc = await spawnCount();
await page.click("#ws-new");
await waitSpawn(beforeEsc);
await pop.waitFor({ timeout: 3000 });
await page.keyboard.press("Escape");
check("Escape keeps the new session at home and returns focus to it",
  (await pop.count()) === 0 && await page.evaluate(() =>
    document.activeElement?.classList.contains("xterm-helper-textarea")));

// --- グループ見出しの右クリック / + の「セッションを作成」: そのグループにルートで即作成 ---
const groupHead = page.locator('.ws-group[data-group-id="g"]');
const membersBefore = await page.locator(".ws-group-members .ws-item").count();
const beforeGroup = await spawnCount();
await groupHead.click({ button: "right" });
await page.waitForSelector("#ctx-menu", { timeout: 3000 });
const createItem = page.locator("#ctx-menu > button", { hasText: "セッションを作成" });
check("group menu offers only session creation (no submenu or Finder item)",
  (await createItem.count()) === 1 &&
  (await createItem.locator(".ctx-sub-arrow").count()) === 0 &&
  (await page.locator("#ctx-menu > button", { hasText: "Finder" }).count()) === 0);
await createItem.hover();
await page.waitForTimeout(250);
check("hovering the menu item creates nothing", (await spawnCount()) === beforeGroup);
await createItem.click();
await waitSpawn(beforeGroup);
await pop.waitFor({ timeout: 3000 });
check("group menu creates at home inside that group and opens the browser",
  (await lastSpawn()).cwd === "/home/user" &&
  (await page.locator(".ws-group-members .ws-item").count()) === membersBefore + 1 &&
  (await page.locator("#ctx-menu").count()) === 0 && await browserOnNewPane(),
  JSON.stringify(await lastSpawn()));
await page.keyboard.press("Escape");

await groupHead.locator(".ws-group-create").click();
await page.waitForSelector("#ctx-menu", { timeout: 3000 });
const beforeGroupPlus = await spawnCount();
await page.locator("#ctx-menu > button", { hasText: "セッションを作成" }).click();
await waitSpawn(beforeGroupPlus);
await pop.waitFor({ timeout: 3000 });
check("group + menu creates at home and opens the browser",
  (await lastSpawn()).cwd === "/home/user" && await browserOnNewPane());
await page.keyboard.press("Escape");

// --- サイドバー余白の右クリックも同じ ---
await page.evaluate(() => {
  const list = document.querySelector("#ws-list");
  const r = list.getBoundingClientRect();
  list.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 40,
  }));
});
await page.waitForSelector("#ctx-menu", { timeout: 3000 });
check("sidebar blank-area menu has create but no Finder item",
  (await page.locator("#ctx-menu > button", { hasText: "セッションを作成" }).count()) === 1 &&
  (await page.locator("#ctx-menu > button", { hasText: "Finder" }).count()) === 0);
const beforeBlank = await spawnCount();
await page.locator("#ctx-menu > button", { hasText: "セッションを作成" }).click();
await waitSpawn(beforeBlank);
await pop.waitFor({ timeout: 3000 });
check("blank-area create uses home and opens the browser",
  (await lastSpawn()).cwd === "/home/user" && await browserOnNewPane());
await page.keyboard.press("Escape");

// --- セッションのコピーは場所が決まっているので、ブラウザーを開かない ---
const beforeDup = await spawnCount();
await page.locator(".ws-item.is-active").click({ button: "right" });
await page.waitForSelector("#ctx-menu", { timeout: 3000 });
await page.locator("#ctx-menu button", { hasText: "セッションをコピー" }).first().click();
await waitSpawn(beforeDup);
await page.waitForTimeout(200);
check("duplicating a session does not open the folder browser", (await pop.count()) === 0);

// --- 詳細フォーム（Cmd/Ctrl+T）の場所欄だけは、ブラウザーで場所を選ぶ ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForSelector("#ws-new-form:not([hidden])", { timeout: 3000 });
check("form location defaults to the current pane's directory",
  (await page.locator("#ws-new-loc").textContent()) === "表示中ペインと同じ場所");
await page.click("#ws-new-loc");
const picker = page.locator(".pathbar-pop.is-pick");
await picker.waitFor({ timeout: 3000 });
check("form: the browser only chooses the folder",
  (await picker.locator(".pathbar-action.is-primary span").textContent()) === "このフォルダーを選択");
await page.keyboard.press("Escape");
check("form: Escape closes only the browser",
  (await pop.count()) === 0 && await page.locator("#ws-new-form").isVisible());
await page.click("#ws-new-loc");
await picker.locator(".pathbar-side-item", { hasText: "recent2" }).click();
await picker.locator(".pathbar-action.is-primary").click();
check("choosing in the form only updates the location field",
  (await page.locator("#ws-new-loc").textContent()) === "/proj/recent2" &&
  await page.locator("#ws-new-form").isVisible());
const beforeForm = await spawnCount();
await page.locator("#ws-new-shells button").first().click();
await waitSpawn(beforeForm);
check("form creates the session at the chosen location without opening the browser",
  (await lastSpawn()).cwd === "/proj/recent2" && (await pop.count()) === 0,
  JSON.stringify(await lastSpawn()));

// --- フォームを開き直すと場所欄は既定に戻る ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForSelector("#ws-new-form:not([hidden])", { timeout: 3000 });
check("reopening the form resets the location to the default",
  (await page.locator("#ws-new-loc").textContent()) === "表示中ペインと同じ場所");
await page.keyboard.press("Escape");

await page.close();
}
