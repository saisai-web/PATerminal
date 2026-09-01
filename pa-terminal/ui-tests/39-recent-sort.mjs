export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Whole 行の「最近操作した順」トグル（配置・フラットMRU表示・DnD無効・復帰）
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "recent-a",
    settings: { language: "ja" },
    collapsedGroups: ["recent-group"],
    groups: [{ id: "recent-group", name: "Review" }],
    workspaces: [
      // Alpha は保存値なし → 起動時の setActive で最新の時刻が入る
      { id: "recent-a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "recent-b", name: "Beta", lastOpAt: 5000, shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "recent-c", name: "Gamma", lastOpAt: 9000, group: "recent-group",
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "c" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(300);

const toggle = page.locator(".ws-recent-sort");
const visibleNames = () => page.locator(".ws-item:visible .ws-name").allTextContents();

// 配置: Whole 行の中で、右側コントロール群（件数・+）の一番左に置く。
check("recent-sort toggle sits in the Whole head", await page.evaluate(() => {
  return !!document.querySelector(".ws-whole-head .ws-recent-sort");
}));
check("recent-sort toggle is leftmost of the right-side controls", await page.evaluate(() => {
  const head = document.querySelector(".ws-whole-head");
  const name = head?.querySelector(".ws-whole-name")?.getBoundingClientRect();
  const sort = head?.querySelector(".ws-recent-sort")?.getBoundingClientRect();
  const count = head?.querySelector(".ws-group-count")?.getBoundingClientRect();
  const create = head?.querySelector(".ws-group-create")?.getBoundingClientRect();
  return !!name && !!sort && !!count && !!create &&
    name.right <= sort.left && sort.right <= count.left && count.right <= create.left;
}));
check("recent sort defaults to off", (await toggle.getAttribute("aria-pressed")) === "false");
check("default view keeps the collapsed-group hierarchy",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta"]));

// ON: 全セッションをフラットな新しい順で表示（起動時にアクティブ化した Alpha が先頭、
// 保存済みの lastOpAt から Gamma > Beta。折りたたみ中グループの中身も並びに出る）。
await toggle.click();
await page.waitForTimeout(30);
check("recent sort turns on", (await toggle.getAttribute("aria-pressed")) === "true");
check("sessions are flat in most-recently-operated order",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Gamma", "Beta"]));
check("group headers are hidden while sorted",
  (await page.locator(".ws-group:visible").count()) === 0);
check("session drag is disabled while sorted",
  (await page.locator('.ws-item[data-ws-id="recent-a"]').getAttribute("draggable")) === "false");

// 切替操作で順序が追従する: Beta をアクティブ化すると先頭へ。
await page.locator('.ws-item[data-ws-id="recent-b"] .ws-head').click();
await page.waitForTimeout(30);
check("activating a session moves it to the top",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Beta", "Alpha", "Gamma"]));
check("toggle stays on across re-renders", (await toggle.getAttribute("aria-pressed")) === "true");

// 検索とは AND（状態フィルターと同じ workspaceMatchesDisplay を通る）。
await page.locator("#ws-search").fill("gam");
check("search combines with the recent sort",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Gamma"]));
await page.locator("#ws-search").fill("");

// OFF: 従来の階層・並び・折りたたみ状態へ完全に戻る（保存順は一切変えていない）。
await toggle.click();
await page.waitForTimeout(30);
check("turning off restores the saved hierarchy order",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta"]));
check("group headers come back after turning off",
  (await page.locator(".ws-group:visible").count()) === 1);
check("session drag is enabled again",
  (await page.locator('.ws-item[data-ws-id="recent-a"]').getAttribute("draggable")) === "true");

await page.close();
}
