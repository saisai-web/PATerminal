export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// v4 復元: 空グループ + 子階層
// ============================================================

const pageV4 = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageV4.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageV4.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "nested-session",
    collapsedGroups: ["parent"],
    groups: [
      { id: "parent", name: "Parent" },
      { id: "child", name: "Child", parentId: "parent" },
      { id: "empty", name: "Empty" },
      { id: "kept", name: "Kept", color: "purple" },
      { id: "none", name: "None", color: null },
    ],
    workspaces: [
      {
        id: "nested-session", name: "Nested Session", group: "child",
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "nested" },
      },
    ],
  });
});
await pageV4.goto(BASE_URL);
await pageV4.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageV4.waitForTimeout(300);
check("v4 restores a nested group hierarchy",
  (await pageV4.locator(".ws-group[data-group-id=parent] + .ws-group-members > .ws-group[data-group-id=child]").count()) === 1 &&
    (await pageV4.locator(".ws-group[data-group-id=child] + .ws-group-members > .ws-item",
      { hasText: "Nested Session" }).count()) === 1);
check("v4 restores empty groups independently of sessions",
  (await pageV4.locator(".ws-whole-members > .ws-group[data-group-id=empty]").count()) === 1);
// 色機能より前のグループには色を自動で振り、既存の色と「色なし」(null) は保つ
const groupColor = (id) =>
  pageV4.locator(`.ws-group[data-group-id=${id}]`).getAttribute("data-ws-color");
const autoColors = [await groupColor("parent"), await groupColor("child"), await groupColor("empty")];
check("v4 restore gives colorless groups distinct automatic colors",
  autoColors.every((c) => ["red", "orange", "yellow", "green", "blue"].includes(c)) &&
    new Set(autoColors).size === 3,
  JSON.stringify(autoColors));
check("v4 restore keeps saved colors and an explicit none",
  await groupColor("kept") === "purple" && await groupColor("none") === null);
await pageV4.close();

}
