// ============================================================
// 一斉入力の送信先モーダル
// ツールバーの「一斉入力」ボタン（OFF のとき）から開き、打鍵を送るセッションを選ぶ。
// 現在のセッションは常に対象で外せない。選択はランタイム専用（Workspace.broadcastTargets）
// で、一斉入力を切ると忘れる。Cmd/Ctrl+Shift+B は従来どおりモーダルを開かずに即 ON/OFF。
// モーダルなので layout() は呼ばない。
// ============================================================

import { t } from "../../i18n";
import { startBroadcast } from "../../terminal/focus";
import { groupById, groupPath } from "../../workspace/groups";
import { getActiveWs, workspaces } from "../../workspace/state";
import type { Workspace } from "../../workspace/types";

const overlay = document.querySelector<HTMLDivElement>("#broadcast-overlay")!;
const panel = document.querySelector<HTMLDivElement>("#broadcast-panel")!;
const openBtn = document.querySelector<HTMLButtonElement>("#broadcast")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#broadcast-dialog-close")!;
const cancelBtn = document.querySelector<HTMLButtonElement>("#broadcast-cancel")!;
const startBtn = document.querySelector<HTMLButtonElement>("#broadcast-start")!;
const selectAllEl = document.querySelector<HTMLInputElement>("#broadcast-select-all")!;
const countEl = document.querySelector<HTMLSpanElement>("#broadcast-count")!;
const listEl = document.querySelector<HTMLDivElement>("#broadcast-ws-list")!;

type Deps = { focusTerminal: () => void };

let deps: Deps | null = null;
/** モーダルを開いている間だけの選択（自セッションは含めない） */
const picked = new Set<string>();

/** 現在のセッション以外の候補。表示順は workspaces 配列（サイドバーの並び）そのまま */
function candidates(active: Workspace): Workspace[] {
  return workspaces.filter((w) => w !== active);
}

function paneCount(w: Workspace): number {
  return w.panes.size;
}

function renderList() {
  const active = getActiveWs();
  listEl.textContent = "";
  if (!active) return;

  listEl.append(buildRow(active, true));
  for (const w of candidates(active)) listEl.append(buildRow(w, false));
  renderCount();
}

function buildRow(w: Workspace, isActive: boolean): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "bc-row" + (isActive ? " is-current" : "");
  row.dataset.wsId = w.id;

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "bc-check";
  check.value = w.id;
  check.checked = isActive || picked.has(w.id);
  check.disabled = isActive; // 現在のセッションは常に対象
  check.onchange = () => {
    if (check.checked) picked.add(w.id);
    else picked.delete(w.id);
    renderCount();
  };

  const text = document.createElement("span");
  text.className = "bc-row-text";
  const name = document.createElement("span");
  name.className = "bc-row-name";
  name.textContent = w.name;
  text.append(name);

  const group = groupById(w.group);
  const sub = [group ? groupPath(group) : "", t("bc.panes", { n: String(paneCount(w)) })]
    .filter(Boolean)
    .join(" · ");
  const subEl = document.createElement("span");
  subEl.className = "bc-row-sub";
  subEl.textContent = isActive ? `${t("bc.current")} · ${sub}` : sub;
  text.append(subEl);

  row.append(check, text);
  return row;
}

function renderCount() {
  const active = getActiveWs();
  const total = picked.size + (active ? 1 : 0);
  countEl.textContent = t("bc.count", { n: String(total) });
  const others = active ? candidates(active) : [];
  selectAllEl.checked = others.length > 0 && others.every((w) => picked.has(w.id));
  selectAllEl.disabled = others.length === 0;
  startBtn.textContent = picked.size ? t("bc.startN", { n: String(total) }) : t("bc.start");
}

/** 言語切替で開いていない間の文言も貼り直す（applyStaticTexts の後に呼ばれる） */
export function renderBroadcastDialogTexts() {
  if (!overlay.hidden) renderList();
  else renderCount();
}

function setOpen(open: boolean) {
  overlay.hidden = !open;
  openBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    const active = getActiveWs();
    picked.clear();
    // 一斉入力中に開き直したときは今の送信先を初期選択にする
    if (active) for (const id of active.broadcastTargets) picked.add(id);
    renderList();
  } else if (overlay.contains(document.activeElement)) {
    // 非表示の入力欄にフォーカスが残るとショートカットを飲む（他モーダルと同じ）
    deps?.focusTerminal();
  }
}

export function openBroadcastDialog() {
  setOpen(true);
}

export function closeBroadcastDialog() {
  if (!overlay.hidden) setOpen(false);
}

export function initBroadcastDialog(d: Deps) {
  deps = d;
  closeBtn.onclick = () => setOpen(false);
  cancelBtn.onclick = () => setOpen(false);
  selectAllEl.onchange = () => {
    const active = getActiveWs();
    if (!active) return;
    picked.clear();
    if (selectAllEl.checked) for (const w of candidates(active)) picked.add(w.id);
    renderList();
  };
  startBtn.onclick = () => {
    const active = getActiveWs();
    if (!active) return;
    setOpen(false);
    startBroadcast(active, picked);
    d.focusTerminal();
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) setOpen(false);
  });
  // 開いている間だけ握る（閉じている間に握るとショートカットを飲む）
  panel.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    e.stopPropagation();
    if (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "BUTTON") {
      e.preventDefault();
      startBtn.click();
    }
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || overlay.hidden) return;
      e.stopPropagation();
      setOpen(false);
    },
    true,
  );
}
