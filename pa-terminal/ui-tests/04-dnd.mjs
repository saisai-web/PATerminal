export default async function (ctx) {
const { page, check } = ctx;

// ============================================================
// サイドバーのドラッグ&ドロップ並べ替え
// 状態: [Session 1(未分類), api(team), web(team)]
// ============================================================

/** src 項目を dst 項目の上端/下端/中央へネイティブ DnD で落とす */
const dragItemTo = async (srcLoc, dstLoc, pos) => {
  // 行中央の常設メモ input からはnative dragが始まらないため、名前をdrag handleにする。
  const sb = await srcLoc.locator(".ws-name").boundingBox();
  const db = await dstLoc.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  const ty = pos === "top" ? db.y + 3 : pos === "bottom" ? db.y + db.height - 3 : db.y + db.height / 2;
  // dragover を確実に発火させるため2回に分けて動かす
  await page.mouse.move(db.x + db.width / 2, ty, { steps: 10 });
  await page.mouse.move(db.x + db.width / 2, ty + 1);
  await page.mouse.up();
  await page.waitForTimeout(300);
};

/** グループ見出しを別見出しの上端/下端/中央へネイティブ DnD で落とす */
const dragGroupTo = async (srcLoc, dstLoc, pos) => {
  const sb = await srcLoc.boundingBox();
  const db = await dstLoc.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  const ty = pos === "top" ? db.y + 3 : pos === "bottom" ? db.y + db.height - 3 : db.y + db.height / 2;
  await page.mouse.move(db.x + db.width / 2, ty, { steps: 10 });
  await page.mouse.move(db.x + db.width / 2, ty + 1);
  await page.mouse.up();
  await page.waitForTimeout(300);
};

// --- 25b. 未分類セッションをグループ内の項目の下へドラッグ → 加入 + 末尾に並ぶ ---
await dragItemTo(
  page.locator(".ws-item", { hasText: "Session 1" }),
  page.locator(".ws-group-members .ws-item", { hasText: "web" }),
  "bottom",
);
const dndMembers1 = await page.locator(".ws-group-members .ws-item .ws-name").allTextContents();
check("drag ungrouped session into group joins it", dndMembers1.join(",") === "api,web,Session 1",
  `members=${dndMembers1.join(",")}`);

// --- 25c. グループ内で並べ替え（先頭項目の上へドラッグ） ---
await dragItemTo(
  page.locator(".ws-group-members .ws-item", { hasText: "Session 1" }),
  page.locator(".ws-group-members .ws-item", { hasText: "api" }),
  "top",
);
const dndMembers2 = await page.locator(".ws-group-members .ws-item .ws-name").allTextContents();
check("drag reorders within group", dndMembers2.join(",") === "Session 1,api,web",
  `members=${dndMembers2.join(",")}`);

// --- 25d. リスト余白へドラッグ → グループから出て未分類の末尾へ ---
{
  const src = page.locator(".ws-group-members .ws-item", { hasText: "Session 1" });
  const sb = await src.locator(".ws-name").boundingBox();
  const lb = await page.locator("#ws-list").boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height - 12, { steps: 10 });
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height - 11);
  await page.mouse.up();
  await page.waitForTimeout(300);
}
const dndMembers3 = await page.locator(".ws-group-members .ws-item .ws-name").allTextContents();
const dndLastItem = await page.locator(".ws-whole-members > .ws-item .ws-name").last().textContent();
check("drag to empty area ungroups and moves to end",
  dndMembers3.join(",") === "api,web" && dndLastItem === "Session 1",
  `members=${dndMembers3.join(",")} last="${dndLastItem}"`);

