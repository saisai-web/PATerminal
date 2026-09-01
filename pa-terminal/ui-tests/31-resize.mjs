export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// PTY サイズの同期
// xterm の cols/rows と PTY のサイズがずれると TUI（claude / codex）が
// 実際と違う幅で描き続け、アプリを再起動するまで直らないレイアウト崩れになる
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(600);
// このスイートはエクスプローラー開閉の回帰ではなく、従来と同じ3カラムの
// レイアウト条件で PTY サイズ同期を検証する。
await page.click("#exp-reopen");
await page.waitForTimeout(300);

// --- 0. xterm の描画面がスクロールバーのトラックを覆わない ---
// FitAddon は xterm 自身の padding だけを列数計算から引く。親の padding を
// 使うと canvas が scrollbar 領域まで伸び、WebKit ではつまみの半分が隠れる。
const scrollbarGeometry = await page.evaluate(() => {
  const viewport = document.querySelector(".pane-body .xterm .xterm-viewport");
  const screen = document.querySelector(".pane-body .xterm .xterm-screen");
  if (!viewport || !screen) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const contentRight = viewportRect.left + viewport.clientWidth;
  return {
    scrollbarWidth: viewport.offsetWidth - viewport.clientWidth,
    overlap: Math.max(0, screenRect.right - contentRight),
  };
});
check("terminal canvas stays clear of the scrollbar track",
  !!scrollbarGeometry && scrollbarGeometry.overlap <= 1,
  scrollbarGeometry
    ? `scrollbar=${scrollbarGeometry.scrollbarWidth}px overlap=${scrollbarGeometry.overlap.toFixed(1)}px`
    : "xterm viewport or screen missing");

// --- 0b. Files パネル開閉後も最新出力を表示する ---
// WebKit は横幅変更後の遅延リフローで xterm viewport を先頭へ戻すことがある。
// 後続の resize 束ね検証へ大量の履歴を持ち込まないよう専用ページで確認する。
const pageScroll = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await pageScroll.addInitScript(() => {
  const scrollback = Array.from(
    { length: 100 },
    (_, index) => `resize-history-${String(index).padStart(3, "0")}`,
  ).join("\r\n") + "\r\n";
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "scroll",
    workspaces: [{
      id: "scroll",
      name: "Scroll",
      shellKind: "default",
      broadcast: false,
      root: { kind: "leaf", title: "scroll", scrollback },
    }],
  });
});
await pageScroll.goto(BASE_URL);
await pageScroll.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageScroll.waitForTimeout(400);
for (const [button, action] of [["#exp-reopen", "opening"], ["#exp-close", "closing"]]) {
  const before = await pageScroll.locator(
    ".workspace-layer:not([hidden]) .xterm-viewport",
  ).evaluate((el) => {
    el.scrollTop = 0;
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
  });
  check(`${action} Files can reproduce a viewport at the top`,
    before.top === 0 && before.height > before.client, JSON.stringify(before));
  await pageScroll.locator(button).click();
  await pageScroll.waitForTimeout(200);
  const after = await pageScroll.locator(
    ".workspace-layer:not([hidden]) .xterm-viewport",
  ).evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  check(`${action} Files keeps the terminal at the latest output`,
    after.top >= after.height - after.client - 1, JSON.stringify(after));
}
await pageScroll.close();

const resizesOf = (id) => page.evaluate(
  (paneId) => window.__ptyResizes.filter((r) => r.id === paneId), id);
const lastResize = async (id) => (await resizesOf(id)).slice(-1)[0];

// --- 1. 生成された全ペインに初回サイズが届く ---
// spawn は要素が DOM に入る前なので cols/rows は既定の 80x24。実サイズを決める
// 最初の fit は spawn の await が解ける前に走るため、購読が後回しだと
// この1回きりの通知を誰も受け取れず、以後 fit は変化時しか発火しない
await page.click("#split-right");
await page.waitForTimeout(600);
const spawnDims = await page.evaluate(() => window.__ptySpawns.map((s) => ({ id: s.id, cols: s.cols })));
const missing = [];
for (const s of spawnDims) {
  if ((await resizesOf(s.id)).length === 0) missing.push(s.id);
}
check("every spawned pane gets its real size delivered to the PTY",
  spawnDims.length >= 2 && missing.length === 0,
  `spawns=${spawnDims.length} missing=${JSON.stringify(missing)}`);

