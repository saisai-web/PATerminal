export default async function (ctx) {
const { page, check, MOD } = ctx;

// --- 0. 初期状態: 1ペイン + サイドバーに1セッション ---
const paneCount = await page.locator(".pane").count();
const divCount = await page.locator(".divider").count();
check("fresh install starts with 1 pane", paneCount === 1, `panes=${paneCount}`);
check("single-pane default has no divider", divCount === 0, `dividers=${divCount}`);
check("initial single pane cannot be closed", !(await page.locator(".pane-close").isVisible()));
const wsCount0 = await page.locator(".ws-item").count();
check("sidebar shows 1 session", wsCount0 === 1, `items=${wsCount0}`);
const sidebarBox0 = await page.locator("#sidebar").boundingBox();
check("sidebar uses the wider default width", Math.abs((sidebarBox0?.width ?? 0) - 320) < 2,
  `width=${Math.round(sidebarBox0?.width ?? 0)}px`);
check("explorer panel closed by default", await page.locator("#explorer").isHidden());
check("toolbar has no explorer toggle", (await page.locator("#explorer-toggle").count()) === 0);
check("toolbar has a file-path attachment button next to the image button",
  await page.locator("#attach-file").isVisible() &&
    await page.locator("#attach-image + #attach-file").count() === 1);
check("right-side explorer opener is visible by default",
  await page.locator("#exp-reopen").isVisible() &&
    (await page.locator("#exp-reopen svg").count()) === 1);
await page.click("#exp-reopen");
await page.waitForTimeout(300);
check("right-side opener opens explorer", await page.locator("#explorer").isVisible());
// ターミナル下のフッター余白と「新規ペイン/新規セッション」バー:
// サイドバーの設定ボタン上の線と同じ高さに揃い、境界線が全幅で一直線に通る
const mainFootBox = await page.locator("#main-foot").boundingBox();
const sideFootBox = await page.locator("#sidebar-foot").boundingBox();
const expActBox = await page.locator("#exp-actions").boundingBox();
check("terminal footer aligns with sidebar foot line",
  mainFootBox && sideFootBox &&
    Math.abs(mainFootBox.y - sideFootBox.y) < 1 &&
    Math.abs(mainFootBox.height - sideFootBox.height) < 1,
  `main=${mainFootBox?.y}/${mainFootBox?.height} side=${sideFootBox?.y}/${sideFootBox?.height}`);
check("explorer actions bar aligns with foot line",
  expActBox && sideFootBox &&
    Math.abs(expActBox.y - sideFootBox.y) < 1 &&
    Math.abs(expActBox.height - sideFootBox.height) < 1,
  `actions=${expActBox?.y}/${expActBox?.height} side=${sideFootBox?.y}/${sideFootBox?.height}`);

// 以降の分割・ブロードキャスト回帰テスト用に4ペインへ増やす。
// 分割は常にレイアウト全体への追加（横 = 全高の右列 / 下 = 全幅の下段）なので、
// 横2回 + 下1回で「3列 + 全幅の下段」の4ペインになる。
for (let i = 0; i < 2; i++) {
  await page.click("#split-right");
  await page.waitForTimeout(100);
}
await page.click("#split-down");
await page.waitForTimeout(100);
check("manual splitting grows the initial session to 4 panes",
  (await page.locator(".pane").count()) === 4 && (await page.locator(".divider").count()) === 3);
// 下分割はフォーカス中ペインの下ではなく、上の全ペインを横断する全幅の下段になる
const layerBox = await page.locator(".workspace-layer").first().boundingBox();
const bottomBox = await page.locator(".pane").nth(3).boundingBox();
check("split-down spans the full layout width",
  layerBox && bottomBox && Math.abs(bottomBox.width - layerBox.width) < 4,
  `bottom=${Math.round(bottomBox?.width ?? 0)}px layer=${Math.round(layerBox?.width ?? 0)}px`);

// --- 1. キーボード入力: ペインをクリックして打鍵 → pty_write が飛ぶ ---
const firstBody = page.locator(".pane .pane-body").first();
await firstBody.click();
await page.keyboard.type("echo hi", { delay: 20 });
// pane.write は outBuf に溜めて setTimeout → writeChain で送るので、打鍵直後には
// 最後の chunk がまだ出ていない。CI の負荷が高いと最後の1文字を取りこぼす
await page.waitForFunction(
  () => window.__ptyWrites.map((w) => w.data).join("").includes("echo hi"),
  undefined,
  { timeout: 5000 },
).catch(() => {});
let writes = await page.evaluate(() => window.__ptyWrites.map((w) => w.data).join(""));
check("keyboard input reaches pty_write", writes.includes("echo hi"), `writes="${writes}"`);

// --- 2. ドラッグリサイズ: 縦ディバイダを +120px ---
const vDiv = page.locator(".divider.dir-row").first();
const db = await vDiv.boundingBox();
const paneBoxBefore = await page.locator(".pane").first().boundingBox();
await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(db.x + db.width / 2 + i * 10, db.y + db.height / 2);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(300);
const paneBoxAfter = await page.locator(".pane").first().boundingBox();
const delta = paneBoxAfter.width - paneBoxBefore.width;
check("divider drag resizes pane", delta > 80, `width delta=${Math.round(delta)}px`);

// --- 3. ドラッグ後に body.dragging が残留していない ---
const draggingStuck = await page.evaluate(() => document.body.classList.contains("dragging"));
check("no stuck body.dragging after drag", !draggingStuck);

// --- 4. ドラッグ後もクリック→キーボード入力が生きている（残留バグの回帰テスト） ---
const before = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".pane .pane-body").nth(1).click();
await page.keyboard.type("after-drag", { delay: 20 });
await page.waitForFunction(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join("").includes("after-drag"),
  before,
  { timeout: 5000 },
).catch(() => {});
const afterInfo = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""),
  before,
);
check("typing works after drag", afterInfo.includes("after-drag"),
  `new writes="${afterInfo}"`);

