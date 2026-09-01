export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// セッション状態フィルター（Whole の上・検索とのAND・activityへのライブ追従）
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "filter-a",
    settings: { language: "ja" },
    collapsedGroups: ["filter-group"],
    groups: [{ id: "filter-group", name: "Review" }],
    workspaces: [
      { id: "filter-a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "filter-b", name: "Beta", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "filter-c", name: "Gamma", group: "filter-group", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(300);

const button = (filter) => page.locator(`#ws-status-filter [data-status-filter="${filter}"]`);
const visibleNames = () => page.locator(".ws-item:visible .ws-name").allTextContents();
const setFilter = async (filter) => {
  await button(filter).click();
  await page.waitForTimeout(30);
};
const emit = (event, payload) =>
  page.evaluate(([ev, pl]) => window.__emit(ev, pl), [event, payload]);

check("status filter is placed above Whole", await page.evaluate(() => {
  const filter = document.querySelector("#ws-status-filter")?.getBoundingClientRect();
  const whole = document.querySelector(".ws-whole-group")?.getBoundingClientRect();
  return !!filter && !!whole && filter.bottom <= whole.top;
}));
check("status filter defaults to all", (await button("all").getAttribute("aria-pressed")) === "true");
check("default all keeps the existing collapsed-group view",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta"]));

// 状態フィルター中は、折りたたみ中のグループも展開して一致セッションを見せる。
await setFilter("done");
check("done filter initially shows every done session",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Beta", "Gamma"]));
check("status filtering expands a collapsed matching group",
  await page.locator('.ws-group[data-group-id="filter-group"] + .ws-group-members').isVisible());
await setFilter("all");

// Gamma を一度操作済みにし、非アクティブ化して入力待ち + 未確認にする。
await page.locator('.ws-group[data-group-id="filter-group"]').click();
await page.locator('.ws-item[data-ws-id="filter-c"] .ws-head').click();
await page.locator('.workspace-layer:not([hidden]) .pane .pane-body').first().click();
await page.keyboard.press("x");
await page.locator('.ws-item[data-ws-id="filter-a"] .ws-head').click();
const [idA, , idC] = await page.evaluate(() => window.__ptySpawns.map((spawn) => spawn.id));
await emit("pty:act", { id: idC, busy: false, busyMs: 200, waiting: true });

// Alpha は実行中、Beta は完了、Gamma は入力待ち + 未確認。
await page.locator('.workspace-layer:not([hidden]) .pane .pane-body').first().click();
await page.keyboard.press("x");
await setFilter("running");
check("running filter shows only running sessions",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha"]));

await page.locator("#ws-search").fill("beta");
check("text search combines with the status filter", (await visibleNames()).length === 0);
await page.locator("#ws-search").fill("alpha");
check("combined search keeps a matching running session",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha"]));
await page.locator("#ws-search").fill("");

await setFilter("done");
check("done filter excludes running and waiting sessions",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Beta"]));
await setFilter("waiting");
check("waiting filter shows the waiting session across groups",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Gamma"]));
await setFilter("unseen");
check("unseen filter uses attention independently of status",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Gamma"]));

// 未確認項目を開くと attention が消え、未確認フィルターから即座に外れる。
await page.locator('.ws-item[data-ws-id="filter-c"] .ws-head').click();
await page.waitForTimeout(30);
check("opening an unseen session removes it from the unseen filter", (await visibleNames()).length === 0);

// 状態の遷移でも、検索操作を挟まずにフィルター結果が更新される。
await setFilter("waiting");
check("waiting state remains after its attention is cleared",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Gamma"]));
await emit("pty:act", { id: idC, busy: true, busyMs: 0, waiting: false });
await page.waitForTimeout(30);
check("a waiting session leaves the filter when output resumes", (await visibleNames()).length === 0);
await setFilter("running");
check("running filter updates after output resumes",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Alpha", "Gamma"]));
await emit("pty:act", { id: idA, busy: false, busyMs: 100, waiting: false });
await page.waitForTimeout(30);
check("a completed session leaves the running filter live",
  JSON.stringify(await visibleNames()) === JSON.stringify(["Gamma"]));

await setFilter("all");
check("all restores every session", (await page.locator(".ws-item").count()) === 3);

await page.close();
}
