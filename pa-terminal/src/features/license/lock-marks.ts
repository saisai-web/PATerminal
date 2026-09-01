// ============================================================
// Locked 中のロック対象機能の入口へ 🔒 を表示する（.is-locked クラス）。
// 🔒 本体は CSS 疑似要素（styles/license.css の .is-locked::after）。
// applyStaticTexts() は data-i18n の textContent を丸ごと置換するため、
// テキストに絵文字を足す方式は言語切替で消える → クラス + 疑似要素にする。
// 呼び出し: boot の applyStaticTexts 直後 / applyLanguage 末尾 / ライセンス状態変化 /
// ペイン数・アクティブセッションの変化（分割ボタンだけペイン数条件があるため）。
// ============================================================

import { getActiveWs } from "../../workspace/state";
import { FREE_PANE_LIMIT, isLocked } from "./license";

/** ペイン数に関係なく常にロックされる入口（Locked 中のみ 🔒） */
const LOCKED_SELECTORS = [
  "#broadcast",
  "#auto-enter-toggle",
  "#pair-open",
  "#quick-phrases-open",
  "#takeover-open",
  "#exp-git-branch",
  "#exp-git-branch-expand",
  "#exp-git-issues-tab",
  "#exp-git-issues-expand",
  "#exp-git-prs-tab",
  "#exp-git-prs-expand",
  "#exp-git-worktrees-tab",
  "#exp-git-worktrees-expand",
];

export function renderLockMarks() {
  const locked = isLocked();
  for (const sel of LOCKED_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) el.classList.toggle("is-locked", locked);
  }
  // 分割は2枚まで無料なので、アクティブセッションが既に上限のときだけ 🔒 を出す
  const paneCount = getActiveWs()?.panes.size ?? 0;
  const splitLocked = locked && paneCount >= FREE_PANE_LIMIT;
  for (const sel of ["#split-right", "#split-down", "#exp-new-pane"]) {
    const el = document.querySelector(sel);
    if (el) el.classList.toggle("is-locked", splitLocked);
  }
}
