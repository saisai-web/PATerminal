export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// エクスプローラー下部の git セクション（コミット履歴 + PR conversation）
// ============================================================

const pageLog = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageLog.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageLog.context().grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: new URL(BASE_URL).origin,
});
await pageLog.addInitScript(() => {
  window.__mockGitLog = {
    repo: true,
    root: "/repo",
    branch: "feat/x",
    detached: false,
    commits: [
      { hash: "abc1234", time: Math.floor(Date.now() / 1000) - 3600, author: "alice",
        refs: "HEAD -> feat/x, origin/feat/x", subject: "add thing" },
      { hash: "def5678", time: Math.floor(Date.now() / 1000) - 86400, author: "bob",
        refs: "", subject: "initial commit" },
    ],
  };
  window.__mockGitCommitDiff = {
    patch: "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context\ndiff --git a/README.md b/README.md\nindex 3333333..4444444 100644\n--- a/README.md\n+++ b/README.md\n@@ -10 +10 @@\n-old docs\n+new docs\n",
    adds: 3,
    dels: 2,
    truncated: false,
  };
  window.__mockPrInfo = {
    found: true,
    number: 12,
    title: "Add thing",
    state: "OPEN",
    url: "https://github.com/o/r/pull/12",
    author: "alice",
    body: "This PR adds the thing.",
    additions: 42,
    deletions: 11,
    changedFiles: 3,
    files: [
      { path: "src/app.ts", previousPath: null, status: "modified", additions: 20, deletions: 6 },
      { path: "src/new-panel.ts", previousPath: "src/old-panel.ts", status: "renamed", additions: 18, deletions: 5 },
      { path: "README.md", previousPath: null, status: "added", additions: 4, deletions: 0 },
    ],
    comments: [
      { author: "bob", body: "LGTM but rename foo", createdAt: "2026-08-01T00:00:00Z",
        kind: "review", state: "CHANGES_REQUESTED" },
      { author: "alice", body: "renamed in abc1234", createdAt: "2026-08-02T00:00:00Z",
        kind: "comment", state: null },
      { author: "carol", body: "Please keep this exact wording.", createdAt: "2026-08-03T00:00:00Z",
        kind: "inline", state: null, path: "src/app.ts", line: 42,
        code: "const exactWording = preserve(input);" },
    ],
  };
  window.__mockPrList = {
    available: true,
    prs: [
      { number: 12, title: "Add thing", state: "OPEN", url: "https://github.com/o/r/pull/12",
        author: "a-very-long-github-author-name", headRefName: "feat/x", baseRefName: "main", isDraft: false,
        updatedAt: "2026-08-03T00:00:00Z" },
      { number: 9, title: "Earlier change", state: "OPEN", url: "https://github.com/o/r/pull/9",
        author: "bob", headRefName: "fix/very-long-branch-name-for-the-list", baseRefName: "main",
        isDraft: false, updatedAt: "2026-07-20T00:00:00Z" },
      { number: 5, title: "Abandoned change", state: "CLOSED", url: "https://github.com/o/r/pull/5",
        author: "carol", headRefName: "fix/abandoned", baseRefName: "main",
        isDraft: false, updatedAt: "2026-07-01T00:00:00Z" },
      { number: 3, title: "Shipped change", state: "MERGED", url: "https://github.com/o/r/pull/3",
        author: "dave", headRefName: "feat/shipped", baseRefName: "main",
        isDraft: false, updatedAt: "2026-06-20T00:00:00Z" },
    ],
  };
  window.__mockPrDiff = {
    patch: "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context\ndiff --git a/README.md b/README.md\nindex 3333333..4444444 100644\n--- a/README.md\n+++ b/README.md\n@@ -10 +10 @@\n-old docs\n+new docs\n",
    adds: 3,
    dels: 2,
    truncated: false,
  };
  window.__mockIssueList = {
    available: true,
    issues: [
      { number: 42, title: "Fix quoted startup", state: "OPEN",
        url: "https://github.com/o/r/issues/42", author: "dora",
        assignees: ["alice", "bob"],
        labels: ["bug", "terminal"], updatedAt: "2026-08-04T00:00:00Z" },
      { number: 8, title: "Unassigned issue", state: "OPEN",
        url: "https://github.com/o/r/issues/8", author: "eve",
        assignees: [],
        labels: [], updatedAt: "2026-07-10T00:00:00Z" },
      { number: 7, title: "Closed issue", state: "CLOSED",
        url: "https://github.com/o/r/issues/7", author: "eve",
        assignees: [],
        labels: [], updatedAt: "2026-07-01T00:00:00Z" },
    ],
  };
  window.__mockIssueInfo = {
    found: true,
    number: 42,
    title: "Fix quoted startup",
    state: "OPEN",
    url: "https://github.com/o/r/issues/42",
    author: "dora",
    body: "Handle a 'quoted' value and do not execute $(touch /tmp/bad).\nKeep the newline.",
    labels: ["bug", "terminal"],
    comments: [
      { author: "eve", body: "Also cover the Codex path in tests.", createdAt: "2026-08-04T12:00:00Z" },
      { author: "frank", body: "Use the whole issue, please.", createdAt: "2026-08-05T01:00:00Z" },
    ],
  };
  window.__mockWorktreeBranches = {
    branches: [
      { name: "feat/x", reference: "refs/heads/feat/x", current: true },
      { name: "origin/main", reference: "refs/remotes/origin/main", current: false },
    ],
  };
  window.__mockWorktreeResult = { path: "/repo/.worktree/issue-42-custom", branch: "issue/42-custom" };
  window.__mockWorktreeList = {
    entries: [
      {
        path: "/repo", branch: "main", head: "abc1234",
        isMain: true, isCurrent: true, detached: false, bare: false,
        locked: false, lockReason: "", missing: false,
      },
      {
        path: "/repo/.worktree/feature-old", branch: "feature/old", head: "def5678",
        isMain: false, isCurrent: false, detached: false, bare: false,
        locked: false, lockReason: "", missing: false,
      },
    ],
  };
});
await pageLog.goto(BASE_URL);
await pageLog.waitForSelector(".pane", { timeout: 10000 });
await pageLog.locator(".pane .pane-body").first().click();
let logShown = true;
await pageLog.waitForSelector("#exp-git:not([hidden])", { timeout: 8000 }).catch(() => { logShown = false; });
check("explorer git section appears in a repo", logShown);
if (logShown) {
  // タブ見出しは固定ラベル。ブランチ名は title だけに載せる（長い名前でタブ列を押し広げない）
  const branchText = ((await pageLog.locator("#exp-git-branch").textContent()) ?? "").trim();
  const branchTitle = (await pageLog.locator("#exp-git-branch").getAttribute("title")) ?? "";
  check("Branch tab keeps a fixed label and puts the branch name in the tooltip",
    branchText === "Branch" && !branchText.includes("feat/x") && branchTitle === "feat/x",
    `label="${branchText}" title="${branchTitle}"`);
  const rowCount = await pageLog.locator("#exp-git-log .git-commit-row").count();
  const firstRow = (await pageLog.locator("#exp-git-log .git-commit-row").first().textContent()) ?? "";
  check("commit rows render hash, subject, author",
    rowCount === 2 && firstRow.includes("abc1234") && firstRow.includes("add thing") && firstRow.includes("alice"),
    `rows=${rowCount} first="${firstRow}"`);
  const refsText = (await pageLog.locator("#exp-git-log .git-commit-refs").first().textContent()) ?? "";
  check("commit decorations shown", refsText.includes("origin/feat/x"), `refs="${refsText}"`);
  // Issue タブ → 一覧 → 本文・全コメント
  await pageLog.locator("#exp-git-issues-tab").click();
  await pageLog.waitForSelector("#exp-git-issues .issue-row", { timeout: 3000 });
  const issueListCall = await pageLog.evaluate(() => (window.__issueListCalls ?? [])[0]);
  const issueRows = await pageLog.locator("#exp-git-issues .issue-row").count();
  const issueListText = (await pageLog.locator("#exp-git-issues").textContent()) ?? "";
  check("Issue tab lists repository issues",
    issueListCall === "/repo" && issueRows === 2 && issueListText.includes("Fix quoted startup") &&
      issueListText.includes("bug"),
    `root=${issueListCall} rows=${issueRows}`);
  check("closed issues are left out of the Issue tab",
    !issueListText.includes("Closed issue"), `list="${issueListText}"`);
  const issueAssignees = await pageLog.locator("#exp-git-issues .issue-assignee").allTextContents();
  const issueLabels = await pageLog.locator("#exp-git-issues .issue-label").allTextContents();
  const unassignedCount = await pageLog.locator("#exp-git-issues .issue-assignee.is-unassigned").count();
  check("Issue rows show assignees, unassigned status and labels",
    issueAssignees.includes("@alice") && issueAssignees.includes("@bob") &&
      unassignedCount === 1 &&
      issueLabels.includes("bug") && issueLabels.includes("terminal"),
    `assignees=${JSON.stringify(issueAssignees)} unassigned=${unassignedCount} labels=${JSON.stringify(issueLabels)}`);
  check("PR badge is hidden while Issue tab is active", !(await pageLog.locator("#exp-git-pr").isVisible()));
  await pageLog.locator("#exp-git-issues .issue-row").first().click();
  await pageLog.waitForSelector("#issue-overlay:not([hidden]) .issue-body", { timeout: 3000 });
  const issueInfoCall = await pageLog.evaluate(() => (window.__issueInfoCalls ?? [])[0]);
  const issueDetailText = (await pageLog.locator("#issue-overlay").textContent()) ?? "";
  check("Issue detail opens in a modal while the list stays intact",
    await pageLog.locator("#issue-panel[role=dialog][aria-modal=true]").isVisible() &&
      await pageLog.locator("#exp-git-issues .issue-row").count() === 2);
  check("Issue detail shows body, labels and every comment",
    issueInfoCall?.root === "/repo" && issueInfoCall?.number === 42 &&
      issueDetailText.includes("Handle a 'quoted' value") &&
      issueDetailText.includes("Also cover the Codex path in tests.") &&
      issueDetailText.includes("Use the whole issue, please."),
    `call=${JSON.stringify(issueInfoCall)}`);
  await pageLog.keyboard.press("Escape");
  check("Escape closes the Issue detail modal", !(await pageLog.locator("#issue-overlay").isVisible()));
  await pageLog.locator("#exp-git-issues .issue-row").first().focus();
  await pageLog.keyboard.press("Enter");
  await pageLog.waitForSelector("#issue-overlay:not([hidden]) .issue-body", { timeout: 3000 });
  check("keyboard activation reopens the Issue detail modal", await pageLog.locator("#issue-panel").isVisible());
  // 既存ローカルブランチを Issue の linked branch にして同名リモートへ Push
  const linkBranchOptions = await pageLog.locator(".issue-link-row select option").allTextContents();
  const selectedLinkBranch = await pageLog.locator(".issue-link-row select").inputValue();
  check("Issue link action lists only local branches and selects the current branch",
    JSON.stringify(linkBranchOptions) === JSON.stringify(["feat/x"]) && selectedLinkBranch === "feat/x",
    `options=${JSON.stringify(linkBranchOptions)} selected=${selectedLinkBranch}`);
  await pageLog.locator(".issue-link-action").click();
  await pageLog.waitForFunction(() => (window.__issueLinkBranchCalls ?? []).length > 0);
  const linkBranchCall = await pageLog.evaluate(() => window.__issueLinkBranchCalls.at(-1));
  const linkBranchMessage = (await pageLog.locator(".issue-link-message").textContent()) ?? "";
  check("Issue link action sends the selected branch and reports the push target",
    linkBranchCall?.root === "/repo" && linkBranchCall?.number === 42 && linkBranchCall?.branch === "feat/x" &&
      linkBranchMessage.includes("feat/x") && linkBranchMessage.includes("origin"),
    `call=${JSON.stringify(linkBranchCall)} message=${linkBranchMessage}`);
  // Issue からはエージェントを選ばず、通常の新規セッションを1つだけ作る
  const issueActionButtons = pageLog.locator(".issue-session-actions button");
  check("Issue action offers one regular new-session button",
    await issueActionButtons.count() === 1 && (await issueActionButtons.first().textContent())?.trim() === "新規セッション");
  const spawnBeforeIssue = await pageLog.evaluate(() => window.__ptySpawns.length);
  await issueActionButtons.click();
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnBeforeIssue);
  const issueSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  check("Issue action creates a default-shell session at repository root",
    issueSpawn?.shell === null && issueSpawn?.cwd === "/repo" && issueSpawn?.args === null,
    `spawn=${JSON.stringify({ shell: issueSpawn?.shell, cwd: issueSpawn?.cwd, args: issueSpawn?.args })}`);
  const issueSessionName = ((await pageLog.locator(".ws-item.is-active .ws-name").textContent()) ?? "").trim();
  check("Issue session keeps the issue number and title in its name",
    issueSessionName === "#42 Fix quoted startup", `name=${issueSessionName}`);
  // worktree モード: 選択したベースブランチから作成し、その cwd で通常セッションを開始
  await pageLog.locator(".issue-worktree-toggle input").check();
  await pageLog.locator(".issue-worktree-fields select").selectOption("refs/remotes/origin/main");
  await pageLog.locator(".issue-worktree-branch").fill("issue/42-custom");
  check("worktree location defaults outside the repository",
    await pageLog.locator(".issue-worktree-directory").inputValue() === "~/worktrees" &&
      await pageLog.locator(".issue-worktree-fields .wt-loc input[value=outside]").isChecked());
  // 配下モードへ切り替えるとそのモードの既定（.worktree）に戻る
  await pageLog.locator(".issue-worktree-fields .wt-loc input[value=inside]").check();
  check("switching the issue form to inside restores .worktree",
    await pageLog.locator(".issue-worktree-directory").inputValue() === ".worktree");
  const spawnBeforeWorktree = await pageLog.evaluate(() => window.__ptySpawns.length);
  await pageLog.locator(".issue-session-actions button").click();
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnBeforeWorktree);
  const worktreeCall = await pageLog.evaluate(() => (window.__worktreeCreateCalls ?? []).at(-1));
  const worktreeSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  check("worktree action uses selected base and new branch",
    worktreeCall?.root === "/repo" && worktreeCall?.baseRef === "refs/remotes/origin/main" &&
      worktreeCall?.branch === "issue/42-custom" && worktreeCall?.directory === ".worktree" &&
      worktreeCall?.location === "inside",
    `call=${JSON.stringify(worktreeCall)}`);
  check("regular issue session starts inside created worktree",
    worktreeSpawn?.shell === null &&
      worktreeSpawn?.cwd === "/repo/.worktree/issue-42-custom" &&
      worktreeSpawn?.args === null,
    `spawn=${JSON.stringify({ shell: worktreeSpawn?.shell, cwd: worktreeSpawn?.cwd, args: worktreeSpawn?.args })}`);
  await pageLog.waitForTimeout(1800);
  const savedIssueSession = await pageLog.evaluate(() => {
    const saved = JSON.parse(window.__savedSession);
    return saved.workspaces.find((w) => w.id === saved.activeId);
  });
  check("Issue action persists a regular default-shell session",
    savedIssueSession?.name === "#42 Fix quoted startup" &&
      savedIssueSession?.root?.cwd === "/repo/.worktree/issue-42-custom" &&
      savedIssueSession?.root?.shell === undefined &&
      savedIssueSession?.root?.resumeShell === undefined,
    `saved=${JSON.stringify(savedIssueSession)}`);
  check("Issue body is not injected into or persisted with the new session",
    savedIssueSession?.root?.args === undefined &&
      !(await pageLog.evaluate(() => window.__savedSession.includes("touch /tmp/bad"))));
  await pageLog.locator("#issue-close").click();
  check("Issue close button returns to the list", !(await pageLog.locator("#issue-overlay").isVisible()) &&
    await pageLog.locator("#exp-git-issues .issue-row").count() === 2);

  // PR タブ → リポジトリのPR一覧 → 本文とコミット差分共通デザインのファイル差分
  await pageLog.locator("#exp-git-prs-tab").click();
  await pageLog.waitForSelector("#exp-git-prs .pr-list-row", { timeout: 3000 });
  const prListCall = await pageLog.evaluate(() => (window.__prListCalls ?? [])[0]);
  const prListText = (await pageLog.locator("#exp-git-prs").textContent()) ?? "";
  check("PR tab lists repository pull requests next to Branch and Issue",
    prListCall === "/repo" && await pageLog.locator("#exp-git-prs .pr-list-row").count() === 2 &&
      prListText.includes("Add thing") && prListText.includes("feat/x") && prListText.includes("main") &&
      prListText.includes("Open"),
    `root=${prListCall} list="${prListText}"`);
  const prListStateLayout = await pageLog.locator("#exp-git-prs .pr-list-row").first().evaluate((row) => {
    const state = row.querySelector(".pr-list-state");
    const rowBox = row.getBoundingClientRect();
    const stateBox = state.getBoundingClientRect();
    return {
      text: state.textContent,
      width: stateBox.width,
      rightGap: rowBox.right - stateBox.right,
      justifySelf: getComputedStyle(state).justifySelf,
    };
  });
  check("PR Open label is compact and aligned at the right edge",
    prListStateLayout.text === "Open" && prListStateLayout.width < 32 &&
      prListStateLayout.rightGap <= 5 && prListStateLayout.justifySelf === "end",
    `layout=${JSON.stringify(prListStateLayout)}`);
  const prListTitleLayout = await pageLog.locator("#exp-git-prs .pr-list-row").first().evaluate((row) => {
    const title = row.querySelector(".pr-list-title");
    const meta = row.querySelector(".pr-list-meta");
    const rowBox = row.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const metaBox = meta.getBoundingClientRect();
    return {
      rowWidth: rowBox.width,
      rowHeight: rowBox.height,
      titleWidth: titleBox.width,
      titleBottom: titleBox.bottom,
      metaTop: metaBox.top,
      metaText: meta.textContent,
    };
  });
  check("PR title keeps a full-width row above long author metadata",
    prListTitleLayout.metaText.includes("a-very-long-github-author-name") &&
      prListTitleLayout.titleWidth >= prListTitleLayout.rowWidth * 0.7 &&
      prListTitleLayout.titleBottom <= prListTitleLayout.metaTop &&
      prListTitleLayout.rowHeight >= 45,
    `layout=${JSON.stringify(prListTitleLayout)}`);
  check("only open pull requests are listed in the PR tab",
    !prListText.includes("Abandoned change") && !prListText.includes("#5") &&
      !prListText.includes("Shipped change") && !prListText.includes("#3") &&
      !prListText.includes("マージ済み") && !prListText.includes("クローズ"),
    `list="${prListText}"`);
  check("PR badge is hidden while PR tab is active", !(await pageLog.locator("#exp-git-pr").isVisible()));
  const prBranchTexts = await pageLog.locator("#exp-git-prs .pr-list-branches").allTextContents();
  const prBranchTitle = await pageLog.locator("#exp-git-prs .pr-list-branches").nth(1).getAttribute("title");
  check("long PR branch names collapse to \"branch\" in the list, full names stay in the tooltip",
    prBranchTexts[0] === "feat/x → main" && prBranchTexts[1] === "branch → main" &&
      prBranchTitle === "fix/very-long-branch-name-for-the-list → main",
    `texts=${JSON.stringify(prBranchTexts)} title=${prBranchTitle}`);
  await pageLog.locator("#exp-git-prs .pr-list-row").first().click();
  await pageLog.waitForSelector("#pr-overlay:not([hidden]) #pr-files .commit-file-nav-item", { timeout: 3000 });
  const prDetailCall = await pageLog.evaluate(() => (window.__prDetailCalls ?? [])[0]);
  const prDiffCallFromList = await pageLog.evaluate(() => (window.__prDiffCalls ?? [])[0]);
  const prListDiffText = (await pageLog.locator("#pr-files").textContent()) ?? "";
  check("PR list opens number-addressed detail and unified diff",
    prDetailCall?.root === "/repo" && prDetailCall?.number === 12 &&
      prDiffCallFromList?.root === "/repo" && prDiffCallFromList?.number === 12 &&
      await pageLog.locator("#pr-files .commit-file-nav-item").count() === 2 &&
      await pageLog.locator("#pr-files .commit-file").count() === 1 &&
      prListDiffText.includes("src/app.ts") && prListDiffText.includes("new line"),
    `detail=${JSON.stringify(prDetailCall)} diff=${JSON.stringify(prDiffCallFromList)}`);
  await pageLog.locator("#pr-conversation-tab").click();
  check("PR list detail shows the pull request body",
    ((await pageLog.locator("#pr-body").textContent()) ?? "").includes("This PR adds the thing."));
  await pageLog.keyboard.press("Escape");
  check("Escape closes PR detail opened from the list", !(await pageLog.locator("#pr-overlay").isVisible()));

  // 取得失敗: gh の理由をそのまま出し、直前まで見えていた一覧は消さない
  await pageLog.evaluate(() => {
    window.__mockPrList = {
      available: false,
      prs: [],
      error: "gh: To get started with GitHub CLI, please run: gh auth login",
    };
  });
  await pageLog.locator("#exp-git-refresh").click();
  await pageLog.waitForSelector("#exp-git-prs .pr-list-error", { timeout: 3000 });
  const prErrText = (await pageLog.locator("#exp-git-prs .pr-list-error").textContent()) ?? "";
  check("PR list shows the gh failure reason instead of a generic message",
    prErrText.includes("gh auth login") && !prErrText.includes("PRはありません"),
    `err="${prErrText}"`);
  check("failed PR refresh keeps the pull requests already listed",
    await pageLog.locator("#exp-git-prs .pr-list-row").count() === 2);
  // 再試行ボタンで取り直す
  await pageLog.evaluate(() => {
    window.__prListCalls = [];
    window.__mockPrList = {
      available: true,
      prs: [
        { number: 12, title: "Add thing", state: "OPEN", url: "https://github.com/o/r/pull/12",
          author: "alice", headRefName: "feat/x", baseRefName: "main", isDraft: false,
          updatedAt: "2026-08-03T00:00:00Z" },
        { number: 9, title: "Earlier change", state: "OPEN", url: "https://github.com/o/r/pull/9",
          author: "bob", headRefName: "fix/earlier", baseRefName: "main", isDraft: false,
          updatedAt: "2026-07-20T00:00:00Z" },
      ],
    };
  });
  await pageLog.locator("#exp-git-prs .pr-list-retry").click();
  await pageLog.waitForSelector("#exp-git-prs .pr-list-error", { state: "detached", timeout: 3000 });
  check("PR list retry button refetches and clears the error",
    (await pageLog.evaluate(() => (window.__prListCalls ?? []).length)) >= 1 &&
      await pageLog.locator("#exp-git-prs .pr-list-row").count() === 2,
    `calls=${await pageLog.evaluate(() => JSON.stringify(window.__prListCalls ?? []))}`);

  // Worktree タブ → 同じ一覧を git パネルからも管理できる
  await pageLog.locator("#exp-git-worktrees-tab").click();
  await pageLog.waitForSelector("#exp-git-worktrees .wt-row", { timeout: 3000 });
  const panelListCall = await pageLog.evaluate(() => (window.__worktreeListCalls ?? []).at(-1));
  const panelWtText = (await pageLog.locator("#exp-git-worktrees").textContent()) ?? "";
  check("Worktree tab lists the repository worktrees",
    panelListCall?.root === "/repo"
      && await pageLog.locator("#exp-git-worktrees .wt-row").count() === 2
      && panelWtText.includes("feature/old")
      && panelWtText.includes("/repo/.worktree/feature-old")
      && await pageLog.locator("#exp-git-worktrees .wt-row").first().locator(".wt-del").count() === 0
      && await pageLog.locator("#exp-git-worktrees .wt-issue-open").count() === 2,
    `call=${JSON.stringify(panelListCall)} text="${panelWtText}"`);

  // 作成済み worktree のブランチを、Worktree タブから後で open Issue に紐付ける
  const featureWt = pageLog.locator("#exp-git-worktrees .wt-row").nth(1);
  const issueListCallsBeforeLink = await pageLog.evaluate(() => (window.__issueListCalls ?? []).length);
  await featureWt.locator(".wt-issue-open").click();
  await featureWt.locator(".wt-issue-link select").waitFor({ state: "visible" });
  const worktreeIssueOptions = await featureWt.locator(".wt-issue-link select option").allTextContents();
  check("worktree issue action fetches open issues only when opened",
    await pageLog.evaluate((before) => (window.__issueListCalls ?? []).length === before + 1,
      issueListCallsBeforeLink)
      && JSON.stringify(worktreeIssueOptions) === JSON.stringify([
        "#42 Fix quoted startup", "#8 Unassigned issue",
      ]),
    `options=${JSON.stringify(worktreeIssueOptions)}`);
  await featureWt.locator(".wt-issue-link select").selectOption("8");
  const linkCallsBeforeWorktree = await pageLog.evaluate(() => (window.__issueLinkBranchCalls ?? []).length);
  await featureWt.locator(".wt-issue-link-action").click();
  await pageLog.waitForFunction(
    (before) => (window.__issueLinkBranchCalls ?? []).length === before + 1,
    linkCallsBeforeWorktree,
  );
  const worktreeLinkCall = await pageLog.evaluate(() => (window.__issueLinkBranchCalls ?? []).at(-1));
  const worktreeLinkMessage = (await featureWt.locator(".wt-issue-status").textContent()) ?? "";
  check("worktree issue action links its branch to the selected issue",
    worktreeLinkCall?.root === "/repo"
      && worktreeLinkCall?.number === 8
      && worktreeLinkCall?.branch === "feature/old"
      && worktreeLinkMessage.includes("feature/old")
      && worktreeLinkMessage.includes("#8")
      && worktreeLinkMessage.includes("origin"),
    `call=${JSON.stringify(worktreeLinkCall)} message="${worktreeLinkMessage}"`);
  await pageLog.locator("#exp-git-refresh").click();
  await pageLog.waitForTimeout(200);
  const listCallCount = await pageLog.evaluate(() => (window.__worktreeListCalls ?? []).length);
  check("refresh re-fetches the worktree list", listCallCount >= 2, `calls=${listCallCount}`);

  // 一括削除: タブ見出しと行の間の操作バーで全選択 → 確認 → まとめて削除
  await pageLog.evaluate(() => {
    window.__worktreeRemoveCalls = [];
    window.__mockWorktreeRemoveResult = undefined;
    window.__mockWorktreeList = {
      entries: [
        { path: "/repo", branch: "main", head: "abc1234",
          isMain: true, isCurrent: true, detached: false, bare: false,
          locked: false, lockReason: "", missing: false },
        { path: "/repo/.worktree/feature-old", branch: "feature/old", head: "def5678",
          isMain: false, isCurrent: false, detached: false, bare: false,
          locked: false, lockReason: "", missing: false },
        { path: "/repo/.worktree/feature-two", branch: "feature/two", head: "aaa1111",
          isMain: false, isCurrent: false, detached: false, bare: false,
          locked: false, lockReason: "", missing: false },
      ],
    };
  });
  await pageLog.locator("#exp-git-refresh").click();
  await pageLog.waitForFunction(
    () => document.querySelectorAll("#exp-git-worktrees .wt-row").length === 3,
    null, { timeout: 3000 });
  const barPlace = await pageLog.evaluate(() => {
    const list = document.querySelector("#exp-git-worktrees");
    const bar = list?.querySelector(".wt-bar");
    const firstRow = list?.querySelector(".wt-row");
    const tabs = document.querySelector("#exp-git-tabs");
    if (!bar || !firstRow || !tabs) return null;
    // 直前に展開した Issue 選択欄で残ったスクロール位置を、配置測定から除外する
    list.scrollTop = 0;
    return {
      isFirstChild: list.firstElementChild === bar,
      belowTabs: bar.getBoundingClientRect().top >= tabs.getBoundingClientRect().bottom - 1,
      aboveRows: bar.getBoundingClientRect().bottom <= firstRow.getBoundingClientRect().top + 1,
      checks: list.querySelectorAll(".wt-check").length,
    };
  });
  check("worktree list puts one bulk bar between the tabs and the rows",
    Boolean(barPlace && barPlace.isFirstChild && barPlace.belowTabs && barPlace.aboveRows
      && barPlace.checks === 2),
    `place=${JSON.stringify(barPlace)}`);
  const bulkDel = pageLog.locator("#exp-git-worktrees .wt-bulk-del");
  check("bulk delete is disabled until something is selected", await bulkDel.isDisabled());
  await pageLog.locator("#exp-git-worktrees .wt-bar-all input").check();
  const bulkLabel = (await bulkDel.textContent()) ?? "";
  check("select all checks every removable worktree and counts them",
    await pageLog.locator("#exp-git-worktrees .wt-check:checked").count() === 2
      && bulkLabel.includes("2") && !(await bulkDel.isDisabled()),
    `label="${bulkLabel}"`);
  await bulkDel.click();
  const bulkBeforeConfirm = await pageLog.evaluate(() => (window.__worktreeRemoveCalls ?? []).length);
  check("bulk delete only arms the confirmation",
    bulkBeforeConfirm === 0 && await pageLog.locator("#exp-git-worktrees .wt-bar .wt-confirm").isVisible(),
    `calls=${bulkBeforeConfirm}`);
  await pageLog.locator("#exp-git-worktrees .wt-bar .wt-yes").click();
  await pageLog.waitForTimeout(400);
  const bulkCalls = await pageLog.evaluate(() => window.__worktreeRemoveCalls ?? []);
  check("confirming removes every selected worktree without force",
    bulkCalls.length === 2 && bulkCalls.every((c) => c.force === false && c.root === "/repo")
      && bulkCalls.some((c) => c.path === "/repo/.worktree/feature-old")
      && bulkCalls.some((c) => c.path === "/repo/.worktree/feature-two"),
    `calls=${JSON.stringify(bulkCalls)}`);

  // 失敗したものだけ選択したまま残し、理由と強制削除を出す
  await pageLog.evaluate(() => {
    window.__worktreeRemoveCalls = [];
    window.__mockWorktreeRemoveResult = {
      errorUnlessForce: "fatal: contains modified or untracked files",
    };
  });
  await pageLog.locator("#exp-git-worktrees .wt-bar-all input").check();
  await pageLog.locator("#exp-git-worktrees .wt-bulk-del").click();
  await pageLog.locator("#exp-git-worktrees .wt-bar .wt-yes").click();
  await pageLog.waitForSelector("#exp-git-worktrees .wt-bulk-error:not([hidden])", { timeout: 3000 });
  const bulkErr = (await pageLog.locator("#exp-git-worktrees .wt-bulk-error").textContent()) ?? "";
  check("a failed bulk removal keeps the failures selected and shows git's reason",
    bulkErr.includes("contains modified or untracked files")
      && bulkErr.includes("/repo/.worktree/feature-two")
      && await pageLog.locator("#exp-git-worktrees .wt-check:checked").count() === 2
      && await pageLog.locator("#exp-git-worktrees .wt-bar .wt-force").isVisible(),
    `err="${bulkErr}"`);
  await pageLog.locator("#exp-git-worktrees .wt-bar .wt-force").click();
  await pageLog.waitForTimeout(400);
  const forcedBulk = await pageLog.evaluate(() =>
    (window.__worktreeRemoveCalls ?? []).filter((c) => c.force === true));
  check("force remove retries only the worktrees that failed",
    forcedBulk.length === 2
      && forcedBulk.some((c) => c.path === "/repo/.worktree/feature-old")
      && forcedBulk.some((c) => c.path === "/repo/.worktree/feature-two"),
    `calls=${JSON.stringify(forcedBulk)}`);
  await pageLog.evaluate(() => { window.__mockWorktreeRemoveResult = undefined; });

  // Branch タブへ戻せばコミット履歴と現在ブランチの PR バッジを再表示する
  await pageLog.locator("#exp-git-branch").click();
  check("Branch tab restores commit history", await pageLog.locator("#exp-git-log").isVisible());
  // コミット行クリック → そのコミット全体のファイル差分
  await pageLog.locator("#exp-git-log .git-commit-row").first().click();
  await pageLog.waitForSelector("#diff-overlay:not([hidden])", { timeout: 3000 });
  const commitDiffCall = await pageLog.evaluate(() => (window.__gitCommitDiffCalls ?? [])[0]);
  const commitDiffTitle = (await pageLog.locator("#diff-path").textContent()) ?? "";
  const commitDiffStats = (await pageLog.locator("#diff-stats").textContent()) ?? "";
  const commitDiffBody = (await pageLog.locator("#diff-body").textContent()) ?? "";
  check("clicking commit requests its diff",
    commitDiffCall?.root === "/repo" && commitDiffCall?.hash === "abc1234",
    `call=${JSON.stringify(commitDiffCall)}`);
  const commitFiles = await pageLog.locator("#diff-body .commit-file").count();
  const commitNavFiles = await pageLog.locator("#diff-body .commit-file-nav-item").count();
  const shownCommitPath = (await pageLog.locator("#diff-body .commit-file-path").textContent()) ?? "";
  const oldLineNumbers = (await pageLog.locator("#diff-body .commit-line-no.old").allTextContents()).join(" ");
  const newLineNumbers = (await pageLog.locator("#diff-body .commit-line-no.new").allTextContents()).join(" ");
  const commitPanelBox = await pageLog.locator("#diff-panel").boundingBox();
  check("commit diff overlay shows title, stats and readable file patches",
    commitDiffTitle.includes("abc1234") && commitDiffTitle.includes("add thing") &&
      commitDiffStats.includes("+3") && commitDiffStats.includes("-2") &&
      commitDiffBody.includes("src/app.ts") && commitDiffBody.includes("README.md") &&
      commitDiffBody.includes("new line") && shownCommitPath === "src/app.ts" &&
      commitFiles === 1 && commitNavFiles === 2 &&
      await pageLog.locator("#diff-body .commit-diff-line.hunk").count() === 1 &&
      await pageLog.locator("#diff-body .commit-diff-line.add").count() === 2 &&
      await pageLog.locator("#diff-body .commit-diff-line.del").count() === 1 &&
      oldLineNumbers.includes("1") && newLineNumbers.includes("1") &&
      commitPanelBox?.width > 1100 && commitPanelBox?.height > 700,
    `title="${commitDiffTitle}" stats="${commitDiffStats}"`);
  await pageLog.locator("#diff-body .commit-file-nav-item").nth(1).click();
  const selectedCommitPath = (await pageLog.locator("#diff-body .commit-file-path").textContent()) ?? "";
  const selectedPatchText = (await pageLog.locator("#diff-body .commit-patches").textContent()) ?? "";
  const selectedOldLineNumbers =
    (await pageLog.locator("#diff-body .commit-line-no.old").allTextContents()).join(" ");
  check("commit file navigation shows only the selected file patch",
    await pageLog.locator("#diff-body .commit-file-nav-item").nth(1).evaluate((el) => el.classList.contains("is-active")) &&
      selectedCommitPath === "README.md" && selectedPatchText.includes("new docs") &&
      !selectedPatchText.includes("new line") && selectedOldLineNumbers.includes("10") &&
      await pageLog.locator("#diff-body .commit-file").count() === 1);
  await pageLog.keyboard.press("Escape");
  check("commit diff overlay closes with Escape", !(await pageLog.locator("#diff-overlay").isVisible()));
  // コミット行右クリック → 変更ファイル表示 / 二段階確認付きの巻き戻し
  await pageLog.locator("#exp-git-log .git-commit-row").first().click({ button: "right" });
  const commitCtxText = (await pageLog.locator("#git-commit-ctx").textContent()) ?? "";
  check("commit context menu offers changed files and rollback",
    commitCtxText.includes("変更ファイルの内容を表示") && commitCtxText.includes("このコミットまで巻き戻す"),
    `menu="${commitCtxText}"`);
  await pageLog.locator("#git-commit-ctx button").first().click();
  await pageLog.waitForSelector("#diff-overlay:not([hidden])", { timeout: 3000 });
  const ctxDiffCall = await pageLog.evaluate(() => (window.__gitCommitDiffCalls ?? []).at(-1));
  check("context menu changed-files action opens the commit diff",
    ctxDiffCall?.root === "/repo" && ctxDiffCall?.hash === "abc1234");
  await pageLog.keyboard.press("Escape");

  await pageLog.locator("#exp-git-log .git-commit-row").nth(1).click({ button: "right" });
  await pageLog.locator("#git-commit-ctx button.is-danger").click();
  const resetCallsBeforeConfirm = await pageLog.evaluate(() => (window.__gitResetCalls ?? []).length);
  const resetWarning = (await pageLog.locator("#git-commit-ctx").textContent()) ?? "";
  check("rollback requires explicit destructive confirmation",
    resetCallsBeforeConfirm === 0 && resetWarning.includes("未コミット変更は破棄") &&
      resetWarning.includes("未追跡ファイルは残ります"),
    `calls=${resetCallsBeforeConfirm} menu="${resetWarning}"`);
  await pageLog.locator("#git-commit-ctx button.is-danger").click();
  await pageLog.waitForFunction(() => (window.__gitResetCalls ?? []).length === 1);
  const resetCall = await pageLog.evaluate(() => window.__gitResetCalls[0]);
  check("confirmed rollback resets the selected repository and commit",
    resetCall?.root === "/repo" && resetCall?.hash === "def5678",
    `call=${JSON.stringify(resetCall)}`);
  check("commit context menu closes after rollback", !(await pageLog.locator("#git-commit-ctx").isVisible()));
  // PR バッジ → conversation オーバーレイ
  let prShown = true;
  await pageLog.waitForSelector("#exp-git-pr:not([hidden])", { timeout: 8000 }).catch(() => { prShown = false; });
  const prCall = await pageLog.evaluate(() => (window.__prCalls ?? [])[0]);
  check("PR badge appears with number",
    prShown && ((await pageLog.locator("#exp-git-pr").textContent()) ?? "").includes("#12"),
    `call=${JSON.stringify(prCall)}`);
  check("pr_info called with repo root and branch",
    prCall?.root === "/repo" && prCall?.branch === "feat/x", `call=${JSON.stringify(prCall)}`);
  if (prShown) {
    await pageLog.locator("#exp-git-pr").click();
    await pageLog.waitForSelector("#pr-overlay:not([hidden])", { timeout: 3000 });
    await pageLog.waitForSelector("#pr-files .commit-file-nav-item", { timeout: 3000 });
    const prTitle = (await pageLog.locator("#pr-title").textContent()) ?? "";
    const prState = (await pageLog.locator("#pr-state").textContent()) ?? "";
    check("PR overlay shows number, title and state",
      prTitle.includes("#12") && prTitle.includes("Add thing") && prState === "Open",
      `title="${prTitle}" state="${prState}"`);
    const prStateFontSize = await pageLog.locator("#pr-state").evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    check("PR overlay uses a compact state label", prStateFontSize === "9px", `size=${prStateFontSize}`);
    const prOverview = (await pageLog.locator("#pr-overview").textContent()) ?? "";
    const prFilesText = (await pageLog.locator("#pr-files").textContent()) ?? "";
    const currentPrDiffCall = await pageLog.evaluate(() => (window.__prDiffCalls ?? []).at(-1));
    check("PR opens with a changed-files summary and commit-style patches",
      await pageLog.locator("#pr-files-view").isVisible() &&
        prOverview.includes("3") && prOverview.includes("+42") && prOverview.includes("−11") &&
        currentPrDiffCall?.root === "/repo" && currentPrDiffCall?.number === 12 &&
        await pageLog.locator("#pr-files .commit-file-nav-item").count() === 2 &&
        await pageLog.locator("#pr-files .commit-file").count() === 1,
      `overview="${prOverview}" call=${JSON.stringify(currentPrDiffCall)}`);
    check("PR patch uses the same file navigation, line numbers and colors as commit diff",
      prFilesText.includes("src/app.ts") && prFilesText.includes("README.md") &&
        prFilesText.includes("new line") &&
        await pageLog.locator("#pr-files .commit-diff-line.hunk").count() === 1 &&
        await pageLog.locator("#pr-files .commit-diff-line.add").count() === 2 &&
        await pageLog.locator("#pr-files .commit-diff-line.del").count() === 1,
      `files="${prFilesText}"`);
    await pageLog.locator("#pr-files .commit-file-nav-item").nth(1).click();
    const selectedPrPatch = (await pageLog.locator("#pr-files .commit-patches").textContent()) ?? "";
    check("PR file navigation shows only the selected patch",
      selectedPrPatch.includes("new docs") && !selectedPrPatch.includes("new line") &&
        await pageLog.locator("#pr-files .commit-file").count() === 1);
    await pageLog.locator("#pr-conversation-tab").click();
    const cards = await pageLog.locator("#pr-body .pr-comment").count();
    const bodyText = (await pageLog.locator("#pr-body").textContent()) ?? "";
    check("conversation cards render (description + 3 comments)",
      cards === 4 && bodyText.includes("This PR adds the thing.") &&
      bodyText.includes("LGTM but rename foo") && bodyText.includes("renamed in abc1234"),
      `cards=${cards}`);
    // レビューの「変更を要求」チップに色クラスが付く
    const changesChip = await pageLog.locator("#pr-body .pr-comment-kind.pr-changes").count();
    check("changes-requested review gets its chip", changesChip === 1, `chips=${changesChip}`);
    // diff 行コメントだけ、ファイル位置 + 本文を表示どおりコピーできる
    const inlineCard = pageLog.locator("#pr-body .pr-comment").filter({ has: pageLog.locator(".pr-inline") });
    const inlineLocation = (await inlineCard.locator(".pr-comment-loc").textContent()) ?? "";
    const inlineCode = (await inlineCard.locator(".pr-comment-code").textContent()) ?? "";
    const copyButtons = await pageLog.locator("#pr-body .pr-comment-copy").count();
    check("inline comment shows location, reviewed code and one copy action",
      inlineLocation === "src/app.ts:42" &&
        inlineCode === "const exactWording = preserve(input);" && copyButtons === 1,
      `location="${inlineLocation}" code=${JSON.stringify(inlineCode)} buttons=${copyButtons}`);
    await inlineCard.locator(".pr-comment-copy").click();
    const copiedComment = await pageLog.evaluate(() => navigator.clipboard.readText());
    const copiedLabel = (await inlineCard.locator(".pr-comment-copy").textContent()) ?? "";
    // Windows のクリップボードは読み戻しで \n を \r\n に正規化するので、改行だけ揃えて比較する
    check("inline comment copy preserves location and body",
      copiedComment.replace(/\r\n/g, "\n") === "src/app.ts:42\nPlease keep this exact wording." &&
        /Copied|コピー済み/.test(copiedLabel),
      `copied=${JSON.stringify(copiedComment)} label="${copiedLabel}"`);
    // GitHub で開く → open_url に PR の URL が渡る
    await pageLog.locator("#pr-open-gh").click();
    await pageLog.waitForTimeout(200);
    const openedPr = await pageLog.evaluate(() => (window.__openedUrls ?? []).slice(-1)[0]);
    check("open-on-GitHub passes PR url to open_url",
      openedPr === "https://github.com/o/r/pull/12", `url=${openedPr}`);
    await pageLog.keyboard.press("Escape");
    check("PR overlay closes with Escape", !(await pageLog.locator("#pr-overlay").isVisible()));
    // オーバーレイを閉じてもターミナルは生きている（stopPropagation の確認を兼ねる）
    // ブランチが変わったら PR を取り直す。PR 無し（gh 不在と同じ）はバッジ非表示
    await pageLog.evaluate(() => {
      window.__mockPrInfo = {
        found: false, number: null, title: null, state: null, url: null,
        author: null, body: null, additions: 0, deletions: 0, changedFiles: 0,
        files: [], comments: [],
      };
      window.__mockGitLog = { ...window.__mockGitLog, branch: "main" };
    });
    await pageLog.waitForTimeout(3600);
    check("PR badge hides when branch has no PR", !(await pageLog.locator("#exp-git-pr").isVisible()));
  }
  // スプリッタのドラッグで高さが変わる（エクスプローラー内で完結・上限 80%）
  const hBefore = await pageLog.evaluate(() => document.querySelector("#exp-git").getBoundingClientRect().height);
  const handle = await pageLog.locator("#exp-git-resize").boundingBox();
  if (handle) {
    await pageLog.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await pageLog.mouse.down();
    await pageLog.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 60, { steps: 5 });
    await pageLog.mouse.up();
  }
  const hAfter = await pageLog.evaluate(() => document.querySelector("#exp-git").getBoundingClientRect().height);
  check("splitter drag grows git section", hAfter - hBefore > 40, `h ${Math.round(hBefore)}→${Math.round(hAfter)}`);
  check("no stuck body.dragging after splitter drag",
    !(await pageLog.evaluate(() => document.body.classList.contains("dragging"))));
  // ダブルクリックで既定の高さ（30%）に戻る
  await pageLog.locator("#exp-git-resize").dblclick();
  const hReset = await pageLog.evaluate(() => document.querySelector("#exp-git").getBoundingClientRect().height);
  check("splitter dblclick resets height", Math.abs(hReset - hBefore) < 8, `h=${Math.round(hReset)}`);
  // リポジトリ外ではセクションごと消える
  await pageLog.evaluate(() => {
    window.__mockGitLog = { repo: false, root: null, branch: null, detached: false, commits: [] };
  });
  await pageLog.waitForTimeout(3600);
  check("git section hides outside a repo",
    !(await pageLog.locator("#exp-git").isVisible()) && !(await pageLog.locator("#exp-git-resize").isVisible()));
}
await pageLog.close();

}
