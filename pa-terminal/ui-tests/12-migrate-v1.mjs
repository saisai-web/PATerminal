export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// v1 → v5 マイグレーション
// ============================================================

const page2 = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page2.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page2.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 1,
    broadcast: false,
    root: {
      kind: "split",
      dir: "row",
      ratio: 0.5,
      a: { kind: "leaf", title: "left", scrollback: "old-left\r\n" },
      b: { kind: "leaf", title: "right" },
    },
  });
});
await page2.goto(BASE_URL);
await page2.waitForSelector(".pane", { timeout: 10000 });
await page2.waitForTimeout(1500);

const migPanes = await page2.locator(".pane").count();
const migItems = await page2.locator(".ws-item").count();
const migName = await page2.locator(".ws-item .ws-name").first().textContent();
check("v1 session restores as single workspace", migPanes === 2 && migItems === 1,
  `panes=${migPanes} items=${migItems}`);
check("migrated session named 'Session 1'", migName === "Session 1", `name="${migName}"`);
const migSaved = await page2.evaluate(() => window.__savedSession);
check("migrated session re-saved as v5",
  typeof migSaved === "string" && migSaved.includes('"version": 5'), );

}
