export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 設定パネル: ペアモードの既定コマンド / worktree の既定の置き場所
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(300);

check("sidebar footer holds exactly the settings and license buttons",
  await page.locator("#sidebar-foot #settings-open").isVisible() &&
    await page.locator("#sidebar-foot #license-open").isVisible() &&
    (await page.locator("#sidebar-foot button").count()) === 2);
check("history and pane-clear are visible in the focused pane header",
  await page.locator(".pane.is-focused .pane-bar #session-trash-open").isVisible() &&
    await page.locator(".pane.is-focused .pane-bar #pane-clear").isVisible() &&
    (await page.locator("#sidebar-foot #session-trash-open").count()) === 0 &&
    (await page.locator("#sidebar-foot #pane-clear").count()) === 0);
const headerOrder = await page.locator(".pane.is-focused .pane-bar #pane-actions > *").evaluateAll(
  (els) => els.map((el) => el.id || el.className),
);
check("pane-clear sits directly to the right of history",
  headerOrder.indexOf("pane-clear") === headerOrder.indexOf("session-trash-open") + 1,
  `order=${JSON.stringify(headerOrder)}`);
check("auto-enter is visible in the toolbar, next to the takeover history button",
  await page.locator("#toolbar #auto-enter-toggle").isVisible() &&
    (await page.locator(".pane.is-focused .pane-bar #auto-enter-toggle").count()) === 0);
const toolbarOrder = await page.locator("#toolbar > *").evaluateAll(
  (els) => els.map((el) => el.id || el.className),
);
check("auto-enter sits directly to the right of the takeover history button",
  toolbarOrder.indexOf("auto-enter-toggle") === toolbarOrder.indexOf("takeover-open") + 1,
  `order=${JSON.stringify(toolbarOrder)}`);
await page.evaluate(() => window.__ptyPushAll("clear-me\r\n"));
await page.waitForTimeout(1200);
const paneTextBeforeClear = await page.evaluate(() => {
  const saved = JSON.parse(window.__savedSession ?? "null");
  return saved?.workspaces?.find((workspace) => workspace.id === saved.activeId)?.root?.scrollback ?? "";
});
const spawnsBeforeClear = await page.evaluate(() => window.__ptySpawns.length);
await page.click("#pane-clear");
// トラッシュボタンは表示クリアではなく、シェルを kill して同じ場所に spawn し直す
// （restartPane）。新しい PTY spawn が起きるまで待つ
await page.waitForFunction((before) => window.__ptySpawns.length === before + 1, spawnsBeforeClear);
await page.waitForTimeout(1200);
const paneTextAfterClear = await page.evaluate(() => {
  const saved = JSON.parse(window.__savedSession ?? "null");
  return saved?.workspaces?.find((workspace) => workspace.id === saved.activeId)?.root?.scrollback ?? "";
});
const killedBeforeRespawn = await page.evaluate(() => {
  const log = (window.__ipcLog ?? []).filter((e) => e.cmd === "pty_kill" || e.cmd === "pty_spawn");
  const killIdx = log.findIndex((e) => e.cmd === "pty_kill");
  const spawnIdx = log.findIndex((e, i) => i > killIdx && e.cmd === "pty_spawn");
  return killIdx !== -1 && spawnIdx !== -1;
});
check("trash button restarts the pane's shell (kills the old process, spawns a fresh one)",
  paneTextBeforeClear?.includes("clear-me") === true &&
    !paneTextAfterClear?.includes("clear-me") &&
    killedBeforeRespawn);
await page.click("#settings-open");
check("auto-enter defaults to off",
  (await page.locator("#auto-enter-toggle").getAttribute("aria-pressed")) === "false");
await page.click('#settings-nav .settings-nav-item[data-section="pair"]');
const implVal = await page.locator("#settings-pair-impl").inputValue();
const reviewVal = await page.locator("#settings-pair-review").inputValue();
check("pair defaults default to claude/codex", implVal === "claude" && reviewVal === "codex",
  `impl=${implVal} review=${reviewVal}`);

// 入れ替えボタンで実装役/レビュー役の既定コマンドを入れ替える
await page.click("#settings-pair-swap");
const swappedImpl = await page.locator("#settings-pair-impl").inputValue();
const swappedReview = await page.locator("#settings-pair-review").inputValue();
check("swap button swaps the default commands",
  swappedImpl === "codex" && swappedReview === "claude",
  `impl=${swappedImpl} review=${swappedReview}`);

