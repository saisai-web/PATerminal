export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;
const MOD = ctx.MOD ?? "Meta";

// ============================================================
// Git ウィンドウの git 操作（Commit / Pull / Push / Fetch / Worktree / Stash と
// サイドバーのブランチツリーからのチェックアウト、ファイルステータスのコミット欄）
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
  window.__mockGitFileDiff = { oldText: "one\ntwo\n", newText: "one\nTWO\nthree\n" };
  window.__mockGitBranches = {
    current: "main",
    upstream: "origin/main",
    localBranches: ["develop", "feature/x", "feature/y", "main"],
    branches: ["origin/develop", "origin/feature/z", "origin/main"],
    remotes: ["origin"],
  };
  const ref = (name, hash, extra = {}) => ({
    name, hash, upstream: "", ahead: 0, behind: 0, gone: false, worktree: "", ...extra,
  });
  window.__mockGitRefs = {
    head: "main",
    local: [
      ref("develop", "bbb2222", { upstream: "origin/develop", behind: 2 }),
      ref("feature/x", "ccc3333", { ahead: 1 }),
      ref("feature/y", "ddd4444"),
      ref("main", "aaa1111", { upstream: "origin/main", worktree: "/repo" }),
    ],
    remote: [
      ref("origin/develop", "bbb2222"),
      ref("origin/feature/z", "eee5555"),
      ref("origin/main", "aaa1111"),
    ],
    tags: [ref("v1.0", "aaa1111")],
  };
  // サイドバーの行クリック（履歴で先端コミットを表示）が見つけられる履歴
  const now = Math.floor(Date.now() / 1000);
  window.__mockGitLog = {
    repo: true,
    root: "/repo",
    branch: "main",
    detached: false,
    commits: [
      { hash: "aaa1111", id: "aaa1111000", parents: ["bbb2222000"], time: now - 3600,
        author: "alice", refs: "HEAD -> refs/heads/main, tag: refs/tags/v1.0", subject: "main tip" },
      { hash: "bbb2222", id: "bbb2222000", parents: [], time: now - 86400,
        author: "bob", refs: "refs/heads/develop", subject: "develop tip" },
    ],
  };
  // 作業中は develop。ベースブランチの初期値は現在のブランチではなく既定ブランチ（main）
  window.__mockWorktreeBranches = {
    branches: [
      { name: "develop", reference: "refs/heads/develop", current: true },
      { name: "main", reference: "refs/heads/main", current: false },
      { name: "origin/develop", reference: "refs/remotes/origin/develop", current: false },
    ],
    defaultRef: "refs/heads/main",
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

const overlay = pageGitOps.locator("#git-window-overlay");
const openGit = async () => {
  if (await overlay.isHidden()) await pageGitOps.locator("#git-open").click();
  await pageGitOps.waitForSelector("#git-window-overlay:not([hidden])", { timeout: 3000 });
  await pageGitOps.waitForTimeout(150);
};
const closeGit = async () => {
  if (await overlay.isVisible()) await pageGitOps.locator("#gw-close").click();
  await pageGitOps.waitForSelector("#git-window-overlay", { state: "hidden", timeout: 3000 });
};
const openWorktreeModal = async () => {
  await openGit();
  await pageGitOps.locator("#git-worktree").click();
};
const refreshWatch = async () => {
  await pageGitOps.evaluate(async () => {
    const { updateGitWatch } = await import("/src/features/git/git-watch.ts");
    updateGitWatch();
  });
  await pageGitOps.waitForTimeout(300);
};
const toastDetail = async () =>
  (await pageGitOps.locator("#git-toast .git-toast-detail").textContent()) ?? "";
// 結果トーストに期待の文言が出るまで待つ（出なければ最後の状態を返す）
const waitToast = async (text) => {
  await pageGitOps.waitForFunction(
    (t) => {
      const toast = document.querySelector("#git-toast");
      return toast && !toast.hidden
        && (toast.querySelector(".git-toast-detail")?.textContent ?? "").includes(t);
    },
    text,
    { timeout: 3000 },
  ).catch(() => {});
  return pageGitOps.evaluate(() => {
    const toast = document.querySelector("#git-toast");
    return {
      visible: Boolean(toast && !toast.hidden),
      kind: toast?.dataset.kind ?? "",
      detail: toast?.querySelector(".git-toast-detail")?.textContent ?? "",
    };
  });
};
const callCount = (name) => pageGitOps.evaluate((n) => (window[n] ?? []).length, name);
const waitCalls = (name, n) => pageGitOps.waitForFunction(
  ([k, c]) => (window[k] ?? []).length >= c, [name, n], { timeout: 3000 },
).catch(() => {});

// ツールバーの Git ボタンは変更ファイル数をバッジで出す
let badgeShown = true;
await pageGitOps.waitForFunction(
  () => document.querySelector("#git-open-badge")?.textContent === "2",
  undefined,
  { timeout: 8000 },
).catch(() => { badgeShown = false; });
check("Git button badge shows the number of changed files", badgeShown
  && await pageGitOps.locator("#git-open-badge").isVisible(),
  `badge=${await pageGitOps.locator("#git-open-badge").textContent()}`);

// Git ウィンドウはターミナルの上に重なるだけで、グリッドを縮めない（resize を起こさない）。
// 起動直後の fit による resize が落ち着いてから数える
const countResizes = () => pageGitOps.evaluate(
  () => (window.__ipcLog ?? []).filter((e) => e.cmd === "pty_resize").length);
for (let i = 0, last = -1; i < 20; i++) {
  const n = await countResizes();
  if (n === last) break;
  last = n;
  await pageGitOps.waitForTimeout(250);
}
const gridBefore = await pageGitOps.evaluate(() => ({
  rect: document.querySelector("#grid")?.getBoundingClientRect().toJSON(),
  resizes: (window.__ipcLog ?? []).filter((e) => e.cmd === "pty_resize").length,
}));
await openGit();
check("Git button opens the Git window", await overlay.isVisible());
await pageGitOps.waitForTimeout(300);
const gridAfter = await pageGitOps.evaluate(() => ({
  rect: document.querySelector("#grid")?.getBoundingClientRect().toJSON(),
  resizes: (window.__ipcLog ?? []).filter((e) => e.cmd === "pty_resize").length,
}));
check("opening the Git window does not resize the terminal grid",
  JSON.stringify(gridBefore.rect) === JSON.stringify(gridAfter.rect)
    && gridBefore.resizes === gridAfter.resizes,
  `before=${JSON.stringify(gridBefore)} after=${JSON.stringify(gridAfter)}`);

if (await overlay.isVisible()) {
  const head = await pageGitOps.evaluate(() => ({
    title: document.querySelector("#gw-title")?.textContent,
    branch: document.querySelector("#gw-branch")?.textContent,
    statusActive: document.querySelector("#gw-nav-status")?.getAttribute("aria-current"),
    statusCount: document.querySelector("#gw-status-count")?.textContent,
    statusView: document.querySelector("#gw-view-status")?.hidden === false,
    empty: document.querySelector("#gw-empty")?.hidden,
  }));
  check("Git window shows the repository, current branch, and File status first",
    head.title === "repo" && head.branch === "main" && head.statusActive === "page"
      && head.statusCount === "2" && head.statusView && head.empty === true,
    `head=${JSON.stringify(head)}`);
  const toolLabels = await pageGitOps.locator("#gw-tools .gw-tool").allTextContents();
  check("git action labels are English and ordered in the header",
    JSON.stringify(toolLabels.map((s) => s.trim()))
      === JSON.stringify(["Commit", "Pull", "Push", "Fetch", "Worktree", "Stash"]),
    `labels=${JSON.stringify(toolLabels)}`);
  const enabledWithChanges = await pageGitOps.evaluate(() =>
    Object.fromEntries(["commit", "pull", "push", "fetch", "worktree", "stash"].map(
      (id) => [id, !document.querySelector(`#git-${id}`)?.disabled])));
  check("every git action is enabled in a repo with changes and remotes",
    Object.values(enabledWithChanges).every(Boolean), `enabled=${JSON.stringify(enabledWithChanges)}`);

  // 閉じ方: ×・Escape・背景クリック・Cmd/Ctrl+E（開くのも Cmd/Ctrl+E）
  await pageGitOps.locator("#gw-close").click();
  check("close button hides the Git window", await overlay.isHidden());
  await pageGitOps.locator(".pane .xterm-helper-textarea").first().focus();
  await pageGitOps.keyboard.press(`${MOD}+e`);
  await pageGitOps.waitForTimeout(200);
  check("Cmd/Ctrl+E opens the Git window from the terminal", await overlay.isVisible());
  await pageGitOps.keyboard.press(`${MOD}+e`);
  await pageGitOps.waitForTimeout(200);
  check("Cmd/Ctrl+E inside the Git window closes it", await overlay.isHidden());
  await openGit();
  await pageGitOps.keyboard.press("Escape");
  await pageGitOps.waitForTimeout(150);
  check("Escape closes the Git window", await overlay.isHidden());
  await openGit();
  await pageGitOps.mouse.click(5, 5);
  await pageGitOps.waitForTimeout(150);
  check("clicking the backdrop closes the Git window", await overlay.isHidden());
  await openGit();

  // ============================================================
  // ファイルステータス: 変更ファイル一覧と、選んだファイルの行番号付き差分
  // ============================================================
  const rows = await pageGitOps.evaluate(() =>
    [...document.querySelectorAll("#gw-status-files .gw-file-row")].map((row) => ({
      path: row.dataset.path,
      checked: row.querySelector("input[type=checkbox]")?.checked,
      status: row.querySelector(".gw-file-status")?.textContent,
      base: row.querySelector(".gw-file-base")?.textContent,
      dir: row.querySelector(".gw-file-dir")?.textContent,
      adds: row.querySelector(".agent-file-adds")?.textContent,
      dels: row.querySelector(".agent-file-dels")?.textContent,
      selected: row.classList.contains("is-selected"),
    })));
  check("File status lists each change with status, name, folder, and line counts",
    rows.length === 2
      && rows[0].path === "src/app.ts" && rows[0].status === "M" && rows[0].base === "app.ts"
      && rows[0].dir === "src" && rows[0].adds === "+2" && rows[0].dels === "-1"
      && rows[1].path === "src/new.ts" && rows[1].status === "A" && rows[1].adds === "+7",
    `rows=${JSON.stringify(rows)}`);
  check("new changes are selected for commit by default", rows.every((r) => r.checked),
    `rows=${JSON.stringify(rows)}`);
  await pageGitOps.waitForSelector("#gw-status-diff-body .commit-diff-line", { timeout: 3000 }).catch(() => {});
  const firstDiff = await pageGitOps.evaluate(() => ({
    path: document.querySelector("#gw-status-diff-path")?.textContent,
    lines: document.querySelectorAll("#gw-status-diff-body .commit-diff-line").length,
  }));
  check("the first file is selected and its diff is shown",
    rows[0]?.selected && firstDiff.path === "src/app.ts" && firstDiff.lines > 0,
    `diff=${JSON.stringify(firstDiff)}`);
  await pageGitOps.locator('#gw-status-files .gw-file-row[data-path="src/new.ts"] .gw-file-base').click();
  await pageGitOps.waitForTimeout(200);
  const secondDiff = await pageGitOps.evaluate(() => ({
    path: document.querySelector("#gw-status-diff-path")?.textContent,
    selected: document.querySelector("#gw-status-files .gw-file-row.is-selected")?.dataset.path,
    checked: document.querySelector('#gw-status-files .gw-file-row[data-path="src/new.ts"] input')?.checked,
  }));
  check("clicking a file row shows its diff without toggling its commit checkbox",
    secondDiff.path === "src/new.ts" && secondDiff.selected === "src/new.ts" && secondDiff.checked === true,
    `diff=${JSON.stringify(secondDiff)}`);

  // すべての差分: 作業ツリー全体の差分を前面のオーバーレイで開く（Git ウィンドウは残る）
  await pageGitOps.evaluate(() => {
    window.__mockGitWorktreeDiff = {
      patch: "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
      adds: 1, dels: 1, truncated: false,
    };
  });
  await pageGitOps.locator("#gw-view-all-diff").click();
  await pageGitOps.waitForSelector("#diff-overlay:not([hidden])", { timeout: 3000 }).catch(() => {});
  const allDiffCall = await pageGitOps.evaluate(() => (window.__gitWorktreeDiffCalls ?? []).at(-1));
  check("All changes opens the working-tree diff for the watched cwd",
    await pageGitOps.locator("#diff-overlay").isVisible() && allDiffCall === "/home/user",
    `call=${JSON.stringify(allDiffCall)}`);
  await pageGitOps.keyboard.press("Escape");
  await pageGitOps.waitForTimeout(150);
  check("Escape closes only the diff overlay, keeping the Git window",
    await pageGitOps.locator("#diff-overlay").isHidden() && await overlay.isVisible());
  await openGit();

  // ============================================================
  // サイドバーのブランチツリー（ローカル / リモート / タグ）からのチェックアウト
  // ============================================================
  await pageGitOps.waitForSelector('#gw-branch-tree .gw-tree-leaf[data-ref="main"]', { timeout: 5000 }).catch(() => {});
  const tree = await pageGitOps.evaluate(() => ({
    local: [...document.querySelectorAll("#gw-branch-tree .gw-tree-leaf")].map((r) => r.dataset.ref),
    folders: [...document.querySelectorAll("#gw-branch-tree .gw-tree-folder")].map((r) => ({
      name: r.textContent, expanded: r.getAttribute("aria-expanded"),
    })),
    current: [...document.querySelectorAll("#gw-branch-tree .gw-tree-leaf.is-current")].map((r) => r.dataset.ref),
    remote: [...document.querySelectorAll("#gw-remote-tree .gw-tree-leaf")].map((r) => r.dataset.ref),
    remoteFolders: [...document.querySelectorAll("#gw-remote-tree .gw-tree-folder")].map((r) => ({
      name: r.textContent, expanded: r.getAttribute("aria-expanded"),
    })),
    tags: [...document.querySelectorAll("#gw-tag-tree .gw-tree-leaf")].map((r) => r.dataset.ref),
  }));
  check("branch tree groups slash names into collapsed folders and marks the current branch",
    JSON.stringify(tree.local) === JSON.stringify(["develop", "main"])
      && JSON.stringify(tree.folders) === JSON.stringify([{ name: "feature", expanded: "false" }])
      && JSON.stringify(tree.current) === JSON.stringify(["main"]),
    `tree=${JSON.stringify(tree)}`);
  check("remote tree opens each remote and lists its branches; tags are listed",
    JSON.stringify(tree.remote) === JSON.stringify(["origin/develop", "origin/main"])
      && tree.remoteFolders[0]?.name === "origin" && tree.remoteFolders[0]?.expanded === "true"
      && tree.remoteFolders[1]?.name === "feature" && tree.remoteFolders[1]?.expanded === "false"
      && JSON.stringify(tree.tags) === JSON.stringify(["v1.0"]),
    `tree=${JSON.stringify(tree)}`);
  await pageGitOps.locator("#gw-branch-tree .gw-tree-folder").first().click();
  await pageGitOps.waitForTimeout(100);
  const expandedFolder = await pageGitOps.evaluate(() => ({
    expanded: document.querySelector("#gw-branch-tree .gw-tree-folder")?.getAttribute("aria-expanded"),
    leaves: [...document.querySelectorAll("#gw-branch-tree .gw-tree-leaf")].map((r) => ({
      ref: r.dataset.ref, label: r.querySelector(".gw-tree-name")?.textContent,
    })),
  }));
  check("clicking a folder expands its branches, labelled by their last segment",
    expandedFolder.expanded === "true"
      && expandedFolder.leaves.some((l) => l.ref === "feature/x" && l.label === "x")
      && expandedFolder.leaves.some((l) => l.ref === "feature/y" && l.label === "y"),
    `folder=${JSON.stringify(expandedFolder)}`);
  // フィルターは一致するブランチだけを、フォルダーを開いた状態で出す
  await pageGitOps.locator("#gw-side-filter").fill("feature");
  await pageGitOps.waitForTimeout(100);
  const filtered = await pageGitOps.evaluate(() => ({
    local: [...document.querySelectorAll("#gw-branch-tree .gw-tree-leaf")].map((r) => r.dataset.ref),
    remote: [...document.querySelectorAll("#gw-remote-tree .gw-tree-leaf")].map((r) => r.dataset.ref),
  }));
  check("sidebar filter narrows branches and opens matching folders",
    JSON.stringify(filtered.local) === JSON.stringify(["feature/x", "feature/y"])
      && JSON.stringify(filtered.remote) === JSON.stringify(["origin/feature/z"]),
    `filtered=${JSON.stringify(filtered)}`);
  await pageGitOps.locator("#gw-side-filter").fill("");
  await pageGitOps.waitForTimeout(100);

  // クリック: 先端コミットを履歴で表示
  await pageGitOps.locator('#gw-tag-tree .gw-tree-leaf[data-ref="v1.0"]').click();
  await pageGitOps.waitForTimeout(200);
  check("clicking a ref reveals its tip commit in History",
    (await pageGitOps.locator("#gw-nav-history").getAttribute("aria-current")) === "page"
      && await pageGitOps.locator("#gw-view-history").isVisible());

  // 現在のブランチはダブルクリックしてもチェックアウトしない
  await pageGitOps.locator('#gw-branch-tree .gw-tree-leaf[data-ref="main"]').dblclick();
  await pageGitOps.waitForTimeout(300);
  check("double-clicking the current branch does not check it out",
    (await callCount("__gitSwitchBranchCalls")) === 0);
  // ダブルクリック: ローカルはそのブランチへ切り替える（リポジトリルートで）
  await pageGitOps.locator('#gw-branch-tree .gw-tree-leaf[data-ref="develop"]').dblclick();
  await waitCalls("__gitSwitchBranchCalls", 1);
  const switchCall = await pageGitOps.evaluate(() => (window.__gitSwitchBranchCalls ?? [])[0]);
  check("double-clicking a local branch invokes git_switch_branch with root and branch",
    switchCall?.root === "/repo" && switchCall?.branch === "develop", `call=${JSON.stringify(switchCall)}`);
  const switchToast = await waitToast("Switched to branch 'develop'");
  check("branch checkout result is shown in the toast",
    switchToast.visible && switchToast.kind === "ok", `toast=${JSON.stringify(switchToast)}`);
  // 右クリックメニュー: 現在のブランチの Checkout は押せない
  await pageGitOps.locator('#gw-branch-tree .gw-tree-leaf[data-ref="main"]').click({ button: "right" });
  const currentMenu = await pageGitOps.evaluate(() =>
    [...document.querySelectorAll("#git-ref-ctx button")].map((b) => ({ text: b.textContent, disabled: b.disabled })));
  check("context menu offers checkout, show in history, and copy; disabled for the current branch",
    currentMenu.length === 3 && currentMenu[0].text === "チェックアウト" && currentMenu[0].disabled
      && !currentMenu[1].disabled && !currentMenu[2].disabled,
    `menu=${JSON.stringify(currentMenu)}`);
  await pageGitOps.keyboard.press("Escape");
  await pageGitOps.waitForTimeout(100);
  check("Escape closes the ref menu but keeps the Git window",
    (await pageGitOps.locator("#git-ref-ctx").count()) === 0 && await overlay.isVisible());
  await pageGitOps.locator('#gw-branch-tree .gw-tree-leaf[data-ref="feature/x"]').click({ button: "right" });
  await pageGitOps.locator("#git-ref-ctx button", { hasText: "チェックアウト" }).click();
  await waitCalls("__gitSwitchBranchCalls", 2);
  const menuSwitch = await pageGitOps.evaluate(() => (window.__gitSwitchBranchCalls ?? [])[1]);
  check("context menu Checkout switches to a nested local branch",
    menuSwitch?.root === "/repo" && menuSwitch?.branch === "feature/x", `call=${JSON.stringify(menuSwitch)}`);
  await waitToast("feature/x");
  // タグはチェックアウト項目を出さない
  await pageGitOps.locator('#gw-tag-tree .gw-tree-leaf[data-ref="v1.0"]').click({ button: "right" });
  const tagMenu = await pageGitOps.locator("#git-ref-ctx button").allTextContents();
  check("tag context menu has no checkout", tagMenu.length === 2 && !tagMenu.includes("チェックアウト"),
    `menu=${JSON.stringify(tagMenu)}`);
  await pageGitOps.keyboard.press("Escape");
  // リモートのダブルクリックは git_checkout_remote（同名ローカルへ / 追跡ブランチ作成）
  await pageGitOps.locator('#gw-remote-tree .gw-tree-leaf[data-ref="origin/develop"]').dblclick();
  await waitCalls("__gitCheckoutRemoteCalls", 1);
  const remoteCall = await pageGitOps.evaluate(() => (window.__gitCheckoutRemoteCalls ?? [])[0]);
  check("double-clicking a remote branch invokes git_checkout_remote",
    remoteCall?.root === "/repo" && remoteCall?.branch === "origin/develop", `call=${JSON.stringify(remoteCall)}`);
  await waitToast("Switched to a new branch");

  // Stash: 監視中の cwd 配下を未追跡ごと退避する
  await pageGitOps.locator("#git-stash").click();
  await waitCalls("__gitStashCalls", 1);
  const stashCwd = await pageGitOps.evaluate(() => (window.__gitStashCalls ?? [])[0]);
  check("stash invokes git_stash with watched cwd", stashCwd === "/home/user", `cwd=${stashCwd}`);
  const stashToast = await waitToast("Saved working directory");
  check("stash result shown in the toast", stashToast.visible && stashToast.kind === "ok",
    `toast=${JSON.stringify(stashToast)}`);

  // ============================================================
  // コミット: 上部の Commit はファイルステータスのコミット欄へ移ってメッセージにフォーカス
  // ============================================================
  const commitBtn = pageGitOps.locator("#git-commit");
  check("commit button enables when changes exist", await commitBtn.isEnabled());
  await commitBtn.click();
  await pageGitOps.waitForTimeout(200);
  const afterCommitBtn = await pageGitOps.evaluate(() => ({
    status: document.querySelector("#gw-nav-status")?.getAttribute("aria-current"),
    visible: document.querySelector("#gw-view-status")?.hidden === false,
    focused: document.activeElement?.id,
    modal: Boolean(document.querySelector("#commit-overlay")),
  }));
  check("Commit switches to File status and focuses the message instead of opening a modal",
    afterCommitBtn.status === "page" && afterCommitBtn.visible
      && afterCommitBtn.focused === "commit-message" && !afterCommitBtn.modal,
    `state=${JSON.stringify(afterCommitBtn)}`);
  const submitCommit = pageGitOps.locator("#commit-submit");
  const pushAfterCommit = pageGitOps.locator("#commit-push-after");
  check("commit box offers push after commit when a remote is available",
    await pushAfterCommit.isVisible() && await pushAfterCommit.isEnabled()
      && !(await pushAfterCommit.isChecked()));
  check("commit submit requires a message", await submitCommit.isDisabled());
  const selectionText = () => pageGitOps.locator("#commit-selection-count").textContent();
  const allSelectedText = await selectionText();
  // 全選択チェックでまとめて外す / 入れる
  await pageGitOps.locator("#commit-select-all").uncheck();
  const noneChecked = await pageGitOps.locator("#gw-status-files input:checked").count();
  await pageGitOps.locator("#commit-message").fill("temp");
  const disabledWithoutFiles = await submitCommit.isDisabled();
  await pageGitOps.locator("#commit-message").fill("");
  await pageGitOps.locator("#commit-select-all").check();
  const allChecked = await pageGitOps.locator("#gw-status-files input:checked").count();
  check("select all toggles every file and commit needs at least one file",
    noneChecked === 0 && disabledWithoutFiles && allChecked === 2,
    `none=${noneChecked} disabled=${disabledWithoutFiles} all=${allChecked}`);
  await pageGitOps.locator('#gw-status-files .gw-file-row[data-path="src/new.ts"] input').uncheck();
  const partialText = await selectionText();
  const selectAllIndeterminate = await pageGitOps.locator("#commit-select-all").evaluate((el) => el.indeterminate);
  check("unchecking a file updates the selection count and select-all state",
    partialText !== allSelectedText && partialText.includes("1") && selectAllIndeterminate,
    `before="${allSelectedText}" after="${partialText}"`);
  // ポーリングで新しい変更が来たら既定でチェック、外したチェックはそのまま
  await pageGitOps.evaluate(() => {
    window.__mockGitChanges = {
      ...window.__mockGitChanges,
      files: [...window.__mockGitChanges.files, { path: "src/late.ts", adds: 5, dels: 0, status: "A" }],
    };
  });
  await refreshWatch();
  const afterNewFile = await pageGitOps.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll("#gw-status-files .gw-file-row")].map(
      (row) => [row.dataset.path, row.querySelector("input")?.checked])));
  check("a newly changed file is checked while an unchecked file stays unchecked across polls",
    afterNewFile["src/late.ts"] === true && afterNewFile["src/new.ts"] === false
      && afterNewFile["src/app.ts"] === true
      && (await pageGitOps.locator("#git-open-badge").textContent()) === "3",
    `rows=${JSON.stringify(afterNewFile)}`);
  await pageGitOps.evaluate(() => {
    window.__mockGitChanges = {
      ...window.__mockGitChanges,
      files: window.__mockGitChanges.files.filter((f) => f.path !== "src/late.ts"),
    };
  });
  await refreshWatch();
  await pageGitOps.locator("#commit-message").fill("feat: add git actions\n\nOnly commit app.ts");
  await pushAfterCommit.check();
  check("commit enables with a selected file and message", await submitCommit.isEnabled());
  // Cmd/Ctrl+Enter で送信する
  const pushesBeforeCommit = await callCount("__gitPushCalls");
  await pageGitOps.locator("#commit-message").press(`${MOD}+Enter`);
  await waitCalls("__gitCommitCalls", 1);
  const commitCall = await pageGitOps.evaluate(() => (window.__gitCommitCalls ?? [])[0]);
  check("Cmd/Ctrl+Enter commits via git_commit with watched cwd, message, and selected paths",
    commitCall?.cwd === "/home/user"
      && commitCall?.message === "feat: add git actions\n\nOnly commit app.ts"
      && JSON.stringify(commitCall?.paths) === JSON.stringify(["src/app.ts"]),
    `call=${JSON.stringify(commitCall)}`);
  await waitCalls("__gitPushCalls", pushesBeforeCommit + 1);
  const commitPushCall = await pageGitOps.evaluate(() => (window.__gitPushCalls ?? []).at(-1));
  check("commit with push enabled invokes git_push after the commit",
    (await callCount("__gitPushCalls")) === pushesBeforeCommit + 1 && commitPushCall?.root === "/repo",
    `call=${JSON.stringify(commitPushCall)}`);
  const commitToast = await waitToast("feat: add git actions");
  await pageGitOps.waitForTimeout(100);
  const clearedMessage = await pageGitOps.locator("#commit-message").inputValue();
  check("commit result shown, message cleared, and the Git window stays open",
    commitToast.visible && commitToast.kind === "ok" && commitToast.detail.includes("Everything up-to-date")
      && clearedMessage === "" && !(await pushAfterCommit.isChecked()) && await overlay.isVisible(),
    `toast=${JSON.stringify(commitToast)} input="${clearedMessage}"`);
  // コミット失敗はコミット欄とトーストの両方に出す
  await pageGitOps.evaluate(() => { window.__mockGitCommitResult = { error: "error: pathspec did not match" }; });
  await pageGitOps.locator("#commit-message").fill("broken");
  await submitCommit.click();
  const commitErrToast = await waitToast("pathspec did not match");
  const commitErrBox = (await pageGitOps.locator("#commit-error").textContent()) ?? "";
  check("commit failure shows the error inline and keeps the message",
    commitErrToast.kind === "err" && commitErrBox.includes("pathspec")
      && await pageGitOps.locator("#commit-error").isVisible()
      && (await pageGitOps.locator("#commit-message").inputValue()) === "broken",
    `toast=${JSON.stringify(commitErrToast)} box="${commitErrBox}"`);
  await pageGitOps.evaluate(() => { window.__mockGitCommitResult = undefined; });
  await pageGitOps.locator("#commit-message").fill("");

  // Worktree から開くセッションが同じ階層へ入ることを検証するため、表示中セッションを
  // 一時グループで包む（グループ名ではなく安定 ID / DOM 階層で判定する）。
  await closeGit();
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
  await openWorktreeModal();
  await pageGitOps.waitForSelector("#worktree-overlay:not([hidden])");
  const defaultDirectory = await pageGitOps.locator("#worktree-directory").inputValue();
  const defaultBase = await pageGitOps.locator("#worktree-base").inputValue();
  const defaultOutside = await pageGitOps.locator("#worktree-loc input[value=outside]").isChecked();
  check("worktree modal defaults to outside ~/worktrees and the repository default branch",
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
  const worktreeMsg = await toastDetail();
  check("worktree result is shown and the modal closes",
    worktreeMsg.includes("/repo/.worktree/feature-strip-worktree")
      && await pageGitOps.locator("#worktree-overlay").isHidden(),
    `msg=${worktreeMsg}`);
  // 新しいセッションのターミナルを見せるため、Git ウィンドウも閉じる
  check("creating a worktree session closes the Git window",
    await pageGitOps.locator("#git-window-overlay").isHidden());
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
  await openWorktreeModal();
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
  await openWorktreeModal();
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
  await openWorktreeModal();
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
  await openWorktreeModal();
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
  await openWorktreeModal();
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
    msg: document.querySelector("#git-toast .git-toast-detail")?.textContent ?? "",
    gitWindowOpen: document.querySelector("#git-window-overlay")?.hidden === false,
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
      && !prSession.gitWindowOpen
      && JSON.stringify(prSession.selected) === JSON.stringify(["#42 リサイズ競合を直す"]),
    `session=${JSON.stringify(prSession)}`);


  // ============================================================
  // Push / Fetch / Pull（結果とエラーは右下のトーストに全文出す）
  // ============================================================
  await openGit();
  await pageGitOps.locator("#git-push").click();
  const pushToast = await waitToast("Everything up-to-date");
  const pushCall = await pageGitOps.evaluate(() => (window.__gitPushCalls ?? []).at(-1));
  check("push invokes git_push with repository root", pushCall?.root === "/repo", `call=${JSON.stringify(pushCall)}`);
  check("push result shown in the toast", pushToast.visible && pushToast.kind === "ok",
    `toast=${JSON.stringify(pushToast)}`);
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
  const pushErr = await waitToast("failed to push some refs");
  check("push failure shows every line, not just the first",
    pushErr.kind === "err"
      && pushErr.detail.includes("Pull first")
      && pushErr.detail.includes("To https://github.com/o/r.git")
      && pushErr.detail.includes("[rejected]")
      && pushErr.detail.includes("failed to push some refs"),
    `toast=${JSON.stringify(pushErr)}`);
  const pushErrWrap = await pageGitOps.evaluate(() => {
    const el = document.querySelector("#git-toast .git-toast-detail");
    const s = el ? getComputedStyle(el) : null;
    return {
      ws: s?.whiteSpace ?? "",
      h: el?.getBoundingClientRect().height ?? 0,
      clipped: el ? el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 : true,
    };
  });
  check("push failure wraps instead of clipping to one line",
    pushErrWrap.ws === "pre-wrap" && pushErrWrap.h > 40 && !pushErrWrap.clipped,
    `style=${JSON.stringify(pushErrWrap)}`);
  // 失敗トーストは Git ウィンドウより手前に出る
  const toastOnTop = await pageGitOps.evaluate(() => {
    const el = document.querySelector("#git-toast .git-toast-detail");
    const r = el?.getBoundingClientRect();
    if (!r) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 5);
    return Boolean(hit && document.querySelector("#git-toast")?.contains(hit));
  });
  check("the result toast is shown above the Git window", toastOnTop);
  await pageGitOps.evaluate(() => {
    window.__mockGitPushResult = undefined;
  });
  // Fetch: 全リモートの更新をリポジトリルートから取得する
  await pageGitOps.locator("#git-fetch").click();
  const fetchToast = await waitToast("Fetched all remotes");
  const fetchCall = await pageGitOps.evaluate(() => (window.__gitFetchCalls ?? [])[0]);
  check("fetch invokes git_fetch with repository root", fetchCall?.root === "/repo", `call=${JSON.stringify(fetchCall)}`);
  check("fetch result shown in the toast", fetchToast.visible && fetchToast.kind === "ok",
    `toast=${JSON.stringify(fetchToast)}`);
  // プル: ボタン押下後に取り込み元を選び、リポジトリルートで git_pull を呼ぶ
  await pageGitOps.locator("#git-pull").click();
  await pageGitOps.waitForSelector("#pull-overlay:not([hidden])", { timeout: 3000 }).catch(() => {});
  check("pull button opens a modal with upstream selected",
    await pageGitOps.locator("#pull-overlay").isVisible()
      && await pageGitOps.locator("#pull-branch").inputValue() === "origin/main");
  const pullOnTop = await pageGitOps.evaluate(() => {
    const btn = document.querySelector("#pull-submit");
    const r = btn?.getBoundingClientRect();
    if (!r) return false;
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#pull-submit") === btn;
  });
  check("pull modal stacks above the Git window", pullOnTop);
  await pageGitOps.locator("#pull-branch").selectOption("origin/develop");
  await pageGitOps.locator("#pull-submit").click();
  const pullToast = await waitToast("Already up to date");
  const pullCall = await pageGitOps.evaluate(() => (window.__gitPullCalls ?? [])[0]);
  check("pull invokes git_pull with selected branch",
    pullCall?.root === "/repo" && pullCall?.branch === "origin/develop",
    `call=${JSON.stringify(pullCall)}`);
  check("pull result shown in the toast and the Git window stays open",
    pullToast.visible && pullToast.kind === "ok" && await overlay.isVisible(),
    `toast=${JSON.stringify(pullToast)}`);
  // プル失敗（コンフリクト等）はエラー表示になる
  await pageGitOps.evaluate(() => {
    window.__mockGitPullResult = { error: "CONFLICT (content): merge conflict in src/app.ts" };
  });
  await pageGitOps.locator("#git-pull").click();
  await pageGitOps.locator("#pull-submit").click();
  const pullErr = await waitToast("CONFLICT");
  const pullModalErr = (await pageGitOps.locator("#pull-error").textContent()) ?? "";
  check("pull conflict shows error message",
    pullErr.kind === "err" && pullErr.detail.includes("CONFLICT") && pullModalErr.includes("CONFLICT"),
    `toast=${JSON.stringify(pullErr)} modal="${pullModalErr}"`);
  await pageGitOps.locator("#pull-cancel").click();
  await pageGitOps.evaluate(() => { window.__mockGitPullResult = undefined; });

  // 変更ゼロになったら Stash とコミットだけ disabled（Worktree/Push/Fetch/Pull は可能なまま）
  await pageGitOps.evaluate(() => {
    window.__mockGitChanges = { repo: true, root: "/repo", files: [] };
  });
  await refreshWatch();
  const cleanState = await pageGitOps.evaluate(() => ({
    stash: document.querySelector("#git-stash")?.disabled,
    commit: document.querySelector("#git-commit")?.disabled,
    worktree: document.querySelector("#git-worktree")?.disabled,
    push: document.querySelector("#git-push")?.disabled,
    fetch: document.querySelector("#git-fetch")?.disabled,
    pull: document.querySelector("#git-pull")?.disabled,
    badgeHidden: document.querySelector("#git-open-badge")?.hidden,
    empty: Boolean(document.querySelector("#gw-status-files .gw-status-empty")),
    submit: document.querySelector("#commit-submit")?.disabled,
    allDiff: document.querySelector("#gw-view-all-diff")?.disabled,
  }));
  check("change actions disabled when clean, remote actions stay enabled",
    cleanState.stash && cleanState.commit && !cleanState.worktree
      && !cleanState.push && !cleanState.fetch && !cleanState.pull,
    `state=${JSON.stringify(cleanState)}`);
  check("clean repo hides the badge and shows an empty File status",
    cleanState.badgeHidden && cleanState.empty && cleanState.submit && cleanState.allDiff,
    `state=${JSON.stringify(cleanState)}`);
  // リモートが無いリポジトリでは Pull / Push / Fetch を disabled にする（ボタンは残す）
  await pageGitOps.evaluate(() => {
    window.__mockGitBranches = { current: "main", upstream: null, localBranches: ["main"], branches: [], remotes: [] };
  });
  await refreshWatch();
  const noRemote = await pageGitOps.evaluate(() => Object.fromEntries(["pull", "push", "fetch"].map((id) => {
    const el = document.querySelector(`#git-${id}`);
    return [id, { visible: Boolean(el?.getClientRects().length), disabled: el?.disabled }];
  })));
  check("no-remote repo disables pull, push, and fetch",
    Object.values(noRemote).every((s) => s.visible && s.disabled),
    `state=${JSON.stringify(noRemote)}`);
  // リポジトリ外では「Git リポジトリではありません」を出し、操作はすべて disabled
  await pageGitOps.evaluate(() => {
    window.__mockGitChanges = { repo: false, root: null, files: [] };
  });
  await refreshWatch();
  const noRepo = await pageGitOps.evaluate(() => ({
    empty: document.querySelector("#gw-empty")?.hidden === false,
    text: document.querySelector("#gw-empty")?.textContent ?? "",
    status: document.querySelector("#gw-view-status")?.hidden,
    disabled: ["commit", "pull", "push", "fetch", "worktree", "stash"].every(
      (id) => document.querySelector(`#git-${id}`)?.disabled),
  }));
  check("outside a repository the Git window says so and disables every action",
    noRepo.empty && noRepo.text.length > 0 && noRepo.status && noRepo.disabled,
    `state=${JSON.stringify(noRepo)}`);
}
await pageGitOps.close();

}
