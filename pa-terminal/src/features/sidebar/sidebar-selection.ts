// ============================================================
// サイドバーの複数選択
// 選択（selectedWsIds）は「表示中のセッション」とは独立した操作対象の集合。
// Ctrl/Cmd+クリックで増減、Shift+クリックで表示順の範囲選択。まとめて閉じる /
// ドラッグでグループへ入れる、の対象になる。修飾クリックでは setActive を呼ばない
// （選ぶだけでセッションを切り替えると PTY の可視状態が無駄に往復するため）。
// ============================================================

import { createParentGroup } from "../../workspace/groups";
import { t } from "../../i18n";
import {
  getHostOs,
  getSelectionAnchor,
  selectedWsIds,
  setSelectionAnchor,
  workspaces,
} from "../../workspace/state";
import type { Workspace } from "../../workspace/types";
import { closeWorkspaces } from "../../workspace/workspace";

const wsList = document.querySelector<HTMLDivElement>("#ws-list")!;
const wsSelBar = document.querySelector<HTMLDivElement>("#ws-selection")!;
const wsSelCountEl = document.querySelector<HTMLSpanElement>("#ws-selection-count")!;
const wsSelGroupBtn = document.querySelector<HTMLButtonElement>("#ws-selection-group")!;
const wsSelCloseBtn = document.querySelector<HTMLButtonElement>("#ws-selection-close")!;
const wsSelClearBtn = document.querySelector<HTMLButtonElement>("#ws-selection-clear")!;

/** サイドバーに実際に並んでいる順のセッション ID。
    折りたたみ中のグループ内や検索で消えている項目は範囲選択に含めない */
export function visibleWsIds(): string[] {
  return [...wsList.querySelectorAll<HTMLElement>(".ws-item")]
    .filter((el) => !el.closest(".ws-group-members[hidden]"))
    .map((el) => el.dataset.wsId ?? "")
    .filter(Boolean);
}

/** 選択中のセッションを表示順（workspaces 配列順）で返す。閉じられた ID は落ちる */
export function selectedWorkspaces(): Workspace[] {
  return workspaces.filter((w) => selectedWsIds.has(w.id));
}

/** 右クリック・ドラッグの操作対象。複数選択の中の項目ならその選択全体、
    選択外（または単独選択）ならその項目1つだけ */
export function actionTargets(w: Workspace): Workspace[] {
  if (selectedWsIds.size > 1 && selectedWsIds.has(w.id)) return selectedWorkspaces();
  return [w];
}

/** 選択マークだけを外科的に更新する（renderSidebar は呼ばない: インライン編集ガードで
    握り潰されたり、ドラッグ中の DOM を作り直したりしないため。ws-git と同じ方針） */
export function refreshSelectionMarks() {
  for (const el of wsList.querySelectorAll<HTMLElement>(".ws-item")) {
    // 表示中セッションは操作対象の複数選択とは別に、常に選択表示を付ける。
    // これにより一括操作へ勝手に加えずに、左バーの表示とターミナルを一致させる。
    const selected =
      (!!el.dataset.wsId && selectedWsIds.has(el.dataset.wsId)) || el.classList.contains("is-active");
    el.classList.toggle("is-selected", selected);
    el.setAttribute("aria-selected", String(selected || el.classList.contains("is-active")));
  }
  renderSelectionBar();
}

/** 選択が2件以上のときだけ出す一括操作バー（右クリックを知らなくても一括削除できる） */
export function renderSelectionBar() {
  const n = selectedWsIds.size;
  wsSelBar.hidden = n < 2;
  if (wsSelBar.hidden) return;
  wsSelCountEl.textContent = t("sel.count", { n: String(n) });
  wsSelGroupBtn.textContent = t("sel.group");
  wsSelGroupBtn.title = t("sel.groupTitle");
  wsSelCloseBtn.textContent = t("sel.close");
  wsSelCloseBtn.title = t("sel.closeTitle");
  wsSelClearBtn.textContent = t("sel.clear");
  wsSelClearBtn.title = t("sel.clearTitle");
}

export function clearWsSelection() {
  if (!selectedWsIds.size) return;
  selectedWsIds.clear();
  setSelectionAnchor(null);
  refreshSelectionMarks();
}

export function setWsSelection(list: Workspace[], anchor: Workspace | null) {
  selectedWsIds.clear();
  for (const w of list) selectedWsIds.add(w.id);
  if (anchor) setSelectionAnchor(anchor.id);
  refreshSelectionMarks();
}

/** 選択を増減する修飾キーか。macOS の Ctrl+クリックは OS 的に右クリック（contextmenu）
    なので Cmd だけを見る。Windows / Linux は Ctrl */
export function additiveClick(e: MouseEvent): boolean {
  return e.metaKey || (e.ctrlKey && getHostOs() !== "macos");
}

/** Ctrl/Cmd+クリック: その項目の選択を反転（表示中セッションは切り替えない） */
export function toggleWsSelection(w: Workspace) {
  if (!selectedWsIds.delete(w.id)) selectedWsIds.add(w.id);
  setSelectionAnchor(w.id);
  refreshSelectionMarks();
}

/** Shift+クリック: 起点から表示順で範囲選択。additive（Ctrl 併用）なら既存選択に足す */
export function selectWsRange(w: Workspace, additive: boolean) {
  const order = visibleWsIds();
  const to = order.indexOf(w.id);
  const anchorId = getSelectionAnchor();
  const from = anchorId ? order.indexOf(anchorId) : -1;
  if (to < 0 || from < 0) {
    // 起点が畳まれた・閉じられた等で見つからないときは単独選択に退化する
    setWsSelection([w], w);
    return;
  }
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (!additive) selectedWsIds.clear();
  for (const id of range) selectedWsIds.add(id);
  refreshSelectionMarks(); // 起点は動かさない（連続 Shift+クリックで伸縮できる）
}
wsSelGroupBtn.onclick = () => {
  const targets = selectedWorkspaces();
  if (targets.length) createParentGroup(targets);
};
wsSelCloseBtn.onclick = () => void closeWorkspaces(selectedWorkspaces());
wsSelClearBtn.onclick = () => clearWsSelection();
