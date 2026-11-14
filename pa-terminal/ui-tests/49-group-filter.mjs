export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Whole 行のグループ名チップ（グループでの絞り込み・複数選択・他の絞り込みとのAND）
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "gf-a",
    settings: { language: "ja" },
    collapsedGroups: ["gf-review"],
    groups: [
      { id: "gf-review", name: "Review" },
      { id: "gf-build", name: "Build" },
      { id: "gf-nested", name: "Nested", parentId: "gf-build" },
      { id: "gf-empty", name: "Empty" },
    ],
    workspaces: [
      { id: "gf-a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "gf-b", name: "Beta", group: "gf-review", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "gf-c", name: "Gamma", group: "gf-build", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c" } },
      { id: "gf-d", name: "Delta", group: "gf-nested", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "d" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(300);

const chip = (id) => page.locator(`.ws-group-filter-chip[data-group-filter="${id}"]`);
const visibleNames = async () =>
  JSON.stringify(await page.locator(".ws-item:visible .ws-name").allTextContents());
const visibleGroups = async () =>
  JSON.stringify(await page.locator(".ws-group:visible .ws-group-name").allTextContents());
const names = (...list) => JSON.stringify(list);
const toggle = async (id) => {
  await chip(id).click();
  await page.waitForTimeout(30);
};

const panelToggle = page.locator(".ws-group-filter-toggle");
check("group filter starts collapsed behind a toggle right of the Whole name",
  (await page.locator(".ws-group-filter").count()) === 0 &&
    (await panelToggle.getAttribute("aria-expanded")) === "false" &&
    (await panelToggle.getAttribute("data-active")) === "false" &&
    await page.evaluate(() => {
      const head = document.querySelector(".ws-whole-head");
      const name = head?.querySelector(".ws-whole-name")?.getBoundingClientRect();
      const tog = head?.querySelector(".ws-group-filter-toggle")?.getBoundingClientRect();
      const recent = head?.querySelector(".ws-recent-sort")?.getBoundingClientRect();
      return !!name && !!tog && !!recent && name.right <= tog.left && tog.right <= recent.left;
    }));
await panelToggle.click();
check("group chips list the top-level groups only, in sidebar order",
  JSON.stringify(await page.locator(".ws-group-filter-chip").allTextContents()) ===
    names("Review", "Build", "Empty"));
check("opened chips sit below the Whole row, above the session list",
  (await panelToggle.getAttribute("aria-expanded")) === "true" &&
    await page.evaluate(() => {
      const name = document.querySelector(".ws-whole-name")?.getBoundingClientRect();
      const panel = document.querySelector(".ws-whole-head .ws-group-filter")?.getBoundingClientRect();
      const members = document.querySelector(".ws-whole-members")?.getBoundingClientRect();
      return !!name && !!panel && !!members && name.bottom <= panel.top && panel.bottom <= members.top;
    }));
check("no group is selected by default",
  (await page.locator('.ws-group-filter-chip[aria-pressed="true"]').count()) === 0 &&
    (await visibleNames()) === names("Alpha", "Gamma", "Delta"));

await toggle("gf-review");
check("selecting a group shows only its sessions and opens it",
  (await chip("gf-review").getAttribute("aria-pressed")) === "true" &&
    (await visibleNames()) === names("Beta") && (await visibleGroups()) === names("Review"));

await toggle("gf-build");
check("several groups can be selected, including nested sessions",
  (await visibleNames()) === names("Beta", "Gamma", "Delta") &&
    (await visibleGroups()) === names("Review", "Build", "Nested"));

await page.locator("#ws-search").fill("delta");
check("text search combines with the group filter", (await visibleNames()) === names("Delta"));
await page.locator("#ws-search").fill("alpha");
check("search cannot bring back a session outside the selected groups",
  (await visibleNames()) === names());
await page.locator("#ws-search").fill("");

await page.locator(".ws-recent-sort").click();
check("recent-sort view keeps the group filter",
  JSON.stringify((await page.locator(".ws-item:visible .ws-name").allTextContents()).sort()) ===
    names("Beta", "Delta", "Gamma"));
await page.locator(".ws-recent-sort").click();

// 欄を閉じても絞り込みは続き、トグルが選択数で絞り込み中と示す。
await panelToggle.click();
check("collapsing the chips keeps the filter and shows the selected count",
  (await page.locator(".ws-group-filter").count()) === 0 &&
    (await panelToggle.getAttribute("data-active")) === "true" &&
    (await page.locator(".ws-group-filter-count").textContent()) === "2" &&
    (await visibleNames()) === names("Beta", "Gamma", "Delta"));
await panelToggle.click();

await toggle("gf-review");
check("deselecting one group keeps the other",
  (await chip("gf-review").getAttribute("aria-pressed")) === "false" &&
    (await visibleNames()) === names("Gamma", "Delta"));

// 絞り込み中も見出しクリックでの開閉は効き、再描画（セッション切替）でも戻らない。
await page.locator('.ws-group[data-group-id="gf-nested"]').click();
await page.locator('.ws-item[data-ws-id="gf-c"] .ws-head').click();
await page.waitForTimeout(50);
check("a group collapsed while filtering stays collapsed", (await visibleNames()) === names("Gamma"));
await page.locator('.ws-group[data-group-id="gf-nested"]').click();

await toggle("gf-build");
await toggle("gf-empty");
check("a selected empty group still shows its header",
  (await visibleNames()) === names() && (await visibleGroups()) === names("Empty"));
await toggle("gf-empty");
check("clearing every chip restores the full list",
  (await visibleNames()) === names("Alpha", "Beta", "Gamma", "Delta"));

// 選択中のグループを解散したら、絞り込みも一緒に外れる（何も出ない一覧にしない）。
await toggle("gf-review");
await page.evaluate(async () => {
  const state = await import("/src/workspace/state.ts");
  const { renderSidebar } = await import("/src/features/sidebar/sidebar.ts");
  for (const w of state.workspaces) if (w.group === "gf-review") w.group = undefined;
  state.groups.splice(state.groups.findIndex((g) => g.id === "gf-review"), 1);
  renderSidebar();
});
check("removing a selected group drops it from the filter",
  (await chip("gf-review").count()) === 0 &&
    (await visibleNames()) === names("Alpha", "Beta", "Gamma", "Delta"));

await page.close();
}
