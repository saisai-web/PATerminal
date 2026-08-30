export default async function (ctx) {
const { page, check, MOD, dragItemTo } = ctx;

// ============================================================
// サイドバーの複数選択（Ctrl/Cmd+クリック / Shift+クリック / 一括操作）
// 状態: [api(team), web(team), Session 1(未分類)] → 一時的に Session 2/3 を足す
// ============================================================

await page.click("#ws-new");
await page.waitForTimeout(250);
await page.click("#ws-new");
await page.waitForTimeout(350);
const selFixture = await page.locator("#ws-list > .ws-item .ws-name").allTextContents();
check("multi-select fixture adds two ungrouped sessions",
  selFixture.join(",") === "Session 1,Session 2,Session 3", `items=${selFixture.join(",")}`);

// --- 25f. Ctrl/Cmd+クリックは選択に足すだけでセッションを切り替えない ---
await page.locator(".ws-item", { hasText: "Session 2" }).locator(".ws-name").click();
await page.waitForTimeout(200);
await page.locator(".ws-item", { hasText: "Session 3" }).locator(".ws-name").click({ modifiers: [MOD] });
await page.waitForTimeout(200);
const ctrlSel = await page.locator(".ws-item.is-selected .ws-name").allTextContents();
const ctrlActive = await page.locator(".ws-item.is-active .ws-name").textContent();
check("Ctrl/Cmd+click adds an item to the selection",
  ctrlSel.join(",") === "Session 2,Session 3", `selected=${ctrlSel.join(",")}`);
check("Ctrl/Cmd+click keeps the active session", ctrlActive === "Session 2", `active=${ctrlActive}`);
const selBarText = (await page.locator("#ws-selection-count").textContent()) ?? "";
check("selection bar appears with the count",
  (await page.locator("#ws-selection").isVisible()) && selBarText.includes("2"),
  `bar="${selBarText}"`);

// --- 25g. 同じ項目をもう一度 Ctrl/Cmd+クリック → 選択から外れる ---
await page.locator(".ws-item", { hasText: "Session 3" }).locator(".ws-name").click({ modifiers: [MOD] });
await page.waitForTimeout(200);
const ctrlToggled = await page.locator(".ws-item.is-selected .ws-name").allTextContents();
check("Ctrl/Cmd+click toggles the item off", ctrlToggled.join(",") === "Session 2",
  `selected=${ctrlToggled.join(",")}`);
check("selection bar hides below two items", await page.locator("#ws-selection").isHidden());

// --- 25h. Shift+クリックは表示順の範囲（グループの内外をまたぐ）を選ぶ ---
await page.locator(".ws-item", { hasText: "Session 1" }).locator(".ws-name").click();
await page.waitForTimeout(200);
await page.locator(".ws-group-members .ws-item", { hasText: "api" }).locator(".ws-name").click({ modifiers: ["Shift"] });
await page.waitForTimeout(200);
const rangeSel = await page.locator(".ws-item.is-selected .ws-name").allTextContents();
check("Shift+click selects the visible range",
  rangeSel.join(",") === "Session 1,Session 2,Session 3,api", `selected=${rangeSel.join(",")}`);

// --- 25i. 複数選択中の右クリックメニューは一括操作を出す ---
await page.locator(".ws-item", { hasText: "Session 2" }).locator(".ws-name").click();
await page.waitForTimeout(150);
await page.locator(".ws-item", { hasText: "Session 3" }).locator(".ws-name").click({ modifiers: [MOD] });
await page.waitForTimeout(150);
await page.locator(".ws-item", { hasText: "Session 3" }).click({ button: "right" });
await page.waitForTimeout(200);
const selMenuTexts = await page.locator("#ctx-menu button").allTextContents();
check("context menu offers closing the whole selection",
  selMenuTexts.some((v) => v.includes("選択中の 2 セッションを閉じる")),
  `items=${selMenuTexts.join("|")}`);
check("context menu offers grouping the whole selection",
  selMenuTexts.some((v) => v.includes("選択中の 2 セッションをグループにまとめる")),
  `items=${selMenuTexts.join("|")}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const selStillSelected = await page.locator(".ws-item.is-selected").count();
check("right-click inside the selection keeps it", selStillSelected === 2,
  `selected=${selStillSelected}`);

// --- 25j. 複数選択をまとめてグループ見出しへドラッグ → 全部が加入 ---
await dragItemTo(
  page.locator("#ws-list > .ws-item", { hasText: "Session 3" }),
  page.locator(".ws-group", { hasText: "team" }),
  "center",
);
const multiDropMembers = await page.locator(".ws-group-members .ws-item .ws-name").allTextContents();
check("dragging a multi-selection into a group moves every selected session",
  multiDropMembers.join(",") === "Session 2,Session 3,api,web",
  `members=${multiDropMembers.join(",")}`);
const multiDropMarks = await page.locator(".drop-before, .drop-after, .drop-into").count();
check("no leftover drop indicators after a multi-drag", multiDropMarks === 0,
  `marks=${multiDropMarks}`);

// --- 25k. 一括操作バーの「閉じる」で選択セッションをまとめて閉じる ---
await page.click("#ws-selection-close");
await page.waitForTimeout(800);
const afterBulkClose = await page.locator(".ws-item .ws-name").allTextContents();
check("selection bar closes every selected session at once",
  afterBulkClose.join(",") === "Session 1,api,web", `items=${afterBulkClose.join(",")}`);
check("selection bar hides after the bulk close", await page.locator("#ws-selection").isHidden());
await page.waitForFunction(() => {
  const s = window.__savedSession;
  if (!s) return false;
  return JSON.parse(s).workspaces.length === 3;
}, undefined, { timeout: 8000 }).catch(() => {});
const bulkSaved = JSON.parse(await page.evaluate(() => window.__savedSession));
check("bulk close persisted in session",
  bulkSaved.workspaces.map((w) => w.name).join(",") === "api,web,Session 1",
  `saved=${bulkSaved.workspaces.map((w) => w.name).join(",")}`);

// --- 25l. 修飾なしクリックは選択を1つに戻す ---
await page.locator(".ws-group-members .ws-item", { hasText: "web" }).locator(".ws-name").click();
await page.waitForTimeout(200);
const plainSel = await page.locator(".ws-item.is-selected .ws-name").allTextContents();
check("plain click resets the selection to a single item", plainSel.join(",") === "web",
  `selected=${plainSel.join(",")}`);

}
