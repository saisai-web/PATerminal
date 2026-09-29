// ペイン上部のバーの Git 操作（ブランチ表示・切り替え・作成・Pull / Push / Fetch）と、
// 差分ビューのファイル一覧が長いパスを省略せずに見せること
export default async function ({ browser, check, BASE_URL }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(() => {
    window.__mockGitSummary = {
      repo: true, root: "/repo/app", branch: "main", detached: false,
      upstream: "origin/main", ahead: 1, behind: 2, fileCount: 3, adds: 5, dels: 1,
    };
    const ref = (name, extra = {}) => ({
      name, hash: "abc1234", upstream: "", ahead: 0, behind: 0, gone: false, worktree: "", ...extra,
    });
    window.__mockGitRefs = {
      head: "main",
      local: [
        ref("main", { upstream: "origin/main", ahead: 1, behind: 2, worktree: "/repo/app" }),
        ref("feature/login"),
        ref("hotfix", { worktree: "/repo/app-hotfix" }),
      ],
      remote: [ref("origin/main"), ref("origin/feature/remote-only")],
      tags: [],
    };
  });
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane .xterm-helper-textarea");
  await page.waitForSelector(".pane-git:not([hidden])", { timeout: 10000 });

  const bar = await page.evaluate(() => {
    const git = document.querySelector(".pane .pane-git");
    const head = document.querySelector(".pane .pane-bar-head");
    return {
      inHead: git.parentElement === head,
      bottomLeaf: document.querySelector(".pane-pathbar .pane-pathbar-leaf").textContent,
      bottomHasGit: !!document.querySelector(".pane-pathbar .pane-git"),
      name: git.querySelector(".pane-git-name").textContent,
      sync: git.querySelector(".pane-git-sync").textContent,
      dirty: git.querySelector(".pane-git-dirty").textContent,
      pullAttn: git.querySelector(".is-pull").classList.contains("is-attn"),
      pullCount: git.querySelector(".is-pull .pane-git-count").textContent,
      pushShown: !git.querySelector(".is-push").hidden,
    };
  });
  check("pane git: sits in the top pane bar while the bottom bar keeps the folder path",
    bar.inHead && !bar.bottomHasGit && bar.bottomLeaf === "~", JSON.stringify(bar));
  check("pane git: shows the branch, push/pull counts and changed files",
    bar.name === "main" && bar.sync === "↑1↓2" && bar.dirty === "3", JSON.stringify(bar));
  check("pane git: Pull is highlighted with the behind count and Push appears when ahead",
    bar.pullAttn && bar.pullCount === "2" && bar.pushShown, JSON.stringify(bar));

  // 下のバー: 長いパスも「…」で省略せず全文を見せる（収まらなければ折り返す）
  const longDir = "/home/user/projects/customer-portal/packages/frontend-application/src/components/very-long-directory-name";
  await page.evaluate((d) => window.__ptyPushAll(`\x1b]7;file://host${d}\x07`), longDir);
  await page.waitForFunction(() => document.querySelector(".pane-pathbar-leaf")?.textContent === "very-long-directory-name");
  const pathBox = await page.evaluate(() => {
    const text = document.querySelector(".pane-pathbar-text");
    const bar = document.querySelector(".pane-pathbar");
    const xterm = bar.parentElement.querySelector(".xterm").getBoundingClientRect();
    return {
      text: text.textContent,
      fits: text.scrollWidth <= text.clientWidth + 1,
      barH: bar.getBoundingClientRect().height,
      above: xterm.bottom <= bar.getBoundingClientRect().top + 0.5,
    };
  });
  check("path bar: a long folder path is shown in full without an ellipsis",
    pathBox.text === "~/projects/customer-portal/packages/frontend-application/src/components/very-long-directory-name" &&
      pathBox.fits && pathBox.above, JSON.stringify(pathBox));
  await page.setViewportSize({ width: 700, height: 820 });
  await page.waitForFunction(() => document.querySelector(".pane-pathbar").getBoundingClientRect().height > 30);
  check("path bar: a path wider than the pane wraps and the terminal refits above it",
    await page.evaluate(() => {
      const bar = document.querySelector(".pane-pathbar");
      const xterm = bar.parentElement.querySelector(".xterm").getBoundingClientRect();
      return xterm.bottom <= bar.getBoundingClientRect().top + 0.5;
    }));
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => window.__ptyPushAll("\x1b]7;file://host/home/user\x07"));

  // Pull はそのブランチの upstream から取り込む
  await page.locator(".pane-git .is-pull").click();
  await page.waitForFunction(() => (window.__gitPullCalls ?? []).length === 1);
  check("pull: pulls the current branch's upstream",
    JSON.stringify(await page.evaluate(() => window.__gitPullCalls[0])) ===
      JSON.stringify({ root: "/repo/app", branch: "origin/main" }));
  await page.waitForFunction(() => !document.querySelector(".pane-git.is-busy"));

  // ブランチ一覧: 現在のブランチ・他のローカル・別 worktree で使用中・ローカルに無いリモートだけ
  const openPop = async () => {
    await page.locator(".pane-git-branch").click();
    await page.waitForSelector(".pgit-pop .pgit-row");
  };
  await openPop();
  const rows = await page.$$eval(".pgit-row", (els) => els.map((el) => ({
    name: el.querySelector(".pgit-row-name").textContent,
    cls: el.className,
  })));
  check("branches: lists local branches first, then remote-only ones",
    JSON.stringify(rows.map((r) => r.name)) ===
      JSON.stringify(["main", "feature/login", "hotfix", "origin/feature/remote-only"]), JSON.stringify(rows));
  check("branches: marks the current branch and a branch used by another worktree",
    rows[0].cls.includes("is-current") && rows[2].cls.includes("is-blocked"), JSON.stringify(rows));
  check("branches: the filter has focus and the popover opens below the top bar",
    await page.evaluate(() => {
      // 開くアニメーション中の矩形ではなく、配置した上端で比べる
      const top = parseFloat(document.querySelector(".pgit-pop").style.top);
      const bar = document.querySelector(".pane .pane-bar").getBoundingClientRect();
      return document.activeElement === document.querySelector(".pgit-filter input") && top >= bar.bottom - 6;
    }));

  // aria-disabled の行は Playwright が押せる状態になるまで待つので、DOM の click を直接送る
  await page.locator(".pgit-row", { hasText: "hotfix" }).dispatchEvent("click");
  check("branches: a branch checked out in another worktree cannot be chosen",
    (await page.evaluate(() => (window.__gitSwitchBranchCalls ?? []).length)) === 0 &&
      (await page.locator(".pgit-pop").count()) === 1);

  await page.locator(".pgit-row", { hasText: "feature/login" }).click();
  await page.waitForFunction(() => (window.__gitSwitchBranchCalls ?? []).length === 1);
  check("branches: clicking a local branch switches to it and closes the list",
    (await page.evaluate(() => window.__gitSwitchBranchCalls[0].branch)) === "feature/login" &&
      (await page.locator(".pgit-pop").count()) === 0);
  await page.waitForFunction(() => !document.querySelector(".pane-git.is-busy"));

  await openPop();
  await page.keyboard.type("remote-only");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window.__gitCheckoutRemoteCalls ?? []).length === 1);
  check("branches: Enter on a filtered remote branch checks it out",
    (await page.evaluate(() => window.__gitCheckoutRemoteCalls[0].branch)) === "origin/feature/remote-only");
  await page.waitForFunction(() => !document.querySelector(".pane-git.is-busy"));

  await openPop();
  await page.keyboard.type("feature/new-idea");
  const createRows = await page.$$eval(".pgit-row", (els) => els.map((el) => el.className));
  check("branches: an unknown name offers only a create row",
    createRows.length === 1 && createRows[0].includes("is-create"), JSON.stringify(createRows));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window.__gitCreateBranchCalls ?? []).length === 1);
  check("branches: Enter creates the branch and switches to it",
    JSON.stringify(await page.evaluate(() => window.__gitCreateBranchCalls[0])) ===
      JSON.stringify({ root: "/repo/app", branch: "feature/new-idea" }));
  await page.waitForFunction(() => !document.querySelector(".pane-git.is-busy"));

  await openPop();
  await page.keyboard.type("bad name");
  check("branches: names Git would reject are not offered", (await page.locator(".pgit-row.is-create").count()) === 0);
  await page.keyboard.press("Escape");
  check("branches: Escape closes the list and returns focus to the terminal",
    (await page.locator(".pgit-pop").count()) === 0 &&
      await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")));

  // Commit は Worktree と Fetch の間。Git ウィンドウのファイルステータスを開いてメッセージ欄へ
  await page.evaluate(() => {
    window.__mockGitChanges = {
      repo: true, root: "/repo/app", files: [{ path: "src/app.ts", adds: 1, dels: 0, status: "M" }],
    };
  });
  check("commit: sits between Worktree and Fetch in the pane bar",
    (await page.locator(".pane-git .is-worktree + .is-commit + .is-fetch").count()) === 1 &&
      await page.locator(".pane-git .is-commit").isEnabled());
  await page.locator(".pane-git .is-commit").click();
  await page.waitForFunction(() => document.activeElement?.id === "commit-message", undefined, { timeout: 5000 })
    .catch(() => {});
  check("commit: opens the Git window on file status with the message focused",
    await page.locator("#git-window-overlay").isVisible() &&
      await page.locator("#gw-view-status").isVisible() &&
      await page.evaluate(() => document.activeElement?.id === "commit-message"));
  await page.locator("#gw-close").click();
  await page.evaluate(() => {
    window.__mockGitSummary = { ...window.__mockGitSummary, fileCount: 0 };
  });
  await page.waitForFunction(() => document.querySelector(".pane-git .is-commit")?.disabled === true,
    undefined, { timeout: 8000 }).catch(() => {});
  check("commit: disabled when there are no changes",
    await page.locator(".pane-git .is-commit").isDisabled());

  // リポジトリ外へ出たら Git 部分を隠す（フォルダーボタンは残る）
  await page.evaluate(() => {
    window.__mockGitSummary = { repo: false, root: null, branch: null, fileCount: 0, adds: 0, dels: 0 };
  });
  await page.waitForSelector(".pane-git[hidden]", { state: "attached", timeout: 8000 });
  check("pane git: hides outside a repository and keeps the folder path",
    await page.locator(".pane-pathbar-path").isVisible());

  // 差分ビューのファイル一覧: 最長のパスが収まるまで列を広げ、それでも長いパスは折り返して全文を見せる
  await page.evaluate(async () => {
    const { openCommitDiffOverlay } = await import("/src/features/git/diff-overlay.ts");
    const file = (path) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
    openCommitDiffOverlay("abc1234 test", {
      patch: file("src/features/agents/components/extraordinarily/long/nested/folder/structure/path-bar-git-integration.ts") +
        file("README.md"),
      adds: 2, dels: 2, truncated: false,
    });
  });
  await page.waitForSelector(".commit-file-nav-item");
  const nav = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".commit-file-nav-path")];
    const long = items[0];
    const navEl = document.querySelector(".commit-file-nav");
    const body = document.querySelector(".commit-diff");
    return {
      text: long.textContent,
      fits: long.scrollWidth <= long.clientWidth + 1,
      wraps: long.getBoundingClientRect().height > items[1].getBoundingClientRect().height,
      navW: navEl.getBoundingClientRect().width,
      bodyW: body.getBoundingClientRect().width,
    };
  });
  check("files: a long path is shown in full without an ellipsis",
    nav.text.endsWith("path-bar-git-integration.ts") && nav.fits && nav.wraps, JSON.stringify(nav));
  check("files: the file list widens for long paths, up to 45% of the view",
    nav.navW > 250 && nav.navW <= nav.bodyW * 0.45 + 1, JSON.stringify(nav));
  await page.close();
}
