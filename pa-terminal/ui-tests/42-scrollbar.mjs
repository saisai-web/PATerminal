// The fixed thumb must have the same geometry and behavior on both engines.
// Run with Vite serving the app: npm run test:ui:scrollbar
import { chromium, webkit } from "playwright";
import { BASE_URL, check, results } from "./context.mjs";

async function verifyScrollbar(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.addInitScript(() => {
    window.__mockSessionLoad = JSON.stringify({
      version: 5, activeId: "scroll", workspaces: [{
        id: "scroll", name: "Scroll", shellKind: "default", broadcast: false,
        root: { kind: "leaf", scrollback: Array.from({ length: 400 }, (_, i) => `ROW-${i}`).join("\r\n") },
      }],
    });
  });
  await page.goto(BASE_URL);
  await page.waitForSelector(".xterm-viewport");
  await page.evaluate(async () => {
    const { panes } = await import("/src/workspace/state.ts");
    window.scrollbarTestPane = [...panes.values()][0];
    window.scrollbarTestPane.term.options.cursorBlink = false;
  });
  await page.waitForTimeout(400);
  const metrics = () => page.evaluate(() => {
    const p = window.scrollbarTestPane, v = p.el.querySelector(".xterm-viewport");
    const rail = p.el.querySelector(".pane-scrollbar");
    const r = rail.getBoundingClientRect();
    const thumb = rail.querySelector(".pane-scroll-thumb").getBoundingClientRect();
    return {
      x: r.right - 7, top: r.top, bottom: r.bottom,
      thumbY: thumb.top + thumb.height / 2, thumbHeight: thumb.height,
      railWidth: r.width, disabled: rail.getAttribute("aria-disabled"),
      line: p.term.buffer.active.viewportY, base: p.term.buffer.active.baseY,
      scrollTop: v.scrollTop, nativeWidth: v.offsetWidth - v.clientWidth,
      viewportOverflow: getComputedStyle(v).overflowY,
      scrollbars: p.el.querySelectorAll(".pane-scrollbar").length,
    };
  });
  const screen = await page.locator(".xterm-screen").boundingBox();
  const clip = { ...screen, height: Math.min(120, screen.height) };
  const bottom = await metrics();
  check("the terminal has one 32px thumb on a 14px rail",
    bottom.thumbHeight === 32 && bottom.railWidth === 14 && bottom.scrollbars === 1,
    JSON.stringify(bottom));
  check("no native scrollbar remains underneath to steal WKWebView mouse events",
    bottom.nativeWidth === 0 && bottom.viewportOverflow === "hidden");
  const bottomImage = await page.screenshot({ clip });
  await page.mouse.move(bottom.x, bottom.thumbY);
  await page.mouse.down();
  await page.mouse.move(bottom.x, bottom.top + 1, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const top = await metrics();
  const topImage = await page.screenshot({ clip });
  check("dragging the fixed thumb scrolls both the buffer and viewport to the first line",
    bottom.base > 300 && top.line === 0 && top.scrollTop === 0, JSON.stringify(top));
  check("dragging changes rendered terminal text, not only the scrollbar position",
    !bottomImage.equals(topImage));

  await page.mouse.click(top.x, top.bottom - 10);
  await page.waitForTimeout(200);
  const clicked = await metrics();
  check("clicking the track moves through the history", clicked.line > 0, JSON.stringify(clicked));
  await page.mouse.move(clicked.x, clicked.thumbY);
  await page.mouse.down();
  await page.mouse.move(clicked.x, clicked.bottom - 1, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const returned = await metrics();
  check("dragging back to the bottom displays the latest output", returned.line === returned.base,
    JSON.stringify(returned));
  await page.mouse.move(returned.x, returned.bottom - 20);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
  const wheeled = await metrics();
  check("the wheel over the scrollbar scrolls history", wheeled.line < returned.line,
    JSON.stringify(wheeled));
  check("the thumb follows wheel scrolling before it is grabbed again", wheeled.thumbY < returned.thumbY,
    JSON.stringify(wheeled));
  await page.mouse.move(wheeled.x, wheeled.thumbY);
  await page.mouse.down();
  await page.mouse.move(wheeled.x, wheeled.top + 1, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check("the thumb remains draggable after wheel scrolling", (await metrics()).line === 0);

  // TUI programs own their alternate screen; wheel events must still reach xterm
  // so it can forward the requested mouse reports to the PTY.
  await page.evaluate(async () => {
    const p = window.scrollbarTestPane;
    await new Promise(resolve => p.term.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h", resolve));
    window.scrollbarTestData = [];
    p.term.onData(data => window.scrollbarTestData.push(data));
  });
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(200);
  const reports = await page.evaluate(() => window.scrollbarTestData);
  check("scrolling over the rail still reaches TUI mouse handling",
    reports.some(data => /^\x1b\[<64;/.test(data)), JSON.stringify(reports));
  const alternate = await metrics();
  check("unsupported application-owned screens keep a fixed but disabled thumb",
    alternate.base === 0 && alternate.thumbHeight === 32 && alternate.disabled === "true");
  await page.evaluate(() => { window.scrollbarTestData = []; });
  await page.mouse.move(alternate.x, alternate.thumbY);
  await page.mouse.down();
  await page.mouse.move(alternate.x, alternate.top + 1, { steps: 8 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  check("the scrollbar never substitutes relative wheel or key input for absolute seeking",
    await page.evaluate(() => scrollbarTestData.length === 0));
  await page.evaluate(async () => {
    await new Promise(resolve => scrollbarTestPane.term.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l", resolve));
  });
  await page.waitForTimeout(100);
  const normal = await metrics();
  await page.mouse.click(normal.x, (normal.top + normal.bottom) / 2);
  await page.waitForTimeout(100);
  const halfway = await metrics();
  check("the middle of the rail addresses the middle of the entire history",
    halfway.base > 300 && halfway.disabled === "false" &&
      Math.abs(halfway.line - halfway.base / 2) <= 1, JSON.stringify(halfway));
  await page.mouse.move(halfway.x, halfway.thumbY);
  await page.mouse.down();
  await page.mouse.move(halfway.x, halfway.bottom - 1, { steps: 8 });
  await page.mouse.up();
  const absoluteBottom = await metrics();
  await page.waitForTimeout(300);
  check("releasing at the bottom stays at the last line without recentering or holding",
    absoluteBottom.base > 300 && absoluteBottom.line === absoluteBottom.base &&
      (await metrics()).line === absoluteBottom.base);
  await page.mouse.move(absoluteBottom.x, absoluteBottom.thumbY);
  await page.mouse.down();
  await page.mouse.move(absoluteBottom.x, absoluteBottom.top + 1, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  check("releasing at the top goes straight to the first line", (await metrics()).line === 0);

  // Long history, new shells, short output and alternate-screen TUIs must all
  // keep the same thumb size when displayed together.
  const mixed = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await mixed.addInitScript(() => {
    const history = { kind: "leaf", title: "history", scrollback: "history line\r\n".repeat(300) };
    window.__mockSessionLoad = JSON.stringify({ version: 5, activeId: "mixed", workspaces: [{
      id: "mixed", name: "Mixed", shellKind: "default", broadcast: false,
      root: { kind: "split", dir: "row", ratio: 0.5,
        a: { kind: "split", dir: "col", ratio: 0.5,
          a: history, b: { kind: "leaf", title: "new shell" } },
        b: { kind: "split", dir: "col", ratio: 0.5,
          a: { kind: "leaf", title: "short output", scrollback: "one line\r\n" },
          b: { kind: "leaf", title: "TUI" } },
      },
    }] });
  });
  await mixed.goto(BASE_URL);
  await mixed.waitForSelector(".pane");
  await mixed.evaluate(async () => {
    const { panes } = await import("/src/workspace/state.ts");
    for (const p of panes.values()) {
      p.term.options.cursorBlink = false;
      if (p.spec.title === "TUI") await new Promise(resolve => p.term.write("\x1b[?1049hTUI screen", resolve));
    }
  });
  await mixed.waitForTimeout(400);
  const readIndicators = () => mixed.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { panes } = await import("/src/workspace/state.ts");
    return [...panes.values()].map(p => {
      const rail = p.el.querySelector(".pane-scrollbar");
      const thumb = rail.querySelector(".pane-scroll-thumb").getBoundingClientRect();
      return { title: p.spec.title, base: p.term.buffer.active.baseY,
        height: thumb.height, width: thumb.width, disabled: rail.getAttribute("aria-disabled"),
      };
    });
  });
  const indicators = await readIndicators();
  check("all four mixed panes show a thumb, including the three without scrollback",
    indicators.length === 4 && indicators.filter(p => p.base === 0).length === 3 &&
      indicators.every(p => p.height === 32 && p.width === 10),
    JSON.stringify(indicators));
  const writeToNewShell = text => mixed.evaluate(async data => {
    const { panes } = await import("/src/workspace/state.ts");
    const p = [...panes.values()].find(p => p.spec.title === "new shell");
    await new Promise(resolve => p.term.write(data, resolve));
  }, text);
  await writeToNewShell("new history\r\n".repeat(300));
  const grown = (await readIndicators()).find(p => p.title === "new shell");
  check("new output enables scrolling without changing the thumb size",
    grown.base > 0 && grown.height === 32 && grown.disabled === "false", JSON.stringify(grown));
  await writeToNewShell("\x1b[3J");
  const cleared = (await readIndicators()).find(p => p.title === "new shell");
  check("clearing scrollback still keeps a 32px thumb",
    cleared.base === 0 && cleared.height === 32 && cleared.disabled === "true", JSON.stringify(cleared));
  await writeToNewShell("long history\r\n".repeat(10100));
  const long = (await readIndicators()).find(p => p.title === "new shell");
  check("the thumb remains 32px even at the 10,000-line limit",
    long.base === 10000 && long.height === 32, JSON.stringify(long));
  await mixed.setViewportSize({ width: 1100, height: 700 });
  await mixed.waitForTimeout(300);
  check("resizing panes does not change the thumb height",
    (await readIndicators()).every(p => p.height === 32));
}

for (const engine of [webkit, chromium]) {
  console.log(`ENGINE: ${engine.name()}`);
  const browser = await engine.launch();
  try {
    await verifyScrollbar(browser);
  } finally {
    await browser.close();
  }
}
const failures = results.filter(result => !result.ok);
console.log(`${results.length - failures.length}/${results.length} passed`);
process.exitCode = failures.length ? 1 : 0;
