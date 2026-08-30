export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// git 変更の自動表示（クリーンなリポジトリでも固定表示 + diff オーバーレイ）
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
// フォーカス中ペインの cwd（mock の OSC 7）確定 → 即ポーリング。
// 変更がなくても Git 操作バーは固定表示される。
await pageGit.locator(".pane .pane-body").first().click();
let gitAutoOpen = true;
await pageGit.waitForSelector("#agent-panel:not([hidden])", { timeout: 8000 }).catch(() => { gitAutoOpen = false; });
check("git panel appears in a clean repository", gitAutoOpen);
if (gitAutoOpen) {
  check("clean repository keeps a compact change strip visible",
    await pageGit.locator("#agent-panel").evaluate((el) => el.classList.contains("is-collapsed"))
      && await pageGit.locator("#git-actions").isVisible()
      && (await pageGit.locator("#agent-empty").textContent())?.includes("ファイル変更はありません"));
  check("compact clean repository keeps every git command reachable",
    (await pageGit.locator("#git-actions button").count()) === 7);
  check("the all-changes button always uses the ChangeFile label",
    ((await pageGit.locator("#agent-title").textContent()) ?? "").trim() === "ChangeFile");
  await pageGit.evaluate(async () => {
    window.__mockGitChanges = {
      repo: true,
      root: "/repo",
      files: [
        { path: "src/app.ts", adds: 2, dels: 1, status: "M" },
        { path: "README.md", adds: 1, dels: 0, status: "A" },
      ],
    };
    const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
    updateGitWatch();
  });
  await pageGit.waitForFunction(
    () => document.querySelector("#agent-summary")?.textContent?.includes("+3"),
    undefined,
    { timeout: 5000 },
  );
  check("compact git hides individual files behind the all-changes button",
    !(await pageGit.locator("#git-changes").isVisible())
      && ((await pageGit.locator("#agent-title").textContent()) ?? "").includes("2"));
  await pageGit.locator("#agent-title").click();
  await pageGit.waitForSelector("#diff-overlay:not([hidden])", { timeout: 5000 });
  const worktreeDiffCwd = await pageGit.evaluate(() => (window.__gitWorktreeDiffCalls ?? [])[0]);
  const allChangeFiles = await pageGit.locator("#diff-body .commit-file-nav-item").count();
  const allChangeTitle = (await pageGit.locator("#diff-path").textContent()) ?? "";
  check("changes heading opens all worktree changes in commit-style view",
    worktreeDiffCwd === "/home/user" && allChangeFiles === 2 &&
      allChangeTitle.includes("未コミットの変更") &&
      await pageGit.locator("#diff-panel").evaluate((el) => el.classList.contains("is-commit")),
    `cwd=${worktreeDiffCwd} files=${allChangeFiles} title="${allChangeTitle}"`);
  await pageGit.locator("#diff-body .commit-file-nav-item").nth(1).click();
  const worktreeSelectedPath = (await pageGit.locator("#diff-body .commit-file-path").textContent()) ?? "";
  const worktreeSelectedPatch = (await pageGit.locator("#diff-body .commit-patches").textContent()) ?? "";
  check("worktree file navigation switches the visible patch",
    worktreeSelectedPath === "README.md" && worktreeSelectedPatch.includes("new docs") &&
      !worktreeSelectedPatch.includes("B"));
  await pageGit.keyboard.press("Escape");
  await pageGit.locator("#agent-collapse").click();
  await pageGit.waitForSelector("#git-changes .agent-file-row", { timeout: 5000 });
  const gitRow = (await pageGit.locator("#git-changes .agent-file-row").first().textContent()) ?? "";
  check("expanded git row shows name and counts",
    gitRow.includes("app.ts") && gitRow.includes("+2") && gitRow.includes("-1"),
    `row="${gitRow}"`);
  await pageGit.locator("#git-changes .agent-file-row").first().click();
  await pageGit.waitForSelector("#diff-overlay:not([hidden])", { timeout: 3000 });
  const gAdd = await pageGit.locator("#diff-body .diff-line.add").count();
  const gDel = await pageGit.locator("#diff-body .diff-line.del").count();
  check("git diff overlay renders old/new", gAdd === 2 && gDel === 1, `add=${gAdd} del=${gDel}`);
  await pageGit.keyboard.press("Escape");
  check("git diff overlay closes", !(await pageGit.locator("#diff-overlay").isVisible()));
  await pageGit.locator("#agent-collapse").click();
  await pageGit.waitForTimeout(120);
  // クリーンに戻ったら一覧ごと消える（ポーリング1周期 + 余裕を待つ）
  await pageGit.evaluate(() => {
    window.__mockGitChanges = { repo: true, root: "/repo", files: [] };
  });
  await pageGit.waitForTimeout(3600);
  check("git list clears when clean", !(await pageGit.locator("#git-changes").isVisible()));
  check("git panel stays visible and compact when clean",
    await pageGit.locator("#agent-panel").isVisible()
      && await pageGit.locator("#agent-panel").evaluate((el) => el.classList.contains("is-collapsed"))
      && await pageGit.locator("#git-actions").isVisible());
  // シェルで cd したら監視先も追従する（pty_cwd = シェルの実 cwd を毎ポーリング解決）
  await pageGit.evaluate(() => {
    window.__gitCalls = [];
    window.__mockPtyCwd = "/moved/elsewhere";
  });
  await pageGit.waitForTimeout(3600);
  const movedCwd = await pageGit.evaluate(() => window.__gitCalls[window.__gitCalls.length - 1]);
  check("git watch follows shell cd (pty_cwd)", movedCwd === "/moved/elsewhere", `cwd=${movedCwd}`);
  // リポジトリ外に切り替わったら（cd 等）何も出さない・エラーにもならない
  await pageGit.evaluate(() => {
    window.__mockGitChanges = { repo: false, root: null, files: [] };
  });
  await pageGit.waitForTimeout(3600);
  check("non-repo cwd hides the git panel", !(await pageGit.locator("#agent-panel").isVisible()));
}
await pageGit.close();

// ポーリング中に監視先が変わった場合、古い cwd の応答で変更一覧・Git 操作欄を
// 上書きせず、切替時の再確認を直後に実行する。
const pageGitRace = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageGitRace.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageGitRace.goto(BASE_URL);
await pageGitRace.waitForSelector(".pane", { timeout: 10000 });
await pageGitRace.evaluate(async () => {
  const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
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
  () => document.querySelector("#git-changes-list")?.textContent?.includes("current.ts"),
  undefined,
  { timeout: 1800 },
).catch(() => { latestGitShown = false; });
const raceState = await pageGitRace.evaluate(() => ({
  text: document.querySelector("#git-changes-list")?.textContent ?? "",
  actionsAvailable: !(document.querySelector("#git-actions")?.hasAttribute("hidden") ?? true),
  compact: document.querySelector("#agent-panel")?.classList.contains("is-collapsed"),
  calls: window.__gitCalls ?? [],
}));
check("git watch keeps the latest cwd when a poll is in flight",
  latestGitShown && raceState.text.includes("current.ts") && !raceState.text.includes("stale.ts"),
  `text="${raceState.text}" calls=${JSON.stringify(raceState.calls)}`);
check("git actions remain available after an in-flight cwd switch",
  latestGitShown && raceState.actionsAvailable && raceState.compact === true);
await pageGitRace.close();

}
