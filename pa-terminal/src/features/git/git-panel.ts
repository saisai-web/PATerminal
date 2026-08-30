// エクスプローラー下部の git セクション: フォーカス中ペインの cwd が属するリポジトリの
// コミット履歴を表示し、現在ブランチに GitHub PR があればバッジ → conversation オーバーレイ。
//
// コミット履歴（git_log）は変更ストリップの3秒ポーリング（pollGit）に相乗りする。
// PR 情報（pr_info = gh CLI、ネットワーク）は root+branch が変わった時と60秒間隔と
// 手動 ⟳ のみ。gh 不在・未認証・PR 無しはバッジ非表示に退化するだけで壊れない。
//
// セクションの開閉・スプリッタはエクスプローラーの固定幅の内側で完結するため、
// layout()/refit は一切呼ばない（呼ぶと無駄な全ペイン refit になる）。
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。
//
// 中身は機能ごとに分けてあり、このファイルは公開 API（initGitPanel / gitPanelTick /
// renderGitPanelTexts）とタブ切替・スプリッタだけを持つ:
//   git-panel-types.ts … git_log / gh のレスポンス型
//   git-log.ts         … Branch タブ（コミット履歴・右クリックメニュー・巻き戻し）
//   issues-tab.ts      … Issue タブ（一覧・詳細モーダル・ブランチ紐付け・セッション作成）
//   pr-tab.ts          … PR タブ（open な PR の一覧）
//   pr-overlay.ts      … PR バッジと PR 変更ファイル / conversation オーバーレイ

import { renderWorktreeList, renderWorktreeListTexts } from "./worktree";
import { t } from "../../i18n";
import { isLocked, onLicenseChange, requireFeature } from "../license/license";
import { pollLog, renderBranchLine, renderGitLogTexts, renderGitSection } from "./git-log";
import {
  getIssueRoot,
  issuesTabShown,
  refreshIssuesTab,
  renderIssueOverlayTexts,
  renderIssues,
} from "./issues-tab";
import { fetchPrList, prsTabShown, renderPrList } from "./pr-tab";
import { refreshPrBadge, renderPrBadge, renderPrOverlayTexts } from "./pr-overlay";

type GitPanelDeps = {
  /** エクスプローラーが表示中か。閉じている間は git_log の subprocess を起こさない */
  isExplorerOpen: () => boolean;
  /** Issue の作業用にデフォルトシェルの新規セッションを開く */
  createIssueSession: (args: {
    issueNumber: number;
    issueTitle: string;
    cwd: string;
  }) => void;
};

let deps: GitPanelDeps = { isExplorerOpen: () => false, createIssueSession: () => {} };

export function initGitPanel(d: GitPanelDeps): void {
  deps = d;
}

/** サブモジュール（issues-tab のセッション作成）から読む */
export function getDeps(): GitPanelDeps {
  return deps;
}

const branchEl = document.querySelector<HTMLButtonElement>("#exp-git-branch")!;
const issuesTabBtn = document.querySelector<HTMLButtonElement>("#exp-git-issues-tab")!;
const prsTabBtn = document.querySelector<HTMLButtonElement>("#exp-git-prs-tab")!;
const worktreesTabBtn = document.querySelector<HTMLButtonElement>("#exp-git-worktrees-tab")!;
const refreshBtn = document.querySelector<HTMLButtonElement>("#exp-git-refresh")!;
const logEl = document.querySelector<HTMLDivElement>("#exp-git-log")!;
const issuesEl = document.querySelector<HTMLDivElement>("#exp-git-issues")!;
const prsEl = document.querySelector<HTMLDivElement>("#exp-git-prs")!;
const worktreesEl = document.querySelector<HTMLDivElement>("#exp-git-worktrees")!;

/** 変更ストリップの pollGit（3秒周期 + updateGitWatch 契機）から毎回呼ばれる */
export function gitPanelTick(cwd: string | null): void {
  if (isLocked()) return; // ソフトロック対象（Locked 中は subprocess も起こさない）
  if (!deps.isExplorerOpen()) return;
  if (!cwd) {
    renderGitSection(null);
    return;
  }
  void pollLog(cwd);
}

/** 言語切替時: 動的生成部分を作り直す（シグネチャを捨てて次描画を強制） */
export function renderGitPanelTexts(): void {
  renderGitLogTexts();
  renderPrBadge();
  refreshBtn.title = refreshTitle();
  renderIssues();
  renderPrList();
  renderWorktreeListTexts([worktreesEl]);
  renderIssueOverlayTexts();
  renderPrOverlayTexts();
}

// ============================================================
// Branch / Issue / PR / Worktree タブ（Issue・PR は gh CLI。タブを開いた時だけ一覧を取得）
// Worktree は git のローカル情報だけなので独自ポーリングは持たず、タブ表示と ⟳ で取得する
// ============================================================

export type GitTab = "branch" | "issues" | "prs" | "worktrees";

let activeTab: GitTab = "branch";

