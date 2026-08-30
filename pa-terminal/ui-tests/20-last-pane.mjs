export default async function (ctx) {
const { browser, check, MOD, BASE_URL } = ctx;

// ============================================================
// 最後の1ペインは閉じられない
// ============================================================

const pageSolo = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageSolo.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageSolo.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 3,
    activeId: "solo",
    workspaces: [
      { id: "solo", name: "Solo", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "only" } },
    ],
  });
});
await pageSolo.goto(BASE_URL);
await pageSolo.waitForSelector(".pane", { timeout: 10000 });
await pageSolo.waitForTimeout(300);

check("single pane hides close button", !(await pageSolo.locator(".pane-close").first().isVisible()));
await pageSolo.locator(".pane .pane-body").click();
await pageSolo.keyboard.press(`${MOD}+Shift+w`);
await pageSolo.waitForTimeout(300);
const soloAfterKey = await pageSolo.locator(".pane").count();
check("Cmd/Ctrl+Shift+W cannot close last pane", soloAfterKey === 1, `panes=${soloAfterKey}`);

// 分割すると閉じるボタンが現れ、1枚に戻ると再び消える
await pageSolo.click("#split-right");
await pageSolo.waitForTimeout(300);
check("close button appears with 2 panes", await pageSolo.locator(".pane-close").first().isVisible());
await pageSolo.locator(".pane-close").last().click();
await pageSolo.waitForTimeout(300);
const soloAfterClose = await pageSolo.locator(".pane").count();
check("closing back to 1 pane works", soloAfterClose === 1, `panes=${soloAfterClose}`);
check("close button hidden again at 1 pane", !(await pageSolo.locator(".pane-close").first().isVisible()));
await pageSolo.close();

}