// --- 5. 比率クランプ: 端まで大きくドラッグ → 10%〜90% ---
const db2 = (await page.locator(".divider.dir-row").first().boundingBox());
await page.mouse.move(db2.x + 3, db2.y + db2.height / 2);
await page.mouse.down();
await page.mouse.move(5, db2.y + db2.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
// 比率はディバイダを共有する兄弟間のもの。左端のディバイダはペイン1|2の間なので、
// クランプの分母は2ペイン分の行グループ幅（グリッド全幅ではない）
const minBox = await page.locator(".pane").nth(0).boundingBox();
const sibBox = await page.locator(".pane").nth(1).boundingBox();
const groupW = sibBox.x + sibBox.width - minBox.x;
check("ratio clamped at 10%", minBox.width / groupW > 0.08 && minBox.width / groupW < 0.15,
  `left pane ${Math.round((minBox.width / groupW) * 100)}% of its group`);

// --- 6. ドラッグ確定でセッション保存が走る（v5 形式） ---
await page.waitForTimeout(1200);
const savedAfter = await page.evaluate(() => window.__savedSession);
check("session auto-saved after drag (v5)",
  typeof savedAfter === "string" && savedAfter.includes('"version": 5') && savedAfter.includes('"workspaces"'));

// --- 7. ブロードキャスト: ONにして打鍵 → アクティブセッションの全ペインへ ---
// ボタンは送信先モーダルを開く。送信先を足さずに開始すればセッション内で閉じる
await page.click("#broadcast");
await page.waitForSelector("#broadcast-overlay:not([hidden])", { timeout: 3000 });
await page.click("#broadcast-start");
await page.waitForTimeout(100);
await page.locator(".pane .pane-body").first().click();
const wBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("x");
await page.waitForTimeout(100);
const bWrites = await page.evaluate((n) => window.__ptyWrites.slice(n), wBefore);
const uniqueIds = new Set(bWrites.filter((w) => w.data === "x").map((w) => w.id));
check("broadcast sends key to all panes", uniqueIds.size === 4, `panes hit=${uniqueIds.size}`);
await page.click("#broadcast"); // off に戻す

// --- 8. ⌘⇧D で分割（キーボードショートカット） ---
await page.locator(".pane .pane-body").first().click();
const pBefore = await page.locator(".pane").count();
await page.keyboard.press(`${MOD}+Shift+KeyD`);
await page.waitForTimeout(400);
const pAfter = await page.locator(".pane").count();
check("Cmd+Shift+D splits pane", pAfter === pBefore + 1, `panes ${pBefore}→${pAfter}`);

ctx.pAfter = pAfter;
}
