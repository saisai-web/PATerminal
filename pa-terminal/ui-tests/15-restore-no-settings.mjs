export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// v3 復元: settings なし → dark で正常起動
// ============================================================

const pageNoSet = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageNoSet.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageNoSet.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 3,
    activeId: "a",
    collapsedGroups: [],
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
    ],
  });
});
await pageNoSet.goto(BASE_URL);
await pageNoSet.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageNoSet.waitForTimeout(300);
const noSetBg = await pageNoSet.evaluate(() =>
  document.documentElement.style.getPropertyValue("--bg").trim());
check("missing settings falls back to dark", noSetBg === "#07090b", `--bg=${noSetBg}`);
await pageNoSet.close();

}
