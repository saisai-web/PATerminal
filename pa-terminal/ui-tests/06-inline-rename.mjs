export default async function (ctx) {
const { page, check, MOD } = ctx;

// ============================================================
// インラインリネーム（Esc / 空文字 / 打鍵の隔離 / ペイン名）
// ============================================================

// --- 26. Esc でキャンセル ---
await page.keyboard.press(`${MOD}+Digit1`);
await page.waitForTimeout(200);
const nameBefore = await page.locator(".ws-item.is-active .ws-name").textContent();
await page.locator(".ws-item.is-active .ws-name").dblclick();
await page.locator(".ws-item .inline-edit").fill("zzz");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const nameAfterEsc = await page.locator(".ws-item.is-active .ws-name").textContent();
check("Esc cancels rename", nameAfterEsc === nameBefore, `name="${nameAfterEsc}"`);

// --- 27. 空文字は確定不可（キャンセル扱い） ---
await page.locator(".ws-item.is-active .ws-name").dblclick();
await page.locator(".ws-item .inline-edit").fill("   ");
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
const nameAfterEmpty = await page.locator(".ws-item.is-active .ws-name").textContent();
check("empty name is rejected", nameAfterEmpty === nameBefore, `name="${nameAfterEmpty}"`);

// --- 28. 編集中の打鍵がターミナル・ショートカットに流れない ---
await page.locator(".ws-item.is-active .ws-name").dblclick();
const editWritesBefore = await page.evaluate(() => window.__ptyWrites.length);
const editPanesBefore = await page.locator(".pane").count();
await page.keyboard.type("abc", { delay: 20 });
await page.keyboard.press(`${MOD}+Shift+KeyD`); // 分割ショートカットも吸われないこと
await page.waitForTimeout(300);
const editWritesAfter = await page.evaluate(() => window.__ptyWrites.length);
const editPanesAfter = await page.locator(".pane").count();
check("editing keystrokes don't reach terminal", editWritesAfter === editWritesBefore,
  `writes +${editWritesAfter - editWritesBefore}`);
check("shortcuts suppressed while editing", editPanesAfter === editPanesBefore,
  `panes ${editPanesBefore}→${editPanesAfter}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// --- 29. ペイン名のインライン編集 + 保存内容に反映 ---
await page.locator(".workspace-layer:not([hidden]) .pane-title").first().dblclick();
await page.waitForTimeout(150);
await page.locator(".pane-bar .inline-edit").fill("my-pane");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () => (window.__savedSession ?? "").includes('"my-pane"'),
  undefined,
  { timeout: 8000 },
).catch(() => {});
const paneTitle = await page.locator(".workspace-layer:not([hidden]) .pane-title").first().textContent();
const savedPane = await page.evaluate(() => window.__savedSession);
check("pane title inline rename", paneTitle === "my-pane", `title="${paneTitle}"`);
check("pane title persisted in session", savedPane.includes('"my-pane"'));

ctx.editPanesAfter = editPanesAfter;
}
