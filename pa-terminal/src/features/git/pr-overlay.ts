// 現在ブランチの PR バッジ（gh CLI）と、PR の変更ファイル / conversation オーバーレイ。
//
// PR 情報（pr_info = gh CLI、ネットワーク）は root+branch が変わった時と60秒間隔と
// 手動 ⟳ のみ。gh 不在・未認証・PR 無しはバッジ非表示に退化するだけで壊れない。
// オーバーレイは diff オーバーレイと同じ操作系（layout() には触れない）。

import { invoke } from "@tauri-apps/api/core";
import { renderPullRequestDiffBody } from "./diff-overlay";
import type { CommitDiff } from "./diff-overlay";
import { copyText } from "../../shared/clipboard";
import { getLang, t } from "../../i18n";
import { getActiveTab } from "./git-panel";
import { statusEl } from "./git-log";
import { getIssueRoot } from "./issues-tab";
import { getPrListPrs } from "./pr-tab";
import { openWorktreeDialogForPr } from "./pr-worktree";
import { isWorktreeDialogOpen } from "./worktree-dialog";
import type { GitLog, PrInfo, PrSummary } from "./git-panel-types";

const prBtn = document.querySelector<HTMLButtonElement>("#exp-git-pr")!;

let curKey: string | null = null; // `${root}\0${branch}`。PR 照会の同一性キー
let prBusy = false;
let prInfo: PrInfo | null = null;
let prFetchedAt = 0;
const PR_REFRESH_MS = 60_000; // gh はネットワークを叩くので3秒ごとには呼ばない

// ============================================================
// PR 情報（gh CLI）: root+branch の変化で即取得、同一なら60秒ごと、⟳ で強制
// ============================================================

export function updatePrTarget(res: GitLog | null): void {
  // detached HEAD はブランチ名が SHA なので PR 照会をスキップ
  const key = res?.repo && res.root && res.branch && !res.detached ? `${res.root}\u0000${res.branch}` : null;
  if (key !== curKey) {
    curKey = key;
    prInfo = null;
    prFetchedAt = 0;
    renderPrBadge();
    if (key) void fetchPr(res!.root!, res!.branch!);
    return;
  }
  if (key && Date.now() - prFetchedAt > PR_REFRESH_MS) {
    void fetchPr(res!.root!, res!.branch!);
  }
}

async function fetchPr(root: string, branch: string): Promise<void> {
  if (prBusy) return;
  prBusy = true;
  try {
    const res = await invoke<PrInfo>("pr_info", { root, branch }).catch(() => null);
    if (`${root}\u0000${branch}` !== curKey) return; // 取得中にブランチが変わった
    prFetchedAt = Date.now();
    prInfo = res;
    renderPrBadge();
  } finally {
    prBusy = false;
  }
}

export function prStateClass(state: string | null | undefined): string {
  return state === "MERGED" ? "pr-merged" : state === "CLOSED" ? "pr-closed" : "pr-open";
}

export function prStateLabel(state: string | null | undefined): string {
  return state === "MERGED" ? t("git.prMerged") : state === "CLOSED" ? t("git.prClosed") : "Open";
}

export function renderPrBadge(): void {
  const pr = prInfo;
  if (getActiveTab() !== "branch" || !pr?.found || pr.number === null) {
    prBtn.hidden = true;
    return;
  }
  prBtn.hidden = false;
  prBtn.textContent = `PR #${pr.number}`;
  prBtn.className = prStateClass(pr.state);
  prBtn.title = t("git.prBadgeTitle", { title: pr.title ?? "" });
}

/** ⟳ ボタン（Branch タブ）: 現在ブランチの PR を取り直す */
export function refreshPrBadge(): void {
  prFetchedAt = 0;
  const key = curKey;
  if (!key) return;
  const [root, branch] = key.split("\u0000");
  void fetchPr(root, branch);
}

// ============================================================
// PR conversation オーバーレイ（diff オーバーレイと同じ操作系。layout() には触れない）
// ============================================================

