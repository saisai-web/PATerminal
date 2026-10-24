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
// 色機能より前のグループと6色時代の自動色は、見えている見出しの順に赤・青を交互に塗る。
// 表示中セッションが Child にあるため Parent は開いて復元される。折りたたむと Child は数えない。
// 「色なし」(null) は保ち、数えない
const groupColor = (id) =>
  pageV4.locator(`.ws-group[data-group-id=${id}]`).getAttribute("data-ws-color");
const visibleColors = async () => ({
  parent: await groupColor("parent"),
  empty: await groupColor("empty"),
  kept: await groupColor("kept"),
  none: await groupColor("none"),
});
const expandedColors = { ...(await visibleColors()), child: await groupColor("child") };
check("v4 restore alternates red and blue down the visible groups, children included",
  JSON.stringify(expandedColors) ===
    JSON.stringify({ parent: "red", empty: "red", kept: "blue", none: null, child: "blue" }) &&
    await pageV4.locator(".ws-group[data-group-id=child] + .ws-group-members")
      .getAttribute("data-ws-color") === "blue",
  JSON.stringify(expandedColors));
await pageV4.locator(".ws-group[data-group-id=parent]").click();
await pageV4.waitForTimeout(100);
const collapsedColors = await visibleColors();
check("collapsing a group repaints the alternating colors without its hidden children",
  JSON.stringify(collapsedColors) ===
    JSON.stringify({ parent: "red", empty: "blue", kept: "red", none: null }),
  JSON.stringify(collapsedColors));
await pageV4.waitForFunction(
  () => JSON.parse(window.__savedSession ?? "null")?.settings?.groupColorsAlternate === true,
  null, { timeout: 5000 },
).catch(() => {});
const savedV4 = await pageV4.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
check("automatic group colors are not stored and the alternate marker is saved",
  savedV4?.settings?.groupColors === "red-blue" &&
    savedV4?.settings?.groupColorsAlternate === true &&
    savedV4?.groups?.find((g) => g.id === "kept")?.color === undefined &&
    savedV4?.groups?.find((g) => g.id === "none")?.color === null,
  JSON.stringify(savedV4?.groups));
await pageV4.close();

// ランダムな赤青を保存していた頃のデータは、赤・青を一度だけ自動色へ戻して交互に塗り直す。
// 赤青化の後に自分で選んだ赤青以外の色は残す
const pageRandom = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageRandom.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageRandom.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "random-session",
    settings: { groupColors: "red-blue" },
    groups: [
      { id: "r1", name: "R1", color: "red" },
      { id: "r2", name: "R2", color: "red" },
      { id: "green", name: "Green", color: "green" },
      { id: "b1", name: "B1", color: "blue" },
    ],
    workspaces: [
      {
        id: "random-session", name: "Random Session", group: "r1",
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "random" },
      },
    ],
  });
});
await pageRandom.goto(BASE_URL);
await pageRandom.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageRandom.waitForTimeout(300);
const randomColors = await pageRandom.evaluate(() =>
  [...document.querySelectorAll(".ws-group")].map((el) => `${el.dataset.groupId}:${el.dataset.wsColor}`));
check("random red/blue colors from before are redone as alternating colors",
  JSON.stringify(randomColors) === JSON.stringify(["r1:red", "r2:blue", "green:green", "b1:red"]),
  JSON.stringify(randomColors));
await pageRandom.close();

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
  const { createGroup } = await import("/src/workspace/groups.ts");
  const group = createGroup("Colored");
  return {
    saved: JSON.parse(window.__savedSession ?? "null")?.settings?.groupColors,
    stored: group.color,
    shown: document.querySelector(`.ws-group[data-group-id="${group.id}"]`)?.dataset.wsColor,
  };
});
check("turning the option on is saved and colors new groups red or blue",
  turnedOn.saved === "red-blue" && turnedOn.stored === undefined &&
    ["red", "blue"].includes(turnedOn.shown),
  JSON.stringify(turnedOn));
await pageNone.close();

}
