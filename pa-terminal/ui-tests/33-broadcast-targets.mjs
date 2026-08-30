export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 一斉入力の送信先モーダル
// ボタン → モーダルでセッションを選ぶ → 選んだ全セッションの全ペインへ届く。
// 送信先はランタイム専用（session.json に保存しない）で、一斉入力を切ると忘れる。
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "a",
    groups: [{ id: "g", name: "Grp" }],
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "a1" }, b: { kind: "leaf", title: "a2" } } },
      { id: "b", name: "Bravo", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b1" } },
      { id: "c", name: "Charlie", group: "g", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c1" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await page.waitForTimeout(500);

const openDialog = async () => {
  await page.click("#broadcast");
  await page.waitForSelector("#broadcast-overlay:not([hidden])", { timeout: 3000 });
};
const rowCheck = (name) =>
  page.locator(".bc-row", { hasText: name }).locator("input.bc-check");
const typeInTerminal = async (key) => {
  await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
  const before = await page.evaluate(() => window.__ptyWrites.length);
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
  const writes = await page.evaluate((n) => window.__ptyWrites.slice(n), before);
  return new Set(writes.filter((w) => w.data === key).map((w) => w.id));
};

// --- モーダルの中身 ---
await openDialog();
check("broadcast button opens the target dialog",
  await page.locator("#broadcast-overlay").isVisible());
check("dialog lists every session", (await page.locator(".bc-row").count()) === 3,
  `rows=${await page.locator(".bc-row").count()}`);
check("current session is always a target and cannot be unchecked",
  (await rowCheck("Alpha").isChecked()) && (await rowCheck("Alpha").isDisabled()));
check("grouped session shows its group path",
  (await page.locator(".bc-row", { hasText: "Charlie" }).textContent()).includes("Grp"));
check("rows show the pane count",
  (await page.locator(".bc-row", { hasText: "Alpha" }).textContent()).includes("2"));

// --- Escape ではライブ状態を変えない（ドラフト方式） ---
await rowCheck("Bravo").check();
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Escape closes the dialog without starting",
  (await page.locator("#broadcast-overlay").isHidden()) &&
    !(await page.evaluate(() => document.body.classList.contains("broadcasting"))));

// --- 送信先を選んで開始 → 裏セッションのペインにも届く ---
await openDialog();
check("dialog reopens with an empty target list", !(await rowCheck("Bravo").isChecked()));
await rowCheck("Bravo").check();
await page.click("#broadcast-start");
await page.waitForTimeout(300);
check("broadcasting is on after starting",
  await page.evaluate(() => document.body.classList.contains("broadcasting")));
check("target session is marked in the sidebar",
  (await page.locator('.ws-item[data-ws-id="b"].is-bc-target').count()) === 1 &&
    (await page.locator('.ws-item[data-ws-id="c"].is-bc-target').count()) === 0);

const hit = await typeInTerminal("x");
check("keystroke reaches both sessions (3 panes) including the hidden one",
  hit.size === 3, `panes hit=${hit.size}`);

// --- 送信先は session.json に保存しない ---
await page.waitForTimeout(1200);
const saved = await page.evaluate(() => window.__savedSession);
check("targets are not persisted to session.json",
  typeof saved === "string" && !saved.includes("broadcastTargets"),
  `saved has broadcastTargets=${typeof saved === "string" && saved.includes("broadcastTargets")}`);

// --- 送信先セッションを閉じても壊れない（書き込み時に生存ペインだけ集める） ---
const bravo = page.locator('.ws-item[data-ws-id="b"]');
await bravo.hover();
await bravo.locator(".ws-close").click();
await page.waitForTimeout(400);
const afterClose = await typeInTerminal("y");
check("closed target drops out of the broadcast", afterClose.size === 2,
  `panes hit=${afterClose.size}`);

// --- ON 中のボタンは即停止（モーダルを開かない） ---
await page.click("#broadcast");
await page.waitForTimeout(300);
check("clicking while on stops immediately",
  (await page.locator("#broadcast-overlay").isHidden()) &&
    !(await page.evaluate(() => document.body.classList.contains("broadcasting"))));
check("target marks are cleared when broadcasting stops",
  (await page.locator(".ws-item.is-bc-target").count()) === 0);

// --- 停止したら送信先も忘れる（次に開いたときは空） ---
await openDialog();
check("targets are forgotten after stopping",
  (await page.locator("input.bc-check:checked:not([disabled])").count()) === 0);

// --- すべて選択 ---
await page.locator("#broadcast-select-all").check();
await page.waitForTimeout(100);
check("select-all checks every other session",
  (await page.locator("input.bc-check:checked:not([disabled])").count()) === 1);
await page.click("#broadcast-cancel");
await page.waitForTimeout(200);
check("cancel leaves broadcasting off",
  !(await page.evaluate(() => document.body.classList.contains("broadcasting"))));

await page.close();

}
