export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// セッションごとのメモ: サイドバー1行表示 + 先頭ペイン最大2行表示 /
// IME / 改行 / 検索 / 保存 / 削除履歴 / 再起動復元
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });

const item = page.locator(".ws-item.is-active");
await item.click({ button: "right" });
check("session context menu does not offer note editing",
  await page.locator("#ctx-menu button", { hasText: /メモを(追加|編集)/ }).count() === 0);
await page.keyboard.press("Escape");

const display = page.locator(".ws-item.is-active .ws-note-display");
check("empty note shows a dim placeholder row",
  await display.isVisible() &&
    (await display.textContent()) === "ここにメモを書く…" &&
    await display.evaluate((el) => el.classList.contains("is-empty")));
check("empty note does not add a row to the pane bar",
  await page.locator(".pane-note").count() === 1 &&
    await page.locator(".pane-note").isHidden());

// メモ欄クリックで編集ポップオーバーが開き、textarea へフォーカスが移る
await display.click();
const editor = page.locator(".ws-note-popover .ws-note-popover-input");
check("clicking the note row opens the popover editor focused",
  await editor.isVisible() &&
    await editor.getAttribute("maxlength") === "120" &&
    await editor.getAttribute("placeholder") === "ここにメモを書く…" &&
    await page.locator(".ws-note-popover .ws-note-popover-name").textContent() === "Session 1" &&
    await editor.evaluate((el) => document.activeElement === el));
check("note editor hint documents Shift+Enter",
  (await page.locator(".ws-note-popover-foot").textContent())
    ?.includes("Shift+Enter で改行") === true);

// IME の変換確定 Enter は保存扱いにしない。WebKit の揺れに備えて
// isComposing / composition イベント状態 / keyCode=229 の3経路を個別に再現する。
const imeEnterResult = await editor.evaluate((el) => {
  const fireEnter = (init = {}, keyCode) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  const compositionState = fireEnter();
  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  return {
    compositionState,
    isComposing: fireEnter({ isComposing: true }),
    keyCode229: fireEnter({}, 229),
  };
});
check("IME composition Enter and keyCode 229 keep the editor open",
  await page.locator(".ws-note-popover").count() === 1 &&
    !imeEnterResult.compositionState &&
    !imeEnterResult.isComposing &&
    !imeEnterResult.keyCode229,
  JSON.stringify(imeEnterResult));
const popover = page.locator(".ws-note-popover");
const initialPopoverBox = await popover.boundingBox();
const initialEditorBox = await editor.boundingBox();
check("note popover can be resized in both directions",
  await popover.evaluate((el) => getComputedStyle(el).resize) === "both");
if (initialPopoverBox) {
  await page.mouse.move(
    initialPopoverBox.x + initialPopoverBox.width - 2,
    initialPopoverBox.y + initialPopoverBox.height - 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    initialPopoverBox.x + initialPopoverBox.width + 118,
    initialPopoverBox.y + initialPopoverBox.height + 78,
    { steps: 5 },
  );
  await page.mouse.up();
}
const enlargedPopoverBox = await popover.boundingBox();
const enlargedEditorBox = await editor.boundingBox();
check("dragging the popover corner enlarges the note view",
  initialPopoverBox && enlargedPopoverBox &&
    enlargedPopoverBox.width > initialPopoverBox.width + 80 &&
    enlargedPopoverBox.height > initialPopoverBox.height + 40,
  `before=${JSON.stringify(initialPopoverBox)} after=${JSON.stringify(enlargedPopoverBox)}`);
check("the note textarea follows the enlarged card",
  initialEditorBox && enlargedEditorBox &&
    enlargedEditorBox.width > initialEditorBox.width + 80 &&
    enlargedEditorBox.height > initialEditorBox.height + 40,
  `before=${JSON.stringify(initialEditorBox)} after=${JSON.stringify(enlargedEditorBox)}`);
