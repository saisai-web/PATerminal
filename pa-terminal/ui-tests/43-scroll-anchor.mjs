export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// スクロール位置のアンカー
// ユーザーがホイール / タッチで動かさない限り、ターミナルのスクロール位置は動かない。
//
// 再現していた不具合: 非表示セッションのペインに出力が届く（切替直後の in-flight
// データ）と、xterm 5.x の Viewport が高さ 0 の要素で scroll area を計算し、再表示後も
// DOM の scrollTop が末尾より 1 画面上で止まる。この状態で DOM に scroll イベントが
// 1 つ届く（ホイールの 1px など）と、xterm はバッファを 1 画面分遡らせ、以後の出力に
// 追従しなくなる。フォーカスを受けないペインは切替でサイズが変わらず xterm が
// 測り直さないため、右ペインで決定的に再現する。
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  const history = (tag) => Array.from(
    { length: 300 },
    (_, index) => `${tag}-history-${String(index).padStart(3, "0")}`,
  ).join("\r\n") + "\r\n";
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "alpha",
    workspaces: [
      { id: "alpha", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "alpha", scrollback: history("alpha") } },
      { id: "bravo", name: "Bravo", shellKind: "default", broadcast: false,
        root: {
          kind: "split",
          dir: "row",
          ratio: 0.5,
          a: { kind: "leaf", title: "left", scrollback: history("left") },
          b: { kind: "leaf", title: "right", scrollback: history("right") },
        } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForTimeout(500);

const clickWs = (name) => page.locator(".ws-item", { hasText: name }).locator(".ws-name").click();
const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join("\r\n") + "\r\n";
const push = (text) => page.evaluate((t) => window.__ptyPushAll(t), text);
// 右ペイン（フォーカスを受けない）の xterm バッファと DOM viewport の状態
const rightPane = () => page.locator(".workspace-layer:not([hidden]) .pane").nth(1);
const readRight = () => rightPane().evaluate(async (pane) => {
  const { panes } = await import("/src/workspace/state.ts");
  const target = [...panes.values()].find((candidate) => candidate.el === pane);
  const viewport = pane.querySelector(".xterm-viewport");
  const screen = pane.querySelector(".xterm-screen");
  const buffer = target.term.buffer.active;
  const rowHeight = screen.getBoundingClientRect().height / target.term.rows;
  return {
    line: buffer.viewportY,
    baseY: buffer.baseY,
    rows: target.term.rows,
    top: viewport.scrollTop,
    max: viewport.scrollHeight - viewport.clientHeight,
    expectedTop: Math.round(buffer.viewportY * rowHeight),
    userScrolling: target.term._core._bufferService.isUserScrolling,
    resizes: window.__ptyResizes.filter((r) => r.id === target.id).map((r) => r.rows),
  };
});
const wheelOverRight = async (deltaY) => {
  const box = await rightPane().locator(".xterm-screen").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
};

// --- 1. 非表示中に出力を受けたセッションを開き直しても DOM とバッファがずれない ---
await clickWs("Bravo");
await page.waitForTimeout(300);
await push(lines("live", 60)); // カーソルを最下行に置き、以後の出力でバッファが伸びる状態にする
await page.waitForTimeout(300);
const live = await readRight();
check("the scroll-anchor regression starts at the bottom with history above",
  live.line === live.baseY && live.baseY > 100 && live.top === live.max,
  JSON.stringify(live));

await clickWs("Alpha");
await page.waitForTimeout(50);
await push(lines("hidden", 5)); // 非表示の Bravo へ届く in-flight 出力
await page.waitForTimeout(150);
await clickWs("Bravo");
await page.waitForTimeout(400); // 開き直しただけで、解禁される出力は無い
const reopened = await readRight();
check("the never-focused pane keeps its size across the switch (precondition)",
  reopened.rows === live.rows && reopened.resizes.slice(-1)[0] === live.rows,
  JSON.stringify(reopened));
check("reopening a session after hidden output keeps the DOM viewport aligned with the buffer",
  reopened.line === reopened.baseY &&
    Math.abs(reopened.top - reopened.expectedTop) <= 1 &&
    reopened.top >= reopened.max - 1,
  JSON.stringify(reopened));

// --- 2. 1px のホイールで 1 画面分飛ばない（修正前は rows 行分遡っていた） ---
await wheelOverRight(-1);
await page.waitForTimeout(200);
const nudged = await readRight();
check("a one-pixel wheel tick after reopening does not throw the terminal a screen back",
  nudged.line >= nudged.baseY - 1 && !nudged.userScrolling,
  JSON.stringify(nudged));

// --- 3. ホイール / タッチを伴わない DOM scroll は phantom として戻す ---
const phantom = await rightPane().evaluate(async (pane) => {
  const viewport = pane.querySelector(".xterm-viewport");
  viewport.scrollTop = 0;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const { panes } = await import("/src/workspace/state.ts");
  const target = [...panes.values()].find((candidate) => candidate.el === pane);
  return {
    line: target.term.buffer.active.viewportY,
    baseY: target.term.buffer.active.baseY,
    top: viewport.scrollTop,
    max: viewport.scrollHeight - viewport.clientHeight,
  };
});
check("a viewport scroll without a wheel gesture is reverted to the bottom",
  phantom.line === phantom.baseY && phantom.top >= phantom.max - 1,
  JSON.stringify(phantom));

// --- 4. ユーザーのホイールは尊重され、出力やレイアウト変更で末尾へ戻されない ---
await wheelOverRight(-180); // 10 行ぶん遡る
await page.waitForTimeout(250);
const scrolledUp = await readRight();
check("a real wheel scroll moves the terminal into history",
  scrolledUp.line < scrolledUp.baseY && scrolledUp.line >= scrolledUp.baseY - 12,
  JSON.stringify(scrolledUp));
await push(lines("while-reading", 3));
await page.waitForTimeout(250);
const afterOutput = await readRight();
check("output while reading history does not move the viewport",
  afterOutput.line === scrolledUp.line && afterOutput.baseY === scrolledUp.baseY + 3,
  JSON.stringify(afterOutput));
await page.click("#exp-reopen"); // 横幅が変わる = layout → refit
await page.waitForTimeout(300);
const afterLayout = await readRight();
check("a layout change while reading history does not jump to the bottom",
  afterLayout.line < afterLayout.baseY && Math.abs(afterLayout.top - afterLayout.expectedTop) <= 1,
  JSON.stringify(afterLayout));
await page.click("#exp-close");
await page.waitForTimeout(300);

// --- 5. 末尾まで戻せば再び出力へ追従する ---
await wheelOverRight(100000);
await page.waitForTimeout(250);
await push(lines("resumed", 3));
await page.waitForTimeout(250);
const resumed = await readRight();
check("scrolling back to the bottom resumes following the output",
  resumed.line === resumed.baseY && resumed.top >= resumed.max - 1 && !resumed.userScrolling,
  JSON.stringify(resumed));

await page.close();

}
