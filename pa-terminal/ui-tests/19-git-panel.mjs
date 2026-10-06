export default async function (ctx) {
const { browser, check, BASE_URL, MOD } = ctx;

// ============================================================
// Git ウィンドウ（ツールバーの Git ボタン / Cmd+E で開く大きめのモーダル）
//   ファイルステータス・履歴（コミットグラフ + インライン詳細）・サイドバーのブランチ / タグ・
//   Issue / PR / Worktree の各ビューと PR バッジ
// ============================================================

const pageLog = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageLog.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageLog.context().grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: new URL(BASE_URL).origin,
});
await pageLog.addInitScript(() => {
  // リポジトリ判定とルートは git_changes、現在のブランチは git_branches から来る
  window.__mockGitChanges = { repo: true, root: "/repo", files: [] };
  window.__mockGitBranches = {
    current: "feat/x", upstream: "origin/feat/x", localBranches: ["feat/x", "main"],
    branches: ["origin/feat/x", "origin/main"], remotes: ["origin"],
  };
  window.__mockGitLog = {
    repo: true,
    root: "/repo",
    branch: "feat/x",
    detached: false,
    // 履歴は常に全ブランチ: 現在のブランチに無い fix/other のコミットも並ぶ
    commits: [
      { hash: "abc1234", id: "abc1234000", parents: ["def5678000"], time: Math.floor(Date.now() / 1000) - 3600,
        author: "alice", refs: "HEAD -> refs/heads/feat/x, refs/remotes/origin/feat/x, tag: refs/tags/v1.0",
        subject: "add thing" },
      { hash: "fed9876", id: "fed9876000", parents: ["def5678000"], time: Math.floor(Date.now() / 1000) - 7200,
        author: "carol", refs: "refs/heads/fix/other", subject: "other branch work" },
      { hash: "def5678", id: "def5678000", parents: [], time: Math.floor(Date.now() / 1000) - 86400,
        author: "bob", refs: "", subject: "initial commit" },
    ],
  };
  const ref = (name, hash, extra = {}) => ({
    name, hash, upstream: "", ahead: 0, behind: 0, gone: false, worktree: "", ...extra,
  });
  window.__mockGitRefs = {
    head: "feat/x",
    local: [
      ref("feat/x", "abc1234", { upstream: "origin/feat/x" }),
      ref("fix/other", "fed9876"),
      ref("main", "fed9876"),
      ref("stale", "0000000"),
    ],
    remote: [ref("origin/feat/x", "abc1234"), ref("origin/main", "fed9876")],
    tags: [ref("v1.0", "abc1234"), ref("v0.9", "def5678")],
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
    headRefName: "feat/x",
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
  window.__mockIssueCreateResult = {
    number: 99,
    url: "https://github.com/o/r/issues/99",
  };
  window.__mockPickedFiles = ["/tmp/screenshot.png", "/tmp/trace.log"];
  window.__mockWorktreeBranches = {
    branches: [
      { name: "feat/x", reference: "refs/heads/feat/x", current: true },
      { name: "origin/main", reference: "refs/remotes/origin/main", current: false },
    ],
    defaultRef: "refs/remotes/origin/main",
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
// git_log へ渡る引数をまるごと記録する（履歴は常に全ブランチ: cwd 以外を渡さない）
await pageLog.evaluate(() => {
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals.invoke.bind(internals);
  window.__gitLogArgs = [];
  internals.invoke = (cmd, args, options) => {
    if (cmd === "git_log") window.__gitLogArgs.push(args);
    return invoke(cmd, args, options);
  };
});
await pageLog.locator(".pane .pane-body").first().click();
await pageLog.waitForTimeout(300);
const gridBefore = await pageLog.locator(".pane .pane-body").first().boundingBox();
check("Git window stays closed and fetches no issues / PRs / history until opened",
  await pageLog.locator("#git-window-overlay").isHidden() &&
    await pageLog.evaluate(() => (window.__issueListCalls ?? []).length === 0 &&
      (window.__prListCalls ?? []).length === 0 && window.__gitLogArgs.length === 0));
await pageLog.locator("#git-open").click();
let logShown = true;
await pageLog.waitForSelector("#git-window-overlay:not([hidden]) #git-window", { timeout: 8000 })
  .catch(() => { logShown = false; });
check("Git button opens the Git window in a repo", logShown);
if (logShown) {
  const ensureGitWindow = async () => {
    if (await pageLog.locator("#git-window-overlay").isHidden()) await pageLog.locator("#git-open").click();
    await pageLog.waitForSelector("#git-window-overlay:not([hidden])", { timeout: 3000 });
  };
  const windowBox = await pageLog.locator("#git-window").boundingBox();
  const gridAfter = await pageLog.locator(".pane .pane-body").first().boundingBox();
  check("Git window is a large dialog that does not resize the terminal grid",
    await pageLog.locator("#git-window[role=dialog][aria-modal=true]").isVisible() &&
      Boolean(windowBox && windowBox.width >= 900 && windowBox.height >= 650) &&
      JSON.stringify(gridBefore) === JSON.stringify(gridAfter) &&
      await pageLog.locator("#git-open").getAttribute("aria-expanded") === "true",
    `window=${JSON.stringify(windowBox)} before=${JSON.stringify(gridBefore)} after=${JSON.stringify(gridAfter)}`);
  // 初めて開いたときはコミット前の変更（ファイルステータス）から見せる
  const firstView = await pageLog.evaluate(() => ({
    current: [...document.querySelectorAll("[data-gw-nav][aria-current=page]")].map((b) => b.id),
    shown: [...document.querySelectorAll("#gw-main .gw-view")].filter((v) => !v.hidden).map((v) => v.id),
  }));
  check("first open shows the File status view",
    JSON.stringify(firstView.current) === JSON.stringify(["gw-nav-status"]) &&
      JSON.stringify(firstView.shown) === JSON.stringify(["gw-view-status"]) &&
      await pageLog.locator("#gw-empty").isHidden(),
    JSON.stringify(firstView));
  // ヘッダー: リポジトリ名（title はルート）と git_branches の現在ブランチ
  await pageLog.waitForFunction(() => document.querySelector("#gw-branch")?.textContent === "feat/x", null,
    { timeout: 3000 }).catch(() => {});
  check("header shows the repository name and current branch",
    ((await pageLog.locator("#gw-title").textContent()) ?? "").trim() === "repo" &&
      await pageLog.locator("#gw-title").getAttribute("title") === "/repo" &&
      await pageLog.locator("#gw-branch").textContent() === "feat/x" &&
      await pageLog.locator("#gw-branch").isVisible(),
    `title="${await pageLog.locator("#gw-title").textContent()}" branch="${await pageLog.locator("#gw-branch").textContent()}"`);
  const tools = await pageLog.locator("#gw-tools > button").evaluateAll((buttons) =>
    buttons.map((b) => ({ id: b.id, label: b.textContent?.trim(), svg: !!b.querySelector("svg") })));
  check("Git window header exposes commit / pull / push / fetch / worktree / stash with icons",
    tools.map((x) => x.id).join() === "git-commit,git-pull,git-push,git-fetch,git-worktree,git-stash" &&
      tools.every((x) => x.svg && x.label),
    JSON.stringify(tools));

  // 開閉: Escape / × / 背景クリック / Cmd+E
  await pageLog.keyboard.press("Escape");
  check("Escape closes the Git window",
    await pageLog.locator("#git-window-overlay").isHidden() &&
      await pageLog.locator("#git-open").getAttribute("aria-expanded") === "false");
  await pageLog.locator(".pane .pane-body").first().click();
  await pageLog.keyboard.press(`${MOD}+e`);
  const shortcutOpened = await pageLog.locator("#git-window-overlay").isVisible();
  await pageLog.keyboard.press(`${MOD}+e`);
  check("Cmd/Ctrl+E toggles the Git window",
    shortcutOpened && await pageLog.locator("#git-window-overlay").isHidden());
  await pageLog.locator("#git-open").click();
  await pageLog.locator("#gw-close").click();
  check("close button closes the Git window", await pageLog.locator("#git-window-overlay").isHidden());
  await pageLog.locator("#git-open").click();
  await pageLog.mouse.click(5, 815);
  check("clicking the backdrop closes the Git window", await pageLog.locator("#git-window-overlay").isHidden());
  await pageLog.locator("#git-open").click();
  await pageLog.waitForSelector("#git-window-overlay:not([hidden])");

  // ---- 大きさとサイドバーの幅: ハンドルで変えられ、縮めた分は本文側が広がる ----
  {
    const dragBy = async (selector, dx, dy) => {
      const box = await pageLog.locator(selector).boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await pageLog.mouse.move(x, y);
      await pageLog.mouse.down();
      await pageLog.mouse.move(x + dx, y + dy, { steps: 4 });
      await pageLog.mouse.up();
    };
    const sizes = () => pageLog.evaluate(() => ({
      w: document.querySelector("#git-window").offsetWidth,
      h: document.querySelector("#git-window").offsetHeight,
      side: document.querySelector("#gw-side").offsetWidth,
      body: document.querySelector("#gw-body").offsetWidth,
      main: document.querySelector("#gw-body").offsetWidth - document.querySelector("#gw-side").offsetWidth,
    }));
    const before = await sizes();
    await dragBy("#git-window > .panel-grip.is-xy", -80, -50);
    const shrunk = await sizes();
    check("dragging the corner resizes the Git window around the centre without closing it",
      Math.abs(before.w - shrunk.w - 160) <= 2 && Math.abs(before.h - shrunk.h - 100) <= 2 &&
        await pageLog.locator("#git-window-overlay").isVisible(),
      JSON.stringify({ before, shrunk }));
    await dragBy("#gw-side .gw-side-grip", -60, 0);
    const narrow = await sizes();
    check("dragging the sidebar edge narrows it and gives the width to the view",
      Math.abs(shrunk.side - narrow.side - 60) <= 2 && Math.abs(narrow.main - shrunk.main - 60) <= 2,
      JSON.stringify({ shrunk, narrow }));
    await pageLog.locator("#gw-close").click();
    await pageLog.locator("#git-open").click();
    await pageLog.waitForSelector("#git-window-overlay:not([hidden])");
    const reopened = await sizes();
    check("the Git window keeps its size and sidebar width when reopened",
      reopened.w === narrow.w && reopened.h === narrow.h && reopened.side === narrow.side,
      JSON.stringify({ reopened, narrow }));
    await pageLog.locator("#git-window > .panel-grip.is-xy").dblclick();
    await pageLog.locator("#gw-side .gw-side-grip").dblclick();
    const reset = await sizes();
    check("double-clicking the handles restores the Git window's default size",
      reset.w === before.w && reset.h === before.h && reset.side === before.side,
      JSON.stringify({ reset, before }));
  }

  // ---- 履歴ビュー（コミットグラフ）----
  await pageLog.locator("#gw-nav-history").click();
  await pageLog.waitForSelector("#gw-log .git-commit-row", { timeout: 3000 });
  check("History nav shows the history view and marks itself current",
    await pageLog.locator("#gw-nav-history").getAttribute("aria-current") === "page" &&
      await pageLog.locator("#gw-view-history").isVisible() &&
      await pageLog.locator("#gw-view-status").isHidden());
  const rowCount = await pageLog.locator("#gw-log .git-commit-row").count();
  const firstRow = (await pageLog.locator("#gw-log .git-commit-row").first().textContent()) ?? "";
  check("commit rows render hash, subject, author",
    rowCount === 3 && firstRow.includes("abc1234") && firstRow.includes("add thing") && firstRow.includes("alice"),
    `rows=${rowCount} first="${firstRow}"`);
  const refChips = await pageLog.locator("#gw-log .git-commit-row").first()
    .locator(".git-commit-refs .git-ref").evaluateAll((chips) =>
      chips.map((chip) => ({ cls: chip.className, text: chip.textContent, remote: chip.dataset.remote ?? "" })));
  check("commit decorations become ref chips (local+remote merged, current first, tag separate)",
    refChips.length === 2 &&
      refChips[0].text === "feat/x" && refChips[0].cls.includes("is-current") &&
      refChips[0].remote === "origin/feat/x" &&
      refChips[1].text === "v1.0" && refChips[1].cls.includes("git-ref-tag"),
    JSON.stringify(refChips));
  check("each commit row draws its graph cell",
    await pageLog.locator("#gw-log .git-commit-row > .git-graph-cell > svg.git-graph").count() === 3 &&
      await pageLog.locator("#gw-log .git-commit-row.is-head .graph-dot.is-head").count() === 1);
  const logArgs = await pageLog.evaluate(() => window.__gitLogArgs);
  check("history always asks git_log for all branches (only cwd is passed)",
    logArgs.length > 0 && logArgs.every((a) => JSON.stringify(Object.keys(a ?? {})) === '["cwd"]') &&
      await pageLog.locator("[id^=exp-git-scope]").count() === 0,
    JSON.stringify(logArgs.slice(-2)));
  check("history lists commits from other branches too",
    ((await pageLog.locator("#gw-log").textContent()) ?? "").includes("other branch work"));

  // 初めて履歴を開いたら HEAD のコミットが選ばれ、詳細がその場に出る
  await pageLog.waitForSelector("#gw-commit-detail .commit-file-nav-item", { timeout: 3000 }).catch(() => {});
  const selectedRows = await pageLog.locator("#gw-log .git-commit-row.is-selected").evaluateAll((rows) =>
    rows.map((r) => ({ id: r.dataset.id, aria: r.getAttribute("aria-selected") })));
  const headDetail = (await pageLog.locator("#gw-commit-detail .gw-commit-detail-head").textContent()) ?? "";
  const firstDiffCall = await pageLog.evaluate(() => (window.__gitCommitDiffCalls ?? [])[0]);
  check("HEAD commit is auto-selected when history first shows",
    selectedRows.length === 1 && selectedRows[0].id === "abc1234000" && selectedRows[0].aria === "true" &&
      headDetail.includes("add thing") && headDetail.includes("abc1234000") &&
      firstDiffCall?.root === "/repo" && firstDiffCall?.hash === "abc1234",
    `selected=${JSON.stringify(selectedRows)} head="${headDetail}" call=${JSON.stringify(firstDiffCall)}`);
  // インライン詳細: ファイル一覧と行番号つきのパッチ
  const detailBody = pageLog.locator("#gw-commit-detail .gw-commit-detail-body");
  const oldLineNumbers = (await detailBody.locator(".commit-line-no.old").allTextContents()).join(" ");
  const newLineNumbers = (await detailBody.locator(".commit-line-no.new").allTextContents()).join(" ");
  check("inline commit detail shows the changed files and a readable patch",
    await detailBody.locator(".commit-file-nav-item").count() === 2 &&
      await detailBody.locator(".commit-file").count() === 1 &&
      ((await detailBody.locator(".commit-file-path").textContent()) ?? "") === "src/app.ts" &&
      await detailBody.locator(".commit-diff-line.hunk").count() === 1 &&
      await detailBody.locator(".commit-diff-line.add").count() === 2 &&
      await detailBody.locator(".commit-diff-line.del").count() === 1 &&
      oldLineNumbers.includes("1") && newLineNumbers.includes("1"),
    `text="${(await detailBody.textContent())?.slice(0, 200)}"`);
  await detailBody.locator(".commit-file-nav-item").nth(1).click();
  const selectedPatchText = (await detailBody.locator(".commit-patches").textContent()) ?? "";
  check("inline commit file navigation shows only the selected file patch",
    await detailBody.locator(".commit-file-nav-item").nth(1).evaluate((el) => el.classList.contains("is-active")) &&
      ((await detailBody.locator(".commit-file-path").textContent()) ?? "") === "README.md" &&
      selectedPatchText.includes("new docs") && !selectedPatchText.includes("new line") &&
      (await detailBody.locator(".commit-line-no.old").allTextContents()).join(" ").includes("10"));
  // 行クリックは選択 + インライン詳細（差分オーバーレイは開かない）
  await pageLog.locator("#gw-log .git-commit-row").nth(1).click();
  await pageLog.waitForFunction(() =>
    document.querySelector("#gw-commit-detail .gw-commit-detail-head")?.textContent?.includes("other branch work"),
    null, { timeout: 3000 }).catch(() => {});
  const clickedDiffCall = await pageLog.evaluate(() => (window.__gitCommitDiffCalls ?? []).at(-1));
  check("clicking a commit selects it and shows its detail inline instead of an overlay",
    await pageLog.locator("#gw-log .git-commit-row").nth(1).getAttribute("aria-selected") === "true" &&
      await pageLog.locator("#gw-log .git-commit-row.is-selected").count() === 1 &&
      await pageLog.locator("#diff-overlay").isHidden() &&
      clickedDiffCall?.hash === "fed9876",
    `call=${JSON.stringify(clickedDiffCall)}`);
  await pageLog.keyboard.press("ArrowDown");
  const afterDown = await pageLog.locator("#gw-log .git-commit-row.is-selected").getAttribute("data-id");
  await pageLog.keyboard.press("ArrowUp");
  await pageLog.keyboard.press("ArrowUp");
  const afterUp = await pageLog.locator("#gw-log .git-commit-row.is-selected").getAttribute("data-id");
  check("arrow keys move the commit selection",
    afterDown === "def5678000" && afterUp === "abc1234000" &&
      await pageLog.locator("#git-window-overlay").isVisible(),
    `down=${afterDown} up=${afterUp}`);

  // 検索: 一致だけを並べ、グラフ列を外す
  await pageLog.locator("#gw-search").fill("initial");
  check("search filters commits and drops the graph column",
    await pageLog.locator("#gw-log .git-commit-row").count() === 1 &&
      await pageLog.locator("#gw-log svg.git-graph").count() === 0 &&
      ((await pageLog.locator("#gw-log .git-commit-row").textContent()) ?? "").includes("def5678"));
  await pageLog.locator("#gw-search").fill("");
  check("clearing search restores the graph",
    await pageLog.locator("#gw-log svg.git-graph").count() === 3);
  await pageLog.locator("#gw-nav-search").click();
  check("Search nav opens history with the search box focused",
    await pageLog.locator("#gw-nav-search").getAttribute("aria-current") === "page" &&
      await pageLog.locator("#gw-view-history").isVisible() &&
      await pageLog.locator("#gw-search").evaluate((el) => document.activeElement === el));

  // サイドバー: タグ / ブランチをクリックすると履歴でそのコミットへ飛ぶ
  await pageLog.waitForSelector('#gw-tag-tree .gw-tree-leaf[data-ref="v0.9"]', { timeout: 5000 }).catch(() => {});
  check("sidebar lists branches, remotes and tags from git_refs",
    await pageLog.evaluate(() => (window.__gitRefsCalls ?? []).includes("/repo")) &&
      await pageLog.locator('#gw-branch-tree .gw-tree-leaf[data-ref="feat/x"]').count() === 1 &&
      await pageLog.locator('#gw-remote-tree .gw-tree-leaf[data-ref="origin/main"]').count() === 1 &&
      await pageLog.locator("#gw-tag-tree .gw-tree-leaf").count() === 2,
    `refs=${JSON.stringify(await pageLog.locator("#gw-side .gw-tree-leaf").evaluateAll((els) => els.map((e) => e.dataset.ref)))}`);
  await pageLog.locator("#gw-nav-status").click();
  await pageLog.locator('#gw-tag-tree .gw-tree-leaf[data-ref="v0.9"]').click();
  await pageLog.waitForFunction(() =>
    document.querySelector("#gw-commit-detail .gw-commit-detail-head")?.textContent?.includes("initial commit"),
    null, { timeout: 3000 }).catch(() => {});
  check("clicking a tag in the sidebar reveals the tagged commit in history",
    await pageLog.locator("#gw-nav-history").getAttribute("aria-current") === "page" &&
      await pageLog.locator("#gw-view-history").isVisible() &&
      await pageLog.locator("#gw-log .git-commit-row.is-selected").getAttribute("data-id") === "def5678000" &&
      ((await pageLog.locator("#gw-commit-detail .gw-commit-detail-head").textContent()) ?? "").includes("initial commit"));
  await pageLog.locator('#gw-branch-tree .gw-tree-leaf[data-ref="main"]').click();
  await pageLog.waitForFunction(() =>
    document.querySelector("#gw-log .git-commit-row.is-selected")?.dataset.id === "fed9876000",
    null, { timeout: 3000 }).catch(() => {});
  check("clicking a branch in the sidebar reveals its tip commit",
    await pageLog.locator("#gw-log .git-commit-row.is-selected").getAttribute("data-id") === "fed9876000");
  await pageLog.locator('#gw-branch-tree .gw-tree-leaf[data-ref="stale"]').click();
  await pageLog.waitForTimeout(200);
  const staleMsg = (await pageLog.locator("#git-toast .git-toast-detail").textContent()) ?? "";
  check("a ref whose commit is not in the history reports it instead of selecting something else",
    staleMsg.includes("履歴に含まれていません") &&
      await pageLog.locator("#gw-log .git-commit-row.is-selected").getAttribute("data-id") === "fed9876000",
    `msg="${staleMsg}"`);

  // 各ビューが Git ウィンドウの広い領域にその場の内容を出す
  const liveViews = [
    { nav: "issues", view: "#gw-view-issues", ready: "#gw-issues .issue-row", title: "Issue", refresh: "Issueを更新" },
    { nav: "prs", view: "#gw-view-prs", ready: "#gw-prs .pr-list-row", title: "PR", refresh: "PRを更新" },
    { nav: "worktrees", view: "#gw-view-worktrees", ready: "#gw-worktrees .wt-row", title: "Worktree",
      refresh: "worktree一覧を更新" },
    { nav: "history", view: "#gw-view-history", ready: "#gw-log .git-commit-row", title: "History", refresh: "更新" },
  ];
  for (const v of liveViews) {
    await pageLog.locator(`#gw-nav-${v.nav}`).click();
    const ready = await pageLog.waitForSelector(v.ready, { timeout: 3000 }).then(() => true, () => false);
    const viewBox = await pageLog.locator(v.view).boundingBox();
    const shown = await pageLog.evaluate(() =>
      [...document.querySelectorAll("#gw-main .gw-view")].filter((el) => !el.hidden).map((el) => el.id));
    const refreshTitle = await pageLog.locator("#gw-refresh").getAttribute("title");
    check(`${v.title} nav shows its live content in the large Git window view`,
      ready && JSON.stringify(shown) === JSON.stringify([v.view.slice(1)]) &&
        await pageLog.locator(`#gw-nav-${v.nav}`).getAttribute("aria-current") === "page" &&
        Boolean(viewBox && viewBox.width >= 700 && viewBox.height >= 500) &&
        refreshTitle === v.refresh,
      `shown=${JSON.stringify(shown)} box=${JSON.stringify(viewBox)} refresh="${refreshTitle}"`);
  }

  // 右クリックメニュー: Escape はメニューだけ閉じる。「変更ファイル」は差分オーバーレイで開く
  await pageLog.locator("#gw-log .git-commit-row").first().click({ button: "right" });
  const commitCtxText = (await pageLog.locator("#git-commit-ctx").textContent()) ?? "";
  check("commit context menu offers changed files and rollback",
    commitCtxText.includes("変更ファイルの内容を表示") && commitCtxText.includes("このコミットまで巻き戻す"),
    `menu="${commitCtxText}"`);
  await pageLog.keyboard.press("Escape");
  check("Escape closes only the commit context menu",
    await pageLog.locator("#git-commit-ctx").count() === 0 &&
      await pageLog.locator("#git-window-overlay").isVisible());
  await pageLog.locator("#gw-log .git-commit-row").first().click({ button: "right" });
  await pageLog.locator("#git-commit-ctx button").first().click();
  await pageLog.waitForSelector("#diff-overlay:not([hidden])", { timeout: 3000 });
  const ctxDiffCall = await pageLog.evaluate(() => (window.__gitCommitDiffCalls ?? []).at(-1));
  const commitDiffTitle = (await pageLog.locator("#diff-path").textContent()) ?? "";
  const commitDiffStats = (await pageLog.locator("#diff-stats").textContent()) ?? "";
  const commitDiffBody = (await pageLog.locator("#diff-body").textContent()) ?? "";
  const commitPanelBox = await pageLog.locator("#diff-panel").boundingBox();
  check("context menu changed-files action opens the commit diff overlay",
    ctxDiffCall?.root === "/repo" && ctxDiffCall?.hash === "abc1234" &&
      commitDiffTitle.includes("abc1234") && commitDiffTitle.includes("add thing") &&
      commitDiffStats.includes("+3") && commitDiffStats.includes("-2") &&
      commitDiffBody.includes("src/app.ts") && commitDiffBody.includes("README.md") &&
      await pageLog.locator("#diff-body .commit-file-nav-item").count() === 2 &&
      commitPanelBox?.width > 1100 && commitPanelBox?.height > 700,
    `call=${JSON.stringify(ctxDiffCall)} title="${commitDiffTitle}" box=${JSON.stringify(commitPanelBox)}`);
  await pageLog.keyboard.press("Escape");
  check("Escape closes the diff opened over the Git window without closing the window",
    !(await pageLog.locator("#diff-overlay").isVisible()) &&
      await pageLog.locator("#git-window-overlay").isVisible());
  const focusAfterDiff = await pageLog.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}#${el.id}.${el.className}` : "none";
  });
  await pageLog.keyboard.press("Escape");
  check("a second Escape closes the Git window",
    await pageLog.locator("#git-window-overlay").isHidden(), `focus after diff close=${focusAfterDiff}`);
  if (await pageLog.locator("#git-window-overlay").isVisible()) await pageLog.locator("#gw-close").click();
  await pageLog.locator("#git-open").click();
  await pageLog.waitForSelector("#git-window-overlay:not([hidden])");
  check("reopening the Git window keeps the last view",
    await pageLog.locator("#gw-nav-history").getAttribute("aria-current") === "page" &&
      await pageLog.locator("#gw-view-history").isVisible());

  // Issue タブ → 一覧 → 本文・全コメント
  await pageLog.locator("#gw-nav-issues").click();
  await pageLog.waitForSelector("#gw-issues .issue-row", { timeout: 3000 });
  const issueListCall = await pageLog.evaluate(() => (window.__issueListCalls ?? [])[0]);
  const issueRows = await pageLog.locator("#gw-issues .issue-row").count();
  const issueListText = (await pageLog.locator("#gw-issues").textContent()) ?? "";
  check("Issue tab lists repository issues",
    issueListCall === "/repo" && issueRows === 2 && issueListText.includes("Fix quoted startup") &&
      issueListText.includes("bug"),
    `root=${issueListCall} rows=${issueRows}`);
  check("closed issues are left out of the Issue tab",
    !issueListText.includes("Closed issue"), `list="${issueListText}"`);
  const issueAssignees = await pageLog.locator("#gw-issues .issue-assignee").allTextContents();
  const issueLabels = await pageLog.locator("#gw-issues .issue-label").allTextContents();
  const unassignedCount = await pageLog.locator("#gw-issues .issue-assignee.is-unassigned").count();
  check("Issue rows show assignees, unassigned status and labels",
    issueAssignees.includes("@alice") && issueAssignees.includes("@bob") &&
      unassignedCount === 1 &&
      issueLabels.includes("bug") && issueLabels.includes("terminal"),
    `assignees=${JSON.stringify(issueAssignees)} unassigned=${unassignedCount} labels=${JSON.stringify(issueLabels)}`);
  // PR バッジはどのビューでもヘッダーに出る（現在のブランチの PR）
  await pageLog.waitForSelector("#gw-pr:not([hidden])", { timeout: 8000 }).catch(() => {});
  check("PR badge stays visible while the Issues view is active", await pageLog.locator("#gw-pr").isVisible());
  // Issue タブの作成ボタン → タイトル・本文・複数添付を1回の GitHub 作成コマンドへ渡す
  check("Issue tab exposes the create action",
    await pageLog.locator("#gw-create-issue").isVisible() &&
      (await pageLog.locator("#gw-create-issue").textContent())?.trim() === "作成");
  await pageLog.locator("#gw-create-issue").click();
  check("Issue create action opens an accessible modal",
    await pageLog.locator("#issue-create-panel[role=dialog][aria-modal=true]").isVisible() &&
      await pageLog.locator("#issue-create-title").evaluate((element) => document.activeElement === element));
  await pageLog.locator("#issue-create-title").fill("Report terminal crash");
  await pageLog.locator("#issue-create-description").fill("Steps\n1. Open a pane\n2. Run the command");
  await pageLog.locator("#issue-create-add-files").click();
  const pickedFiles = await pageLog.locator("#issue-create-file-list .issue-create-file span").allTextContents();
  check("Issue create modal accepts multiple attachments from the native picker",
    JSON.stringify(pickedFiles) === JSON.stringify(["screenshot.png", "trace.log"]),
    `files=${JSON.stringify(pickedFiles)}`);
  await pageLog.locator("#issue-create-submit").click();
  await pageLog.waitForFunction(() => (window.__issueCreateCalls ?? []).length > 0);
  const issueCreateCall = await pageLog.evaluate(() => window.__issueCreateCalls.at(-1));
  await pageLog.waitForSelector("#issue-create-overlay", { state: "hidden" });
  check("Issue create submits title, body and attachment paths to the watched repository",
    issueCreateCall?.root === "/repo" && issueCreateCall?.title === "Report terminal crash" &&
      issueCreateCall?.body === "Steps\n1. Open a pane\n2. Run the command" &&
      JSON.stringify(issueCreateCall?.attachmentPaths) ===
        JSON.stringify(["/tmp/screenshot.png", "/tmp/trace.log"]),
    `call=${JSON.stringify(issueCreateCall)}`);
  check("Issue create closes the modal and refreshes the Issue list after success",
    !(await pageLog.locator("#issue-create-overlay").isVisible()) &&
      (await pageLog.evaluate(() => (window.__issueListCalls ?? []).length)) >= 2);
  await pageLog.locator("#gw-issues .issue-row").first().click();
  await pageLog.waitForSelector("#issue-overlay:not([hidden]) .issue-body", { timeout: 3000 });
  const issueInfoCall = await pageLog.evaluate(() => (window.__issueInfoCalls ?? [])[0]);
  const issueDetailText = (await pageLog.locator("#issue-overlay").textContent()) ?? "";
  check("Issue detail opens in a modal while the list stays intact",
    await pageLog.locator("#issue-panel[role=dialog][aria-modal=true]").isVisible() &&
      await pageLog.locator("#gw-issues .issue-row").count() === 2);
  check("Issue detail shows body, labels and every comment",
    issueInfoCall?.root === "/repo" && issueInfoCall?.number === 42 &&
      issueDetailText.includes("Handle a 'quoted' value") &&
      issueDetailText.includes("Also cover the Codex path in tests.") &&
      issueDetailText.includes("Use the whole issue, please."),
    `call=${JSON.stringify(issueInfoCall)}`);
  await pageLog.keyboard.press("Escape");
  check("Escape closes the Issue detail modal but keeps the Git window open",
    !(await pageLog.locator("#issue-overlay").isVisible()) &&
      await pageLog.locator("#git-window-overlay").isVisible());
  await pageLog.locator("#gw-issues .issue-row").first().focus();
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
  check("Issue action defaults to worktree mode with the repository default branch",
    await pageLog.locator(".issue-worktree-toggle input").isChecked() &&
      await pageLog.locator(".issue-worktree-fields").isVisible() &&
      await pageLog.locator(".issue-worktree-fields select").inputValue() === "refs/remotes/origin/main");
  const issueLocRadios = pageLog.locator(".issue-worktree-fields input[name^=issue-worktree-loc]");
  const issueRadioBoxes = await issueLocRadios.evaluateAll((radios) =>
    radios.map((radio) => {
      const box = radio.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    }));
  check("Issue location radios keep their native size instead of the text-input styling",
    issueRadioBoxes.length === 2 && issueRadioBoxes.every((box) => box.w > 0 && box.w <= 24 && box.h <= 24),
    `boxes=${JSON.stringify(issueRadioBoxes)}`);
  // 環境ファイル（gitignore 対象）の引き継ぎも Worktree モーダルと同じラジオで選べ、既定は「引き継ぐ」
  check("Issue form offers the inherit-ignored-files choice and defaults to inheriting",
    await pageLog.locator(".issue-worktree-fields input[name^=issue-worktree-inherit]").count() === 2 &&
      await pageLog.locator(".issue-worktree-fields input[name^=issue-worktree-inherit][value=yes]").isChecked() &&
      await pageLog.locator("#issue-worktree-progress").isHidden());
  // チェックを外せば従来どおりリポジトリルートの通常セッションも作れる
  await pageLog.locator(".issue-worktree-toggle input").uncheck();
  await pageLog.locator(".issue-session-note").fill("課題メモ\n次の作業");
  const spawnBeforeIssue = await pageLog.evaluate(() => window.__ptySpawns.length);
  await issueActionButtons.click();
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnBeforeIssue);
  check("creating a session from an Issue closes the Git window",
    await pageLog.locator("#git-window-overlay").isHidden());
  check("Issue without worktree passes the multiline note",
    await pageLog.locator(".ws-item.is-active .ws-note-display").textContent() === "課題メモ\n次の作業");
  const issueSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  check("Issue action creates a default-shell session at repository root",
    issueSpawn?.shell === null && issueSpawn?.cwd === "/repo" && issueSpawn?.args === null,
    `spawn=${JSON.stringify({ shell: issueSpawn?.shell, cwd: issueSpawn?.cwd, args: issueSpawn?.args })}`);
  const issueSessionName = ((await pageLog.locator(".ws-item.is-active .ws-name").textContent()) ?? "").trim();
  check("Issue session keeps the issue number and title in its name",
    issueSessionName === "#42 Fix quoted startup", `name=${issueSessionName}`);
  // worktree モード: 選択したベースブランチから作成し、その cwd で通常セッションを開始
  await pageLog.locator(".issue-worktree-toggle input").check();
  await pageLog.locator(".issue-worktree-fields select").selectOption("refs/heads/feat/x");
  await pageLog.locator(".issue-worktree-branch").fill("issue/42-custom");
  check("worktree location defaults outside the repository",
    await pageLog.locator(".issue-worktree-directory").inputValue() === "~/worktrees" &&
      await pageLog.locator(".issue-worktree-fields .wt-loc input[value=outside]").isChecked());
  // 配下モードへ切り替えるとそのモードの既定（.worktree）に戻る
  await pageLog.locator(".issue-worktree-fields .wt-loc input[value=inside]").check();
  check("switching the issue form to inside restores .worktree",
    await pageLog.locator(".issue-worktree-directory").inputValue() === ".worktree");
  const spawnBeforeWorktree = await pageLog.evaluate(() => window.__ptySpawns.length);
  await pageLog.locator(".issue-worktree-fields input[name^=issue-worktree-inherit][value=no]").check();
  const issueSuccessResult = await pageLog.evaluate(() => window.__mockWorktreeResult);
  await pageLog.evaluate(() => { window.__mockWorktreeResult = { error: "issue worktree failed" }; });
  await pageLog.locator(".issue-session-actions button").click();
  await pageLog.waitForSelector(".issue-run-message.is-error");
  check("Issue failure preserves editable note and saves inherit choice",
    await pageLog.locator(".issue-session-note").inputValue() === "課題メモ\n次の作業" &&
    await pageLog.locator(".issue-session-note").isEnabled() &&
    await pageLog.evaluate(async () => (await import("/src/features/git/worktree.ts")).getWorktreePrefs().inherit === false));
  await pageLog.evaluate(result => { window.__mockWorktreeResult = result; }, issueSuccessResult);
  await pageLog.evaluate(() => { window.__mockWorktreeCreateDelay = 150; });
  await pageLog.locator(".issue-session-actions button").click();
  // 作成中は Worktree モーダルと同じく、ボタンが「準備中」になり入力とラジオが止まり、
  // パネルの上にローディングが重なる
  check("Issue worktree creation shows progress and disables the form while it runs",
    ((await pageLog.locator(".issue-session-actions button").textContent()) ?? "").includes("準備中") &&
      await pageLog.locator(".issue-session-actions button").isDisabled() &&
      await pageLog.locator(".issue-session-note").isDisabled() &&
      await pageLog.locator(".issue-worktree-fields select").isDisabled() &&
      await pageLog.locator(".issue-worktree-fields .wt-loc input[value=inside]").isDisabled() &&
      await pageLog.locator(".issue-worktree-fields input[name^=issue-worktree-inherit][value=yes]").isDisabled() &&
      await pageLog.locator("#issue-worktree-progress").isVisible() &&
      ((await pageLog.locator("#issue-worktree-progress-title").textContent()) ?? "").includes("作成中") &&
      await pageLog.locator("#git-worktree").isDisabled());
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnBeforeWorktree);
  await pageLog.evaluate(() => { window.__mockWorktreeCreateDelay = 0; });
  check("Issue worktree progress overlay disappears once the session is created",
    await pageLog.locator("#issue-worktree-progress").isHidden());
  check("Issue worktree passes the note",
    await pageLog.locator(".ws-item.is-active .ws-note-display").textContent() === "課題メモ\n次の作業");
  const worktreeCall = await pageLog.evaluate(() => (window.__worktreeCreateCalls ?? []).at(-1));
  const worktreeSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  check("worktree action uses selected base, new branch, and inherit choice",
    worktreeCall?.root === "/repo" && worktreeCall?.baseRef === "refs/heads/feat/x" &&
      worktreeCall?.branch === "issue/42-custom" && worktreeCall?.directory === ".worktree" &&
      worktreeCall?.location === "inside" && worktreeCall?.inherit === false,
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
  const savedWorktreePrefs = await pageLog.evaluate(() => JSON.parse(window.__savedSession).settings?.worktree);
  check("Issue action persists the location and inherit choice but not the base branch (it always starts at the default branch)",
    savedWorktreePrefs?.location === "inside" && savedWorktreePrefs?.insideDir === ".worktree" &&
      savedWorktreePrefs?.inherit === false && savedWorktreePrefs?.issueBaseRef === undefined,
    `worktree=${JSON.stringify(savedWorktreePrefs)}`);
  check("Issue body is not injected into or persisted with the new session",
    savedIssueSession?.root?.args === undefined &&
      !(await pageLog.evaluate(() => window.__savedSession.includes("touch /tmp/bad"))));
  await pageLog.locator("#issue-close").click();
  await ensureGitWindow();
  check("Issue close button returns to the list", !(await pageLog.locator("#issue-overlay").isVisible()) &&
    await pageLog.locator("#gw-nav-issues").getAttribute("aria-current") === "page" &&
    await pageLog.locator("#gw-issues .issue-row").count() === 2);
  await pageLog.locator("#gw-issues .issue-row").first().click();
  await pageLog.waitForSelector("#issue-overlay:not([hidden]) .issue-worktree-fields:not([hidden])", { timeout: 3000 });
  check("reopening an Issue keeps worktree mode and starts again from the default branch",
    await pageLog.locator(".issue-worktree-toggle input").isChecked() &&
      await pageLog.locator(".issue-worktree-fields select").inputValue() === "refs/remotes/origin/main");
  await pageLog.locator("#issue-close").click();

  // PR タブ → リポジトリのPR一覧 → 本文とコミット差分共通デザインのファイル差分
  await pageLog.locator("#gw-nav-prs").click();
  await pageLog.waitForSelector("#gw-prs .pr-list-row", { timeout: 3000 });
  const prListCall = await pageLog.evaluate(() => (window.__prListCalls ?? [])[0]);
  const prListText = (await pageLog.locator("#gw-prs").textContent()) ?? "";
  check("PR tab lists repository pull requests next to Branch and Issue",
    prListCall === "/repo" && await pageLog.locator("#gw-prs .pr-list-row").count() === 2 &&
      prListText.includes("Add thing") && prListText.includes("feat/x") && prListText.includes("main") &&
      prListText.includes("Open"),
    `root=${prListCall} list="${prListText}"`);
  const prListStateLayout = await pageLog.locator("#gw-prs .pr-list-row").first().evaluate((row) => {
    const state = row.querySelector(".pr-list-state");
    const rowBox = row.getBoundingClientRect();
    const stateBox = state.getBoundingClientRect();
    return {
      text: state.textContent,
      width: stateBox.width,
      rightGap: rowBox.right - stateBox.right,
      padRight: parseFloat(getComputedStyle(row).paddingRight),
      justifySelf: getComputedStyle(state).justifySelf,
    };
  });
  check("PR Open label is compact and aligned at the right edge",
    prListStateLayout.text === "Open" && prListStateLayout.width < 32 &&
      prListStateLayout.rightGap <= prListStateLayout.padRight + 1 && prListStateLayout.justifySelf === "end",
    `layout=${JSON.stringify(prListStateLayout)}`);
  const prListTitleLayout = await pageLog.locator("#gw-prs .pr-list-row").first().evaluate((row) => {
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
  check("PR badge stays visible while the PRs view is active", await pageLog.locator("#gw-pr").isVisible());
  const prBranchTexts = await pageLog.locator("#gw-prs .pr-list-branches").allTextContents();
  const prBranchTitle = await pageLog.locator("#gw-prs .pr-list-branches").nth(1).getAttribute("title");
  check("long PR branch names collapse to \"branch\" in the list, full names stay in the tooltip",
    prBranchTexts[0] === "feat/x → main" && prBranchTexts[1] === "branch → main" &&
      prBranchTitle === "fix/very-long-branch-name-for-the-list → main",
    `texts=${JSON.stringify(prBranchTexts)} title=${prBranchTitle}`);

  // 一覧のボタンは詳細を開かず、変更ストリップと同じ Worktree モーダルを PR モードで開く。
  // 置き場所ラジオ・読み込み中の無効化・既存 worktree 一覧が同じ画面で出ること、gh を
  // 呼び直さず一覧の PR がそのまま選べることを確認する。
  await pageLog.evaluate(() => {
    window.__mockWorktreeFromPrResult = {
      path: "/repo/.worktree/feat-x",
      branch: "feat/x",
      reused: false,
    };
    window.__mockWorktreeFromPrDelay = 600;
  });
  const prDetailCallsBeforeListSession = await pageLog.evaluate(() => (window.__prDetailCalls ?? []).length);
  const prListCallsBeforeListSession = await pageLog.evaluate(() => (window.__prListCalls ?? []).length);
  const prWorktreeCallsBeforeListSession = await pageLog.evaluate(() => (window.__worktreeFromPrCalls ?? []).length);
  const spawnsBeforeListSession = await pageLog.evaluate(() => window.__ptySpawns.length);
  await pageLog.locator("#gw-prs .pr-list-row").first().locator(".pr-list-session").click();
  await pageLog.waitForSelector("#worktree-overlay:not([hidden])", { timeout: 3000 });
  await pageLog.waitForFunction(() => !document.querySelector("#worktree-submit").disabled, null, { timeout: 3000 });
  const prDialogOptions = await pageLog.locator("#worktree-pr option").allTextContents();
  check("PR list action opens the shared worktree modal in PR mode with that PR selected",
    await pageLog.locator("#worktree-source input[value=pr]").isChecked() &&
      await pageLog.locator("#worktree-pr").inputValue() === "12" &&
      prDialogOptions.length === 2 && prDialogOptions[0] === "#12 Add thing" &&
      await pageLog.locator("#worktree-base-field").isHidden() &&
      await pageLog.locator("#worktree-loc input[type=radio]").count() === 2 &&
      await pageLog.locator("#worktree-loc input[value=inside]").isChecked() &&
      await pageLog.locator("#worktree-directory").inputValue() === ".worktree" &&
      await pageLog.locator("#worktree-list .wt-row").count() >= 1 &&
      await pageLog.evaluate((before) => (window.__prListCalls ?? []).length === before, prListCallsBeforeListSession) &&
      await pageLog.evaluate((before) => (window.__prDetailCalls ?? []).length === before, prDetailCallsBeforeListSession),
    `options=${JSON.stringify(prDialogOptions)} pr=${await pageLog.locator("#worktree-pr").inputValue()}`);
  await pageLog.locator("#worktree-note").fill("PRメモ\n確認する");
  await pageLog.locator("#worktree-submit").click();
  check("PR worktree creation shows progress in the modal and blocks a second submit",
    await pageLog.locator("#worktree-submit").isDisabled() &&
      await pageLog.locator("#worktree-pr").isDisabled() &&
      await pageLog.locator("#worktree-loc input[value=outside]").isDisabled() &&
      await pageLog.locator("#git-worktree").isDisabled());
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnsBeforeListSession);
  check("PR session displays the multiline note",
    await pageLog.locator(".ws-item.is-active .ws-note-display").textContent() === "PRメモ\n確認する");
  const listPrWorktreeCall = await pageLog.evaluate(() => (window.__worktreeFromPrCalls ?? []).at(-1));
  const listPrSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  const listPrSessionName = ((await pageLog.locator(".ws-item.is-active .ws-name").textContent()) ?? "").trim();
  check("PR modal passes the PR and the chosen worktree destination",
    await pageLog.evaluate((before) => (window.__worktreeFromPrCalls ?? []).length === before + 1,
      prWorktreeCallsBeforeListSession) &&
      listPrWorktreeCall?.root === "/repo" && listPrWorktreeCall?.number === 12 &&
      listPrWorktreeCall?.branch === "feat/x" && listPrWorktreeCall?.directory === ".worktree" &&
      listPrWorktreeCall?.location === "inside" && listPrWorktreeCall?.inherit === false,
    `call=${JSON.stringify(listPrWorktreeCall)}`);
  check("successful PR creation closes the modal and the Git window and focuses a named default-shell session",
    await pageLog.locator("#worktree-overlay").isHidden() &&
      !(await pageLog.locator("#git-window-overlay").isVisible()) &&
      listPrSpawn?.shell === null && listPrSpawn?.cwd === "/repo/.worktree/feat-x" &&
      listPrSpawn?.args === null && listPrSessionName === "#12 Add thing" &&
      await pageLog.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")),
    `spawn=${JSON.stringify(listPrSpawn)} name=${listPrSessionName}`);

  // 詳細側は失敗時にモーダルと理由を残し、同じ画面から再実行できる。
  await ensureGitWindow();
  await pageLog.locator("#gw-prs .pr-list-row").first().click();
  await pageLog.waitForSelector("#pr-overlay:not([hidden]) #pr-files .commit-file-nav-item", { timeout: 3000 });
  await pageLog.evaluate(() => {
    window.__mockWorktreeFromPrDelay = 0;
    window.__mockWorktreeFromPrResult = { error: "fetch failed for pull/12/head" };
  });
  const spawnsBeforePrFailure = await pageLog.evaluate(() => window.__ptySpawns.length);
  await pageLog.locator("#pr-new-session").click();
  await pageLog.waitForSelector("#worktree-overlay:not([hidden])", { timeout: 3000 });
  await pageLog.waitForFunction(() => !document.querySelector("#worktree-submit").disabled, null, { timeout: 3000 });
  check("PR detail action opens the same modal above the detail with that PR selected",
    await pageLog.locator("#pr-overlay").isVisible() &&
      await pageLog.locator("#worktree-source input[value=pr]").isChecked() &&
      await pageLog.locator("#worktree-pr").inputValue() === "12");
  await pageLog.locator("#worktree-note").fill("PRメモ\n確認する");
  await pageLog.locator("#worktree-submit").click();
  await pageLog.waitForSelector("#worktree-error:not([hidden])", { timeout: 3000 });
  check("PR failure retains the editable note",
    await pageLog.locator("#worktree-note").inputValue() === "PRメモ\n確認する" &&
    await pageLog.locator("#worktree-note").isEnabled());
  const prSessionFailure = (await pageLog.locator("#worktree-error").textContent()) ?? "";
  check("failed PR worktree creation keeps modal and detail open, shows the reason, and allows retry",
    await pageLog.locator("#worktree-overlay").isVisible() &&
      await pageLog.locator("#pr-overlay").isVisible() &&
      await pageLog.locator("#git-window-overlay").isVisible() &&
      prSessionFailure.includes("fetch failed for pull/12/head") &&
      await pageLog.locator("#worktree-submit").isEnabled() &&
      await pageLog.evaluate((before) => window.__ptySpawns.length === before, spawnsBeforePrFailure),
    `error=${JSON.stringify(prSessionFailure)}`);
  // Escape はモーダルだけを閉じ、その下の PR 詳細は残る
  await pageLog.keyboard.press("Escape");
  check("Escape closes only the worktree modal and leaves the PR detail open",
    await pageLog.locator("#worktree-overlay").isHidden() && await pageLog.locator("#pr-overlay").isVisible());
  await pageLog.evaluate(() => {
    window.__mockWorktreeFromPrResult = {
      path: "/existing/feat-x",
      branch: "feat/x",
      reused: true,
    };
  });
  const prWorktreeCallsBeforeRetry = await pageLog.evaluate(() => (window.__worktreeFromPrCalls ?? []).length);
  const spawnsBeforePrRetry = await pageLog.evaluate(() => window.__ptySpawns.length);
  await pageLog.locator("#pr-new-session").click();
  await pageLog.waitForSelector("#worktree-overlay:not([hidden])", { timeout: 3000 });
  await pageLog.waitForFunction(() => !document.querySelector("#worktree-submit").disabled, null, { timeout: 3000 });
  await pageLog.locator("#worktree-note").fill("PRメモ\n確認する");
  await pageLog.locator("#worktree-submit").click();
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnsBeforePrRetry);
  const reusedPrSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  check("PR detail retry reuses the returned worktree and closes into a fresh regular session",
    await pageLog.evaluate((before) => (window.__worktreeFromPrCalls ?? []).length === before + 1,
      prWorktreeCallsBeforeRetry) &&
      await pageLog.locator("#worktree-overlay").isHidden() &&
      !(await pageLog.locator("#pr-overlay").isVisible()) &&
      !(await pageLog.locator("#git-window-overlay").isVisible()) &&
      reusedPrSpawn?.shell === null && reusedPrSpawn?.cwd === "/existing/feat-x" &&
      reusedPrSpawn?.args === null &&
      ((await pageLog.locator(".ws-item.is-active .ws-name").textContent()) ?? "").trim() === "#12 Add thing",
    `spawn=${JSON.stringify(reusedPrSpawn)}`);

  // 既存の詳細・diff 表示検証用に開き直す。
  await ensureGitWindow();
  await pageLog.locator("#gw-prs .pr-list-row").first().click();
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
  check("Escape closes PR detail opened from the list but keeps the Git window open",
    !(await pageLog.locator("#pr-overlay").isVisible()) &&
      await pageLog.locator("#git-window-overlay").isVisible());

  // 取得失敗: gh の理由をそのまま出し、直前まで見えていた一覧は消さない
  await pageLog.evaluate(() => {
    window.__mockPrList = {
      available: false,
      prs: [],
      error: "gh: To get started with GitHub CLI, please run: gh auth login",
    };
  });
  await pageLog.locator("#gw-refresh").click();
  await pageLog.waitForSelector("#gw-prs .pr-list-error", { timeout: 3000 });
  const prErrText = (await pageLog.locator("#gw-prs .pr-list-error").textContent()) ?? "";
  check("PR list shows the gh failure reason instead of a generic message",
    prErrText.includes("gh auth login") && !prErrText.includes("PRはありません"),
    `err="${prErrText}"`);
  check("failed PR refresh keeps the pull requests already listed",
    await pageLog.locator("#gw-prs .pr-list-row").count() === 2);
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
  await pageLog.locator("#gw-prs .pr-list-retry").click();
  await pageLog.waitForSelector("#gw-prs .pr-list-error", { state: "detached", timeout: 3000 });
  check("PR list retry button refetches and clears the error",
    (await pageLog.evaluate(() => (window.__prListCalls ?? []).length)) >= 1 &&
      await pageLog.locator("#gw-prs .pr-list-row").count() === 2,
    `calls=${await pageLog.evaluate(() => JSON.stringify(window.__prListCalls ?? []))}`);

  // Worktree タブ → 同じ一覧を git パネルからも管理できる
  await pageLog.locator("#gw-nav-worktrees").click();
  await pageLog.waitForSelector("#gw-worktrees .wt-row", { timeout: 3000 });
  const panelListCall = await pageLog.evaluate(() => (window.__worktreeListCalls ?? []).at(-1));
  const panelWtText = (await pageLog.locator("#gw-worktrees").textContent()) ?? "";
  check("Worktree tab lists the repository worktrees",
    panelListCall?.root === "/repo"
      && await pageLog.locator("#gw-worktrees .wt-row").count() === 2
      && panelWtText.includes("feature/old")
      && panelWtText.includes("/repo/.worktree/feature-old")
      && await pageLog.locator("#gw-worktrees .wt-row").first().locator(".wt-del").count() === 0
      && await pageLog.locator("#gw-worktrees .wt-issue-open").count() === 2
      && await pageLog.locator("#gw-worktrees .wt-session-open").count() === 2,
    `call=${JSON.stringify(panelListCall)} text="${panelWtText}"`);

  // 各行の Issues の右隣から、その worktree を cwd にした通常セッションを開く
  const featureWt = pageLog.locator("#gw-worktrees .wt-row").nth(1);
  const worktreeActions = await featureWt.locator(":scope > .wt-actions > button").evaluateAll((buttons) =>
    buttons.map((button) => button.className));
  check("worktree row puts the new-session action to the right of Issues",
    worktreeActions[0] === "wt-issue-open" && worktreeActions[1] === "wt-session-open",
    `actions=${JSON.stringify(worktreeActions)}`);
  const spawnBeforeExistingWorktree = await pageLog.evaluate(() => window.__ptySpawns.length);
  await featureWt.locator(".wt-session-open").click();
  await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, spawnBeforeExistingWorktree);
  const existingWorktreeSpawn = await pageLog.evaluate(() => window.__ptySpawns.at(-1));
  const existingWorktreeSessionName =
    ((await pageLog.locator(".ws-item.is-active .ws-name").textContent()) ?? "").trim();
  check("worktree new-session action opens a default shell in that worktree",
    existingWorktreeSpawn?.shell === null
      && existingWorktreeSpawn?.cwd === "/repo/.worktree/feature-old"
      && existingWorktreeSpawn?.args === null
      && existingWorktreeSessionName === "feature/old",
    `spawn=${JSON.stringify(existingWorktreeSpawn)} name=${existingWorktreeSessionName}`);

  check("opening a worktree session closes the Git window",
    await pageLog.locator("#git-window-overlay").isHidden());
  // ルートに作る「セッションを作成」と違い、場所が決まっているのでフォルダーブラウザーは開かない
  await pageLog.waitForTimeout(150);
  check("opening a worktree session does not open the folder browser",
    (await pageLog.locator(".pathbar-pop").count()) === 0);
  await ensureGitWindow();
  await pageLog.waitForSelector("#gw-worktrees .wt-row", { timeout: 3000 });
  // 作成済み worktree のブランチを、Worktree ビューから後で open Issue に紐付ける
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
  await pageLog.locator("#gw-refresh").click();
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
  await pageLog.locator("#gw-refresh").click();
  await pageLog.waitForFunction(
    () => document.querySelectorAll("#gw-worktrees .wt-row").length === 3,
    null, { timeout: 3000 });
  const barPlace = await pageLog.evaluate(() => {
    const list = document.querySelector("#gw-worktrees");
    const bar = list?.querySelector(".wt-bar");
    const firstRow = list?.querySelector(".wt-row");
    const tabs = document.querySelector("#gw-view-worktrees .gw-view-head");
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
  check("worktree list puts one bulk bar between the view header and the rows",
    Boolean(barPlace && barPlace.isFirstChild && barPlace.belowTabs && barPlace.aboveRows
      && barPlace.checks === 2),
    `place=${JSON.stringify(barPlace)}`);
  const bulkDel = pageLog.locator("#gw-worktrees .wt-bulk-del");
  check("bulk delete is disabled until something is selected", await bulkDel.isDisabled());
  await pageLog.locator("#gw-worktrees .wt-bar-all input").check();
  const bulkLabel = (await bulkDel.textContent()) ?? "";
  check("select all checks every removable worktree and counts them",
    await pageLog.locator("#gw-worktrees .wt-check:checked").count() === 2
      && bulkLabel.includes("2") && !(await bulkDel.isDisabled()),
    `label="${bulkLabel}"`);
  await bulkDel.click();
  const bulkBeforeConfirm = await pageLog.evaluate(() => (window.__worktreeRemoveCalls ?? []).length);
  check("bulk delete only arms the confirmation",
    bulkBeforeConfirm === 0 && await pageLog.locator("#gw-worktrees .wt-bar .wt-confirm").isVisible(),
    `calls=${bulkBeforeConfirm}`);
  await pageLog.locator("#gw-worktrees .wt-bar .wt-yes").click();
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
  await pageLog.locator("#gw-worktrees .wt-bar-all input").check();
  await pageLog.locator("#gw-worktrees .wt-bulk-del").click();
  await pageLog.locator("#gw-worktrees .wt-bar .wt-yes").click();
  await pageLog.waitForSelector("#gw-worktrees .wt-bulk-error:not([hidden])", { timeout: 3000 });
  const bulkErr = (await pageLog.locator("#gw-worktrees .wt-bulk-error").textContent()) ?? "";
  check("a failed bulk removal keeps the failures selected and shows git's reason",
    bulkErr.includes("contains modified or untracked files")
      && bulkErr.includes("/repo/.worktree/feature-two")
      && await pageLog.locator("#gw-worktrees .wt-check:checked").count() === 2
      && await pageLog.locator("#gw-worktrees .wt-bar .wt-force").isVisible(),
    `err="${bulkErr}"`);
  await pageLog.locator("#gw-worktrees .wt-bar .wt-force").click();
  await pageLog.waitForTimeout(400);
  const forcedBulk = await pageLog.evaluate(() =>
    (window.__worktreeRemoveCalls ?? []).filter((c) => c.force === true));
  check("force remove retries only the worktrees that failed",
    forcedBulk.length === 2
      && forcedBulk.some((c) => c.path === "/repo/.worktree/feature-old")
      && forcedBulk.some((c) => c.path === "/repo/.worktree/feature-two"),
    `calls=${JSON.stringify(forcedBulk)}`);
  await pageLog.evaluate(() => { window.__mockWorktreeRemoveResult = undefined; });

  // 履歴へ戻す → 右クリックの巻き戻しは二段階確認
  await pageLog.locator("#gw-nav-history").click();
  await pageLog.waitForSelector("#gw-log .git-commit-row", { timeout: 3000 });
  check("History nav restores commit history", await pageLog.locator("#gw-log").isVisible());
  await pageLog.locator("#gw-log .git-commit-row").nth(2).click({ button: "right" });
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
  await pageLog.waitForSelector("#gw-pr:not([hidden])", { timeout: 8000 }).catch(() => { prShown = false; });
  const prCall = await pageLog.evaluate(() => (window.__prCalls ?? [])[0]);
  check("PR badge appears with number",
    prShown && ((await pageLog.locator("#gw-pr").textContent()) ?? "").includes("#12"),
    `call=${JSON.stringify(prCall)}`);
  check("pr_info called with repo root and branch",
    prCall?.root === "/repo" && prCall?.branch === "feat/x", `call=${JSON.stringify(prCall)}`);
  if (prShown) {
    await pageLog.locator("#gw-pr").click();
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
    // 一覧を経由せず現在ブランチのバッジから開いた詳細も、PrInfo の headRefName で実行できる。
    await pageLog.evaluate(() => {
      window.__mockWorktreeFromPrDelay = 0;
      window.__mockWorktreeFromPrResult = {
        path: "/existing/current-pr",
        branch: "feat/x",
        reused: true,
      };
    });
    const currentPrWorktreeCallsBefore = await pageLog.evaluate(() => (window.__worktreeFromPrCalls ?? []).length);
    const currentPrSpawnsBefore = await pageLog.evaluate(() => window.__ptySpawns.length);
    await ensureGitWindow();
    await pageLog.locator("#gw-pr").click();
    await pageLog.waitForSelector("#pr-overlay:not([hidden])", { timeout: 3000 });
    check("current-branch PR detail enables its session action from PrInfo headRefName",
      await pageLog.locator("#pr-new-session").isEnabled());
    // バッジから開いた詳細も同じ Worktree モーダルを経由する（PR 一覧を開いていなくても
    // 詳細の PR が選択肢に入る）
    await pageLog.locator("#pr-new-session").click();
    await pageLog.waitForSelector("#worktree-overlay:not([hidden])", { timeout: 3000 });
    await pageLog.waitForFunction(() => !document.querySelector("#worktree-submit").disabled, null, { timeout: 3000 });
    check("current-branch PR detail opens the worktree modal with the detail PR selected",
      await pageLog.locator("#worktree-source input[value=pr]").isChecked() &&
        await pageLog.locator("#worktree-pr").inputValue() === "12");
    await pageLog.locator("#worktree-note").fill("PRメモ\n確認する");
    await pageLog.locator("#worktree-submit").click();
    await pageLog.waitForFunction((n) => window.__ptySpawns.length > n, currentPrSpawnsBefore);
    const currentPrWorktreeCall = await pageLog.evaluate(() => (window.__worktreeFromPrCalls ?? []).at(-1));
    check("current-branch PR badge creates and focuses a session for the head branch",
      await pageLog.evaluate((before) => (window.__worktreeFromPrCalls ?? []).length === before + 1,
        currentPrWorktreeCallsBefore) &&
        currentPrWorktreeCall?.number === 12 && currentPrWorktreeCall?.branch === "feat/x" &&
        await pageLog.locator("#worktree-overlay").isHidden() &&
        !(await pageLog.locator("#pr-overlay").isVisible()) &&
        await pageLog.locator("#git-window-overlay").isHidden() &&
        ((await pageLog.evaluate(() => window.__ptySpawns.at(-1)))?.cwd === "/existing/current-pr") &&
        await pageLog.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")),
      `call=${JSON.stringify(currentPrWorktreeCall)}`);
    // オーバーレイを閉じてもターミナルは生きている（stopPropagation の確認を兼ねる）
    // ブランチが変わったら PR を取り直す。PR 無し（gh 不在と同じ）はバッジ非表示
    await pageLog.evaluate(() => {
      window.__mockPrInfo = {
        found: false, number: null, title: null, state: null, url: null,
        headRefName: null,
        author: null, body: null, additions: 0, deletions: 0, changedFiles: 0,
        files: [], comments: [],
      };
      window.__mockGitLog = { ...window.__mockGitLog, branch: "main" };
      window.__mockGitBranches = { ...window.__mockGitBranches, current: "main" };
    });
    await ensureGitWindow();
    await pageLog.waitForTimeout(3600);
    check("PR badge hides when branch has no PR", !(await pageLog.locator("#gw-pr").isVisible()));
  }
  // 監視先はフォーカス中ペインのシェルの実 cwd。cd すれば履歴もその cwd で取り直す
  if (!(await pageLog.locator("#git-window-overlay").isVisible())) {
    await pageLog.locator("#git-open").click();
    await pageLog.waitForSelector("#git-window-overlay:not([hidden])");
  }
  await pageLog.locator("#gw-nav-history").click();
  await pageLog.evaluate(() => { window.__mockPtyCwd = "/repo/sub"; });
  await pageLog.locator("#gw-refresh").click();
  await pageLog.waitForFunction(() => window.__gitLogArgs.at(-1)?.cwd === "/repo/sub", null, { timeout: 5000 })
    .catch(() => {});
  check("history follows the focused pane cwd",
    await pageLog.evaluate(() => window.__gitLogArgs.at(-1)?.cwd) === "/repo/sub",
    `args=${await pageLog.evaluate(() => JSON.stringify(window.__gitLogArgs.slice(-2)))}`);
  // リポジトリ外ではビューを全部隠し、その旨を出す
  await pageLog.evaluate(() => {
    window.__mockGitChanges = { repo: false, root: null, files: [] };
    window.__mockGitLog = { repo: false, root: null, branch: null, detached: false, commits: [] };
  });
  await pageLog.waitForTimeout(3600);
  const emptyText = (await pageLog.locator("#gw-empty").textContent()) ?? "";
  check("outside a repo the Git window hides every view and says why",
    await pageLog.locator("#gw-empty").isVisible() && emptyText.includes("Git リポジトリではありません") &&
      await pageLog.evaluate(() =>
        [...document.querySelectorAll("#gw-main .gw-view")].every((el) => el.hidden)),
    `empty="${emptyText}"`);
}
await pageLog.close();

}