// worktree の既定の置き場所をリポジトリ配下 + カスタムディレクトリへ変更
await page.click('#settings-nav .settings-nav-item[data-section="worktree"]');
const outsideChecked = await page.locator('#settings-worktree-loc input[value="outside"]').isChecked();
check("worktree location defaults to outside", outsideChecked);
await page.locator('#settings-worktree-loc input[value="inside"]').check();
await page.locator("#settings-worktree-dir").fill(".my-worktrees");
await page.locator("#settings-worktree-dir").dispatchEvent("change");
await page.click("#settings-close");
await page.waitForTimeout(1600); // scheduleSave のデバウンス + アイドル保存待ち

const saved = await page.evaluate(() => JSON.parse(window.__savedSession).settings);
check("swapped pair defaults persisted",
  saved.pair?.implCmd === "codex" && saved.pair?.reviewCmd === "claude",
  `pair=${JSON.stringify(saved.pair)}`);
check("worktree defaults persisted",
  saved.worktree?.location === "inside" && saved.worktree?.insideDir === ".my-worktrees",
  `worktree=${JSON.stringify(saved.worktree)}`);

// 自動Enter: ボタンから対象セッションを選び、選択したセッションの全ペインへEnterを送る
await page.click("#auto-enter-toggle");
check("auto-enter opens a session picker",
  await page.locator("#auto-enter-panel").isVisible() &&
    (await page.locator("#auto-enter-list .auto-enter-row").count()) === 1);
check("active session is initially not selected for auto-enter",
  !(await page.locator("#auto-enter-list input[type=checkbox]").isChecked()));
await page.locator("#auto-enter-list input[type=checkbox]").check();
await page.click("#auto-enter-close");
await page.click("#split-right");
await page.waitForTimeout(250);
check("history and pane-clear follow the focused pane after splitting",
  await page.locator(".pane.is-focused .pane-bar #session-trash-open").isVisible() &&
    await page.locator(".pane.is-focused .pane-bar #pane-clear").isVisible());
await page.locator(".pane .pane-body").first().click();
const enterBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
const enterWrites = await page.evaluate((n) => window.__ptyWrites.slice(n), enterBefore);
const enterPaneIds = new Set(enterWrites.filter((w) => w.data === "\r").map((w) => w.id));
check("auto-enter sends Enter to every pane in the session", enterPaneIds.size === 2,
  `panes hit=${enterPaneIds.size}`);

// 新しいセッションは既定でOFF。前のセッションの選択は保持される
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(250);
check("new session defaults to auto-enter off",
  (await page.locator("#auto-enter-toggle").getAttribute("aria-pressed")) === "false");
await page.click("#auto-enter-toggle");
const autoEnterChecks = page.locator("#auto-enter-list input[type=checkbox]");
check("auto-enter picker keeps settings per session",
  (await autoEnterChecks.count()) === 2 &&
    await autoEnterChecks.nth(0).isChecked() &&
    !(await autoEnterChecks.nth(1).isChecked()));
await page.locator("#auto-enter-all").check();
check("auto-enter picker keeps an all-sessions mode",
  await page.locator("#auto-enter-all").isChecked() &&
    await autoEnterChecks.nth(0).isDisabled() &&
    await autoEnterChecks.nth(1).isDisabled());
await page.click("#auto-enter-close");
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(250);
check("all-sessions mode applies to newly created sessions",
  (await page.locator("#auto-enter-toggle").getAttribute("aria-pressed")) === "true");
await page.waitForTimeout(1200);
const autoEnterSaved = await page.evaluate(() => JSON.parse(window.__savedSession));
check("auto-enter setting is persisted per workspace",
  autoEnterSaved.settings?.autoEnter === true &&
    autoEnterSaved.workspaces?.some((workspace) => workspace.autoEnter === true) === true);

// ペアのセットアップモーダルは入れ替え後の既定コマンドで開く（「このセッションを置き換え」が既定）
await page.click("#pair-open");
const modalImpl = await page.locator("#pair-impl-cmd").inputValue();
const modalReview = await page.locator("#pair-review-cmd").inputValue();
check("pair setup modal prefills the swapped defaults",
  modalImpl === "codex" && modalReview === "claude",
  `impl=${modalImpl} review=${modalReview}`);
await page.click("#pair-close");

await page.close();

}
