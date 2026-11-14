import { t } from "../../i18n";
import type { ActivityState, Workspace } from "../../workspace/types";
import { hasInputWithinDays } from "./recent-input";

export type SessionStatusFilter = "all" | ActivityState | "unseen" | "archived";

const filterEl = document.querySelector<HTMLDivElement>("#ws-status-filter")!;
const filterButtons = [
  ...filterEl.querySelectorAll<HTMLButtonElement>("button[data-status-filter]"),
];
const archiveFilterButton = filterEl.querySelector<HTMLButtonElement>(
  'button[data-status-filter="archived"]',
)!;
const periodSelect = document.querySelector<HTMLSelectElement>("#ws-period-filter")!;
const archiveBadgeEl = document.querySelector<HTMLSpanElement>("#ws-archive-badge")!;

let currentFilter: SessionStatusFilter = "all";
let unseenArchiveCount = 0;
// 最後に打鍵した日での絞り込み（今日から何日前まで。null は期間を問わない）。
// 状態タブとは別軸で、状態・検索と AND する。状態タブと同じく保存しない。
let periodDaysBack: number | null = null;

function isSessionStatusFilter(value: string | undefined): value is SessionStatusFilter {
  return (
    value === "all" ||
    value === "running" ||
    value === "waiting" ||
    value === "done" ||
    value === "unseen" ||
    value === "archived"
  );
}

function renderPressedState(): void {
  for (const button of filterButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.statusFilter === currentFilter));
  }
  periodSelect.value = periodDaysBack === null ? "" : String(periodDaysBack);
  periodSelect.toggleAttribute("data-active", periodDaysBack !== null);
}

function renderArchiveBadge(): void {
  archiveBadgeEl.hidden = unseenArchiveCount === 0;
  archiveBadgeEl.textContent = unseenArchiveCount > 99 ? "99+" : String(unseenArchiveCount);
}

function clearArchiveBadge(): void {
  if (!unseenArchiveCount) return;
  unseenArchiveCount = 0;
  renderArchiveBadge();
}

/** 新しく通常一覧から退避した件数だけを通知する。保存済みアーカイブは起動時に
    再通知せず、アーカイブ画面を開いた時点でまとめて既読にする。 */
export function markSessionArchived(): void {
  unseenArchiveCount += 1;
  renderArchiveBadge();
}

/** フィルターは表示専用のランタイム状態。起動時は常に従来どおり「すべて」に戻す。 */
export function initSessionStatusFilter(onChange: () => void): void {
  renderPressedState();
  for (const button of filterButtons) {
    button.onclick = () => {
      const next = button.dataset.statusFilter;
      if (!isSessionStatusFilter(next)) return;
      if (next === "archived") clearArchiveBadge();
      if (next === currentFilter) return;
      currentFilter = next;
      renderPressedState();
      onChange();
    };
  }
  periodSelect.onchange = () => {
    periodDaysBack = periodSelect.value === "" ? null : Number(periodSelect.value);
    renderPressedState();
    onChange();
  };
  // 日付が変わったら昨日の分を外す。スリープ中はタイマーが進まないので、復帰時にも見直す。
  let shownDay = new Date().toDateString();
  const refreshOnNewDay = () => {
    const day = new Date().toDateString();
    if (day === shownDay) return;
    shownDay = day;
    if (periodDaysBack !== null) onChange();
  };
  setInterval(refreshOnNewDay, 60_000);
  window.addEventListener("focus", refreshOnNewDay);
}

export function renderSessionStatusFilterTexts(): void {
  filterEl.setAttribute("aria-label", t("ws.filterLabel"));
  archiveFilterButton.setAttribute("aria-label", t("ws.filterArchived"));
  periodSelect.title = t("ws.filterPeriodTitle");
  periodSelect.setAttribute("aria-label", periodSelect.title);
  for (const option of periodSelect.options) {
    option.textContent =
      option.value === ""
        ? t("ws.filterPeriodAll")
        : option.value === "0"
          ? t("ws.filterToday")
          : t("ws.filterDaysBack", { n: option.value });
  }
  renderArchiveBadge();
}

export function isSessionStatusFilterActive(): boolean {
  return currentFilter !== "all" || isPeriodSessionFilterActive();
}

/** アーカイブ画面は退避済みを全部見せる場所なので、期間はそこでは効かせない。 */
function isPeriodSessionFilterActive(): boolean {
  return periodDaysBack !== null && currentFilter !== "archived";
}

/** アーカイブ画面固有の一括操作で、通常セッションを巻き込まないために使う。 */
export function isArchiveSessionStatusFilterActive(): boolean {
  return currentFilter === "archived";
}

/** 件数・キーボード移動で使う現在タブの母集団。状態絞り込みより先に
    アーカイブ済みと通常セッションを完全に分離する。 */
export function isWorkspaceInSessionFilterScope(workspace: Workspace): boolean {
  return currentFilter === "archived" ? workspace.archived === true : workspace.archived !== true;
}

/** 未確認は状態（done / waiting）とは別軸の attention を使い、どちらもまとめて拾う。 */
export function matchesSessionStatusFilter(
  workspace: Workspace,
  activity: ActivityState,
): boolean {
  if (!isWorkspaceInSessionFilterScope(workspace)) return false;
  if (currentFilter === "archived") return true;
  if (periodDaysBack !== null && !hasInputWithinDays(workspace, periodDaysBack)) return false;
  if (currentFilter === "all") return true;
  if (currentFilter === "unseen") return workspace.attention !== null;
  return activity === currentFilter;
}
