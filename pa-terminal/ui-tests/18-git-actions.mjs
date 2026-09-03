export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 変更ストリップの git 操作（Checkout / Stash / Worktree と Commit / Push / Fetch / Pull）
// ============================================================

const pageGitOps = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageGitOps.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageGitOps.addInitScript(() => {
  window.__mockGitChanges = {
    repo: true,
    root: "/repo",
    files: [
      { path: "src/app.ts", adds: 2, dels: 1, status: "M" },
      { path: "src/new.ts", adds: 7, dels: 0, status: "A" },
    ],
  };
  window.__mockGitBranches = {
    current: "main",
    upstream: "origin/main",
    localBranches: ["develop", "main"],
    branches: ["origin/develop", "origin/main"],
    remotes: ["origin"],
  };
  window.__mockWorktreeBranches = {
    branches: [
      { name: "main", reference: "refs/heads/main", current: true },
      { name: "origin/develop", reference: "refs/remotes/origin/develop", current: false },
    ],
  };
  window.__mockWorktreeResult = {
    path: "/repo/.worktree/feature-strip-worktree",
    branch: "feature/strip-worktree",
  };
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
  // 通常削除は「未コミット変更あり」で失敗し、強制削除だけ通る
  window.__mockWorktreeRemoveResult = {
    errorUnlessForce: "fatal: '/repo/.worktree/feature-old' contains modified or untracked files",
  };
});
await pageGitOps.goto(BASE_URL);
await pageGitOps.waitForSelector(".pane", { timeout: 10000 });
await pageGitOps.locator(".pane .pane-body").first().click();
let gitOpsOpen = true;
await pageGitOps.waitForSelector("#agent-panel:not([hidden])", { timeout: 8000 }).catch(() => { gitOpsOpen = false; });
check("git change strip appears in a repo", gitOpsOpen);
if (gitOpsOpen) {
  const defaultStrip = await pageGitOps.evaluate(() => {
    const chips = [...document.querySelectorAll(".agent-file-row")];
    const changes = document.querySelector("#git-changes");
    const actions = document.querySelector("#git-actions");
    const collapseButton = document.querySelector("#agent-collapse");
    const actionRows = [...document.querySelectorAll("#git-actions .git-action-row")];
    const actionButtons = [...document.querySelectorAll("#git-remote-actions button")];
    return {
      compact: document.querySelector("#agent-panel")?.classList.contains("is-collapsed"),
      collapseButtonExpanded: collapseButton?.getAttribute("aria-expanded"),
      collapseButtonText: collapseButton?.textContent,
      changes: Boolean(changes?.getClientRects().length),
      actions: Boolean(actions?.getClientRects().length),
      actionCount: document.querySelectorAll("#git-actions button").length,
      actionRowOverflow: actionRows.map((row) => getComputedStyle(row).overflowX),
      actionRowTops: actionRows.map((row) => Math.round(row.getBoundingClientRect().top)),
      actionRowWidths: actionRows.map((row) => Math.round(row.getBoundingClientRect().width)),
      remoteButtonWidths: actionButtons.map((button) => Math.round(button.getBoundingClientRect().width)),
      panelHeight: document.querySelector("#agent-panel")?.getBoundingClientRect().height ?? 0,
      rows: new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size,
    };
  });
  check("git changes default to a compact all-changes button",
    defaultStrip.compact === true
      && defaultStrip.collapseButtonExpanded === "false" && defaultStrip.collapseButtonText === "▸"
      && !defaultStrip.changes && defaultStrip.actions
      && defaultStrip.actionCount === 7 && defaultStrip.rows === 1,
    `state=${JSON.stringify(defaultStrip)}`);
  check("compact git hides file chips and keeps commands in two horizontal-scroll rows",
    defaultStrip.actionRowOverflow.every((value) => value === "auto")
      && new Set(defaultStrip.actionRowTops).size === 2 && defaultStrip.panelHeight <= 52,
    `state=${JSON.stringify(defaultStrip)}`);
  check("compact git buttons form two aligned toolbars",
    new Set(defaultStrip.actionRowWidths).size === 1
      && Math.max(...defaultStrip.remoteButtonWidths) - Math.min(...defaultStrip.remoteButtonWidths) <= 1,
    `state=${JSON.stringify(defaultStrip)}`);
  await pageGitOps.locator("#agent-collapse").click();
  await pageGitOps.waitForTimeout(120);
  // 変更一覧と操作バーは縦積み。操作は用途ごとの2段に分かれる
  const stripLayout = await pageGitOps.evaluate(() => {
    const panel = document.querySelector("#agent-panel")?.getBoundingClientRect();
    const changes = document.querySelector("#git-changes")?.getBoundingClientRect();
    const actions = document.querySelector("#git-actions")?.getBoundingClientRect();
    const branchRow = document.querySelector("#git-branch-actions")?.getBoundingClientRect();
    const remoteRow = document.querySelector("#git-remote-actions")?.getBoundingClientRect();
    const branchControlTops = [...document.querySelectorAll("#git-branch-actions > *")]
      .map((el) => Math.round(el.getBoundingClientRect().top));
    const remoteButtonWidths = [...document.querySelectorAll("#git-remote-actions button")]
      .map((el) => Math.round(el.getBoundingClientRect().width));
    return panel && changes && actions && branchRow && remoteRow ? {
      panelHeight: panel.height,
      changesTop: changes.top,
      actionsBottom: actions.bottom,
      branchBottom: branchRow.bottom,
      remoteTop: remoteRow.top,
      actionRowWidths: [Math.round(branchRow.width), Math.round(remoteRow.width)],
      branchControlTops,
      remoteButtonWidths,
    } : null;
  });
  check("git actions sit above file changes",
    Boolean(stripLayout && stripLayout.changesTop >= stripLayout.actionsBottom + 3),
    `layout=${JSON.stringify(stripLayout)}`);
  check("git action groups render on separate rows",
    Boolean(stripLayout && stripLayout.remoteTop >= stripLayout.branchBottom + 3),
    `height=${stripLayout?.panelHeight}`);
  check("expanded git actions keep two aligned four-column toolbars",
    Boolean(stripLayout && new Set(stripLayout.actionRowWidths).size === 1
      && new Set(stripLayout.branchControlTops).size === 1
      && Math.max(...stripLayout.remoteButtonWidths) - Math.min(...stripLayout.remoteButtonWidths) <= 1),
    `layout=${JSON.stringify(stripLayout)}`);
  check("two-row git strip stays compact",
    Boolean(stripLayout && stripLayout.panelHeight <= 100),
    `height=${stripLayout?.panelHeight}`);
  await pageGitOps.locator("#git-worktree").hover();
  const gitHoverStyle = await pageGitOps.locator("#git-worktree").evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  check("git controls glow on hover",
    gitHoverStyle.boxShadow !== "none" && gitHoverStyle.borderColor === gitHoverStyle.color,
    `style=${JSON.stringify(gitHoverStyle)}`);
  const collapseHitBox = await pageGitOps.locator("#agent-collapse").boundingBox();
  check("the change-strip collapse control has a practical hit target",
    Boolean(collapseHitBox && collapseHitBox.width >= 28 && collapseHitBox.height >= 24),
    `box=${JSON.stringify(collapseHitBox)}`);
  // 1つのボタンで変更一覧を1行にし、操作バーを隠す（グリッドの高さも変わる）
  const gridHeightExpanded = await pageGitOps.evaluate(
    () => document.querySelector("#grid").getBoundingClientRect().height,
  );
  await pageGitOps.locator("#agent-collapse").click();
  await pageGitOps.waitForTimeout(120);
  const collapsedStrip = await pageGitOps.evaluate(() => {
    const shown = (sel) => Boolean(document.querySelector(sel)?.getClientRects().length);
    return {
      compact: document.querySelector("#agent-panel")?.classList.contains("is-collapsed"),
      content: shown("#agent-content"),
      changes: shown("#git-changes"),
      files: shown("#git-changes-list .agent-file-row"),
      actions: shown("#git-actions"),
      title: shown("#agent-title"),
      summary: document.querySelector("#agent-summary")?.textContent ?? "",
      titleBox: document.querySelector("#agent-title")?.getBoundingClientRect().toJSON(),
      actionButtonHeight: document.querySelector("#git-remote-actions button")?.getBoundingClientRect().height ?? 0,
      gridHeight: document.querySelector("#grid").getBoundingClientRect().height,
    };
  });
  check("collapse hides individual file changes and keeps the diff button with git actions",
    collapsedStrip.compact === true && collapsedStrip.content && !collapsedStrip.changes
      && !collapsedStrip.files && collapsedStrip.actions
      && collapsedStrip.title,
    `state=${JSON.stringify(collapsedStrip)}`);
  check("collapsed strip keeps the change summary visible",
    collapsedStrip.summary.startsWith("ChangeFile")
      && collapsedStrip.summary.includes("2") && collapsedStrip.summary.includes("+9")
      && collapsedStrip.summary.includes("-1"),
    `summary="${collapsedStrip.summary}"`);
  check("the all-changes button is larger than the compact git controls",
    collapsedStrip.titleBox?.width >= 110 && collapsedStrip.titleBox?.height >= 34
      && collapsedStrip.actionButtonHeight < collapsedStrip.titleBox.height / 2,
    `state=${JSON.stringify(collapsedStrip)}`);
  await pageGitOps.locator("#agent-title").hover();
  const changeButtonHover = await pageGitOps.locator("#agent-title").evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  check("the all-changes button glows on hover",
    changeButtonHover.boxShadow !== "none"
      && changeButtonHover.borderColor === changeButtonHover.color,
    `style=${JSON.stringify(changeButtonHover)}`);
  check("the one-line strip gives the extra height back to the grid",
    collapsedStrip.gridHeight > gridHeightExpanded,
    `grid=${collapsedStrip.gridHeight} was=${gridHeightExpanded}`);
  // たたんだあとに変更ファイルが増えても勝手に全展開しない
  await pageGitOps.evaluate(async () => {
    window.__mockGitChanges = {
      ...window.__mockGitChanges,
      files: [...window.__mockGitChanges.files, { path: "src/late.ts", adds: 5, dels: 0, status: "A" }],
    };
    const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
    updateGitWatch();
  });
  await pageGitOps.waitForTimeout(300);
  const afterNewFile = await pageGitOps.evaluate(() => ({
    compact: document.querySelector("#agent-panel")?.classList.contains("is-collapsed"),
    summary: document.querySelector("#agent-summary")?.textContent ?? "",
  }));
  check("new changed files do not expand the compact strip",
    afterNewFile.compact === true && afterNewFile.summary.includes("3"),
    `state=${JSON.stringify(afterNewFile)}`);
  // 次の起動でも閉じたままにするため、たたんだ状態は session.json に残す
  await pageGitOps.waitForFunction(
    () => {
      try { return JSON.parse(window.__savedSession).settings?.collapsed?.changes === true; }
      catch { return false; }
    },
    undefined,
    { timeout: 5000 },
  ).catch(() => {});
  const savedCollapsed = await pageGitOps.evaluate(
    () => JSON.parse(window.__savedSession).settings?.collapsed);
  check("collapsed strip state is persisted", savedCollapsed?.changes === true,
    `collapsed=${JSON.stringify(savedCollapsed)}`);
  await pageGitOps.evaluate(async () => {
    window.__mockGitChanges = {
      ...window.__mockGitChanges,
      files: window.__mockGitChanges.files.filter((f) => f.path !== "src/late.ts"),
    };
    const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
    updateGitWatch();
  });
  await pageGitOps.waitForTimeout(300);
  await pageGitOps.locator("#agent-collapse").click();
  await pageGitOps.waitForTimeout(120);
  const expandedStrip = await pageGitOps.evaluate(() => ({
    compact: document.querySelector("#agent-panel")?.classList.contains("is-collapsed"),
    actions: Boolean(document.querySelector("#git-actions")?.getClientRects().length),
    changes: Boolean(document.querySelector("#git-changes")?.getClientRects().length),
    summaryVisible: Boolean(document.querySelector("#agent-summary")?.getClientRects().length),
    gridHeight: document.querySelector("#grid").getBoundingClientRect().height,
  }));
  check("expanding shows all changes and actions",
    expandedStrip.compact === false && expandedStrip.actions && expandedStrip.changes
      && expandedStrip.summaryVisible
      && expandedStrip.gridHeight === gridHeightExpanded,
    `state=${JSON.stringify(expandedStrip)} was=${gridHeightExpanded}`);
  // 三角ボタン以外に「帯の空白」クリックでも開閉できる（見出し行・帯そのものが対象）
  const stripBlankClick = (sel) => pageGitOps.evaluate((s) => {
    document.querySelector(s).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, sel);
  const stripCompact = () => pageGitOps.evaluate(() =>
    document.querySelector("#agent-panel")?.classList.contains("is-collapsed"));
  // 文字選択のドラッグ直後は開閉しないが、選択が残ったままでも次の通常クリックは効く。
  // getSelection() の有無だけを見続けると、以後の空白クリックが永久に無視される回帰になる。
  const selectionClickStates = await pageGitOps.evaluate(() => {
    const panel = document.querySelector("#agent-panel");
    const content = document.querySelector("#agent-content");
    const text = document.querySelector(".agent-file-name")?.firstChild;
    if (!panel || !content || !text) return null;
    panel.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10,
    }));
    panel.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, buttons: 1, pointerId: 1, clientX: 30, clientY: 10,
    }));
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selectedText = selection?.toString() ?? "";
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const afterDrag = panel.classList.contains("is-collapsed");
    // The old selection is still present. Pointer movement alone must not make the
    // next click look like a new text-selection drag.
    panel.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, button: 0, buttons: 1, pointerId: 2, clientX: 10, clientY: 10,
    }));
    panel.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, buttons: 1, pointerId: 2, clientX: 30, clientY: 10,
    }));
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const afterPlainClick = panel.classList.contains("is-collapsed");
    selection?.removeAllRanges();
    // Keep the following hit-area checks independent if this regression is present.
    if (panel.classList.contains("is-collapsed")) {
      panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    return { afterDrag, afterPlainClick, selectedText };
  });
  check("drag-selecting text does not compact the strip",
    selectionClickStates?.afterDrag === false && Boolean(selectionClickStates?.selectedText),
    `state=${JSON.stringify(selectionClickStates)}`);
  check("a stale text selection does not disable later blank clicks",
    selectionClickStates?.afterPlainClick === true,
    `state=${JSON.stringify(selectionClickStates)}`);
  await stripBlankClick("#agent-panel");
  await pageGitOps.waitForTimeout(120);
  check("clicking the blank strip compacts it", (await stripCompact()) === true);
  await pageGitOps.locator("#agent-summary .agent-file-adds").click();
  await pageGitOps.waitForTimeout(120);
  check("clicking the compact change summary opens the all-changes diff without expanding",
    (await stripCompact()) === true && await pageGitOps.locator("#diff-overlay").isVisible());
  await pageGitOps.keyboard.press("Escape");
  // Keep the following head hit-area check independent if the regression above is present.
  if ((await stripCompact()) === true) {
    await pageGitOps.locator("#agent-collapse").click();
    await pageGitOps.waitForTimeout(120);
  }
  await stripBlankClick("#agent-panel");
  await pageGitOps.waitForTimeout(120);
  await stripBlankClick("#agent-head");
  await pageGitOps.waitForTimeout(120);
  check("clicking the compact head expands the strip", (await stripCompact()) === false);
  // 展開中は操作バーが帯の大半を占めるので、その背景も閉じる対象にする。
  // 実際の操作部品をクリックしたときだけは閉じない。
  await stripBlankClick("#git-actions");
  await pageGitOps.waitForTimeout(80);
  const actionBackgroundCollapsed = (await stripCompact()) === true;
  check("clicking the git action background compacts the strip", actionBackgroundCollapsed);
  if (actionBackgroundCollapsed) {
    await stripBlankClick("#agent-head");
    await pageGitOps.waitForTimeout(80);
  }
  await stripBlankClick("#git-local-branch");
  await pageGitOps.waitForTimeout(80);
  check("clicking a git action control does not compact the strip", (await stripCompact()) === false);
  // ブランチ名は切替用セレクトだけに表示し、重複した現在ブランチ表示を置かない
  check("strip does not duplicate the current branch label",
    await pageGitOps.locator("#git-cur-branch").count() === 0);
  check("pull branch select is not embedded in the strip",
    await pageGitOps.locator("#git-branch").count() === 0);
  const actionLabels = await pageGitOps.locator("#git-actions button").allTextContents();
  check("git action labels are English and ordered by row",
    JSON.stringify(actionLabels) === JSON.stringify(["Checkout", "Stash", "Worktree", "Commit", "Push", "Fetch", "Pull"]),
    `labels=${JSON.stringify(actionLabels)}`);
  const localOptCount = await pageGitOps.locator("#git-local-branch option").count();
  const localSelVal = await pageGitOps.locator("#git-local-branch").inputValue();
  check("local branch select lists branches and selects current",
    localOptCount === 2 && localSelVal === "main" && await pageGitOps.locator("#git-switch-branch").isDisabled(),
    `options=${localOptCount} sel=${localSelVal}`);
  // ターミナル側で checkout されたら、セレクトは現在ブランチへ追従する
  // （全 worktree はローカルブランチ一覧を共有するので、前の選択を残すとずれ続ける）
  const setMockBranch = async (current, upstream) => {
    await pageGitOps.evaluate(async ([cur, up]) => {
      window.__mockGitBranches = { ...window.__mockGitBranches, current: cur, upstream: up };
      const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
      updateGitWatch();
    }, [current, upstream]);
    await pageGitOps.waitForTimeout(300);
  };
  await setMockBranch("develop", "origin/develop");
  check("local branch select follows a checkout made outside the app",
    (await pageGitOps.locator("#git-local-branch").inputValue()) === "develop"
      && (await pageGitOps.locator("#git-switch-branch").isDisabled()),
    `sel=${await pageGitOps.locator("#git-local-branch").inputValue()}`);
  await setMockBranch("main", "origin/main");
  check("local branch select returns to the current branch",
    (await pageGitOps.locator("#git-local-branch").inputValue()) === "main");
  await pageGitOps.locator("#git-local-branch").selectOption("develop");
  // 選びかけの値は、現在ブランチが変わらないかぎりポーリングで巻き戻さない
  await pageGitOps.evaluate(async () => {
    document.querySelector("#git-local-branch").blur();
    const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
    updateGitWatch();
  });
  await pageGitOps.waitForTimeout(300);
  check("a manual branch pick survives polling",
    (await pageGitOps.locator("#git-local-branch").inputValue()) === "develop");
  check("branch switch enables for another local branch", await pageGitOps.locator("#git-switch-branch").isEnabled());
  await pageGitOps.locator("#git-switch-branch").click();
  await pageGitOps.waitForTimeout(300);
  const switchCall = await pageGitOps.evaluate(() => (window.__gitSwitchBranchCalls ?? [])[0]);
  check("branch switch invokes git_switch_branch",
    switchCall?.root === "/repo" && switchCall?.branch === "develop", `call=${JSON.stringify(switchCall)}`);
  // Stash: Checkout の隣のボタンから、監視中の cwd 配下を未追跡ごと退避する
  const stashPlacement = await pageGitOps.evaluate(() => {
    const row = document.querySelector("#git-branch-actions");
    return row ? [...row.children].map((el) => el.id) : null;
  });
  check("stash button sits next to checkout in the branch row",
    JSON.stringify(stashPlacement)
      === JSON.stringify(["git-local-branch", "git-switch-branch", "git-stash", "git-worktree"]),
    `row=${JSON.stringify(stashPlacement)}`);
  await pageGitOps.locator("#git-stash").click();
  await pageGitOps.waitForTimeout(300);
  const stashCwd = await pageGitOps.evaluate(() => (window.__gitStashCalls ?? [])[0]);
  check("stash invokes git_stash with watched cwd", stashCwd === "/home/user", `cwd=${stashCwd}`);
  const stashMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  check("stash result message shown", stashMsg.includes("Saved working directory"), `msg="${stashMsg}"`);
  // コミット: ボタンからモーダルを開き、対象ファイルと複数行メッセージを選べる
  const commitBtn = pageGitOps.locator("#git-commit");
  check("commit button enables when changes exist", await commitBtn.isEnabled());
  await commitBtn.click();
  check("commit button opens modal", await pageGitOps.locator("#commit-overlay").isVisible());
  check("commit modal selects every changed file by default",
    await pageGitOps.locator("#commit-file-list input:checked").count() === 2);
  const messageBox = await pageGitOps.locator("#commit-message").boundingBox();
  check("commit modal shows a large message field",
    Boolean(messageBox && messageBox.width >= 350 && messageBox.height >= 220),
    `box=${JSON.stringify(messageBox)}`);
  const submitCommit = pageGitOps.locator("#commit-submit");
  const pushAfterCommit = pageGitOps.locator("#commit-push-after");
  check("commit modal offers push after commit when a remote is available",
    await pushAfterCommit.isVisible() && await pushAfterCommit.isEnabled()
      && !(await pushAfterCommit.isChecked()));
  check("commit submit requires a message", await submitCommit.isDisabled());
  await pageGitOps.locator(".commit-file-choice").nth(1).locator("input").uncheck();
  await pageGitOps.locator("#commit-message").fill("feat: add git actions\n\nOnly commit app.ts");
  await pushAfterCommit.check();
  check("commit enables with a selected file and message", await submitCommit.isEnabled());
  await submitCommit.click();
  await pageGitOps.waitForTimeout(300);
  const commitCall = await pageGitOps.evaluate(() => (window.__gitCommitCalls ?? [])[0]);
  check("commit invokes git_commit with watched cwd, message, and selected paths",
    commitCall?.cwd === "/home/user"
      && commitCall?.message === "feat: add git actions\n\nOnly commit app.ts"
      && JSON.stringify(commitCall?.paths) === JSON.stringify(["src/app.ts"]),
    `call=${JSON.stringify(commitCall)}`);
  const commitPushCall = await pageGitOps.evaluate(() => (window.__gitPushCalls ?? []).at(-1));
  check("commit with push enabled invokes git_push after the commit",
    commitPushCall?.root === "/repo", `call=${JSON.stringify(commitPushCall)}`);
  const commitMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  const clearedMessage = await pageGitOps.locator("#commit-message").inputValue();
  check("commit result shown, modal closed, and message cleared",
    commitMsg.includes("feat: add git actions")
      && await pageGitOps.locator("#commit-overlay").isHidden()
      && clearedMessage === "",
    `msg="${commitMsg}" input="${clearedMessage}"`);
  // Worktree から開くセッションが同じ階層へ入ることを検証するため、表示中セッションを
  // 一時グループで包む（グループ名ではなく安定 ID / DOM 階層で判定する）。
  const worktreeSourceId = await pageGitOps.locator(".ws-item.is-active").getAttribute("data-ws-id");
  const worktreeSource = pageGitOps.locator(`.ws-item[data-ws-id="${worktreeSourceId}"]`);
  await worktreeSource.click({ button: "right" });
  await pageGitOps.locator("#ctx-menu button", { hasText: "グループを作成" }).click();
  await pageGitOps.waitForTimeout(200);
  // グループ内でも新規セッションへサイドバーを合わせる。実際にスクロールできる量を
  // 作ってから、作成後の位置と明示的なスクロール要求を記録する。
  const sidebarBeforeWorktree = await pageGitOps.evaluate(async () => {
    const { createWorkspace } = await import("/src/workspace/workspace.ts");
    const { getActiveWs } = await import("/src/workspace/state.ts");
    const source = getActiveWs();
    for (let i = 0; i < 8; i++) {
      createWorkspace(`sidebar filler ${i + 1}`, "default", {
        group: source?.group,
        activate: false,
      });
    }
    const list = document.querySelector("#ws-list");
    if (!(list instanceof HTMLElement)) return null;
    list.style.flex = "none";
    list.style.height = "120px";
    list.scrollTop = list.scrollHeight;
    const calls = [];
    const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (...args) {
      calls.push(this.querySelector(".ws-name")?.textContent ?? this.id);
      return nativeScrollIntoView.apply(this, args);
    };
    window.__sidebarScrollState = { before: list.scrollTop, calls };
    return { before: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
  });
  check("grouped worktree setup can observe a scrolled sidebar",
    !!sidebarBeforeWorktree && sidebarBeforeWorktree.before > 0
      && sidebarBeforeWorktree.scrollHeight > sidebarBeforeWorktree.clientHeight,
    `sidebar=${JSON.stringify(sidebarBeforeWorktree)}`);
  const spawnsBeforeWorktree = await pageGitOps.evaluate(() => window.__ptySpawns.length);
  // Worktree: ボタンから作成元・新規ブランチ・格納先を選ぶ。既定はリポジトリ外
  await pageGitOps.locator("#git-worktree").click();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  const defaultDirectory = await pageGitOps.locator("#worktree-directory").inputValue();
  const defaultBase = await pageGitOps.locator("#worktree-base").inputValue();
  const defaultOutside = await pageGitOps.locator("#worktree-loc input[value=outside]").isChecked();
  check("worktree modal defaults to outside ~/worktrees and the current branch",
    defaultOutside && defaultDirectory === "~/worktrees" && defaultBase === "refs/heads/main",
    `outside=${defaultOutside} directory=${defaultDirectory} base=${defaultBase}`);
  // 環境ファイル（gitignore 対象）の引き継ぎは既定で on。今回は off にして作る
  check("worktree modal defaults to inheriting ignored files",
    await pageGitOps.locator("#worktree-inherit input[value=yes]").isChecked());
  await pageGitOps.locator("#worktree-inherit input[value=no]").check();
  // 配下モードへ切り替えるとそのモードの既定（.worktree）が出る
  await pageGitOps.locator("#worktree-loc input[value=inside]").check();
  const insideDirectory = await pageGitOps.locator("#worktree-directory").inputValue();
  check("switching to inside shows that mode's default directory",
    insideDirectory === ".worktree", `dir=${insideDirectory}`);
  await pageGitOps.locator("#worktree-base").selectOption("refs/remotes/origin/develop");
  await pageGitOps.locator("#worktree-branch").fill("feature/strip-worktree");
  const worktreePreview = (await pageGitOps.locator("#worktree-location").textContent()) ?? "";
  check("worktree modal previews the repository-relative destination",
    worktreePreview === "/repo/.worktree/feature-strip-worktree", `preview=${worktreePreview}`);
  await pageGitOps.locator("#worktree-submit").click();
  await pageGitOps.waitForFunction(
    (before) => window.__ptySpawns.length === before + 1,
    spawnsBeforeWorktree,
  );
  const worktreeCall = await pageGitOps.evaluate(() => (window.__worktreeCreateCalls ?? [])[0]);
  check("worktree action invokes creation with the selected base, branch, and directory",
    worktreeCall?.root === "/repo"
      && worktreeCall?.baseRef === "refs/remotes/origin/develop"
      && worktreeCall?.branch === "feature/strip-worktree"
      && worktreeCall?.directory === ".worktree"
      && worktreeCall?.location === "inside"
      && worktreeCall?.inherit === false,
    `call=${JSON.stringify(worktreeCall)}`);
  const worktreeMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  check("worktree result is shown and the modal closes",
    worktreeMsg.includes("/repo/.worktree/feature-strip-worktree")
      && await pageGitOps.locator("#worktree-overlay").isHidden(),
    `msg=${worktreeMsg}`);
  const worktreeSpawn = await pageGitOps.evaluate(() => window.__ptySpawns.at(-1));
  const worktreeSession = await pageGitOps.evaluate(({ sourceId, branch }) => {
    const items = [...document.querySelectorAll(".ws-item")];
    const source = items.find((item) => item.dataset.wsId === sourceId);
    const created = items.find((item) => item.querySelector(".ws-name")?.textContent === branch);
    const siblings = created?.parentElement
      ? [...created.parentElement.children].filter((item) => item.classList.contains("ws-item"))
      : [];
    return {
      active: created?.classList.contains("is-active") ?? false,
      selected: created?.classList.contains("is-selected") ?? false,
      focused: document.activeElement?.classList.contains("xterm-helper-textarea") ?? false,
      sameGroup: Boolean(
        source?.parentElement === created?.parentElement
          && created?.parentElement?.classList.contains("ws-group-members"),
      ),
      immediatelyAfter: siblings.indexOf(created) === siblings.indexOf(source) + 1,
    };
  }, { sourceId: worktreeSourceId, branch: "feature/strip-worktree" });
  check("worktree success opens an active default-shell session in the created directory",
    worktreeSpawn?.shell === null
      && worktreeSpawn?.args === null
      && worktreeSpawn?.cwd === "/repo/.worktree/feature-strip-worktree"
      && worktreeSession.active
      && worktreeSession.selected
      && worktreeSession.focused,
    `spawn=${JSON.stringify(worktreeSpawn)} session=${JSON.stringify(worktreeSession)}`);
  check("worktree session is placed after the source session in the same group hierarchy",
    worktreeSession.sameGroup && worktreeSession.immediatelyAfter,
    `session=${JSON.stringify(worktreeSession)}`);
  // 引き継ぐ / 引き継がないの選択は次回のモーダルにも残る
  await pageGitOps.locator("#git-worktree").click();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  check("worktree modal remembers the inherit choice",
    await pageGitOps.locator("#worktree-inherit input[value=no]").isChecked());
  await pageGitOps.locator("#worktree-cancel").click();
  await pageGitOps.waitForSelector("#worktree-overlay", { state: "hidden" });
  const sidebarAfterGroupedWorktree = await pageGitOps.evaluate(() => {
    const list = document.querySelector("#ws-list");
    return {
      before: window.__sidebarScrollState?.before,
      after: list instanceof HTMLElement ? list.scrollTop : null,
      calls: window.__sidebarScrollState?.calls ?? [],
    };
  });
  const groupedWorktreeView = await pageGitOps.evaluate((branch) => {
    const list = document.querySelector("#ws-list");
    const item = [...document.querySelectorAll(".ws-item")].find(
      (el) => el.querySelector(".ws-name")?.textContent === branch,
    );
    if (!(list instanceof HTMLElement) || !(item instanceof HTMLElement)) return null;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    return {
      visible: itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom,
      list: { top: listRect.top, bottom: listRect.bottom },
      item: { top: itemRect.top, bottom: itemRect.bottom },
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
    };
  }, "feature/strip-worktree");
  check("grouped worktree creation scrolls the active selected session into view",
    sidebarAfterGroupedWorktree.before > 0
      && sidebarAfterGroupedWorktree.calls.includes("feature/strip-worktree")
      && groupedWorktreeView?.visible,
    `sidebar=${JSON.stringify(sidebarAfterGroupedWorktree)} view=${JSON.stringify(groupedWorktreeView)}`);

  // 引き継ぎ中はフォームの上にローディングを重ね、進捗イベント（worktree:inherit）で件数と対象を出す
  await pageGitOps.locator("#git-worktree").click();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  check("worktree progress overlay is hidden while idle",
    await pageGitOps.locator("#worktree-progress").isHidden());
  await pageGitOps.locator("#worktree-inherit input[value=yes]").check();
  await pageGitOps.locator("#worktree-branch").fill("feature/with-env");
  await pageGitOps.evaluate(() => { window.__mockWorktreeCreateDelay = 600; });
  const spawnsBeforeInherit = await pageGitOps.evaluate(() => window.__ptySpawns.length);
  await pageGitOps.locator("#worktree-submit").click();
  await pageGitOps.waitForSelector("#worktree-progress:not([hidden])");
  const progressWhileCopying = await pageGitOps.evaluate(() => ({
    title: document.querySelector("#worktree-progress-title")?.textContent,
    detail: document.querySelector("#worktree-progress-detail")?.textContent,
    count: document.querySelector("#worktree-progress-count")?.textContent,
    fill: document.querySelector("#worktree-progress-fill")?.style.width,
    determinate: !document.querySelector(".wt-progress-bar")?.classList.contains("is-indeterminate"),
    cancelDisabled: document.querySelector("#worktree-cancel")?.disabled,
  }));
  check("worktree progress overlay shows the copied entry, count, and a determinate bar",
    progressWhileCopying.title === "環境ファイルをコピー中…"
      && progressWhileCopying.detail === "node_modules"
      && progressWhileCopying.count === "1 / 3"
      && progressWhileCopying.fill === "33%"
      && progressWhileCopying.determinate
      && progressWhileCopying.cancelDisabled === true,
    `progress=${JSON.stringify(progressWhileCopying)}`);
  await pageGitOps.waitForFunction(
    (before) => window.__ptySpawns.length === before + 1,
    spawnsBeforeInherit,
  );
  check("worktree progress overlay is hidden again once the worktree is ready",
    await pageGitOps.locator("#worktree-progress").isHidden()
      && await pageGitOps.locator("#worktree-overlay").isHidden());
  await pageGitOps.evaluate(() => { window.__mockWorktreeCreateDelay = 0; });

  // リポジトリ外モード: ラベル・ヒント・プレビューが切り替わり、location が渡る
  await pageGitOps.locator("#git-worktree").click();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  await pageGitOps.locator("#worktree-loc input[value=outside]").check();
  const outsideLabel = (await pageGitOps.locator("#worktree-directory-label").textContent()) ?? "";
  const outsideDefault = await pageGitOps.locator("#worktree-directory").inputValue();
  const ignoreHintHidden = await pageGitOps.locator("#worktree-ignore-hint").isHidden();
  const externalHintShown = await pageGitOps.locator("#worktree-external-hint").isVisible();
  check("outside mode swaps the directory label and the gitignore hint",
    outsideDefault === "~/worktrees" && ignoreHintHidden && externalHintShown
      && !outsideLabel.includes("リポジトリ配下"),
    `label="${outsideLabel}" dir=${outsideDefault} ignoreHidden=${ignoreHintHidden} extShown=${externalHintShown}`);
  await pageGitOps.locator("#worktree-directory").fill("/tmp/pa-worktrees");
  await pageGitOps.locator("#worktree-branch").fill("feature/outside-wt");
  const outsidePreview = (await pageGitOps.locator("#worktree-location").textContent()) ?? "";
  check("outside mode previews the absolute destination",
    outsidePreview === "/tmp/pa-worktrees/feature-outside-wt", `preview=${outsidePreview}`);
  await pageGitOps.evaluate(() => {
    window.__mockWorktreeResult = {
      path: "/tmp/pa-worktrees/feature-outside-wt",
      branch: "feature/outside-wt",
    };
  });
  await pageGitOps.locator("#worktree-submit").click();
  await pageGitOps.waitForTimeout(300);
  const outsideCall = await pageGitOps.evaluate(() => (window.__worktreeCreateCalls ?? []).at(-1));
  check("outside mode passes location and the absolute directory",
    outsideCall?.location === "outside" && outsideCall?.directory === "/tmp/pa-worktrees",
    `call=${JSON.stringify(outsideCall)}`);
  const outsideSession = await pageGitOps.evaluate(() => ({
    name: document.querySelector(".ws-item.is-active .ws-name")?.textContent,
    cwd: window.__ptySpawns.at(-1)?.cwd,
  }));
  check("outside worktree also opens its resulting path as a session",
    outsideSession.name === "feature/outside-wt"
      && outsideSession.cwd === "/tmp/pa-worktrees/feature-outside-wt",
    `session=${JSON.stringify(outsideSession)}`);

  // 作成先は記憶され、開き直すと前回のモード・パスに戻る
  await pageGitOps.locator("#git-worktree").click();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  const rememberedMode = await pageGitOps.locator("#worktree-loc input[value=outside]").isChecked();
  const rememberedDir = await pageGitOps.locator("#worktree-directory").inputValue();
  check("worktree modal remembers the last used location",
    rememberedMode && rememberedDir === "/tmp/pa-worktrees",
    `outside=${rememberedMode} dir=${rememberedDir}`);
  // 配下に戻すとそのモードの前回値（.worktree）が出る
  await pageGitOps.locator("#worktree-loc input[value=inside]").check();
  const insideDirAgain = await pageGitOps.locator("#worktree-directory").inputValue();
  check("switching back to inside restores that mode's directory",
    insideDirAgain === ".worktree", `dir=${insideDirAgain}`);

  // 一覧と削除: メイン/現在は消せない、× → 確認 → 通常削除 → 失敗時だけ強制削除
  await pageGitOps.waitForSelector("#worktree-list .wt-row");
  const wtRow = pageGitOps.locator("#worktree-list .wt-row");
  const wtRows = await wtRow.count();
  const mainDeleteButtons = await wtRow.first().locator(".wt-del").count();
  check("worktree modal lists worktrees and hides delete on the main/current one",
    wtRows === 2 && mainDeleteButtons === 0, `rows=${wtRows} mainDel=${mainDeleteButtons}`);
  await wtRow.nth(1).locator(".wt-del").click();
  const removesBeforeConfirm = await pageGitOps.evaluate(() => (window.__worktreeRemoveCalls ?? []).length);
  check("clicking × only arms the confirmation",
    removesBeforeConfirm === 0 && await wtRow.nth(1).locator(".wt-confirm").isVisible(),
    `calls=${removesBeforeConfirm}`);
  await wtRow.nth(1).locator(".wt-yes").click();
  await pageGitOps.waitForTimeout(300);
  const firstRemove = await pageGitOps.evaluate(() => (window.__worktreeRemoveCalls ?? [])[0]);
  const removeError = (await wtRow.nth(1).locator(".wt-error").textContent()) ?? "";
  check("confirming removes without force and surfaces git's error",
    firstRemove?.path === "/repo/.worktree/feature-old" && firstRemove?.force === false
      && removeError.includes("contains modified or untracked files")
      && await wtRow.nth(1).locator(".wt-force").isVisible(),
    `call=${JSON.stringify(firstRemove)} error="${removeError}"`);
  await wtRow.nth(1).locator(".wt-force").click();
  await pageGitOps.waitForTimeout(300);
  const forcedRemove = await pageGitOps.evaluate(() => (window.__worktreeRemoveCalls ?? []).at(-1));
  check("force remove sends force and reloads the list",
    forcedRemove?.force === true && forcedRemove?.path === "/repo/.worktree/feature-old",
    `call=${JSON.stringify(forcedRemove)}`);
  await pageGitOps.locator("#worktree-cancel").click();

  // Worktree（PR から）: open な PR の head ブランチで worktree を用意し、
  // 既にあれば再利用してそのセッションを開く
  await pageGitOps.evaluate(() => {
    window.__mockPrList = {
      available: true,
      prs: [
        {
          number: 42, title: "リサイズ競合を直す", state: "OPEN",
          url: "https://github.com/o/r/pull/42", author: "kai",
          headRefName: "fix/resize-race", baseRefName: "main",
          isDraft: false, updatedAt: "2026-08-10T00:00:00Z",
        },
        {
          number: 40, title: "マージ済みの作業", state: "MERGED",
          url: "https://github.com/o/r/pull/40", author: "kai",
          headRefName: "done/old", baseRefName: "main",
          isDraft: false, updatedAt: "2026-08-01T00:00:00Z",
        },
      ],
    };
    // 同じブランチの worktree が既にある = 作らずに紐付けるだけ
    window.__mockWorktreeFromPrResult = {
      path: "/tmp/pa-worktrees/fix-resize-race", branch: "fix/resize-race", reused: true,
    };
  });
  const prListCallsBeforeOpen = await pageGitOps.evaluate(() => (window.__prListCalls ?? []).length);
  await pageGitOps.locator("#git-worktree").click();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  const prListCallsAfterOpen = await pageGitOps.evaluate(() => (window.__prListCalls ?? []).length);
  check("opening the worktree modal does not reach for PRs",
    prListCallsAfterOpen === prListCallsBeforeOpen,
    `before=${prListCallsBeforeOpen} after=${prListCallsAfterOpen}`);
  await pageGitOps.locator("#worktree-source input[value=pr]").check();
  await pageGitOps.waitForFunction(
    (n) => (window.__prListCalls ?? []).length === n + 1, prListCallsBeforeOpen);
  await pageGitOps.waitForTimeout(200);
  // 表示の出し分けは実際に見えているかで見る（[hidden] は display 指定に負ける）
  const prFields = {
    base: await pageGitOps.locator("#worktree-base-field").isHidden(),
    branch: await pageGitOps.locator("#worktree-branch-field").isHidden(),
    pr: await pageGitOps.locator("#worktree-pr-field").isVisible(),
    options: await pageGitOps.locator("#worktree-pr option").allTextContents(),
  };
  check("PR mode swaps the branch fields for an open-PR picker",
    prFields.base && prFields.branch && prFields.pr
      && JSON.stringify(prFields.options) === JSON.stringify(["#42 リサイズ競合を直す"]),
    `fields=${JSON.stringify(prFields)}`);
  const prPreview = (await pageGitOps.locator("#worktree-location").textContent()) ?? "";
  check("PR mode previews the destination of the PR head branch",
    prPreview === "/tmp/pa-worktrees/fix-resize-race", `preview=${prPreview}`);
  const spawnsBeforePr = await pageGitOps.evaluate(() => window.__ptySpawns.length);
  await pageGitOps.locator("#worktree-submit").click();
  await pageGitOps.waitForFunction(
    (before) => window.__ptySpawns.length === before + 1, spawnsBeforePr);
  const prWorktreeCall = await pageGitOps.evaluate(() => (window.__worktreeFromPrCalls ?? []).at(-1));
  check("PR mode creates the worktree from the pull request head branch",
    prWorktreeCall?.root === "/repo"
      && prWorktreeCall?.number === 42
      && prWorktreeCall?.branch === "fix/resize-race"
      && prWorktreeCall?.directory === "/tmp/pa-worktrees"
      && prWorktreeCall?.location === "outside",
    `call=${JSON.stringify(prWorktreeCall)}`);
  const prSession = await pageGitOps.evaluate(() => ({
    name: document.querySelector(".ws-item.is-active .ws-name")?.textContent,
    cwd: window.__ptySpawns.at(-1)?.cwd,
    msg: document.querySelector("#git-msg")?.textContent ?? "",
    open: document.querySelector("#worktree-overlay")?.hidden === false,
    selected: [...document.querySelectorAll(".ws-item.is-selected")].map(
      (item) => item.querySelector(".ws-name")?.textContent,
    ),
  }));
  check("an existing PR worktree is reused and opened as its own session",
    prSession.name === "#42 リサイズ競合を直す"
      && prSession.cwd === "/tmp/pa-worktrees/fix-resize-race"
      && prSession.msg.includes("再利用")
      && !prSession.open
      && JSON.stringify(prSession.selected) === JSON.stringify(["#42 リサイズ競合を直す"]),
    `session=${JSON.stringify(prSession)}`);

  // Push: 現在ブランチをリポジトリルートから Push する
  await pageGitOps.locator("#git-push").click();
  await pageGitOps.waitForTimeout(300);
  const pushCall = await pageGitOps.evaluate(() => (window.__gitPushCalls ?? []).at(-1));
  check("push invokes git_push with repository root", pushCall?.root === "/repo", `call=${JSON.stringify(pushCall)}`);
  const pushMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  check("push result message shown", pushMsg.includes("Everything up-to-date"), `msg="${pushMsg}"`);
  // Push 失敗（非 fast-forward 等）は git の出力を全文出す。1行に詰めて省略すると
  // "To <url>" しか読めず原因が分からない（Rust 側が1行目に要約を足している）
  await pageGitOps.evaluate(() => {
    window.__mockGitPushResult = {
      error: [
        "Push rejected: the remote has commits you don't have yet. Pull first, then Push again.",
        "To https://github.com/o/r.git",
        " ! [rejected]        HEAD -> main (fetch first)",
        "error: failed to push some refs to 'https://github.com/o/r.git'",
      ].join("\n"),
    };
  });
  await pageGitOps.locator("#git-push").click();
  await pageGitOps.waitForTimeout(300);
  const pushErrClass = (await pageGitOps.locator("#git-msg").getAttribute("class")) ?? "";
  const pushErrMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  check("push failure shows every line, not just the first",
    pushErrClass.includes("err")
      && pushErrMsg.includes("Pull first")
      && pushErrMsg.includes("[rejected]")
      && pushErrMsg.includes("failed to push some refs"),
    `class=${pushErrClass} msg="${pushErrMsg}"`);
  const pushErrWrap = await pageGitOps.evaluate(() => {
    const el = document.querySelector("#git-msg");
    const s = el ? getComputedStyle(el) : null;
    return { ws: s?.whiteSpace ?? "", h: el?.getBoundingClientRect().height ?? 0 };
  });
  check("push failure wraps instead of clipping to one line",
    pushErrWrap.ws === "pre-wrap" && pushErrWrap.h > 20,
    `style=${JSON.stringify(pushErrWrap)}`);
  await pageGitOps.evaluate(() => {
    window.__mockGitPushResult = undefined;
  });
  // Fetch: 全リモートの更新をリポジトリルートから取得する
  await pageGitOps.locator("#git-fetch").click();
  await pageGitOps.waitForTimeout(300);
  const fetchCall = await pageGitOps.evaluate(() => (window.__gitFetchCalls ?? [])[0]);
  check("fetch invokes git_fetch with repository root", fetchCall?.root === "/repo", `call=${JSON.stringify(fetchCall)}`);
  const fetchMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  check("fetch result message shown", fetchMsg.includes("Fetched all remotes"), `msg="${fetchMsg}"`);
  // プル: ボタン押下後に取り込み元を選び、リポジトリルートで git_pull を呼ぶ
  await pageGitOps.locator("#git-pull").click();
  check("pull button opens a modal with upstream selected",
    await pageGitOps.locator("#pull-overlay").isVisible()
      && await pageGitOps.locator("#pull-branch").inputValue() === "origin/main");
  await pageGitOps.locator("#pull-branch").selectOption("origin/develop");
  await pageGitOps.locator("#pull-submit").click();
  await pageGitOps.waitForTimeout(300);
  const pullCall = await pageGitOps.evaluate(() => (window.__gitPullCalls ?? [])[0]);
  check("pull invokes git_pull with selected branch",
    pullCall?.root === "/repo" && pullCall?.branch === "origin/develop",
    `call=${JSON.stringify(pullCall)}`);
  const pullMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  check("pull result message shown", pullMsg.includes("Already up to date"), `msg="${pullMsg}"`);
  // プル失敗（コンフリクト等）はエラー表示になる
  await pageGitOps.evaluate(() => {
    window.__mockGitPullResult = { error: "CONFLICT (content): merge conflict in src/app.ts" };
  });
  await pageGitOps.locator("#git-pull").click();
  await pageGitOps.locator("#pull-submit").click();
  await pageGitOps.waitForTimeout(300);
  const errClass = (await pageGitOps.locator("#git-msg").getAttribute("class")) ?? "";
  const errMsg = (await pageGitOps.locator("#git-msg").textContent()) ?? "";
  const pullModalErr = (await pageGitOps.locator("#pull-error").textContent()) ?? "";
  check("pull conflict shows error message",
    errClass.includes("err") && errMsg.includes("CONFLICT") && pullModalErr.includes("CONFLICT"),
    `class=${errClass} msg="${errMsg}" modal="${pullModalErr}"`);
  await pageGitOps.locator("#pull-cancel").click();
  // 変更ゼロになったら Stash とコミットだけ disabled（Worktree/Push/Fetch/Pull は可能なまま）
  await pageGitOps.evaluate(() => {
    window.__mockGitChanges = { repo: true, root: "/repo", files: [] };
  });
  await pageGitOps.waitForTimeout(3600);
  const stashDisabled = await pageGitOps.locator("#git-stash").isDisabled();
  const commitDisabled = await pageGitOps.locator("#git-commit").isDisabled();
  const worktreeEnabled = await pageGitOps.locator("#git-worktree").isEnabled();
  const pushEnabled = await pageGitOps.locator("#git-push").isEnabled();
  const fetchEnabled = await pageGitOps.locator("#git-fetch").isEnabled();
  const pullEnabled = await pageGitOps.locator("#git-pull").isEnabled();
  check("change actions disabled when clean, remote actions stay enabled",
    stashDisabled && commitDisabled && worktreeEnabled && pushEnabled && fetchEnabled && pullEnabled);
  // 横幅が足りない場合は横スクロールを出さず、各行の操作を折り返す
  await pageGitOps.setViewportSize({ width: 600, height: 820 });
  const narrowLayout = await pageGitOps.evaluate(() => {
    const actions = document.querySelector("#git-actions");
    const branchRow = document.querySelector("#git-branch-actions");
    if (!actions || !branchRow) return null;
    const childTops = [...branchRow.children].map((el) => el.getBoundingClientRect().top);
    return {
      clientWidth: actions.clientWidth,
      scrollWidth: actions.scrollWidth,
      wrapped: new Set(childTops.map((top) => Math.round(top))).size > 1,
    };
  });
  check("narrow git actions wrap without horizontal scrolling",
    Boolean(narrowLayout && narrowLayout.wrapped && narrowLayout.scrollWidth <= narrowLayout.clientWidth + 1),
    `layout=${JSON.stringify(narrowLayout)}`);
  await pageGitOps.setViewportSize({ width: 1280, height: 820 });
  // リモートが無いリポジトリではプルボタンを隠し、Push / Fetch は disabled
  await pageGitOps.locator(".workspace-layer:not([hidden]) .pane-body").click();
  await pageGitOps.evaluate(() => {
    window.__mockGitBranches = { current: "main", upstream: null, branches: [], remotes: [] };
  });
  await pageGitOps.waitForTimeout(3600);
  const pullHidden = !(await pageGitOps.locator("#git-pull").isVisible());
  const pushVisible = await pageGitOps.locator("#git-push").isVisible();
  const pushDisabled = await pageGitOps.locator("#git-push").isDisabled();
  const fetchVisible = await pageGitOps.locator("#git-fetch").isVisible();
  const fetchDisabled = await pageGitOps.locator("#git-fetch").isDisabled();
  check("no-remote repo hides pull UI and disables push and fetch",
    pullHidden && pushVisible && pushDisabled && fetchVisible && fetchDisabled,
    `pullHidden=${pullHidden} pushDisabled=${pushDisabled} fetchDisabled=${fetchDisabled}`);
}
await pageGitOps.close();

}
