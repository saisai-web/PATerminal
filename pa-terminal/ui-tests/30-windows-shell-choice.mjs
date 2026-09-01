export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Windows の新規セッション用シェル選択
// このスイートだけはランナーの既定 OS に関係なく Windows を装う
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => { window.__mockHostOs = "windows"; });
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(600);

// Windows の + も場所フライアウトを開き、既定行を選ぶとネイティブシェルを提示する
const initialCount = await page.locator(".ws-item").count();
await page.click("#ws-new");
check("Windows + opens the location flyout without creating a session",
  await page.locator("#loc-flyout").isVisible() &&
    (await page.locator(".ws-item").count()) === initialCount);
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForSelector("#ws-new-shells button");
const choices = await page.locator("#ws-new-shells button").allTextContents();
check("Windows + default action opens the shell picker without creating a session",
  await page.locator("#ws-new-form").isVisible() &&
    (await page.locator(".ws-item").count()) === initialCount,
  `choices=${JSON.stringify(choices)}`);
check("Windows shell picker offers PowerShell and Command Prompt",
  choices.join(",") === "PowerShell,Command Prompt",
  `choices=${JSON.stringify(choices)}`);

// Command Prompt を選ぶと cmd.exe が PTY に渡る
await page.fill("#ws-new-name", "Command Prompt session");
await page.getByRole("button", { name: "Command Prompt", exact: true }).click();
await page.waitForTimeout(400);
const cmdSpawn = await page.evaluate(() => window.__ptySpawns.at(-1));
check("Command Prompt choice starts cmd.exe",
  cmdSpawn?.shell === "cmd.exe",
  `spawn=${JSON.stringify(cmdSpawn)}`);

// 次の + でも選択でき、PowerShell は Windows PowerShell を明示起動する
await page.click("#ws-new");
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.fill("#ws-new-name", "PowerShell session");
await page.getByRole("button", { name: "PowerShell", exact: true }).click();
await page.waitForTimeout(400);
const powerShellSpawn = await page.evaluate(() => window.__ptySpawns.at(-1));
check("PowerShell choice starts powershell.exe",
  powerShellSpawn?.shell === "powershell.exe",
  `spawn=${JSON.stringify(powerShellSpawn)}`);

await page.close();

}
