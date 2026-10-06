export default async function (ctx) {
const { page, check, MOD } = ctx;

// ============================================================
// Git ウィンドウ（ツールバーの Git ボタン / Cmd/Ctrl+E）の開閉。右パネルは廃止し、
// ファイル操作はペイン下部のパスバーのフォルダーブラウザーに一本化した
// ============================================================

// --- 30. 右パネル・変更ストリップは無く、Git はツールバーのボタンからウィンドウで開く ---
check("no right panel, change strip or reopen icon remains",
  (await page.locator("#explorer, #exp-reopen, #exp-resize, #agent-panel").count()) === 0);
const gridW = (await page.locator("#grid").boundingBox()).width;
await page.click("#git-open");
await page.waitForSelector("#git-window-overlay:not([hidden])");
check("outside a git repository the Git window says so instead of empty views",
  await page.locator("#gw-empty").isVisible() &&
    (await page.locator(".gw-view:not([hidden])").count()) === 0);
check("the Git window starts on File status",
  await page.locator("#gw-nav-status").getAttribute("aria-current") === "page");
check("opening the Git window does not change the terminal layout",
  Math.abs((await page.locator("#grid").boundingBox()).width - gridW) < 1);
await page.click("#gw-close");
check("× closes the Git window", await page.locator("#git-window-overlay").isHidden());

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
// 以降のスイートの前提（旧テストの最後の cd 先）に戻す
await page.evaluate(() => window.__ptyPushAll("\x1b]7;file:///home/user/proj\x1b\\"));
await page.waitForFunction(() =>
  document.querySelector(".ws-item.is-active .ws-sub")?.getAttribute("title") === "/home/user/proj");

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

// --- 40. Cmd/Ctrl+E で開閉トグル（ターミナルのレイアウトは変わらない） ---
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
await page.keyboard.press(`${MOD}+KeyE`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+E opens the Git window", await page.locator("#git-window-overlay").isVisible());
await page.keyboard.press(`${MOD}+KeyE`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+E inside the Git window closes it", await page.locator("#git-window-overlay").isHidden());
check("closing the Git window returns focus to the terminal",
  await page.evaluate(() => Boolean(document.activeElement?.closest(".pane"))));
check("layout unchanged after the Git window", Math.abs((await page.locator("#grid").boundingBox()).width - gridW) < 2,
  `grid=${Math.round((await page.locator("#grid").boundingBox()).width)}px`);

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
check("dblclick resets sidebar width to default", Math.abs(sbBoxReset.width - 384) < 2,
  `width=${Math.round(sbBoxReset.width)}px`);

// --- 44. 詳細フォーム（Cmd/Ctrl+T）の既定の場所は表示中ペインのディレクトリ ---
// （+ と「セッションを作成」はルートに作ってから移動する仕様。38-new-session-location で確認）
await page.evaluate(() => { window.__mockPtyCwd = "/home/user/proj"; });
const cwdSpawnBefore = await page.evaluate(() => window.__ptySpawns.length);
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForSelector("#ws-new-form:not([hidden])", { timeout: 3000 });
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
const cwdSpawns = await page.evaluate((n) => window.__ptySpawns.slice(n), cwdSpawnBefore);
check("the new-session form defaults to the focused pane's directory",
  cwdSpawns.length === 1 && cwdSpawns[0].cwd === "/home/user/proj",
  `spawns=${JSON.stringify(cwdSpawns.map((s) => s.cwd))}`);
await page.evaluate(() => { window.__mockPtyCwd = null; });

}
