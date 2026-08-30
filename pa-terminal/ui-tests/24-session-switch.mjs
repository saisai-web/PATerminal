export default async function (ctx) {
const { browser, check, MOD, BASE_URL } = ctx;

// ============================================================
// キーボードでのセッション切替（Ctrl+Tab / Cmd(+Ctrl)+Shift+↑↓）
// ターミナルにカーソルがあってもマウスへ持ち替えずに切り替えられること
// ============================================================

const pageSw = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageSw.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageSw.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "a",
    collapsedGroups: ["g"],
    groups: [{ id: "g", name: "Folded" }],
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "b", name: "Bravo", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "c", name: "Charlie", group: "g", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c" } },
      { id: "d", name: "Delta", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "d" } },
    ],
  });
});
await pageSw.goto(BASE_URL);
await pageSw.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageSw.waitForTimeout(400);

const activeName = () => pageSw.locator(".ws-item.is-active .ws-name").textContent();
// ターミナル（xterm の textarea）にカーソルがある状態から操作する
const focusTerminal = async () => {
  await pageSw.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
  await pageSw.waitForTimeout(150);
};
const inTerminal = () =>
  pageSw.evaluate(() => !!document.activeElement?.closest?.(".pane-body"));

check("sidebar shows the Ctrl+Tab hint",
  (await pageSw.locator("#ws-switch-hint").isVisible()) &&
    (await pageSw.locator("#ws-switch-hint").textContent()).includes("Ctrl+Tab"),
  await pageSw.locator("#ws-switch-hint").textContent());

await focusTerminal();
check("starts in the terminal", await inTerminal());

// --- Ctrl+Tab: サイドバーの表示順で次のセッションへ（畳んだグループの中は飛ばす） ---
await pageSw.keyboard.press("Control+Tab");
await pageSw.waitForTimeout(300);
// xterm は Tab を \t として PTY へ送ろうとする。capture 側で止まっていること
check("Ctrl+Tab is not forwarded to the shell as a tab",
  !(await pageSw.evaluate(() => window.__ptyWrites.some((w) => w.data.includes("\t")))));
check("Ctrl+Tab switches to the next session while typing in the terminal",
  (await activeName()) === "Bravo", `active="${await activeName()}"`);
check("focus stays in the terminal after switching", await inTerminal());
check("switching selects only that session in the sidebar",
  (await pageSw.locator(".ws-item.is-selected").count()) === 1 &&
    (await pageSw.locator(".ws-item.is-selected .ws-name").textContent()) === "Bravo");

await pageSw.keyboard.press("Control+Tab");
await pageSw.waitForTimeout(300);
check("Ctrl+Tab skips sessions inside a collapsed group",
  (await activeName()) === "Delta", `active="${await activeName()}"`);

// 端では巻き戻す（Delta が表示順の末尾）
await pageSw.keyboard.press("Control+Tab");
await pageSw.waitForTimeout(300);
check("Ctrl+Tab wraps around at the end", (await activeName()) === "Alpha",
  `active="${await activeName()}"`);

// --- Ctrl+Shift+Tab: 逆順。先頭からは末尾へ巻き戻る ---
await pageSw.keyboard.press("Control+Shift+Tab");
await pageSw.waitForTimeout(300);
check("Ctrl+Shift+Tab wraps back to the last session", (await activeName()) === "Delta",
  `active="${await activeName()}"`);

// --- Cmd(+Ctrl)+Shift+↑↓ も同じ移動 ---
await focusTerminal();
await pageSw.keyboard.press(`${MOD}+Shift+ArrowUp`);
await pageSw.waitForTimeout(300);
check("Cmd/Ctrl+Shift+Up moves to the previous session", (await activeName()) === "Bravo",
  `active="${await activeName()}"`);
await pageSw.keyboard.press(`${MOD}+Shift+ArrowDown`);
await pageSw.waitForTimeout(300);
check("Cmd/Ctrl+Shift+Down moves to the next session", (await activeName()) === "Delta",
  `active="${await activeName()}"`);

// --- グループを開くとその中も並びに入る ---
await pageSw.locator(".ws-group[data-group-id=g]").click();
await pageSw.waitForTimeout(200);
await focusTerminal();
await pageSw.keyboard.press("Control+Tab");
await pageSw.waitForTimeout(300);
check("expanding a group puts its sessions back in the rotation",
  (await activeName()) === "Charlie", `active="${await activeName()}"`);

// --- セッションが1つだけなら何も起きない ---
for (const name of ["Bravo", "Charlie", "Delta"]) {
  const item = pageSw.locator(".ws-item", { hasText: name });
  await item.hover();
  await item.locator(".ws-close").click();
  await pageSw.waitForTimeout(300);
}
await focusTerminal();
await pageSw.keyboard.press("Control+Tab");
await pageSw.waitForTimeout(300);
check("Ctrl+Tab is a no-op with a single session",
  (await pageSw.locator(".ws-item").count()) === 1 && (await activeName()) === "Alpha",
  `active="${await activeName()}"`);

await pageSw.close();

}