if (enlargedPopoverBox) {
  await page.mouse.move(
    enlargedPopoverBox.x + enlargedPopoverBox.width - 2,
    enlargedPopoverBox.y + enlargedPopoverBox.height - 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    enlargedPopoverBox.x + enlargedPopoverBox.width - 62,
    enlargedPopoverBox.y + enlargedPopoverBox.height - 42,
    { steps: 5 },
  );
  await page.mouse.up();
}
const reducedPopoverBox = await popover.boundingBox();
check("dragging the popover corner back reduces the note view",
  enlargedPopoverBox && reducedPopoverBox &&
    reducedPopoverBox.width < enlargedPopoverBox.width - 30 &&
    reducedPopoverBox.height < enlargedPopoverBox.height - 20,
  `before=${JSON.stringify(enlargedPopoverBox)} after=${JSON.stringify(reducedPopoverBox)}`);
await popover.evaluate((el) => {
  el.style.left = `${window.innerWidth - 20}px`;
  el.style.top = `${window.innerHeight - 20}px`;
  el.style.width = "2000px";
  el.style.height = "2000px";
});
await page.waitForFunction(() => {
  const el = document.querySelector(".ws-note-popover");
  if (!el) return false;
  const bounds = el.getBoundingClientRect();
  return bounds.left >= 7 && bounds.top >= 7 &&
    bounds.right <= window.innerWidth - 7 && bounds.bottom <= window.innerHeight - 7;
});
const viewportPopoverBox = await popover.boundingBox();
const viewportSize = page.viewportSize();
check("the resized note view stays inside the viewport",
  viewportPopoverBox && viewportSize &&
    viewportPopoverBox.x >= 7 && viewportPopoverBox.y >= 7 &&
    viewportPopoverBox.x + viewportPopoverBox.width <= viewportSize.width - 7 &&
    viewportPopoverBox.y + viewportPopoverBox.height <= viewportSize.height - 7,
  JSON.stringify(viewportPopoverBox));
await editor.fill("  PR #90 のレビュー  ");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("  CI   待ち  ");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("確認");
check("Shift+Enter inserts newlines without closing the editor",
  await page.locator(".ws-note-popover").count() === 1 &&
    (await editor.inputValue()) === "  PR #90 のレビュー  \n  CI   待ち  \n確認");
await page.keyboard.press("Enter");
check("Enter saves the normalized note and closes the editor",
  await page.locator(".ws-note-popover").count() === 0 &&
    (await display.textContent()) === "PR #90 のレビュー\nCI 待ち\n確認" &&
    !(await display.evaluate((el) => el.classList.contains("is-empty"))));
check("sidebar keeps its one-line note presentation",
  await display.evaluate((el) => getComputedStyle(el).whiteSpace) === "nowrap");

const paneNote = page.locator(".pane-note:not([hidden])");
const paneNoteStyle = await paneNote.evaluate((el) => {
  const style = getComputedStyle(el);
  return {
    clamp: style.webkitLineClamp,
    height: el.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(style.lineHeight),
  };
});
check("the first pane bar shows the full note source clamped to two lines",
  await paneNote.textContent() === "PR #90 のレビュー\nCI 待ち\n確認" &&
    await paneNote.getAttribute("title") === "PR #90 のレビュー\nCI 待ち\n確認" &&
    paneNoteStyle.clamp === "2" &&
    paneNoteStyle.height <= paneNoteStyle.lineHeight * 2 + 1,
  JSON.stringify(paneNoteStyle));

// 分割してもツリー先頭 leaf だけに表示し、先頭を再起動しても表示先を失わない。
await page.click("#split-right");
await page.waitForTimeout(200);
check("only the first leaf shows the pane-bar note after splitting",
  await page.locator(".pane-note").count() === 2 &&
    await page.locator(".pane-note:not([hidden])").count() === 1 &&
    !(await page.locator(".pane-note").first().isHidden()) &&
    await page.locator(".pane-note").nth(1).isHidden());
await page.locator(".pane .pane-body").first().click();
const spawnsBeforeRestart = await page.evaluate(() => window.__ptySpawns.length);
await page.click("#pane-clear");
await page.waitForFunction((before) => window.__ptySpawns.length === before + 1, spawnsBeforeRestart);
check("restarting the first pane restores its pane-bar note",
  await page.locator(".pane-note:not([hidden])").count() === 1 &&
    await page.locator(".pane-note:not([hidden])").textContent() ===
      "PR #90 のレビュー\nCI 待ち\n確認");