const prOverlay = document.querySelector<HTMLDivElement>("#pr-overlay")!;
const prPanel = document.querySelector<HTMLDivElement>("#pr-panel")!;
const prStateEl = document.querySelector<HTMLSpanElement>("#pr-state")!;
const prTitleEl = document.querySelector<HTMLSpanElement>("#pr-title")!;
const prSessionBtn = document.querySelector<HTMLButtonElement>("#pr-new-session")!;
const prOpenGhBtn = document.querySelector<HTMLButtonElement>("#pr-open-gh")!;
const prCloseBtn = document.querySelector<HTMLButtonElement>("#pr-close")!;
const prOverviewEl = document.querySelector<HTMLDivElement>("#pr-overview")!;
const prFilesTabBtn = document.querySelector<HTMLButtonElement>("#pr-files-tab")!;
const prConversationTabBtn = document.querySelector<HTMLButtonElement>("#pr-conversation-tab")!;
const prFilesViewEl = document.querySelector<HTMLDivElement>("#pr-files-view")!;
const prFilesStatusEl = document.querySelector<HTMLDivElement>("#pr-files-status")!;
const prFilesEl = document.querySelector<HTMLDivElement>("#pr-files")!;
const prBodyEl = document.querySelector<HTMLDivElement>("#pr-body")!;

let prActiveTab: "files" | "conversation" = "files";
let shownPrInfo: PrInfo | null = null;
let shownPrSummary: PrSummary | null = null;
let shownPrDiff: CommitDiff | null = null;
let shownPrDiffError = "";
let prOverlayToken = 0;
let prPreviousFocus: HTMLElement | null = null;

/** 言語切替時: 開いているオーバーレイを作り直す */
export function renderPrOverlayTexts(): void {
  if (!prOverlay.hidden) renderPrOverlay();
}

function buildPrCard(
  author: string,
  kindLabel: string,
  kindClass: string,
  time: string,
  body: string,
  location?: string,
  copyLocationAndBody = false,
  code?: string | null,
): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "pr-comment";
  const head = document.createElement("div");
  head.className = "pr-comment-head";
  const authorEl = document.createElement("span");
  authorEl.className = "pr-comment-author";
  authorEl.textContent = author;
  head.append(authorEl);
  if (kindLabel) {
    const kind = document.createElement("span");
    kind.className = `pr-comment-kind ${kindClass}`.trim();
    kind.textContent = kindLabel;
    head.append(kind);
  }
  if (time) {
    const timeEl = document.createElement("span");
    timeEl.className = "pr-comment-time";
    const d = new Date(time);
    timeEl.textContent = Number.isNaN(d.getTime()) ? time : d.toLocaleString(getLang());
    timeEl.title = time;
    head.append(timeEl);
  }
  if (copyLocationAndBody && location) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "pr-comment-copy";
    copyBtn.textContent = t("git.copyComment");
    copyBtn.title = t("git.copyCommentTitle");
    copyBtn.onclick = async () => {
      await copyText(`${location}\n${body}`);
      copyBtn.textContent = t("git.commentCopied");
      window.setTimeout(() => {
        if (copyBtn.isConnected) copyBtn.textContent = t("git.copyComment");
      }, 1500);
    };
    head.append(copyBtn);
  }
  card.append(head);
  if (location) {
    const locEl = document.createElement("div");
    locEl.className = "pr-comment-loc";
    locEl.textContent = location;
    locEl.title = location;
    card.append(locEl);
  }
  if (code !== undefined && code !== null) {
    const codeEl = document.createElement("pre");
    codeEl.className = "pr-comment-code";
    const codeText = document.createElement("code");
    codeText.textContent = code;
    codeEl.append(codeText);
    card.append(codeEl);
  }
  if (body) {
    const bodyEl = document.createElement("div");
    bodyEl.className = "pr-comment-body";
    bodyEl.textContent = body; // markdown はプレーン表示（HTML 注入させない）
    card.append(bodyEl);
  }
  return card;
}

function reviewKind(state: string | null): { label: string; cls: string } {
  if (state === "APPROVED") return { label: t("git.reviewApproved"), cls: "pr-approved" };
  if (state === "CHANGES_REQUESTED") return { label: t("git.reviewChangesRequested"), cls: "pr-changes" };
  return { label: t("git.reviewCommented"), cls: "" };
}

function prFileTotals(pr: PrInfo): { additions: number; deletions: number } {
  const files = pr.files ?? [];
  return {
    additions: pr.additions ?? files.reduce((n, f) => n + f.additions, 0),
    deletions: pr.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
  };
}

function renderPrFiles(): void {
  prFilesEl.replaceChildren();
  prFilesStatusEl.hidden = false;
  prFilesStatusEl.className = "pr-files-status";
  if (shownPrDiffError) {
    prFilesStatusEl.classList.add("is-error");
    prFilesStatusEl.textContent = t("git.prDiffFailed", { error: shownPrDiffError });
  } else if (!shownPrDiff) {
    prFilesStatusEl.textContent = t("git.prDiffLoading");
  } else {
    prFilesStatusEl.hidden = true;
    prFilesEl.append(renderPullRequestDiffBody(shownPrDiff));
  }
}

