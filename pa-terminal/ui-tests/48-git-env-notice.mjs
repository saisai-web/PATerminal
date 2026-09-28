export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// git が環境のせいで動かない（Xcode ライセンス未同意・未導入・safe.directory など）ときの
// 復旧案内。リポジトリ外と区別して出し、コマンドはフォーカス中のターミナルへ入力だけする
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockGitChanges = { repo: false, root: null, files: [] };
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.locator(".pane .pane-body").first().click();
await page.waitForTimeout(400);

const repoll = (changes) => page.evaluate(async (next) => {
  window.__mockGitChanges = next;
  const { updateGitWatch } = await import("/src/features/git/git-watch.ts");
  updateGitWatch();
}, changes);

check("outside a repository there is no environment notice",
  await page.locator("#git-env-notice").isHidden());

const license = {
  repo: false,
  root: null,
  files: [],
  problem: { kind: "xcodeLicense", command: "sudo xcodebuild -license accept" },
};
await repoll(license);
await page.waitForSelector("#git-env-notice:not([hidden])", { timeout: 5000 });
const text = (await page.locator("#git-env-notice").textContent()) ?? "";
check("an unaccepted Xcode license explains the cause and shows the fix",
  text.includes("Xcode") &&
    (await page.locator("#git-env-notice .git-env-command").textContent()) === "sudo xcodebuild -license accept",
  text);

const writesBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.locator("#git-env-notice .git-env-actions button").first().click();
// pane.write は直列化キュー経由で pty_write に届く
await page.waitForTimeout(300);
const typed = await page.evaluate((n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""), writesBefore);
check("the fix is typed into the focused terminal without pressing Enter",
  typed === "sudo xcodebuild -license accept", JSON.stringify(typed));

await page.locator("#git-env-notice .git-env-close").click();
await repoll(license);
await page.waitForTimeout(300);
check("a dismissed notice stays closed while the same problem continues",
  await page.locator("#git-env-notice").isHidden());

await repoll({
  repo: false,
  root: null,
  files: [],
  problem: { kind: "dubiousOwnership", command: "git config --global --add safe.directory D:/work/repo" },
});
await page.waitForSelector("#git-env-notice:not([hidden])", { timeout: 5000 });
check("a different problem shows its own command",
  (await page.locator("#git-env-notice .git-env-command").textContent()) ===
    "git config --global --add safe.directory D:/work/repo");

await repoll({ repo: false, root: null, files: [], problem: { kind: "notInstalled", command: null } });
await page.waitForTimeout(300);
check("without a command the notice only explains (no empty command box or buttons)",
  await page.locator("#git-env-notice").isVisible() &&
    await page.locator("#git-env-notice .git-env-command").isHidden() &&
    await page.locator("#git-env-notice .git-env-actions").isHidden());

await repoll({ repo: true, root: "/repo", files: [] });
await page.waitForTimeout(300);
check("the notice closes by itself once git works again",
  await page.locator("#git-env-notice").isHidden());

await page.close();
}
