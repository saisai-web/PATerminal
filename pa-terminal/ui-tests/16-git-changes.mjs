export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// Git ウィンドウの「ファイルステータス」: コミット前の変更一覧・行番号付き差分・
// ツールバーの件数バッジ・監視先（フォーカス中ペインの cwd）の追従
// ============================================================

const pageGit = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageGit.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageGit.addInitScript(() => {
  window.__mockGitChanges = {
    repo: true,
    root: "/repo",
    files: [],
  };
  window.__mockGitFileDiff = { oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" };
  window.__mockGitWorktreeDiff = {
    patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\ndiff --git a/README.md b/README.md\nnew file mode 100644\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1 @@\n+new docs\n",
    adds: 3,
    dels: 1,
    truncated: false,
  };
});
await pageGit.goto(BASE_URL);
await pageGit.waitForSelector(".pane", { timeout: 10000 });
// フォーカス中ペインの cwd（mock の OSC 7）確定 → 即ポーリング
await pageGit.locator(".pane .pane-body").first().click();
await pageGit.waitForTimeout(400);
check("a clean repository shows no change badge on the Git button",
  await pageGit.locator("#git-open-badge").isHidden());
const gridBefore = await pageGit.locator("#grid").boundingBox();
await pageGit.click("#git-open");
await pageGit.waitForSelector("#git-window-overlay:not([hidden])", { timeout: 5000 });
check("the Git window opens on File status",
  await pageGit.locator("#gw-view-status").isVisible() &&
    await pageGit.locator("#gw-nav-status").getAttribute("aria-current") === "page");
await pageGit.waitForSelector("#gw-status-files .gw-status-empty", { timeout: 5000 });
check("a clean repository says there is nothing to commit",
  ((await pageGit.locator("#gw-status-files").textContent()) ?? "").includes("コミットしていない変更はありません") &&
    await pageGit.locator(".gw-diff-placeholder-mark").isVisible());
check("commit, stash and all-changes are disabled while clean",
  await pageGit.locator("#git-commit").isDisabled() && await pageGit.locator("#git-stash").isDisabled() &&
    await pageGit.locator("#gw-view-all-diff").isDisabled() && await pageGit.locator("#commit-message").isDisabled());
check("the Git window leaves the terminal layout alone",
  JSON.stringify(gridBefore) === JSON.stringify(await pageGit.locator("#grid").boundingBox()));

await pageGit.evaluate(async () => {
  window.__mockGitChanges = {
    repo: true,
    root: "/repo",
    files: [
      { path: "src/app.ts", adds: 2, dels: 1, status: "M" },
      { path: "README.md", adds: 1, dels: 0, status: "A" },
      { path: "old/gone.ts", adds: 0, dels: 4, status: "D" },
    ],
  };
  const { updateGitWatch } = await import("/src/features/git/git-watch.ts");
  updateGitWatch();
});
await pageGit.waitForSelector("#gw-status-files .gw-file-row", { timeout: 5000 });
const rows = await pageGit.locator("#gw-status-files .gw-file-row").evaluateAll((els) => els.map((el) => ({
  path: el.dataset.path,
  status: el.querySelector(".gw-file-status")?.textContent,
  base: el.querySelector(".gw-file-base")?.textContent,
  dir: el.querySelector(".gw-file-dir")?.textContent ?? "",
  adds: el.querySelector(".agent-file-adds")?.textContent,
  dels: el.querySelector(".agent-file-dels")?.textContent,
  checked: el.querySelector("input")?.checked,
  selected: el.classList.contains("is-selected"),
})));
check("every changed file is listed with status, name, folder and counts",
  rows.length === 3 &&
    rows[0].status === "M" && rows[0].base === "app.ts" && rows[0].dir === "src" &&
    rows[0].adds === "+2" && rows[0].dels === "-1" &&
    rows[1].status === "A" && rows[2].status === "D",
  JSON.stringify(rows));
check("new changes are included in the commit by default", rows.every((r) => r.checked));
check("the first file is selected so its diff shows right away", rows[0].selected);
check("the Git button and the sidebar show the change count",
  (await pageGit.locator("#git-open-badge").textContent()) === "3" &&
    (await pageGit.locator("#gw-status-count").textContent()) === "3");
await pageGit.waitForSelector("#gw-status-diff-body .commit-diff-line", { timeout: 5000 });
const diff = await pageGit.evaluate(() => ({
  path: document.querySelector("#gw-status-diff-path")?.textContent,
  adds: document.querySelectorAll("#gw-status-diff-body .commit-diff-line.add").length,
  dels: document.querySelectorAll("#gw-status-diff-body .commit-diff-line.del").length,
  numbers: [...document.querySelectorAll("#gw-status-diff-body .commit-diff-line")].map((row) => [
    row.querySelector(".commit-line-no.old")?.textContent ?? "",
    row.querySelector(".commit-line-no.new")?.textContent ?? "",
  ]),
}));
check("the selected file's diff shows with line numbers",
  diff.path === "src/app.ts" && diff.adds === 2 && diff.dels === 1 &&
    JSON.stringify(diff.numbers) === JSON.stringify([["1", "1"], ["2", ""], ["", "2"], ["3", "3"], ["", "4"]]),
  JSON.stringify(diff));

// 別のファイルを選ぶと差分が切り替わる（キーボードでも移動できる）
await pageGit.evaluate(() => { window.__mockGitFileDiff = { oldText: "", newText: "new docs\n" }; });
await pageGit.locator("#gw-status-files .gw-file-row").nth(1).click();
await pageGit.waitForFunction(() => document.querySelector("#gw-status-diff-path")?.textContent === "README.md");
await pageGit.waitForFunction(() => document.querySelector("#gw-status-diff-body")?.textContent?.includes("new docs"));
check("choosing another file switches the diff",
  await pageGit.locator("#gw-status-files .gw-file-row").nth(1).evaluate((el) => el.classList.contains("is-selected")));
await pageGit.evaluate(() => { window.__mockGitFileDiff = { oldText: "x\n", newText: "" }; });
await pageGit.keyboard.press("ArrowDown");
await pageGit.waitForFunction(() => document.querySelector("#gw-status-diff-path")?.textContent === "old/gone.ts");
check("arrow keys move the selection through the file list",
  await pageGit.locator("#gw-status-files .gw-file-row").nth(2).evaluate((el) => el === document.activeElement));

// 外したチェックはポーリングをまたいで保たれ、新しく増えたファイルだけ既定でチェックされる
await pageGit.locator("#gw-status-files .gw-file-row").nth(1).locator("input").uncheck();
await pageGit.evaluate(async () => {
  window.__mockGitChanges = {
    ...window.__mockGitChanges,
    files: [...window.__mockGitChanges.files, { path: "src/late.ts", adds: 5, dels: 0, status: "A" }],
  };
  const { updateGitWatch } = await import("/src/features/git/git-watch.ts");
  updateGitWatch();
});
await pageGit.waitForFunction(() => document.querySelectorAll("#gw-status-files .gw-file-row").length === 4);
const checks = await pageGit.locator("#gw-status-files .gw-file-row input").evaluateAll((els) => els.map((el) => el.checked));
check("an unchecked file stays unchecked and new files join the commit",
  JSON.stringify(checks) === JSON.stringify([true, false, true, true]) &&
    ((await pageGit.locator("#commit-selection-count").textContent()) ?? "").includes("3"),
  JSON.stringify(checks));
check("the selected file stays selected across polls",
  await pageGit.locator("#gw-status-diff-path").textContent() === "old/gone.ts");

// 「すべての差分」はコミット差分と同じ一覧 UI で作業ツリー全体を開く
await pageGit.click("#gw-view-all-diff");
await pageGit.waitForSelector("#diff-overlay:not([hidden])", { timeout: 5000 });
const worktreeDiffCwd = await pageGit.evaluate(() => (window.__gitWorktreeDiffCalls ?? [])[0]);
const allChangeFiles = await pageGit.locator("#diff-body .commit-file-nav-item").count();
const allChangeTitle = (await pageGit.locator("#diff-path").textContent()) ?? "";
check("all changes open in the commit-style view over the Git window",
  worktreeDiffCwd === "/home/user" && allChangeFiles === 2 &&
    allChangeTitle.includes("未コミットの変更") &&
    await pageGit.locator("#diff-panel").evaluate((el) => el.classList.contains("is-commit")),
  `cwd=${worktreeDiffCwd} files=${allChangeFiles} title="${allChangeTitle}"`);
await pageGit.locator("#diff-body .commit-file-nav-item").nth(1).click();
const worktreeSelectedPatch = (await pageGit.locator("#diff-body .commit-patches").textContent()) ?? "";
check("worktree file navigation switches the visible patch",
  worktreeSelectedPatch.includes("new docs") && !worktreeSelectedPatch.includes("B"));
await pageGit.keyboard.press("Escape");
check("Escape closes only the diff, not the Git window",
  await pageGit.locator("#diff-overlay").isHidden() && await pageGit.locator("#git-window-overlay").isVisible());

// クリーンに戻ったら一覧・バッジが消える（ポーリング1周期 + 余裕を待つ）
await pageGit.evaluate(() => {
  window.__mockGitChanges = { repo: true, root: "/repo", files: [] };
});
await pageGit.waitForTimeout(3600);
check("the list clears when the repository becomes clean",
  (await pageGit.locator("#gw-status-files .gw-file-row").count()) === 0 &&
    await pageGit.locator("#git-open-badge").isHidden());
// シェルで cd したら監視先も追従する（pty_cwd = シェルの実 cwd を毎ポーリング解決）
await pageGit.evaluate(() => {
  window.__gitCalls = [];
  window.__mockPtyCwd = "/moved/elsewhere";
});
await pageGit.waitForTimeout(3600);
const movedCwd = await pageGit.evaluate(() => window.__gitCalls[window.__gitCalls.length - 1]);
check("git watch follows shell cd (pty_cwd)", movedCwd === "/moved/elsewhere", `cwd=${movedCwd}`);
// リポジトリ外に切り替わったら（cd 等）案内だけを出す・エラーにもならない
await pageGit.evaluate(() => {
  window.__mockGitChanges = { repo: false, root: null, files: [] };
});
await pageGit.waitForTimeout(3600);
check("outside a repository the Git window says so",
  await pageGit.locator("#gw-empty").isVisible() && await pageGit.locator("#gw-view-status").isHidden());
await pageGit.close();

// ポーリング中に監視先が変わった場合、古い cwd の応答で変更一覧を上書きせず、
// 切替時の再確認を直後に実行する。
const pageGitRace = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageGitRace.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageGitRace.goto(BASE_URL);
await pageGitRace.waitForSelector(".pane", { timeout: 10000 });
await pageGitRace.evaluate(async () => {
  const { updateGitWatch } = await import("/src/features/git/git-watch.ts");
  window.__mockGitChangesByCwd = {
    "/repo/slow": {
      repo: true,
      root: "/repo/slow",
      files: [{ path: "src/stale.ts", adds: 1, dels: 0, status: "M" }],
    },
    "/repo/current": {
      repo: true,
      root: "/repo/current",
      files: [{ path: "src/current.ts", adds: 3, dels: 1, status: "M" }],
    },
  };
  window.__mockGitChangeDelayByCwd = { "/repo/slow": 600 };
  window.__mockPtyCwd = "/repo/slow";
  updateGitWatch();
  await new Promise((resolve) => setTimeout(resolve, 50));
  window.__mockPtyCwd = "/repo/current";
  updateGitWatch();
});
let latestGitShown = true;
await pageGitRace.waitForFunction(
  () => document.querySelector("#gw-status-files")?.textContent?.includes("current.ts"),
  undefined,
  { timeout: 1800 },
).catch(() => { latestGitShown = false; });
const raceState = await pageGitRace.evaluate(() => ({
  text: document.querySelector("#gw-status-files")?.textContent ?? "",
  commitEnabled: !document.querySelector("#git-commit")?.disabled,
  calls: window.__gitCalls ?? [],
}));
check("git watch keeps the latest cwd when a poll is in flight",
  latestGitShown && raceState.text.includes("current.ts") && !raceState.text.includes("stale.ts"),
  `text="${raceState.text}" calls=${JSON.stringify(raceState.calls)}`);
check("git actions remain available after an in-flight cwd switch",
  latestGitShown && raceState.commitEnabled);
await pageGitRace.close();

}
