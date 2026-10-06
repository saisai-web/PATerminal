// Git ウィンドウ: ツールバーの Git ボタン（Cmd/Ctrl+E）で開く大きめのモーダル。
//
//   ┌ ヘッダー: リポジトリ名・現在のブランチ・PR バッジ・操作ボタン（git-actions.ts）
//   ├ サイドバー: ワークスペース（ファイルステータス / 履歴 / 検索 / Worktree）・GitHub
//   │             （Issue / PR）・ブランチ / リモート / タグ（git-sidebar.ts）
//   └ ビュー: ファイルステータス（git-status-view.ts）/ 履歴（git-log.ts）/ Issue / PR / Worktree
//
// 対象はフォーカス中ペインの cwd が属するリポジトリ（git-watch.ts の監視と同じ）。
// 履歴（git_log）とサイドバー（git_refs）は開いている間だけ監視の3秒ポーリングに相乗りする。
// ターミナルの上に重ねるだけなので layout()/refit には触れない。
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。

import { t } from "../../i18n";
import { renderGitEnvNoticeTexts } from "./git-env-notice";
import { isLocked, onLicenseChange, requireFeature } from "../license/license";
import { getCurrentBranch, getGitRoot, updateGitWatch } from "./git-watch";
import { pollLog, renderGitLogTexts, renderGitSection, historyViewShown } from "./git-log";
import { pollRefs, renderSidebarTexts, resetSidebar } from "./git-sidebar";
import { renderStatusViewTexts, statusViewShown } from "./git-status-view";
import {
  getIssueRoot,
  issuesTabShown,
  refreshIssuesAfterCreate,
  refreshIssuesTab,
  renderIssueOverlayTexts,
  renderIssues,
} from "./issues-tab";
import { initIssueCreate, renderIssueCreateTexts, setIssueCreateTabActive } from "./issue-create";
import { fetchPrList, prsTabShown, renderPrList } from "./pr-tab";
import { refreshPrBadge, renderPrBadge, renderPrOverlayTexts } from "./pr-overlay";
import { renderWorktreeList, renderWorktreeListTexts } from "./worktree";
import { isWorktreeDialogOpen, renderWorktreeDialogTexts } from "./worktree-dialog";
import { attachPanelResize, attachSideResize } from "../../shared/drag-resize";

type GitWindowDeps = {
  /** Issue の作業用にデフォルトシェルの新規セッションを開く */
  createIssueSession: (args: {
    issueNumber: number;
    issueTitle: string;
    note?: string;
    cwd: string;
  }) => void;
};

let deps: GitWindowDeps = { createIssueSession: () => {} };

export function initGitWindow(d: GitWindowDeps): void {
  deps = d;
  initIssueCreate({
    getRoot: getIssueRoot,
    onCreated: (root) => refreshIssuesAfterCreate(root),
  });
}

/** サブモジュール（issues-tab のセッション作成）から読む */
export function getDeps(): GitWindowDeps {
  return deps;
}

const openBtn = document.querySelector<HTMLButtonElement>("#git-open")!;
const badgeEl = document.querySelector<HTMLSpanElement>("#git-open-badge")!;
const overlayEl = document.querySelector<HTMLDivElement>("#git-window-overlay")!;
const windowEl = document.querySelector<HTMLDivElement>("#git-window")!;
const titleEl = document.querySelector<HTMLSpanElement>("#gw-title")!;
const branchEl = document.querySelector<HTMLSpanElement>("#gw-branch")!;
const refreshBtn = document.querySelector<HTMLButtonElement>("#gw-refresh")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#gw-close")!;
const emptyEl = document.querySelector<HTMLDivElement>("#gw-empty")!;
const searchEl = document.querySelector<HTMLInputElement>("#gw-search")!;
const statusCountEl = document.querySelector<HTMLSpanElement>("#gw-status-count")!;
const worktreesEl = document.querySelector<HTMLDivElement>("#gw-worktrees")!;
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-gw-nav]"));

export type GitView = "status" | "history" | "issues" | "prs" | "worktrees";
/** サイドバーの項目。「検索」は履歴ビューを検索欄にフォーカスした状態で開く */
type GitNav = GitView | "search";

