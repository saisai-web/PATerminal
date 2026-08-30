export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// ソフトロック（Locked 状態）
// - 3枚以上の保存済みセッションはそのまま復元される（作業を破壊しない）
// - 2枚→3枚目の分割・ブロードキャスト・定型文・履歴・ペア等の入口が止まり、
//   触れた瞬間に購入案内モーダルが出る
// - ロック対象の入口に .is-locked（🔒）が付き、変更ストリップと定型文バーは隠れる
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockLicense = {
    official: true,
    state: "locked",
    locked: true,
    daysLeft: null,
    supporter: false,
    keyMasked: null,
    keyKind: null,
    retrialAvailable: false,
    banner: null,
    guidePending: false,
    checkoutUrl: "https://example.com/checkout",
  };
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "a",
    groups: [],
    workspaces: [
      // 3ペイン: Locked でも復元は無傷であることの検証用
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "a1" },
          b: { kind: "split", dir: "col", ratio: 0.5,
            a: { kind: "leaf", title: "a2" }, b: { kind: "leaf", title: "a3" } } } },
      // 2ペイン: 3枚目の分割がブロックされることの検証用
      { id: "b", name: "Bravo", shellKind: "default", broadcast: false,
        root: { kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "b1" }, b: { kind: "leaf", title: "b2" } } },
      // 1ペイン: 2枚目までは無料で分割できることの検証用
      { id: "c", name: "Charlie", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c1" } },
    ],
    deletedWorkspaces: [
      { id: "old", name: "Old", shellKind: "default", broadcast: false,
        deletedAt: 1700000000000, originalIndex: 0,
        root: { kind: "leaf", title: "o1" } },
    ],
    settings: { quickPhrases: [{ text: "hello quick" }] },
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForTimeout(600);

const paneCount = () =>
  page.locator(".workspace-layer:not([hidden]) .pane").count();
const overlayVisible = () => page.locator("#license-overlay").isVisible();
const closeOverlay = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
};

// --- 3ペインの保存済みセッションはそのまま復元される ---
check("3-pane session is restored intact while locked", (await paneCount()) === 3,
  `panes=${await paneCount()}`);

// --- 🔒 マーク ---
for (const sel of ["#broadcast", "#pair-open", "#quick-phrases-open", "#takeover-open",
  "#auto-enter-toggle"]) {
  check(`${sel} shows the lock mark`,
    await page.locator(`${sel}.is-locked`).count() === 1);
}
// アクティブセッションは3ペイン（上限超え）なので分割ボタンにも 🔒
check("split buttons show the lock mark at the pane limit",
  (await page.locator("#split-right.is-locked").count()) === 1);

// --- 3枚目の分割はブロックされ、購入案内が出る ---
await page.click('.ws-item[data-ws-id="b"] .ws-head');
await page.waitForTimeout(300);
check("2-pane session starts with 2 panes", (await paneCount()) === 2);
await page.click("#split-right");
await page.waitForTimeout(200);
check("third split opens the purchase modal", await overlayVisible());
check("third split is blocked", (await paneCount()) === 2);
await closeOverlay();
check("Escape closes the purchase modal", await page.locator("#license-overlay").isHidden());

// --- 2枚目までの分割は無料のまま ---
await page.click('.ws-item[data-ws-id="c"] .ws-head');
await page.waitForTimeout(300);
check("1-pane session has no lock mark on split buttons",
  (await page.locator("#split-right.is-locked").count()) === 0);
await page.click("#split-right");
await page.waitForTimeout(400);
check("second split still works while locked", (await paneCount()) === 2);
check("second split does not open the purchase modal",
  await page.locator("#license-overlay").isHidden());

// --- ロック対象の入口は購入案内を出す ---
await page.click("#broadcast");
await page.waitForTimeout(200);
check("broadcast opens the purchase modal instead of the target dialog",
  (await overlayVisible()) && (await page.locator("#broadcast-overlay").isHidden()));
await closeOverlay();

await page.click("#takeover-open");
await page.waitForTimeout(200);
check("takeover opens the purchase modal", await overlayVisible());
check("history dialog stays closed", await page.locator("#history-overlay").isHidden());
await closeOverlay();

await page.click("#pair-open");
await page.waitForTimeout(200);
check("pair mode opens the purchase modal", await overlayVisible());
check("pair overlay stays closed", await page.locator("#pair-overlay").isHidden());
await closeOverlay();

await page.click("#quick-phrases-open");
await page.waitForTimeout(200);
check("quick phrases open the purchase modal", await overlayVisible());
await closeOverlay();

// --- 定型文バーと変更ストリップは表示ごと止まる ---
check("quick phrase bar is hidden while locked",
  await page.locator("#quick-phrase-bar").isHidden());
check("change strip is hidden while locked",
  await page.locator("#agent-panel").isHidden());

// --- ゴミ箱: モーダルは開けるが復元だけロック ---
await page.click("#session-trash-open");
await page.waitForSelector("#history-overlay:not([hidden])", { timeout: 3000 });
check("trash entry selects the recently-deleted tab while locked",
  (await page.locator("#history-tab-trash").getAttribute("aria-selected")) === "true");
await page.click("#history-tab-takeover");
await page.waitForTimeout(200);
check("locked conversation tab opens the purchase modal and keeps trash selected",
  await overlayVisible() &&
    (await page.locator("#history-tab-trash").getAttribute("aria-selected")) === "true");
await closeOverlay();
check("trash restore button shows the lock mark",
  (await page.locator(".session-trash-restore.is-locked").count()) === 1);
await page.click(".session-trash-restore");
await page.waitForTimeout(200);
check("trash restore opens the purchase modal", await overlayVisible());
check("locked restore does not bring the session back",
  (await page.locator('.ws-item').count()) === 3);
await closeOverlay();
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// --- 購入ボタンはチェックアウト URL を開く ---
await page.click("#broadcast");
await page.waitForTimeout(200);
await page.click("#license-buy");
await page.waitForTimeout(150);
const opened = await page.evaluate(() => window.__openedUrls ?? []);
check("buy button opens the checkout url",
  opened.includes("https://example.com/checkout"), JSON.stringify(opened));
await closeOverlay();

await page.close();
}
