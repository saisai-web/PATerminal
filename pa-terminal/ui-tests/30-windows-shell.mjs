export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Windows ホストでのパス表示とシェル構文
// （既定シェルは PowerShell なので、cd も引用も POSIX とは別の形になる）
// このスイートだけは TEST_OS に関係なく windows を装う
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
// newTestPage の注入より後に足す = 後勝ちで上書きされる
await page.addInitScript(() => { window.__mockHostOs = "windows"; });
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(600);

// --- エクスプローラーはドライブルート配下を表示する ---
const expPath = await page.locator("#exp-path").textContent();
check("explorer follows the pane cwd on a drive letter",
  expPath === "C:/Users/user", `path=${expPath}`);

// パンくずでドライブルートまで戻れる（Windows は "/" より上に出さない）
await page.locator("#exp-path .exp-path-part").first().click();
await page.waitForTimeout(300);
const rootPath = await page.locator("#exp-path").textContent();
const upVisible = await page.locator(".exp-row.is-up").count();
check("drive root is the top of the tree", rootPath === "C:/" && upVisible === 0,
  `path=${rootPath} up=${upVisible}`);

// --- 「ターミナルをここへ移動」は PowerShell の構文で送る ---
await page.locator(".exp-row.is-dir", { hasText: "Users" }).click({ button: "right" });
await page.waitForTimeout(200);
const cdBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".exp-ctx-item", { hasText: "ターミナルをここへ移動" }).click();
await page.waitForTimeout(300);
const cdSent = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), cdBefore);
check("cd uses Set-Location -LiteralPath with single quotes",
  cdSent === "Set-Location -LiteralPath 'C:/Users'\r", `sent=${JSON.stringify(cdSent)}`);

// --- 画像パスの引用も PowerShell 構文（"…" だと $ が展開される） ---
const imgBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.evaluate(() => { window.__mockPickedImages = ["C:\\tmp\\$env\\a b.png"]; });
await page.click("#attach-image");
await page.waitForTimeout(300);
const imgSent = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), imgBefore);
check("image paths are single-quoted for PowerShell",
  imgSent === "'C:\\tmp\\$env\\a b.png' ", `sent=${JSON.stringify(imgSent)}`);

await page.close();

}
