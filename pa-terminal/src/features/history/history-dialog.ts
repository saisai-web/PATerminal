// ============================================================
// 履歴ダイアログ（会話履歴 / 最近削除したセッション）
//
// ツールバーの「履歴」とペインバーの復元ボタンは同じダイアログを開く。
// 押した入口に対応するタブを初期表示し、各機能固有の描画・操作は
// takeover.ts / session-trash.ts が所有したまま、ここではモーダルと
// タブのライフサイクルだけを調停する。
// ============================================================

import { t } from "../../i18n";

export type HistoryDialogTabController = {
  /** false はライセンス等のゲートで表示を拒否したことを表す。 */
  activate: () => boolean;
  deactivate: () => void;
  /** ダイアログを閉じたとき、次回の表示に持ち越さない状態を破棄する。 */
  reset: () => void;
};

type HistoryTab = "takeover" | "trash";

type HistoryDialogOptions = {
  takeover: HistoryDialogTabController;
  trash: HistoryDialogTabController;
  focusTerminal: () => void;
};

const takeoverOpenBtn = document.querySelector<HTMLButtonElement>("#takeover-open")!;
const trashOpenBtn = document.querySelector<HTMLButtonElement>("#session-trash-open")!;
const overlay = document.querySelector<HTMLDivElement>("#history-overlay")!;
const panel = document.querySelector<HTMLDivElement>("#history-panel")!;
const titleEl = document.querySelector<HTMLSpanElement>("#history-title")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#history-close")!;
const takeoverTabBtn = document.querySelector<HTMLButtonElement>("#history-tab-takeover")!;
const trashTabBtn = document.querySelector<HTMLButtonElement>("#history-tab-trash")!;
const takeoverPanel = document.querySelector<HTMLElement>("#takeover-panel")!;
const trashPanel = document.querySelector<HTMLElement>("#session-trash-panel")!;

let options: HistoryDialogOptions | null = null;
let activeTab: HistoryTab | null = null;

function controller(tab: HistoryTab): HistoryDialogTabController | null {
  return options?.[tab] ?? null;
}

function tabButton(tab: HistoryTab): HTMLButtonElement {
  return tab === "takeover" ? takeoverTabBtn : trashTabBtn;
}

function tabPanel(tab: HistoryTab): HTMLElement {
  return tab === "takeover" ? takeoverPanel : trashPanel;
}

function titleKey(tab: HistoryTab): "takeover.title" | "trash.title" {
  return tab === "takeover" ? "takeover.title" : "trash.title";
}

function renderSelectedTab(tab: HistoryTab): void {
  for (const candidate of ["takeover", "trash"] as const) {
    const selected = candidate === tab;
    const button = tabButton(candidate);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    tabPanel(candidate).hidden = !selected;
  }
  const key = titleKey(tab);
  titleEl.dataset.i18n = key;
  titleEl.textContent = t(key);
}

/** 表示中のダイアログでタブを切り替える。ゲート拒否時は現在タブを維持する。 */
function selectTab(tab: HistoryTab, focusTab = false): boolean {
  if (activeTab === tab && !overlay.hidden) {
    if (focusTab) tabButton(tab).focus();
    return true;
  }
  const next = controller(tab);
  if (!next?.activate()) return false;
  if (activeTab && activeTab !== tab) controller(activeTab)?.deactivate();
  activeTab = tab;
  renderSelectedTab(tab);
  if (focusTab) tabButton(tab).focus();
  return true;
}

function setExpanded(open: boolean): void {
  takeoverOpenBtn.setAttribute("aria-expanded", String(open));
  trashOpenBtn.setAttribute("aria-expanded", String(open));
}

export function openHistoryDialog(tab: HistoryTab): void {
  if (!selectTab(tab)) return;
  overlay.hidden = false;
  setExpanded(true);
  closeBtn.focus();
}

export function closeHistoryDialog(): void {
  if (overlay.hidden) return;
  overlay.hidden = true;
  setExpanded(false);
  if (activeTab) controller(activeTab)?.deactivate();
  options?.takeover.reset();
  options?.trash.reset();
  activeTab = null;
  if (overlay.contains(document.activeElement)) options?.focusTerminal();
}

function moveTabFocus(event: KeyboardEvent, current: HistoryTab): void {
  let next: HistoryTab | null = null;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    next = current === "takeover" ? "trash" : "takeover";
  } else if (event.key === "Home") {
    next = "takeover";
  } else if (event.key === "End") {
    next = "trash";
  }
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  selectTab(next, true);
}

export function initHistoryDialog(deps: HistoryDialogOptions): void {
  options = deps;
  takeoverOpenBtn.onclick = () => openHistoryDialog("takeover");
  trashOpenBtn.onclick = () => openHistoryDialog("trash");
  takeoverTabBtn.onclick = () => selectTab("takeover");
  trashTabBtn.onclick = () => selectTab("trash");
  takeoverTabBtn.onkeydown = (event) => moveTabFocus(event, "takeover");
  trashTabBtn.onkeydown = (event) => moveTabFocus(event, "trash");
  closeBtn.onclick = closeHistoryDialog;
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeHistoryDialog();
  });
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") closeHistoryDialog();
  });
}