// 先頭 leaf を閉じると、次の先頭 leaf へ表示が移る。
await page.locator(".pane.is-focused .pane-close").click();
await page.waitForTimeout(200);
check("closing the first leaf moves the pane-bar note to the next leaf",
  await page.locator(".pane").count() === 1 &&
    await page.locator(".pane-note:not([hidden])").count() === 1 &&
    await page.locator(".pane-note:not([hidden])").textContent() ===
      "PR #90 のレビュー\nCI 待ち\n確認");

await display.click();
check("reopened editor starts from the saved note with its length",
  await editor.inputValue() === "PR #90 のレビュー\nCI 待ち\n確認" &&
    (await page.locator(".ws-note-popover .ws-note-popover-count").textContent()) === "21/120");
await editor.fill("破棄される編集");
check("editing mirrors into the note row before saving",
  (await display.textContent()) === "破棄される編集");
await page.keyboard.press("Escape");
check("Escape discards the edit and restores the row",
  await page.locator(".ws-note-popover").count() === 0 &&
    (await display.textContent()) === "PR #90 のレビュー\nCI 待ち\n確認");

await display.click();
await display.click();
check("clicking the note row again closes the editor (saving)",
  await page.locator(".ws-note-popover").count() === 0 &&
    (await display.textContent()) === "PR #90 のレビュー\nCI 待ち\n確認");

await page.fill("#ws-search", "レビュー ci");
check("session search matches text across note newlines",
  await page.locator(".ws-item").count() === 1);
await page.fill("#ws-search", "");
await page.waitForTimeout(1100);

const saved = await page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
check("session note is saved in session.json v5",
  saved?.version === 5 &&
    saved.workspaces?.[0]?.note === "PR #90 のレビュー\nCI 待ち\n確認");

await item.hover();
await page.locator(".ws-item.is-active .ws-close").click();
await page.waitForTimeout(1200);
const archived = await page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
check("recently-deleted sessions retain their note",
  archived?.deletedWorkspaces?.[0]?.note === "PR #90 のレビュー\nCI 待ち\n確認");

await page.click("#session-trash-open");
check("recently-deleted dialog shows the session note",
  await page.locator(".session-trash-row .session-trash-note").textContent() ===
    "PR #90 のレビュー\nCI 待ち\n確認");
await page.locator(".session-trash-row", { hasText: "Session 1" })
  .locator(".session-trash-restore").click();
await page.waitForTimeout(1100);
check("restoring a deleted session restores its note",
  await page.locator(".ws-item.is-active .ws-note-display").textContent() ===
    "PR #90 のレビュー\nCI 待ち\n確認" &&
    await page.locator(".pane-note:not([hidden])").textContent() ===
      "PR #90 のレビュー\nCI 待ち\n確認");
const restoredRaw = await page.evaluate(() => window.__savedSession ?? "");
await page.close();

const reload = await browser.newPage({ viewport: { width: 1280, height: 820 } });
reload.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await reload.addInitScript((raw) => { window.__mockSessionLoad = raw; }, restoredRaw);
await reload.goto(BASE_URL);
await reload.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
check("session note is restored after app restart",
  await reload.locator(".ws-item.is-active .ws-note-display").textContent() ===
    "PR #90 のレビュー\nCI 待ち\n確認" &&
    await reload.locator(".pane-note:not([hidden])").textContent() ===
      "PR #90 のレビュー\nCI 待ち\n確認");

await reload.locator(".ws-item.is-active .ws-note-display").click();
await reload.locator(".ws-note-popover .ws-note-popover-input").fill("   ");
await reload.keyboard.press("Enter");
check("saving an empty note returns the row to its placeholder",
  (await reload.locator(".ws-item.is-active .ws-note-display").textContent()) ===
    "ここにメモを書く…" &&
    await reload.locator(".ws-item.is-active .ws-note-display")
      .evaluate((el) => el.classList.contains("is-empty")) &&
    await reload.locator(".workspace-layer:not([hidden]) .pane-note").isHidden());
// 復元直後の保存と重なると resaveQueued 経由になるため、2回目のデバウンスまで待つ
await reload.waitForTimeout(2200);
const cleared = await reload.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
const clearedWorkspace = cleared?.workspaces?.find((workspace) => workspace.id === cleared.activeId);
check("a removed note is omitted from saved session data",
  clearedWorkspace && !("note" in clearedWorkspace), JSON.stringify(clearedWorkspace));
await reload.close();

}
