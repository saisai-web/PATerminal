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
// 色機能より前のグループには赤か青を自動で振り、6色時代の色は赤か青へ振り直す。
// 「色なし」(null) は保つ
const groupColor = (id) =>
  pageV4.locator(`.ws-group[data-group-id=${id}]`).getAttribute("data-ws-color");
const autoColors = [await groupColor("parent"), await groupColor("child"), await groupColor("empty")];
check("v4 restore gives colorless groups a red or blue color",
  autoColors.every((c) => ["red", "blue"].includes(c)),
  JSON.stringify(autoColors));
check("v4 restore moves an old six-color group to red or blue and keeps an explicit none",
  ["red", "blue"].includes(await groupColor("kept")) && await groupColor("none") === null);
await pageV4.waitForFunction(
  () => JSON.parse(window.__savedSession ?? "null")?.settings?.groupColors === "red-blue",
  null, { timeout: 5000 },
).catch(() => {});
const savedV4 = await pageV4.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
check("migrated group colors are saved with the red-blue marker",
  savedV4?.settings?.groupColors === "red-blue" &&
    ["red", "blue"].includes(savedV4?.groups?.find((g) => g.id === "kept")?.color),
  JSON.stringify(savedV4?.settings?.groupColors));
await pageV4.close();

// 赤青化の後の保存データは一度だけの振り直しをしない。「色を付けない」設定では
// 色のないグループに色を振らず、設定パネルのチェックボックスで切り替えられる
const pageNone = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageNone.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageNone.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "plain-session",
    settings: { groupColors: "none" },
    groups: [
      { id: "plain", name: "Plain" },
      { id: "green", name: "Green", color: "green" },
    ],
    workspaces: [
      {
        id: "plain-session", name: "Plain Session", group: "plain",
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "plain" },
      },
    ],
  });
});
await pageNone.goto(BASE_URL);
await pageNone.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageNone.waitForTimeout(300);
const noneColor = (id) =>
  pageNone.locator(`.ws-group[data-group-id=${id}]`).getAttribute("data-ws-color");
check("no-color setting leaves restored groups uncolored and keeps colors chosen after the migration",
  await noneColor("plain") === null && await noneColor("green") === "green");
const newGroupColor = await pageNone.evaluate(async () => {
  const { addGroup } = await import("/src/workspace/groups.ts");
  return addGroup("NoColor").color;
});
check("no-color setting creates new groups without a color", newGroupColor === null,
  JSON.stringify(newGroupColor));
await pageNone.click("#settings-open");
await pageNone.waitForTimeout(150);
const groupColorsBox = pageNone.locator("#settings-group-colors");
check("settings shows the automatic group color option off", (await groupColorsBox.isChecked()) === false);
await groupColorsBox.check();
await pageNone.waitForFunction(
  () => JSON.parse(window.__savedSession ?? "null")?.settings?.groupColors === "red-blue",
  null, { timeout: 5000 },
).catch(() => {});
const turnedOn = await pageNone.evaluate(async () => {
  const { addGroup } = await import("/src/workspace/groups.ts");
  return {
    saved: JSON.parse(window.__savedSession ?? "null")?.settings?.groupColors,
    color: addGroup("Colored").color,
  };
});
check("turning the option on is saved and colors new groups red or blue",
  turnedOn.saved === "red-blue" && ["red", "blue"].includes(turnedOn.color),
  JSON.stringify(turnedOn));
await pageNone.close();

}
