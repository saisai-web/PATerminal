export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Whole 行の「最近操作した順」トグル（配置・フラットMRU表示・一覧並べ替え防止・復帰）
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
      // Beta は昨日打鍵した（直近7日以内）、Gamma は9日前（期限切れ）
      { id: "recent-b", name: "Beta", lastOpAt: 5000, lastInputAt: Date.now() - 86_400_000,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "b" } },
      { id: "recent-c", name: "Gamma", lastOpAt: 9000, lastInputAt: Date.now() - 9 * 86_400_000,
        group: "recent-group",
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
const recentBadge = (id) => page.locator(`.ws-item[data-ws-id="${id}"] .ws-recent-input`);
const groupTag = (id) => page.locator(`.ws-item[data-ws-id="${id}"] .ws-group-tag`);
check("hierarchy view shows no per-session group tag", (await page.locator(".ws-group-tag").count()) === 0);

// 直近使用バッジ: 保存済みの lastInputAt が7日以内のセッションだけに出る。
check("a session typed into yesterday shows the recent-input badge",
  (await recentBadge("recent-b").textContent()) === "昨日");
check("a session never typed into has no badge", (await recentBadge("recent-a").count()) === 0);
// 打鍵した瞬間に、再描画なしでその項目へバッジが付く（名前の上の行、状態ラベルの手前）。
await page.locator(".pane .xterm").first().click();
await page.keyboard.type("x");
await page.waitForTimeout(50);
check("typing into the terminal adds today's badge",
  (await recentBadge("recent-a").textContent()) === "今日");
check("the badges sit on their own row above the session name", await page.evaluate(() => {
  const item = document.querySelector('.ws-item[data-ws-id="recent-a"]');
  const tags = item?.querySelector(".ws-tags");
  const name = item?.querySelector(".ws-name");
  return !!tags && !!name &&
    [...tags.children].map((el) => el.className).join(",") === "ws-recent-input,ws-status,ws-actions" &&
    tags.getBoundingClientRect().bottom <= name.getBoundingClientRect().top;
}));
check("typing is persisted as lastInputAt", await page.evaluate(async () => {
  const { workspaces } = await import("/src/workspace/state.ts");
  const at = workspaces.find((w) => w.id === "recent-a")?.lastInputAt;
  return typeof at === "number" && Date.now() - at < 5000;
}));
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
// 階層を描かない代わりに、各項目が自分の所属グループを名乗る。
check("a grouped session names its group while sorted",
  (await groupTag("recent-c").textContent()) === "Review");
check("the group tag leads the badge row", await page.evaluate(() => {
  const tags = document.querySelector('.ws-item[data-ws-id="recent-c"] .ws-tags');
  return [...(tags?.children ?? [])].map((el) => el.className).join(",") === "ws-group-tag,ws-status,ws-actions";
}));
// 操作ボタンはバッジの行に寄せ、名前の行は項目の右端まで使う。
check("action buttons share the badge row and the name spans the item", await page.evaluate(() => {
  const item = document.querySelector('.ws-item[data-ws-id="recent-c"]');
  const actions = item?.querySelector(".ws-tags .ws-actions");
  const head = item?.querySelector(".ws-head")?.getBoundingClientRect();
  const right = actions?.getBoundingClientRect().right;
  return !!actions?.querySelector(".ws-archive") && !!actions.querySelector(".ws-close") &&
    !!head && Math.abs(head.right - right) < 1;
}));
check("an ungrouped session has no group tag", (await groupTag("recent-a").count()) === 0);
check("an input older than 7 days shows no badge", (await recentBadge("recent-c").count()) === 0);
check("the badge survives the flat re-render",
  (await recentBadge("recent-a").textContent()) === "今日");
check("session drag remains available for terminal splits while sorted",
  (await page.locator('.ws-item[data-ws-id="recent-a"]').getAttribute("draggable")) === "true");
const savedOrder = () => page.evaluate(async () => {
  const { workspaces } = await import("/src/workspace/state.ts");
  return workspaces.map((w) => ({ id: w.id, group: w.group, order: w.sidebarOrder }));
});
const beforeDrag = await savedOrder();
const source = await page.locator('.ws-item[data-ws-id="recent-a"] .ws-name').boundingBox();
const target = await page.locator('.ws-item[data-ws-id="recent-c"]').boundingBox();
await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
await page.mouse.down();
await page.mouse.move(target.x + target.width / 2, target.y + target.height - 4, { steps: 10 });
await page.mouse.move(target.x + target.width / 2, target.y + target.height - 3);
await page.mouse.up();
check("sidebar drops while sorted preserve saved order and group membership",
  JSON.stringify(await savedOrder()) === JSON.stringify(beforeDrag));

// Whole 行は一覧をスクロールしても上端に残る（最近順トグルへ常に手が届く）。
await page.setViewportSize({ width: 1280, height: 330 });
check("the Whole head stays pinned while the list scrolls", await page.evaluate(() => {
  const list = document.querySelector("#ws-list");
  list.scrollTop = list.scrollHeight;
  const top = document.querySelector(".ws-whole-head").getBoundingClientRect().top;
  const pinned = list.scrollTop > 0 && Math.abs(top - list.getBoundingClientRect().top) < 1;
  list.scrollTop = 0;
  return pinned;
}));
await page.setViewportSize({ width: 1280, height: 820 });

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
check("group tags go away after turning off", (await page.locator(".ws-group-tag").count()) === 0);
check("session drag is enabled again",
  (await page.locator('.ws-item[data-ws-id="recent-a"]').getAttribute("draggable")) === "true");

await page.close();
}