// --- 25e. グループ見出しをドラッグ → 配下のセッションごと子グループへ移動 ---
const originalGroupId = await page.locator(".ws-whole-members > .ws-group").first().getAttribute("data-group-id");
const listBox = await page.locator("#ws-list").boundingBox();
await page.mouse.click(listBox.x + listBox.width / 2, listBox.y + listBox.height - 8, { button: "right" });
await page.locator("#ctx-menu button", { hasText: "グループを作成" }).click();
await page.waitForTimeout(200);
const rootGroupIds = await page.locator(".ws-whole-members > .ws-group").evaluateAll((els) =>
  els.map((el) => el.getAttribute("data-group-id")),
);
const targetGroupId = rootGroupIds.find((id) => id && id !== originalGroupId);
const originalGroup = page.locator(`.ws-group[data-group-id="${originalGroupId}"]`);
const targetGroup = page.locator(`.ws-group[data-group-id="${targetGroupId}"]`);
await dragGroupTo(originalGroup, targetGroup, "middle");
const nestedGroupState = await page.evaluate(({ sourceId, targetId }) => {
  const source = document.querySelector(`.ws-group[data-group-id="${sourceId}"]`);
  const target = document.querySelector(`.ws-group[data-group-id="${targetId}"]`);
  const members = source?.nextElementSibling;
  return {
    nestedUnderTarget: source?.parentElement?.previousElementSibling === target,
    members: [...(members?.querySelectorAll(".ws-item .ws-name") ?? [])].map((el) => el.textContent),
  };
}, { sourceId: originalGroupId, targetId: targetGroupId });
check("dragging a group nests its whole session tree",
  nestedGroupState.nestedUnderTarget && nestedGroupState.members.join(",") === "api,web",
  `state=${JSON.stringify(nestedGroupState)}`);

// --- 25f. リスト余白へ落とすと、グループ全体をトップレベルへ戻せる ---
{
  const sb = await originalGroup.boundingBox();
  const lb = await page.locator("#ws-list").boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height - 12, { steps: 10 });
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height - 11);
  await page.mouse.up();
  await page.waitForTimeout(300);
}
const movedRootState = await page.evaluate((sourceId) => {
  const source = document.querySelector(`.ws-whole-members > .ws-group[data-group-id="${sourceId}"]`);
  const members = source?.nextElementSibling;
  return {
    root: !!source,
    members: [...(members?.querySelectorAll(".ws-item .ws-name") ?? [])].map((el) => el.textContent),
  };
}, originalGroupId);
check("dragging a group to the empty list area restores it as a root group",
  movedRootState.root && movedRootState.members.join(",") === "api,web",
  `state=${JSON.stringify(movedRootState)}`);

// --- 25g. 見出し上端へのドロップで、同じ階層内の前後順も変えられる ---
await dragGroupTo(originalGroup, targetGroup, "top");
const reorderedRootIds = await page.locator(".ws-whole-members > .ws-group").evaluateAll((els) =>
  els.map((el) => el.getAttribute("data-group-id")),
);
check("dragging a group to a header edge reorders its whole tree",
  reorderedRootIds.indexOf(originalGroupId) < reorderedRootIds.indexOf(targetGroupId),
  `order=${JSON.stringify(reorderedRootIds)}`);

// 一時グループを解散して、以後のテストが従来の [api, web] グループ状態を使えるよう戻す。
await targetGroup.click({ button: "right" });
await page.locator("#ctx-menu button", { hasText: "グループを解散" }).click();
await page.waitForTimeout(200);

// --- 25h. 並び順が保存される + インジケーター残留なし ---
await page.waitForFunction(() => {
  const s = window.__savedSession;
  if (!s) return false;
  const names = JSON.parse(s).workspaces.map((w) => w.name);
  return names.join(",") === "api,web,Session 1";
}, undefined, { timeout: 8000 }).catch(() => {});
const dndSaved = JSON.parse(await page.evaluate(() => window.__savedSession));
const dndSavedNames = dndSaved.workspaces.map((w) => w.name).join(",");
const dndSess1Group = dndSaved.workspaces.find((w) => w.name === "Session 1")?.group;
check("drag order persisted in session", dndSavedNames === "api,web,Session 1" && dndSess1Group == null,
  `order=${dndSavedNames} group=${JSON.stringify(dndSess1Group)}`);
const dndMarks = await page.locator(".drop-before, .drop-after, .drop-into, #ws-list.drop-end").count();
check("no leftover drop indicators", dndMarks === 0, `marks=${dndMarks}`);

ctx.dragItemTo = dragItemTo;
}
