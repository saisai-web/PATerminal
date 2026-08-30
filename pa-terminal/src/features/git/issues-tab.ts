// git セクションの Issue タブ（gh CLI）: 一覧・詳細モーダル・既存ブランチの紐付け・
// Issue の作業用セッションの作成。
//
// 一覧の取得はタブを開いた時と60秒間隔と手動 ⟳ のみ（ネットワークを3秒ごとに叩かない）。
// 監視中のリポジトリ（issueRoot）はこのモジュールが所有し、PR タブ / PR オーバーレイは
// getIssueRoot() で読む。

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { getDeps, getActiveTab, renderWorktreesTab } from "./git-panel";
import { formatDate, statusEl } from "./git-log";
import { fetchPrList, fetchPrListIfStale, renderPrList, resetPrList } from "./pr-tab";
import { closePrOverlay } from "./pr-overlay";
import { getWorktreePrefs, updateWorktreePrefs, worktreeDirFor } from "./worktree";
import type { WorktreeBranch, WorktreeBranches, WorktreeLocation, WorktreeResult } from "./worktree";
import type { GitLog, IssueBranchLink, IssueInfo, IssueList, IssueSummary } from "./git-panel-types";

const issuesEl = document.querySelector<HTMLDivElement>("#exp-git-issues")!;

let issueRoot: string | null = null;
let issueListData: IssueList | null = null;
let issueListFetchedAt = 0;
let issueListToken = 0;
let selectedIssueNumber: number | null = null;
let selectedIssue: IssueInfo | null = null;
let issueDetailToken = 0;
let issueBranches: WorktreeBranch[] = [];
let issueBranchesBusyFor: string | null = null;
const ISSUE_REFRESH_MS = 60_000;

const issueOverlay = document.querySelector<HTMLDivElement>("#issue-overlay")!;
const issuePanel = document.querySelector<HTMLDivElement>("#issue-panel")!;
const issueStateEl = document.querySelector<HTMLSpanElement>("#issue-state")!;
const issueTitleEl = document.querySelector<HTMLSpanElement>("#issue-title")!;
const issueOpenGhBtn = document.querySelector<HTMLButtonElement>("#issue-open-gh")!;
const issueCloseBtn = document.querySelector<HTMLButtonElement>("#issue-close")!;
const issueContentEl = document.querySelector<HTMLDivElement>("#issue-content")!;
let issuePreviousFocus: HTMLElement | null = null;

/** 監視中のリポジトリルート。PR タブ / PR オーバーレイの同一性判定に使う */
export function getIssueRoot(): string | null {
  return issueRoot;
}

/** Issue タブを表示した時: 一覧が古ければ取り直す */
export function issuesTabShown(): void {
  renderIssues();
  if (
    issueRoot &&
    selectedIssueNumber === null &&
    (!issueListData || Date.now() - issueListFetchedAt > ISSUE_REFRESH_MS)
  ) {
    void fetchIssueList(issueRoot);
  }
}

/** ⟳ ボタン（Issue タブ）: 詳細を開いていればその再取得、一覧表示中なら一覧の再取得 */
export function refreshIssuesTab(): void {
  if (selectedIssueNumber !== null) void openIssue(selectedIssueNumber);
  else if (issueRoot) void fetchIssueList(issueRoot);
}

/** 言語切替時: 開いている詳細モーダルを作り直す */
export function renderIssueOverlayTexts(): void {
  if (!issueOverlay.hidden) renderIssueOverlay();
}

