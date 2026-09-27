export default async function (ctx) {
const { page, check, MOD } = ctx;

// ============================================================
// 右パネル（右端アイコンで開く）: フォーカス中ペインの現在地カード + git セクション。
// ファイル操作はペイン下部のパスバーのフォルダーブラウザーに一本化した
// ============================================================

// --- 30. 現在地カードはフォーカス中ペインの cwd を表示し、ファイル一覧は持たない ---
const folderPath = () => page.locator("#exp-folder").getAttribute("data-path");
check("panel shows the focused pane's folder", (await folderPath()) === "/home/user" &&
  (await page.locator("#exp-folder-name").textContent()) === "~" &&
  (await page.locator("#exp-folder-parent").textContent()) === "", `path=${await folderPath()}`);
check("panel no longer carries a file list, search or file actions",
  (await page.locator("#exp-list, #exp-filter, #exp-actions, #exp-favs, .exp-row").count()) === 0);
check("outside a git repository the panel says so instead of an empty area",
  await page.locator("#exp-git").isHidden() && await page.locator("#exp-empty").isVisible());

// 現在地カード → フォーカス中ペインのフォルダーブラウザー（パスバーに付いて開く）
await page.click("#exp-folder");
await page.waitForSelector(".pathbar-pop .pathbar-row");
check("the folder card opens the focused pane's folder browser",
  (await page.locator(".pathbar-crumb[aria-current]").textContent()) === "~");
await page.keyboard.press("Escape");
check("Escape closes the browser opened from the panel", (await page.locator(".pathbar-pop").count()) === 0);

// --- 31. × で閉じてレイアウトが追従し、右端アイコンで開き直せる ---
const gridOpenW = (await page.locator("#grid").boundingBox()).width;
await page.click("#exp-close");
await page.waitForTimeout(300);
const gridClosedW = (await page.locator("#grid").boundingBox()).width;
check("× button closes explorer", await page.locator("#explorer").isHidden());
check("pane layout follows new width", gridClosedW - gridOpenW > 200,
  `grid ${Math.round(gridOpenW)}→${Math.round(gridClosedW)}px`);

// --- 31b. 閉じている間だけ右端に再オープンアイコンが出て、クリックで開き直せる ---
check("reopen icon appears while closed", await page.locator("#exp-reopen").isVisible());
await page.click("#exp-reopen");
await page.waitForTimeout(300);
check("reopen icon reopens explorer", await page.locator("#explorer").isVisible());
check("reopen icon hidden while open", await page.locator("#exp-reopen").isHidden());
await page.click("#exp-close");
await page.waitForTimeout(200);
await page.click("#exp-reopen");
await page.waitForTimeout(300);
check("right-side icon reopens explorer", await page.locator("#explorer").isVisible());
check("reopen syncs to focused pane cwd",
  (await page.locator("#exp-folder").getAttribute("data-path")) === "/home/user");

// シェル内で cd すると（OSC 7）現在地カードも追従する
await page.evaluate(() => window.__ptyPushAll("\x1b]7;file:///home/user/proj\x1b\\"));
await page.waitForFunction(() => document.querySelector("#exp-folder")?.dataset.path === "/home/user/proj");
check("folder card follows the shell's cd",
  (await page.locator("#exp-folder-name").textContent()) === "proj" &&
  (await page.locator("#exp-folder-parent").textContent()).includes("~"));
await page.evaluate(() => window.__ptyPushAll("\x1b]7;file:///home/user\x1b\\"));
await page.waitForFunction(() => document.querySelector("#exp-folder")?.dataset.path === "/home/user");

// サイドバーの cwd は表示幅にかかわらず末尾2階層だけを残す
const longSidebarPath = "/Users/example/development/clients/very-long-project/packages/terminal/src";
await page.evaluate((path) => window.__ptyPushAll(`\x1b]7;file://${path}\x1b\\`), longSidebarPath);
await page.waitForTimeout(300);
const sidebarPathInfo = await page.locator(".ws-item.is-active .ws-sub").evaluate((el) => {
  const style = getComputedStyle(el);
  return {
    text: el.textContent ?? "",
    title: el.getAttribute("title"),
    height: el.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(style.lineHeight),
  };
});
check("sidebar path keeps only its final two components on one line",
  sidebarPathInfo.text === ".../terminal/src" &&
    sidebarPathInfo.title === longSidebarPath &&
    sidebarPathInfo.height <= sidebarPathInfo.lineHeight + 1,
  `text="${sidebarPathInfo.text}" height=${sidebarPathInfo.height}`);
// 現在地カードも長い親パスは1行で先頭側を省き、フォルダ名を優先して残す
const longFilesName = "favorite-name-that-must-not-be-hidden-by-context";
const longFilesPath = `/Users/example/development/extraordinarilylongparentdirectoryname/anotherextraordinarilylongdirectoryname/${longFilesName}`;
await page.evaluate((path) => window.__ptyPushAll(`\x1b]7;file://${path}\x1b\\`), longFilesPath);
await page.waitForFunction((path) => document.querySelector("#exp-folder")?.dataset.path === path, longFilesPath);
const cardBox = await page.evaluate(() => {
  const parent = document.querySelector("#exp-folder-parent");
  const name = document.querySelector("#exp-folder-name");
  const style = getComputedStyle(parent);
  return {
    name: name.textContent, nameWidth: name.clientWidth,
    whiteSpace: style.whiteSpace, clientWidth: parent.clientWidth, scrollWidth: parent.scrollWidth,
    clientHeight: parent.clientHeight, lineHeight: Number.parseFloat(style.lineHeight),
    title: document.querySelector("#exp-folder").title,
  };
});
check("folder card keeps a long parent path on one line and ellipsizes it",
  cardBox.name === longFilesName && cardBox.nameWidth > 0 && cardBox.whiteSpace === "nowrap" &&
    cardBox.clientHeight <= cardBox.lineHeight + 1 && cardBox.scrollWidth > cardBox.clientWidth + 1 &&
    cardBox.title === longFilesPath, JSON.stringify(cardBox));
// 以降のスイートの前提（旧テストの最後の cd 先）に戻す
await page.evaluate(() => window.__ptyPushAll("\x1b]7;file:///home/user/proj\x1b\\"));
await page.waitForFunction(() => document.querySelector("#exp-folder")?.dataset.path === "/home/user/proj");

// --- 41. グループ化してもブロードキャストはアクティブセッション内に閉じる ---
await page.locator(".ws-item", { hasText: "api" }).locator(".ws-name").click();
await page.waitForTimeout(300);
await page.click("#broadcast");
await page.waitForSelector("#broadcast-overlay:not([hidden])", { timeout: 3000 });
await page.click("#broadcast-start"); // 送信先を足さない = セッション内で閉じる
await page.waitForTimeout(100);
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
const grpPaneCount = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const grpBcastBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("q");
await page.waitForTimeout(150);
const grpBcastWrites = await page.evaluate((n) => window.__ptyWrites.slice(n), grpBcastBefore);
const grpBcastIds = new Set(grpBcastWrites.filter((x) => x.data === "q").map((x) => x.id));
check("broadcast stays inside active session even when grouped", grpBcastIds.size === grpPaneCount,
  `panes hit=${grpBcastIds.size}/${grpPaneCount}`);
await page.click("#broadcast");

// --- 40. Cmd/Ctrl+E で開閉トグル（レイアウトも戻る） ---
await page.keyboard.press(`${MOD}+KeyE`);
await page.waitForTimeout(400);
const expClosed = await page.locator("#explorer").isHidden();
const gridRestored = (await page.locator("#grid").boundingBox()).width;
check("Cmd/Ctrl+E closes explorer", expClosed);
check("layout restored after close", Math.abs(gridRestored - gridClosedW) < 2,
  `grid=${Math.round(gridRestored)}px`);
await page.keyboard.press(`${MOD}+KeyE`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+E reopens explorer", await page.locator("#explorer").isVisible());

// --- 41. ハンドルドラッグで幅変更 / 右へ押し込むと閉じる / ダブルクリックで既定幅 ---
const expBox0 = await page.locator("#explorer").boundingBox();
const gridBeforeResize = (await page.locator("#grid").boundingBox()).width;
const handle0 = await page.locator("#exp-resize").boundingBox();
const hy = handle0.y + 100;
await page.mouse.move(handle0.x + 3, hy);
await page.mouse.down();
await page.mouse.move(handle0.x - 140, hy, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const expBoxWide = await page.locator("#explorer").boundingBox();
check("drag handle widens explorer", expBoxWide.width - expBox0.width > 100,
  `${Math.round(expBox0.width)}→${Math.round(expBoxWide.width)}px`);
const gridNarrowW = (await page.locator("#grid").boundingBox()).width;
const gridShrunk = gridBeforeResize - gridNarrowW;
const expGrown = expBoxWide.width - expBox0.width;
check("grid follows explorer resize", Math.abs(gridShrunk - expGrown) < 3,
  `grid -${Math.round(gridShrunk)}px / explorer +${Math.round(expGrown)}px`);
check("no stuck body.dragging after explorer resize",
  !(await page.evaluate(() => document.body.classList.contains("dragging"))));
const handle1 = await page.locator("#exp-resize").boundingBox();
await page.mouse.move(handle1.x + 3, hy);
await page.mouse.down();
await page.mouse.move(handle1.x + expBoxWide.width + 60, hy, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
check("push-in closes explorer", await page.locator("#explorer").isHidden());
check("reopen icon visible after push-close", await page.locator("#exp-reopen").isVisible());
await page.click("#exp-reopen");
await page.waitForTimeout(300);
await page.dblclick("#exp-resize");
await page.waitForTimeout(300);
const expBoxReset = await page.locator("#explorer").boundingBox();
check("dblclick resets width to default", Math.abs(expBoxReset.width - 260) < 2,
  `width=${Math.round(expBoxReset.width)}px`);

// --- 42. サイドバーも « ボタン / 左端タブ / Cmd/Ctrl+B の1クリックでたためる ---
const sidebarW = (await page.locator("#sidebar").boundingBox()).width;
const gridSidebarOpen = (await page.locator("#grid").boundingBox()).width;
await page.click("#sidebar-collapse");
await page.waitForTimeout(300);
check("« button collapses sidebar", await page.locator("#sidebar").isHidden());
check("sidebar reopen tab appears while collapsed",
  await page.locator("#sidebar-reopen").isVisible());
const gridSidebarClosed = (await page.locator("#grid").boundingBox()).width;
check("pane layout follows collapsed sidebar",
  gridSidebarClosed - gridSidebarOpen > sidebarW - 40,
  `grid ${Math.round(gridSidebarOpen)}→${Math.round(gridSidebarClosed)}px`);
await page.click("#sidebar-reopen");
await page.waitForTimeout(300);
check("sidebar reopen tab reopens sidebar", await page.locator("#sidebar").isVisible());
check("sidebar reopen tab hidden while open", await page.locator("#sidebar-reopen").isHidden());
check("layout restored after sidebar reopen",
  Math.abs((await page.locator("#grid").boundingBox()).width - gridSidebarOpen) < 2);
await page.keyboard.press(`${MOD}+KeyB`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+B collapses sidebar", await page.locator("#sidebar").isHidden());
await page.keyboard.press(`${MOD}+KeyB`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+B reopens sidebar", await page.locator("#sidebar").isVisible());

// --- 43. サイドバーも右端ハンドルのドラッグで幅変更 / 左へ押し込むとたたむ / dblclick で既定幅 ---
const sbBox0 = await page.locator("#sidebar").boundingBox();
const gridBeforeSbResize = (await page.locator("#grid").boundingBox()).width;
const sbHandle0 = await page.locator("#sidebar-resize").boundingBox();
const sby = sbHandle0.y + 100;
await page.mouse.move(sbHandle0.x + 3, sby);
await page.mouse.down();
await page.mouse.move(sbHandle0.x + 140, sby, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const sbBoxWide = await page.locator("#sidebar").boundingBox();
check("drag handle widens sidebar", sbBoxWide.width - sbBox0.width > 100,
  `${Math.round(sbBox0.width)}→${Math.round(sbBoxWide.width)}px`);
const gridAfterSbResize = (await page.locator("#grid").boundingBox()).width;
check("grid follows sidebar resize",
  Math.abs((gridBeforeSbResize - gridAfterSbResize) - (sbBoxWide.width - sbBox0.width)) < 3,
  `grid -${Math.round(gridBeforeSbResize - gridAfterSbResize)}px / sidebar +${Math.round(sbBoxWide.width - sbBox0.width)}px`);
check("no stuck body.dragging after sidebar resize",
  !(await page.evaluate(() => document.body.classList.contains("dragging"))));
const sbHandle1 = await page.locator("#sidebar-resize").boundingBox();
await page.mouse.move(sbHandle1.x + 3, sby);
await page.mouse.down();
await page.mouse.move(sbHandle1.x - sbBoxWide.width - 60, sby, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
check("push-in collapses sidebar", await page.locator("#sidebar").isHidden());
check("sidebar reopen tab visible after push-collapse",
  await page.locator("#sidebar-reopen").isVisible());
await page.click("#sidebar-reopen");
await page.waitForTimeout(300);
await page.dblclick("#sidebar-resize");
await page.waitForTimeout(300);
const sbBoxReset = await page.locator("#sidebar").boundingBox();
check("dblclick resets sidebar width to default", Math.abs(sbBoxReset.width - 320) < 2,
  `width=${Math.round(sbBoxReset.width)}px`);

// --- 44. 新規セッションは表示中ペインのディレクトリで開く ---
await page.evaluate(() => { window.__mockPtyCwd = "/home/user/proj"; });
const cwdSpawnBefore = await page.evaluate(() => window.__ptySpawns.length);
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(400);
const cwdSpawns = await page.evaluate((n) => window.__ptySpawns.slice(n), cwdSpawnBefore);
check("new session inherits the focused pane's directory",
  cwdSpawns.length === 1 && cwdSpawns[0].cwd === "/home/user/proj",
  `spawns=${JSON.stringify(cwdSpawns.map((s) => s.cwd))}`);
await page.evaluate(() => { window.__mockPtyCwd = null; });

}