// --- 2. 狭いペインでも PTY の幅が実寸に追従する（報告されたバグの再現） ---
// 分割で 80 桁を下回るペインを作ると、PTY が 80 のままなら TUI は 80 桁幅で描き、
// xterm 側が折り返してカーソル計算が壊れる
const div = page.locator(".divider.dir-row").first();
const db = await div.boundingBox();
await page.mouse.move(db.x + 3, db.y + db.height / 2);
await page.mouse.down();
await page.mouse.move(5, db.y + db.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
const paneIds = await page.evaluate(() =>
  [...document.querySelectorAll(".pane")].map((el, i) => ({ i, w: el.getBoundingClientRect().width })));
const narrowIdx = paneIds.reduce((a, b) => (a.w <= b.w ? a : b)).i;
const narrowId = spawnDims[narrowIdx]?.id ?? spawnDims[0].id;
const narrow = await lastResize(narrowId);
const narrowBox = await page.locator(".pane").nth(narrowIdx).boundingBox();
check("a pane narrower than the 80-column default reports its real width",
  !!narrow && narrow.cols < 80 && narrowBox.width < 400,
  `cols=${narrow?.cols} paneWidth=${Math.round(narrowBox?.width ?? 0)}`);

// --- 3. 0px レイアウトでは fit しない ---
// FitAddon は要素が DOM に付いていて 0px のとき undefined ではなく 2x1 を返す。
// そのまま fit するとバッファが2桁に折り返され、元のサイズに戻しても直らない
const beforeZero = await page.evaluate(() => window.__ptyResizes.length);
// #grid は flex の子なので height だけでは潰れない（flex も外す）
const collapsed = await page.evaluate(() => {
  const grid = document.querySelector("#grid");
  grid.style.flex = "0 0 0px";
  grid.style.height = "0px";
  window.dispatchEvent(new Event("resize"));
  return document.querySelector(".pane").clientHeight;
});
await page.waitForTimeout(400);
const collapsedPane = await page.evaluate(() => document.querySelector(".pane").clientHeight);
await page.evaluate(() => {
  const grid = document.querySelector("#grid");
  grid.style.flex = "";
  grid.style.height = "";
  window.dispatchEvent(new Event("resize"));
});
await page.waitForTimeout(500);
const degenerate = await page.evaluate(
  (n) => window.__ptyResizes.slice(n).filter((r) => r.cols < 4 || r.rows < 2), beforeZero);
check("a collapsed layout never resizes the PTY to a degenerate size",
  collapsedPane === 0 && degenerate.length === 0,
  `paneH=${collapsed}->${collapsedPane} bad=${JSON.stringify(degenerate)}`);
// 潰れた後も元のサイズへ戻る（ガードでスキップした分を ResizeObserver が拾い直す）
const restored = await lastResize(spawnDims[0].id);
check("the pane recovers its size after the layout comes back",
  !!restored && restored.cols >= 4 && restored.rows >= 2,
  `cols=${restored?.cols} rows=${restored?.rows}`);

// --- 4. 連続リサイズを束ねる ---
// TUI が欲しいのは落ち着いた1回であって途中経過ではない
const beforeBurst = await page.evaluate(() => window.__ptyResizes.length);
for (const w of [1200, 1150, 1100, 1050, 1000, 1040, 1080, 1120]) {
  await page.setViewportSize({ width: w, height: 820 });
  await page.waitForTimeout(20);
}
await page.waitForTimeout(700);
const burst = await page.evaluate((n) => window.__ptyResizes.slice(n), beforeBurst);
const perPane = {};
for (const r of burst) perPane[r.id] = (perPane[r.id] ?? 0) + 1;
const worst = Math.max(0, ...Object.values(perPane));
check("a burst of window resizes is coalesced", worst > 0 && worst <= 2,
  `perPane=${JSON.stringify(perPane)}`);

// 束ねた後も最終サイズは正しい
await page.waitForTimeout(200);
const finalBox = await page.locator(".pane").nth(1).boundingBox();
const finalResize = await lastResize(spawnDims[1].id);
check("the settled resize matches the final pane width",
  !!finalResize && finalResize.cols > 8 && finalBox.width > 0,
  `cols=${finalResize?.cols} width=${Math.round(finalBox?.width ?? 0)}`);

// --- 5. 同じサイズは送り直さない ---
const beforeSame = await page.evaluate(() => window.__ptyResizes.length);
await page.evaluate(() => window.dispatchEvent(new Event("resize")));
await page.waitForTimeout(500);
const afterSame = await page.evaluate(() => window.__ptyResizes.length);
check("an unchanged layout sends no resize", afterSame === beforeSame,
  `${beforeSame} -> ${afterSame}`);

// --- 6. 失敗しても取りこぼさない（リトライ） ---
// pty_resize は fire-and-forget なので、落ちたサイズは fit が変化時しか
// 発火しない以上もう二度と送られてこない
const beforeRetry = await page.evaluate(() => window.__ptyResizes.length);
await page.evaluate(() => { window.__mockPtyResizeFailUntil = 2; });
await page.setViewportSize({ width: 1240, height: 800 });
await page.waitForTimeout(2000);
const landed = await page.evaluate((n) => window.__ptyResizes.slice(n), beforeRetry);
const failLeft = await page.evaluate(() => window.__mockPtyResizeFailUntil);
check("a failed resize is retried until it lands",
  failLeft === 0 && landed.length > 0,
  `failLeft=${failLeft} landed=${landed.length}`);

// --- 7. セッション切替はサイズを確定させてから出力を解禁する ---
// 非表示中に幅が変わっていると、先に解禁すると旧サイズで描かれた出力（最大2MB）が
// 新しいグリッドへ流し込まれる
await page.evaluate(() => { window.__ipcLog.length = 0; });
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(700);
await page.setViewportSize({ width: 1000, height: 780 });
await page.waitForTimeout(500);
await page.locator(".ws-item .ws-head").first().click();
await page.waitForTimeout(800);
const order = await page.evaluate(() => window.__ipcLog);
const lastResizeAt = Math.max(-1, ...order.filter((e) => e.cmd === "pty_resize").map((e) => e.t));
const showAt = Math.max(-1, ...order.filter((e) => e.cmd === "pty_set_visible").map((e) => e.t));
check("session switch resizes before releasing the buffered output",
  showAt < 0 || lastResizeAt < 0 || showAt >= lastResizeAt,
  `lastResize=${lastResizeAt.toFixed(1)} setVisible=${showAt.toFixed(1)}`);

await page.close();

}
