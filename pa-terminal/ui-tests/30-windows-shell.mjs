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
// --- パスバーはドライブ配下のパスを表示し、フォルダーブラウザーはドライブルートまで上がれる
// （Windows は "/" より上に出さない）
await page.click(".workspace-layer:not([hidden]) .pane-pathbar-path");
await page.waitForSelector(".pathbar-pop .pathbar-row");
const upBtn = page.locator(".pathbar-pop-head .pathbar-icon-btn").first();
await upBtn.click();
await upBtn.click();
await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "C:/");
check("drive root is the top of the folder browser", await upBtn.isDisabled());

// --- 「ここへ移動」は PowerShell の構文で送る ---
await page.locator(".pathbar-row", { hasText: "Users" }).click();
await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "Users");
const cdBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".pathbar-action.is-primary").click();
await page.waitForTimeout(300);
const cdSent = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), cdBefore);
check("cd uses Set-Location -LiteralPath with single quotes",
  cdSent === "Set-Location -LiteralPath 'C:/Users'\r", `sent=${JSON.stringify(cdSent)}`);

await page.close();

}