const VIEWS: Record<GitView, HTMLElement> = {
  status: document.querySelector<HTMLElement>("#gw-view-status")!,
  history: document.querySelector<HTMLElement>("#gw-view-history")!,
  issues: document.querySelector<HTMLElement>("#gw-view-issues")!,
  prs: document.querySelector<HTMLElement>("#gw-view-prs")!,
  worktrees: document.querySelector<HTMLElement>("#gw-view-worktrees")!,
};

let open = false;
let repo = false; // 直近の監視でリポジトリ内だったか
let activeNav: GitNav = "status"; // 初めて開いたときはコミット前の変更から見せる
let previousFocus: HTMLElement | null = null;

function viewOf(nav: GitNav): GitView {
  return nav === "search" ? "history" : nav;
}

export function isGitWindowOpen(): boolean {
  return open;
}

/** Issue / PR / Worktree の各モジュールが「いま自分のビューが見えているか」を判断する。
    閉じている間は null（ネットワークを叩く一覧取得を起こさない） */
export function getActiveView(): GitView | null {
  return open && repo ? viewOf(activeNav) : null;
}

export function isStatusViewVisible(): boolean {
  return getActiveView() === "status";
}

export function openGitWindow(nav?: GitNav): void {
  if (!requireFeature()) return; // ソフトロック中は購入案内
  if (nav) activeNav = nav;
  if (!open) {
    open = true;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayEl.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
    repo = Boolean(getGitRoot()); // 監視の結果が来るまでの初期表示
  }
  renderGitWindowHeader();
  applyView();
  updateGitWatch(); // 変更一覧・履歴・サイドバーを即取得（3秒ポーリングを待たない）
  requestAnimationFrame(() => {
    if (activeNav === "search") searchEl.focus();
    else navButtons.find((b) => b.dataset.gwNav === activeNav)?.focus();
  });
}

export function closeGitWindow(restoreFocus = true): void {
  if (!open) return;
  open = false;
  overlayEl.hidden = true;
  openBtn.setAttribute("aria-expanded", "false");
  setIssueCreateTabActive(false);
  const focus = previousFocus;
  previousFocus = null;
  if (restoreFocus && focus?.isConnected) focus.focus();
}

export function toggleGitWindow(): void {
  if (open) closeGitWindow();
  else openGitWindow();
}

/** ビューを切り替える（ファイルステータスへ移ってコミット欄にフォーカス、など外からも使う） */
export function showGitWindowView(nav: GitNav): void {
  if (!open) {
    openGitWindow(nav);
    return;
  }
  activeNav = nav;
  applyView();
  if (nav === "search") searchEl.focus();
}