/** サブモジュールが「いま自分のタブが見えているか」を判断するのに読む */
export function getActiveTab(): GitTab {
  return activeTab;
}

/** Worktree タブの一覧描画（要素をこのファイルに閉じ込めるための入口） */
export function renderWorktreesTab(root: string | null): void {
  void renderWorktreeList(worktreesEl, root);
}

function refreshTitle(): string {
  if (activeTab === "issues") return t("git.refreshIssues");
  if (activeTab === "prs") return t("git.refreshPrs");
  if (activeTab === "worktrees") return t("git.refreshWorktrees");
  return t("git.refresh");
}

function setGitTab(tab: GitTab): void {
  activeTab = tab;
  const issues = tab === "issues";
  const prs = tab === "prs";
  const worktrees = tab === "worktrees";
  const branch = tab === "branch";
  branchEl.classList.toggle("is-active", branch);
  branchEl.setAttribute("aria-selected", String(branch));
  issuesTabBtn.classList.toggle("is-active", issues);
  issuesTabBtn.setAttribute("aria-selected", String(issues));
  prsTabBtn.classList.toggle("is-active", prs);
  prsTabBtn.setAttribute("aria-selected", String(prs));
  worktreesTabBtn.classList.toggle("is-active", worktrees);
  worktreesTabBtn.setAttribute("aria-selected", String(worktrees));
  logEl.hidden = !branch;
  renderBranchLine();
  issuesEl.hidden = !issues;
  prsEl.hidden = !prs;
  worktreesEl.hidden = !worktrees;
  refreshBtn.title = refreshTitle();
  renderPrBadge();
  if (worktrees) {
    renderWorktreesTab(getIssueRoot());
  } else if (issues) {
    issuesTabShown();
  } else if (prs) {
    prsTabShown();
  }
}

// タブはソフトロック対象。Locked 中も 🔒 付きで見せたまま、クリックで購入案内を出す
branchEl.onclick = () => {
  if (requireFeature()) setGitTab("branch");
};
issuesTabBtn.onclick = () => {
  if (requireFeature()) setGitTab("issues");
};
prsTabBtn.onclick = () => {
  if (requireFeature()) setGitTab("prs");
};
worktreesTabBtn.onclick = () => {
  if (requireFeature()) setGitTab("worktrees");
};

// Locked 遷移でタブの中身だけ隠す（セクションの枠とタブ列は 🔒 を見せるため残す）。
// 解除されたら現在のタブを引き直して表示を復元する
onLicenseChange((s) => {
  if (s.locked) {
    logEl.hidden = true;
    issuesEl.hidden = true;
    prsEl.hidden = true;
    worktreesEl.hidden = true;
  } else {
    setGitTab(activeTab);
  }
});

refreshBtn.onclick = () => {
  if (activeTab === "issues") {
    refreshIssuesTab();
    return;
  }
  if (activeTab === "prs") {
    const root = getIssueRoot();
    if (root) void fetchPrList(root);
    return;
  }
  if (activeTab === "worktrees") {
    renderWorktreesTab(getIssueRoot());
    return;
  }
  refreshPrBadge();
};

// ============================================================
// スプリッタ（ファイル一覧との境界）: エクスプローラー内で完結するので refit 不要
// ============================================================

const explorerEl = document.querySelector<HTMLDivElement>("#explorer")!;
const sectionEl = document.querySelector<HTMLDivElement>("#exp-git")!;
const resizeEl = document.querySelector<HTMLDivElement>("#exp-git-resize")!;

const GIT_MIN_H = 90;

resizeEl.addEventListener("pointerdown", (down) => {
  down.preventDefault();
  try {
    resizeEl.setPointerCapture(down.pointerId);
  } catch {
    /* キャプチャ不可でも move は届く範囲で動く */
  }
  resizeEl.classList.add("is-dragging");
  document.body.classList.add("dragging");
  const startH = sectionEl.getBoundingClientRect().height;
  const startY = down.clientY;

  const move = (ev: PointerEvent) => {
    const maxH = Math.max(GIT_MIN_H, Math.round(explorerEl.clientHeight * 0.8));
    const h = Math.min(maxH, Math.max(GIT_MIN_H, Math.round(startH + (startY - ev.clientY))));
    sectionEl.style.height = `${h}px`;
  };
  const finish = () => {
    resizeEl.removeEventListener("pointermove", move);
    resizeEl.removeEventListener("pointerup", finish);
    resizeEl.removeEventListener("pointercancel", finish);
    resizeEl.removeEventListener("lostpointercapture", finish);
    resizeEl.classList.remove("is-dragging");
    document.body.classList.remove("dragging");
  };
  resizeEl.addEventListener("pointermove", move);
  resizeEl.addEventListener("pointerup", finish);
  resizeEl.addEventListener("pointercancel", finish);
  resizeEl.addEventListener("lostpointercapture", finish);
});

// ダブルクリックで既定の高さ（CSS の 30%）に戻す
resizeEl.addEventListener("dblclick", () => {
  sectionEl.style.removeProperty("height");
});
