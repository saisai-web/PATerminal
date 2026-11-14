import { scheduleSave } from "../../app/session";
import { getLang, t } from "../../i18n";
import type { Workspace } from "../../workspace/types";

// 「直近に使った」= ターミナルへ実際に打鍵したセッション。lastOpAt（アクティブ化）は
// 開いて眺めただけでも更新されるので、打鍵時刻は lastInputAt として別に持つ。

/** この期間内に打鍵があればサイドバーに「直近使用」バッジを出す。 */
export const RECENT_INPUT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 打鍵のたびに保存・DOM 更新を走らせない。バッジは日単位の表示なので分単位で足りる。 */
const RECORD_INTERVAL_MS = 60 * 1000;

const wsList = document.querySelector<HTMLDivElement>("#ws-list")!;

export function hasRecentInput(ws: Workspace, now = Date.now()): boolean {
  return ws.lastInputAt !== undefined && now - ws.lastInputAt < RECENT_INPUT_WINDOW_MS;
}

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** 今日から daysBack 日前（ローカル日付）までに打鍵したセッション。0 は今日だけで、
    期間絞り込みと「今日 / 昨日 / 3日前」バッジが同じ日付の数え方になる。 */
export function hasInputWithinDays(ws: Workspace, daysBack: number, now = Date.now()): boolean {
  if (ws.lastInputAt === undefined) return false;
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - daysBack); // 夏時間の切り替え日も暦日で数える
  return ws.lastInputAt >= since.getTime();
}

let notifyFirstInputToday: (() => void) | null = null;

/** その日最初の打鍵で期間絞り込みの一覧へ加えるための通知（sidebar が接続する）。 */
export function onFirstInputToday(listener: () => void): void {
  notifyFirstInputToday = listener;
}

/** ユーザーの打鍵（xterm onData のうち端末の自動応答でないもの）で呼ぶ。 */
export function markWorkspaceInput(ws: Workspace): void {
  const now = Date.now();
  if (ws.lastInputAt !== undefined && now - ws.lastInputAt < RECORD_INTERVAL_MS) return;
  const firstToday = !hasInputWithinDays(ws, 0, now);
  ws.lastInputAt = now;
  scheduleSave();
  if (firstToday) notifyFirstInputToday?.();
  // activity と同じく該当項目だけを外科的に更新する（renderSidebar は呼ばない）
  const tags = wsList.querySelector<HTMLElement>(`.ws-item[data-ws-id="${ws.id}"] .ws-tags`);
  if (tags) renderRecentInputBadge(tags, ws);
}

/** 今日 / 昨日 / 3日前。表示言語の言い回しは Intl に任せる。 */
function dayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  return new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" }).format(days, "day");
}

/** .ws-tags 内のバッジを現在の lastInputAt に合わせる（状態ラベルの手前に置く）。 */
export function renderRecentInputBadge(tags: HTMLElement, ws: Workspace): void {
  const now = Date.now();
  let badge = tags.querySelector<HTMLElement>(".ws-recent-input");
  if (!hasRecentInput(ws, now)) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ws-recent-input";
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 5 4-5 4"/><path d="M13 17h6"/></svg><span></span>';
    const status = tags.querySelector(".ws-status");
    if (status) status.before(badge);
    else tags.append(badge);
  }
  badge.lastElementChild!.textContent = dayLabel(ws.lastInputAt!, now);
  badge.title = t("ws.recentInputTitle", {
    when: new Date(ws.lastInputAt!).toLocaleString(getLang(), {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  });
  badge.setAttribute("aria-label", badge.title);
}