function applyView(): void {
  const view = viewOf(activeNav);
  windowEl.classList.toggle("is-norepo", !repo);
  emptyEl.hidden = repo;
  emptyEl.textContent = repo ? "" : t("gw.noRepo");
  for (const b of navButtons) {
    const on = b.dataset.gwNav === activeNav;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  for (const [name, el] of Object.entries(VIEWS)) el.hidden = !repo || name !== view;
  setIssueCreateTabActive(repo && view === "issues");
  refreshBtn.title = refreshTitle();
  refreshBtn.setAttribute("aria-label", refreshBtn.title);
  if (!repo) return;
  if (view === "status") statusViewShown();
  else if (view === "history") historyViewShown();
  else if (view === "issues") issuesTabShown();
  else if (view === "prs") prsTabShown();
  else if (view === "worktrees") renderWorktreesView(getIssueRoot());
}

/** Worktree ビューの一覧描画（要素をこのファイルに閉じ込めるための入口） */
export function renderWorktreesView(root: string | null): void {
  void renderWorktreeList(worktreesEl, root, { showSessionAction: true });
}

function refreshTitle(): string {
  const view = viewOf(activeNav);
  if (view === "issues") return t("git.refreshIssues");
  if (view === "prs") return t("git.refreshPrs");
  if (view === "worktrees") return t("git.refreshWorktrees");
  return t("gw.refresh");
}

/** git 監視（3秒周期 + updateGitWatch 契機）から毎回呼ばれる */
export function gitWindowTick(cwd: string | null, inRepo: boolean): void {
  if (!open || isLocked()) return;
  if (inRepo !== repo) {
    repo = inRepo;
    applyView();
  }
  renderGitWindowHeader();
  if (!cwd || !inRepo) {
    renderGitSection(null);
    resetSidebar();
    return;
  }
  void pollLog(cwd);
  const root = getGitRoot();
  if (root) void pollRefs(root);
}

/** ヘッダーのリポジトリ名と現在のブランチ */
export function renderGitWindowHeader(): void {
  const root = getGitRoot();
  const name = root ? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root : "Git";
  titleEl.textContent = name;
  titleEl.title = root ?? "";
  const branch = getCurrentBranch();
  branchEl.textContent = branch ?? "";
  branchEl.title = branch ?? "";
  branchEl.hidden = !branch;
}

/** ツールバーの Git ボタンの件数バッジ（コミット前の変更ファイル数） */
export function renderGitOpenBadge(count: number): void {
  badgeEl.hidden = count === 0;
  badgeEl.textContent = count === 0 ? "" : count > 99 ? "99+" : String(count);
  statusCountEl.hidden = count === 0;
  statusCountEl.textContent = count === 0 ? "" : String(count);
  const label = count > 0 ? `${t("gw.open")} · ${t("gw.changedCount", { n: String(count) })}` : t("gw.open");
  openBtn.title = label;
  openBtn.setAttribute("aria-label", label);
}

/** 言語切替時: 動的生成部分を作り直す */
export function renderGitWindowTexts(): void {
  renderGitLogTexts();
  renderStatusViewTexts();
  renderSidebarTexts();
  renderPrBadge();
  renderIssues();
  renderPrList();
  renderWorktreeListTexts([worktreesEl]);
  renderIssueOverlayTexts();
  renderIssueCreateTexts();
  renderPrOverlayTexts();
  if (isWorktreeDialogOpen()) renderWorktreeDialogTexts();
  renderGitOpenBadge(Number(statusCountEl.textContent) || 0);
  renderGitEnvNoticeTexts();
  applyView();
}

openBtn.onclick = () => toggleGitWindow();
closeBtn.onclick = () => closeGitWindow();
for (const b of navButtons) {
  b.onclick = () => showGitWindowView(b.dataset.gwNav as GitNav);
}
refreshBtn.onclick = () => {
  const view = viewOf(activeNav);
  if (view === "issues") {
    refreshIssuesTab();
    return;
  }
  if (view === "prs") {
    const root = getIssueRoot();
    if (root) void fetchPrList(root);
    return;
  }
  if (view === "worktrees") {
    renderWorktreesView(getIssueRoot());
    return;
  }
  refreshPrBadge();
  updateGitWatch();
};

// 大きさは右辺・下辺・右下の角で、サイドバーの幅はその端のハンドルで変えられる
// （ダブルクリックで既定へ戻す。layout()/refit には触れない）
attachPanelResize(windowEl, { key: "pa.gitWindowSize", cssVar: "--gw", minW: 640, minH: 400 });
attachSideResize(
  document.querySelector<HTMLElement>("#gw-body")!,
  document.querySelector<HTMLElement>("#gw-side")!,
  { key: "pa.gitWindowSideWidth", cssVar: "--gw-side-w", sizedClass: "is-side-sized", gripClass: "gw-side-grip" },
);

overlayEl.addEventListener("pointerdown", (e) => {
  if (e.target === overlayEl) closeGitWindow();
});
// ウィンドウ内の矢印キーや文字入力をターミナル・グローバルショートカットへ流さない。
// Cmd/Ctrl+E だけは開閉のショートカットとして扱う
windowEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.code === "KeyE" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    closeGitWindow();
  }
});
window.addEventListener(
  "keydown",
  (e) => {
    // Issue / PR / diff / Pull / Worktree など、このウィンドウからさらに開いた前面ダイアログの
    // Escape はそのダイアログだけに任せる（前面側はウィンドウの外の要素にフォーカスがある）
    // 前面ダイアログを閉じた直後はフォーカスが body に落ちることがある（開いたメニューの
    // ボタンが消えている等）。その Escape もウィンドウ宛てとして扱う
    const target = e.target as Node;
    const ours = windowEl.contains(target) || target === document.body;
    if (!e.defaultPrevented && open && e.key === "Escape" && ours) {
      // 入力済みの検索欄の Escape はまず文字を消す（欄の keydown が処理する）
      const input = target as HTMLInputElement;
      if (input.type === "search" && input.value) return;
      e.stopPropagation();
      e.preventDefault();
      closeGitWindow();
    }
  },
  true,
);

// Locked へ遷移したら閉じる（入口のボタンは 🔒 付きで残り、押すと購入案内が出る）
onLicenseChange((s) => {
  if (s.locked) closeGitWindow(false);
});

renderGitOpenBadge(0);