function setPrTab(tab: "files" | "conversation"): void {
  prActiveTab = tab;
  const files = tab === "files";
  prFilesTabBtn.classList.toggle("is-active", files);
  prFilesTabBtn.setAttribute("aria-selected", String(files));
  prConversationTabBtn.classList.toggle("is-active", !files);
  prConversationTabBtn.setAttribute("aria-selected", String(!files));
  prFilesViewEl.hidden = !files;
  prBodyEl.hidden = files;
}

function renderPrSessionControls(number: number | null, headRefName: string | null): void {
  prSessionBtn.textContent = t("pr.newSession");
  prSessionBtn.title = t("pr.newSessionTitle");
  prSessionBtn.disabled = number === null || !headRefName;
}

function renderPrOverlay(): void {
  const pr = shownPrInfo;
  const summaryInfo = shownPrSummary;
  const number = pr?.number ?? summaryInfo?.number ?? null;
  const title = pr?.title ?? summaryInfo?.title ?? "";
  const state = pr?.state ?? summaryInfo?.state ?? null;
  const url = pr?.url ?? summaryInfo?.url ?? null;
  const headRefName = pr?.headRefName ?? summaryInfo?.headRefName ?? null;
  prStateEl.hidden = state === null;
  prStateEl.textContent = summaryInfo?.isDraft ? t("git.prDraft") : prStateLabel(state);
  prStateEl.className = prStateClass(state);
  prTitleEl.textContent = `#${number ?? "?"} ${title}`.trim();
  prTitleEl.title = url ?? "";
  prOpenGhBtn.hidden = !url;
  renderPrSessionControls(number, headRefName);

  prOverviewEl.replaceChildren();
  prBodyEl.replaceChildren();
  if (!pr) {
    const branches = document.createElement("strong");
    branches.textContent = summaryInfo
      ? `${summaryInfo.headRefName} → ${summaryInfo.baseRefName}`
      : t("pr.loading");
    prOverviewEl.append(branches);
    prFilesTabBtn.textContent = t("git.prFiles");
    prConversationTabBtn.textContent = t("git.prConversation");
    prBodyEl.append(statusEl(t("pr.detailLoading")));
    renderPrFiles();
    setPrTab(prActiveTab);
    return;
  }
  if (!pr.found) {
    prOverviewEl.append(statusEl(t("pr.detailFailed"), true));
    prFilesTabBtn.textContent = t("git.prFiles");
    prConversationTabBtn.textContent = t("git.prConversation");
    prBodyEl.append(statusEl(t("pr.detailFailed"), true));
    renderPrFiles();
    setPrTab(prActiveTab);
    return;
  }

  const files = pr.files ?? [];
  const fileCount = pr.changedFiles ?? files.length;
  const totals = prFileTotals(pr);
  const overview = document.createElement("strong");
  overview.textContent = t("git.prFilesSummary", { n: String(fileCount) });
  const adds = document.createElement("span");
  adds.className = "pr-overview-adds";
  adds.textContent = `+${totals.additions}`;
  const dels = document.createElement("span");
  dels.className = "pr-overview-dels";
  dels.textContent = `−${totals.deletions}`;
  prOverviewEl.append(overview, adds, dels);

  const conversationCount = pr.comments.length + (pr.body && pr.author ? 1 : 0);
  prFilesTabBtn.textContent = t("git.prFilesTab", { n: String(fileCount) });
  prConversationTabBtn.textContent = t("git.prConversationTab", { n: String(conversationCount) });
  renderPrFiles();

  if (pr.body && pr.author) {
    prBodyEl.append(buildPrCard(pr.author, t("git.prDescription"), "", "", pr.body));
  }
  if (pr.comments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pr-empty";
    empty.textContent = t("git.prNoComments");
    prBodyEl.append(empty);
  }
  for (const c of pr.comments) {
    const kind =
      c.kind === "review" ? reviewKind(c.state) : c.kind === "inline" ? { label: t("git.reviewInline"), cls: "pr-inline" } : { label: "", cls: "" };
    const location = c.kind === "inline" && c.path ? (c.line !== null ? `${c.path}:${c.line}` : c.path) : undefined;
    prBodyEl.append(
      buildPrCard(
        c.author,
        kind.label,
        kind.cls,
        c.createdAt,
        c.body,
        location,
        c.kind === "inline",
        c.kind === "inline" ? c.code : null,
      ),
    );
  }
  setPrTab(prActiveTab);
}