export function updateIssueTarget(res: GitLog | null): void {
  const root = res?.repo && res.root ? res.root : null;
  if (root === issueRoot) {
    if (
      getActiveTab() === "issues" &&
      root &&
      selectedIssueNumber === null &&
      Date.now() - issueListFetchedAt > ISSUE_REFRESH_MS
    ) {
      void fetchIssueList(root);
    }
    if (getActiveTab() === "prs" && root) {
      fetchPrListIfStale(root);
    }
    return;
  }
  issueRoot = root;
  issueListData = null;
  issueListFetchedAt = 0;
  resetPrList();
  closeIssueOverlay();
  closePrOverlay();
  issueBranches = [];
  issueBranchesBusyFor = null;
  issueListToken++;
  if (getActiveTab() === "issues") {
    renderIssues();
    if (root) void fetchIssueList(root);
  } else if (getActiveTab() === "prs") {
    renderPrList();
    if (root) void fetchPrList(root);
  } else if (getActiveTab() === "worktrees") {
    renderWorktreesTab(root);
  }
}

async function fetchIssueList(root: string): Promise<void> {
  const token = ++issueListToken;
  issueListData = null;
  selectedIssueNumber = null;
  selectedIssue = null;
  renderIssues();
  const res = await invoke<IssueList>("issue_list", { root }).catch(() => null);
  if (token !== issueListToken || root !== issueRoot) return;
  issueListFetchedAt = Date.now();
  issueListData = res ?? { available: false, issues: [] };
  renderIssues();
}

function buildIssueRow(issue: IssueSummary): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "issue-row";
  row.role = "button";
  row.tabIndex = 0;
  row.title = issue.title;
  const number = document.createElement("span");
  number.className = "issue-number";
  number.textContent = `#${issue.number}`;
  const title = document.createElement("span");
  title.className = "issue-row-title";
  title.textContent = issue.title;
  const facts = document.createElement("div");
  facts.className = "issue-row-facts";
  const assignees = document.createElement("span");
  assignees.className = "issue-row-assignees";
  assignees.setAttribute("aria-label", t("issue.assignees"));
  const assignedLogins = issue.assignees ?? [];
  if (assignedLogins.length === 0) {
    const unassigned = document.createElement("span");
    unassigned.className = "issue-assignee is-unassigned";
    unassigned.textContent = t("issue.unassigned");
    assignees.append(unassigned);
  } else {
    for (const login of assignedLogins) {
      const assignee = document.createElement("span");
      assignee.className = "issue-assignee";
      assignee.textContent = `@${login}`;
      assignees.append(assignee);
    }
  }
  facts.append(assignees);
  const issueLabels = issue.labels ?? [];
  if (issueLabels.length > 0) {
    const labels = document.createElement("span");
    labels.className = "issue-row-labels";
    labels.setAttribute("aria-label", t("issue.labels"));
    for (const name of issueLabels) {
      const label = document.createElement("span");
      label.className = "issue-label";
      label.textContent = name;
      labels.append(label);
    }
    facts.append(labels);
  }
  const meta = document.createElement("span");
  meta.className = "issue-row-meta";
  meta.textContent = `${issue.author} · ${formatDate(issue.updatedAt)}`;
  row.append(number, title, facts, meta);
  row.onclick = () => void openIssue(issue.number);
  row.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    }
  };
  return row;
}

export function renderIssues(): void {
  issuesEl.innerHTML = "";
  if (!issueRoot) {
    issuesEl.append(statusEl(t("issue.empty")));
    return;
  }
  if (!issueListData) {
    issuesEl.append(statusEl(t("issue.loading")));
    return;
  }
  if (!issueListData.available) {
    issuesEl.append(statusEl(t("issue.loadFailed"), true));
    return;
  }
  // クローズ済みは出さない（gh 側も --state open だが、古いキャッシュ相手の保険）
  const open = issueListData.issues.filter((issue) => (issue.state ?? "").toUpperCase() !== "CLOSED");
  if (open.length === 0) {
    issuesEl.append(statusEl(t("issue.empty")));
    return;
  }
  for (const issue of open) issuesEl.append(buildIssueRow(issue));
}

