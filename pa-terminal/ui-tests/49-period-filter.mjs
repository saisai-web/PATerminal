export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 期間絞り込み（最後に打鍵した日が 今日 / 3日前まで / 7日前まで・状態/検索とAND・打鍵へのライブ追従）
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  const today = Date.now();
  const yesterday = today - 86_400_000;
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "today-a",
    settings: { language: "ja" },
    collapsedGroups: ["today-group"],
    groups: [{ id: "today-group", name: "Review" }],
    workspaces: [
      // Alpha は開いているだけで、まだ一度も打鍵していない
      { id: "today-a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "today-b", name: "Beta", lastInputAt: today, shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b" } },
      { id: "today-c", name: "Gamma", lastInputAt: today, group: "today-group",
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "c" } },
      // Delta は今日開いた（lastOpAt）だけで、打鍵は昨日
      { id: "today-d", name: "Delta", lastOpAt: today, lastInputAt: yesterday,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "d" } },
      // Zeta は5日前、Eta は9日前に打鍵した
      { id: "today-z", name: "Zeta", lastInputAt: today - 5 * 86_400_000,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "z" } },
      { id: "today-h", name: "Eta", lastInputAt: today - 9 * 86_400_000,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "h" } },
      { id: "today-e", name: "Epsilon", lastInputAt: yesterday, archived: true,
        shellKind: "default", broadcast: false, root: { kind: "leaf", title: "e" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(300);

const period = page.locator("#ws-period-filter");
const setPeriod = async (value) => {
  await period.selectOption(value);
  await page.waitForTimeout(30);
};
const statusButton = (filter) => page.locator(`#ws-status-filter [data-status-filter="${filter}"]`);
const visibleNames = async () =>
  (await page.locator(".ws-item:visible .ws-name").allTextContents()).sort();
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

check("period select sits in the filter row", await page.evaluate(() =>
  !!document.querySelector("#ws-status-filter select#ws-period-filter")));
check("period options are labelled in the display language",
  same(await period.locator("option").allTextContents(), ["全期間", "今日", "3日前まで", "7日前まで"]));
check("period filter defaults to any time", (await period.inputValue()) === "");
check("default view is unchanged", same(await visibleNames(), ["Alpha", "Beta", "Delta", "Eta", "Zeta"]));

await setPeriod("7");
check("7 days keeps everything typed into within a week",
  same(await visibleNames(), ["Beta", "Delta", "Gamma", "Zeta"]));
await setPeriod("3");
check("3 days drops the session typed into 5 days ago",
  same(await visibleNames(), ["Beta", "Delta", "Gamma"]));
await setPeriod("0");
check("the select is marked while filtering", (await period.getAttribute("data-active")) !== null);
check("the status tab stays on all", (await statusButton("all").getAttribute("aria-pressed")) === "true");
check("only sessions typed into today remain, including inside a collapsed group",
  same(await visibleNames(), ["Beta", "Gamma"]));
check("a group without a match today is not left empty",
  (await page.locator(".ws-group:visible").count()) === 1);

// その日最初の打鍵で、再描画を待たずに一覧へ加わる。
await page.locator(".workspace-layer:not([hidden]) .pane .xterm").first().click();
await page.keyboard.type("x");
await page.waitForTimeout(50);
check("typing into a session adds it to today's list", same(await visibleNames(), ["Alpha", "Beta", "Gamma"]));

// 状態タブ・検索とは AND。
await statusButton("running").click();
await page.waitForTimeout(30);
check("today combines with the status tab", same(await visibleNames(), ["Alpha"]));
await statusButton("all").click();
await page.locator("#ws-search").fill("gam");
await page.waitForTimeout(30);
check("today combines with text search", same(await visibleNames(), ["Gamma"]));
await page.locator("#ws-search").fill("delta");
await page.waitForTimeout(30);
check("search cannot bring back a session not typed into today", (await visibleNames()).length === 0);
await page.locator("#ws-search").fill("");

// アーカイブ画面は退避済みを全部見せる。
await statusButton("archived").click();
await page.waitForTimeout(30);
check("the archive view ignores the today filter", same(await visibleNames(), ["Epsilon"]));
await statusButton("all").click();
await page.waitForTimeout(30);
check("today is still applied after leaving the archive", same(await visibleNames(), ["Alpha", "Beta", "Gamma"]));

await setPeriod("");
check("the select is unmarked for any time", (await period.getAttribute("data-active")) === null);
check("any time restores the collapsed-group view",
  same(await visibleNames(), ["Alpha", "Beta", "Delta", "Eta", "Zeta"]));

await page.close();
}