function unavailablePrInfo(): PrInfo {
  return {
    found: false,
    number: null,
    title: null,
    headRefName: null,
    state: null,
    url: null,
    author: null,
    body: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    files: [],
    comments: [],
  };
}

async function loadPrOverlay(root: string, number: number, knownInfo: PrInfo | null): Promise<void> {
  const token = ++prOverlayToken;
  const detailPromise = knownInfo
    ? Promise.resolve(knownInfo)
    : invoke<PrInfo>("pr_detail", { root, number }).catch(() => unavailablePrInfo());
  const diffPromise = invoke<CommitDiff>("pr_diff", { root, number })
    .then((diff) => ({ diff, error: "" }))
    .catch((error) => ({ diff: null, error: String(error) }));
  const [detail, diff] = await Promise.all([detailPromise, diffPromise]);
  if (token !== prOverlayToken || root !== getIssueRoot() || number !== (shownPrInfo?.number ?? shownPrSummary?.number)) return;
  shownPrInfo = detail;
  shownPrDiff = diff.diff;
  shownPrDiffError = diff.error;
  renderPrOverlay();
}

function openPrOverlay(root: string, number: number, knownInfo: PrInfo | null, summary: PrSummary | null): void {
  if (number <= 0) return;
  if (prOverlay.hidden) {
    prPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  shownPrInfo = knownInfo;
  shownPrSummary = summary;
  shownPrDiff = null;
  shownPrDiffError = "";
  prActiveTab = "files";
  prOverlay.hidden = false;
  renderPrOverlay();
  prCloseBtn.focus();
  void loadPrOverlay(root, number, knownInfo);
}

export function openPrFromList(summary: PrSummary): void {
  const root = getIssueRoot();
  if (!root) return;
  openPrOverlay(root, summary.number, null, summary);
}

function openCurrentPrOverlay(): void {
  const current = prInfo;
  const root = curKey?.split("\u0000")[0];
  if (!root || !current?.found || current.number === null) return;
  const summary = getPrListPrs()?.find((item) => item.number === current.number) ?? null;
  openPrOverlay(root, current.number, current, summary);
}

export function closePrOverlay(restoreFocus = true): void {
  prOverlay.hidden = true;
  prOverlayToken++;
  shownPrInfo = null;
  shownPrSummary = null;
  shownPrDiff = null;
  shownPrDiffError = "";
  prFilesEl.replaceChildren();
  prBodyEl.replaceChildren();
  if (restoreFocus && prPreviousFocus?.isConnected) prPreviousFocus.focus();
  prPreviousFocus = null;
}

prBtn.onclick = openCurrentPrOverlay;
prSessionBtn.onclick = () => {
  const number = shownPrInfo?.number ?? shownPrSummary?.number ?? null;
  if (number === null) return;
  void openWorktreeDialogForPr(number, {
    number,
    title: shownPrInfo?.title ?? shownPrSummary?.title ?? "",
    headRefName: shownPrInfo?.headRefName ?? shownPrSummary?.headRefName ?? "",
    state: shownPrInfo?.state ?? shownPrSummary?.state ?? "OPEN",
  });
};
prFilesTabBtn.onclick = () => setPrTab("files");
prConversationTabBtn.onclick = () => setPrTab("conversation");
prOpenGhBtn.onclick = () => {
  const url = shownPrInfo?.url ?? shownPrSummary?.url;
  if (url) void invoke("open_url", { url }).catch(() => {});
};
prCloseBtn.onclick = () => closePrOverlay();
prOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === prOverlay) closePrOverlay(); // バックドロップクリックで閉じる
});
// パネル内の打鍵をターミナルやショートカットに流さない（diff オーバーレイと同じ流儀）
prPanel.addEventListener("keydown", (e) => e.stopPropagation());
window.addEventListener(
  "keydown",
  (e) => {
    // 上に Worktree モーダルが乗っている間はそちらの Escape に任せる
    if (!prOverlay.hidden && e.key === "Escape" && !isWorktreeDialogOpen()) {
      e.stopPropagation();
      e.preventDefault();
      closePrOverlay();
    }
  },
  true,
);

