import { t } from "../../i18n";
import type { Workspace } from "../../workspace/types";

// 表示専用のランタイム状態。ステータスフィルタと同じ流儀で保存せず、起動時は常に
// 従来の並び（OFF）へ戻す。lastOpAt 自体は session.json v5 に保存するので、
// 再起動後に ON にしても前回までの操作順で並ぶ。
let recentSortActive = false;

let notifyChange: (() => void) | null = null;

/** composition root から renderSidebar を接続する（sidebar との循環初期化を避ける）。 */
export function initSessionRecentSort(onChange: () => void): void {
  notifyChange = onChange;
}

export function isRecentSortActive(): boolean {
  return recentSortActive;
}

/** Whole 行の右側コントロール群の一番左に置くトグル。renderSidebar のたびに作り直す。 */
export function buildRecentSortButton(): HTMLButtonElement {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ws-recent-sort";
  toggle.textContent = t("ws.sortRecent");
  toggle.title = t("ws.sortRecentTitle");
  toggle.setAttribute("aria-label", t("ws.sortRecentTitle"));
  toggle.setAttribute("aria-pressed", String(recentSortActive));
  toggle.onclick = (e) => {
    e.stopPropagation();
    recentSortActive = !recentSortActive;
    notifyChange?.();
  };
  return toggle;
}

/** 最近操作した順（新しい順）。未記録の旧データは末尾へ（sort は stable なので
    同値は workspaces 配列順を維持する）。呼び出し元の配列は変更しない。 */
export function sortByRecentOp(list: Workspace[]): Workspace[] {
  return [...list].sort((a, b) => (b.lastOpAt ?? 0) - (a.lastOpAt ?? 0));
}
