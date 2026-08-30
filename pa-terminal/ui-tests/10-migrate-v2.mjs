export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// v2 → v5 マイグレーション
// ============================================================

const pageV2 = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageV2.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageV2.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 2,
    activeId: "b",
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
      { id: "b", name: "Beta", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "beta" } },
    ],
  });
});
await pageV2.goto(BASE_URL);
// 1枚目のペインは非アクティブ側（非表示レイヤー）なので、可視レイヤー内で待つ
await pageV2.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageV2.waitForFunction(
  () => !!window.__savedSession,
  undefined,
  { timeout: 8000 },
).catch(() => {});
const v2Items = await pageV2.locator(".ws-item").count();
const v2Active = await pageV2.locator(".ws-item.is-active .ws-name").textContent();
check("v2 session restores fully", v2Items === 2 && v2Active === "Beta",
  `items=${v2Items} active="${v2Active}"`);
const v2Saved = JSON.parse(await pageV2.evaluate(() => window.__savedSession));
check("v2 file re-saved as v5",
  v2Saved.version === 5 && Array.isArray(v2Saved.groups) && Array.isArray(v2Saved.collapsedGroups) &&
    Array.isArray(v2Saved.deletedWorkspaces),
  `version=${v2Saved.version}`);
await pageV2.close();

}