async function openIssue(number: number): Promise<void> {
  const root = issueRoot;
  if (!root) return;
  if (issueOverlay.hidden) {
    issuePreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  selectedIssueNumber = number;
  selectedIssue = null;
  issueOverlay.hidden = false;
  renderIssueOverlay();
  issueCloseBtn.focus();
  const token = ++issueDetailToken;
  const [info] = await Promise.all([
    invoke<IssueInfo>("issue_info", { root, number }).catch(() => null),
    fetchIssueBranches(root),
  ]);
  if (token !== issueDetailToken || root !== issueRoot || number !== selectedIssueNumber) return;
  selectedIssue = info ?? {
    found: false,
    number: null,
    title: null,
    state: null,
    url: null,
    author: null,
    body: null,
    labels: [],
    comments: [],
  };
  renderIssueOverlay();
}

function closeIssueOverlay(): void {
  issueOverlay.hidden = true;
  selectedIssueNumber = null;
  selectedIssue = null;
  issueDetailToken++;
  issueContentEl.replaceChildren();
  if (issuePreviousFocus?.isConnected) issuePreviousFocus.focus();
  issuePreviousFocus = null;
}

function renderIssueOverlay(): void {
  const number = selectedIssueNumber;
  if (number === null) return;
  const issue = selectedIssue;
  const summary = issueListData?.issues.find((item) => item.number === number);
  const state = issue?.state ?? summary?.state ?? null;
  const url = issue?.url ?? summary?.url ?? null;
  issueStateEl.hidden = state === null;
  issueStateEl.className = `issue-state${state === "CLOSED" ? " is-closed" : ""}`;
  issueStateEl.textContent = state === null ? "" : issueStateLabel(state);
  issueTitleEl.textContent = `#${number} ${issue?.title ?? summary?.title ?? ""}`.trim();
  issueTitleEl.title = url ?? "";
  issueOpenGhBtn.hidden = !url;
  issueContentEl.replaceChildren();
  if (!issue) {
    issueContentEl.append(statusEl(t("issue.loading")));
  } else if (!issue.found) {
    issueContentEl.append(statusEl(t("issue.loadFailed"), true));
  } else if (issueRoot) {
    issueContentEl.append(buildIssueDetail(issueRoot, issue));
  }
}

async function fetchIssueBranches(root: string): Promise<void> {
  if (issueBranchesBusyFor === root) return;
  issueBranchesBusyFor = root;
  try {
    const res = await invoke<WorktreeBranches>("git_worktree_branches", { root }).catch(() => null);
    if (root === issueRoot) issueBranches = res?.branches ?? [];
  } finally {
    if (issueBranchesBusyFor === root) issueBranchesBusyFor = null;
  }
}

function issueBranchName(issue: IssueInfo): string {
  const slug = (issue.title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `issue/${issue.number ?? "x"}${slug ? `-${slug}` : ""}`;
}

function issueStateLabel(state: string | null): string {
  return state === "CLOSED" ? t("issue.stateClosed") : t("issue.stateOpen");
}

function buildIssueDetail(root: string, issue: IssueInfo): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "issue-detail";
  const meta = document.createElement("div");
  meta.className = "issue-detail-meta";
  const labels = issue.labels.length ? ` · ${issue.labels.join(", ")}` : "";
  meta.textContent = `${issue.author ?? "?"}${labels}`;
  const body = document.createElement("div");
  body.className = "issue-body";
  body.textContent = issue.body || t("issue.noDescription");
  wrap.append(meta, body);

  if (issue.comments.length > 0) {
    const commentsTitle = document.createElement("div");
    commentsTitle.className = "issue-comments-title";
    commentsTitle.textContent = `${t("issue.comments")} (${issue.comments.length})`;
    wrap.append(commentsTitle);
    for (const comment of issue.comments) {
      const card = document.createElement("div");
      card.className = "issue-comment";
      const cardHead = document.createElement("div");
      cardHead.className = "issue-comment-head";
      cardHead.textContent = `${comment.author} · ${formatDate(comment.createdAt)}`;
      const cardBody = document.createElement("div");
      cardBody.className = "issue-comment-body";
      cardBody.textContent = comment.body;
      card.append(cardHead, cardBody);
      wrap.append(card);
    }
  }
  wrap.append(buildIssueLinkControls(root, issue), buildIssueRunControls(root, issue));
  return wrap;
}

function buildIssueLinkControls(root: string, issue: IssueInfo): HTMLDivElement {
  const section = document.createElement("div");
  section.className = "issue-link";
  const title = document.createElement("div");
  title.className = "issue-link-title";
  title.textContent = t("issue.linkTitle");
  const hint = document.createElement("div");
  hint.className = "issue-link-hint";
  hint.textContent = t("issue.linkHint");
  const label = document.createElement("label");
  label.textContent = t("issue.localBranch");
  const row = document.createElement("div");
  row.className = "issue-link-row";
  const select = document.createElement("select");
  const localBranches = issueBranches.filter((b) => b.reference.startsWith("refs/heads/"));
  for (const branch of localBranches) {
    const option = document.createElement("option");
    option.value = branch.name;
    option.textContent = branch.name;
    option.selected = branch.current;
    select.append(option);
  }
  if (localBranches.length === 0) {
    const option = document.createElement("option");
    option.textContent = t("issue.noLocalBranches");
    select.append(option);
    select.disabled = true;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "issue-link-action";
  button.textContent = t("issue.linkAction");
  button.disabled = localBranches.length === 0 || !issue.number;
  const message = document.createElement("div");
  message.className = "issue-run-message issue-link-message";
  button.onclick = () => void linkIssueBranch(root, issue, select, button, message);
  row.append(select, button);
  section.append(title, hint, label, row, message);
  return section;
}

async function linkIssueBranch(
  root: string,
  issue: IssueInfo,
  select: HTMLSelectElement,
  button: HTMLButtonElement,
  message: HTMLDivElement,
): Promise<void> {
  if (!issue.number || !select.value) return;
  button.disabled = true;
  select.disabled = true;
  message.classList.remove("is-error");
  message.textContent = t("issue.linking");
  try {
    const result = await invoke<IssueBranchLink>("issue_link_branch", {
      root,
      number: issue.number,
      branch: select.value,
    });
    message.textContent = t("issue.linkSuccess", {
      branch: result.branch,
      number: String(issue.number),
      remote: result.remote,
    });
  } catch (e) {
    message.classList.add("is-error");
    message.textContent = t("issue.linkFailed", { error: String(e) });
  } finally {
    button.disabled = false;
    select.disabled = false;
  }
}

function buildIssueRunControls(root: string, issue: IssueInfo): HTMLDivElement {
  const run = document.createElement("div");
  run.className = "issue-run";
  const runTitle = document.createElement("div");
  runTitle.className = "issue-run-title";
  runTitle.textContent = t("issue.runTitle");
  const toggle = document.createElement("label");
  toggle.className = "issue-worktree-toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.disabled = issueBranches.length === 0;
  toggle.append(checkbox, document.createTextNode(t("issue.useWorktree")));

  const fields = document.createElement("div");
  fields.className = "issue-worktree-fields";
  fields.hidden = true;
  const baseLabel = document.createElement("label");
  baseLabel.textContent = t("issue.baseBranch");
  const base = document.createElement("select");
  for (const b of issueBranches) {
    const option = document.createElement("option");
    option.value = b.reference;
    option.textContent = b.name;
    option.selected = b.current;
    base.append(option);
  }
  const branchLabel = document.createElement("label");
  branchLabel.textContent = t("issue.newBranch");
  const branch = document.createElement("input");
  branch.type = "text";
  branch.className = "issue-worktree-branch";
  branch.value = issueBranchName(issue);
  // 置き場所（リポジトリ配下 / 外）。前回使ったモードと格納先を初期値にする
  const prefs = getWorktreePrefs();
  const locLabel = document.createElement("label");
  locLabel.textContent = t("issue.worktreeLocationMode");
  const loc = document.createElement("div");
  loc.className = "wt-loc";
  const locRadios: HTMLInputElement[] = [];
  for (const value of ["inside", "outside"] as const) {
    const item = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `issue-worktree-loc-${issue.number ?? "x"}`;
    radio.value = value;
    radio.checked = prefs.location === value;
    const text = document.createElement("span");
    text.textContent = t(value === "outside" ? "issue.worktreeOutside" : "issue.worktreeInside");
    item.append(radio, text);
    loc.append(item);
    locRadios.push(radio);
  }
  const directoryLabel = document.createElement("label");
  const directory = document.createElement("input");
  directory.type = "text";
  directory.className = "issue-worktree-directory";
  directory.value = worktreeDirFor(prefs.location);
  directory.spellcheck = false;
  const locationOf = (): WorktreeLocation =>
    locRadios.find((r) => r.checked)?.value === "outside" ? "outside" : "inside";
  const applyLocation = () => {
    directoryLabel.textContent = t(
      locationOf() === "outside" ? "issue.worktreeDirectoryExternal" : "issue.worktreeDirectory",
    );
  };
  for (const radio of locRadios) {
    radio.onchange = () => {
      directory.value = worktreeDirFor(locationOf());
      applyLocation();
    };
  }
  applyLocation();
  fields.append(baseLabel, base, branchLabel, branch, locLabel, loc, directoryLabel, directory);
  checkbox.onchange = () => {
    fields.hidden = !checkbox.checked;
  };

  const actions = document.createElement("div");
  actions.className = "issue-session-actions";
  const create = document.createElement("button");
  create.type = "button";
  create.textContent = t("issue.runSession");
  const message = document.createElement("div");
  message.className = "issue-run-message";
  create.onclick = () =>
    void createIssueSession(
      root,
      issue,
      checkbox,
      base,
      branch,
      directory,
      locationOf,
      create,
      message,
    );
  actions.append(create);
  run.append(runTitle, toggle, fields, actions, message);
  return run;
}

async function createIssueSession(
  root: string,
  issue: IssueInfo,
  useWorktree: HTMLInputElement,
  base: HTMLSelectElement,
  branch: HTMLInputElement,
  directory: HTMLInputElement,
  locationOf: () => WorktreeLocation,
  button: HTMLButtonElement,
  message: HTMLDivElement,
): Promise<void> {
  button.disabled = true;
  message.classList.remove("is-error");
  message.textContent = t("issue.preparing");
  try {
    let cwd = root;
    if (useWorktree.checked) {
      const newBranch = branch.value.trim();
      const worktreeDirectory = directory.value.trim();
      if (!base.value || !newBranch || !worktreeDirectory) {
        throw new Error("base branch, new branch, and worktree directory are required");
      }
      const location = locationOf();
      const result = await invoke<WorktreeResult>("git_worktree_create", {
        root,
        baseRef: base.value,
        branch: newBranch,
        directory: worktreeDirectory,
        location,
      });
      updateWorktreePrefs(
        location === "outside"
          ? { location, outsideDir: worktreeDirectory }
          : { location, insideDir: worktreeDirectory },
      );
      cwd = result.path;
    }
    getDeps().createIssueSession({
      issueNumber: issue.number ?? 0,
      issueTitle: issue.title ?? "Issue",
      cwd,
    });
    message.textContent = "";
  } catch (e) {
    message.classList.add("is-error");
    message.textContent = t("issue.runFailed", { error: String(e) });
  } finally {
    button.disabled = false;
  }
}

issueOpenGhBtn.onclick = () => {
  const summaryUrl = issueListData?.issues.find((item) => item.number === selectedIssueNumber)?.url;
  const url = selectedIssue?.url ?? summaryUrl;
  if (url) void invoke("open_url", { url }).catch(() => {});
};
issueCloseBtn.onclick = closeIssueOverlay;
issueOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === issueOverlay) closeIssueOverlay();
});
issuePanel.addEventListener("keydown", (e) => e.stopPropagation());
window.addEventListener(
  "keydown",
  (e) => {
    if (!issueOverlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      closeIssueOverlay();
    }
  },
  true,
);
