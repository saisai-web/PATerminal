// ============================================================
// 最近削除したセッション（履歴つき復元）
// ============================================================

import { getLang, t } from "../../i18n";
import { lockClass, requireFeature } from "../license/license";
import { normalizeWorkspaceNote } from "../../workspace/note";
import type { DeletedWorkspace, SerializedNode } from "../../workspace/types";
import {
  closeHistoryDialog,
  type HistoryDialogTabController,
} from "../history/history-dialog";

type SessionTrashOptions = {
  restore: (saved: DeletedWorkspace) => boolean;
  onChange: () => void;
  clearPane: () => void;
};

/** スクロールバックを含むため無制限には保持しない。新しいものから最大20セッション。 */
const MAX_DELETED_WORKSPACES = 20;

const openBtn = document.querySelector<HTMLButtonElement>("#session-trash-open")!;
const clearPaneBtn = document.querySelector<HTMLButtonElement>("#pane-clear")!;
const hintEl = document.querySelector<HTMLParagraphElement>("#session-trash-hint")!;
const listEl = document.querySelector<HTMLDivElement>("#session-trash-list")!;
const emptyEl = document.querySelector<HTMLDivElement>("#session-trash-empty")!;
const errorEl = document.querySelector<HTMLDivElement>("#session-trash-error")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#session-trash-clear")!;
const clearCancelBtn = document.querySelector<HTMLButtonElement>("#session-trash-clear-cancel")!;

let deletedWorkspaces: DeletedWorkspace[] = [];
let options: SessionTrashOptions | null = null;
let clearArmed = false;

function isSerializedNode(value: unknown, depth = 0): value is SerializedNode {
  if (!value || typeof value !== "object" || depth > 64) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") return true;
  return (
    node.kind === "split" &&
    (node.dir === "row" || node.dir === "col") &&
    typeof node.ratio === "number" &&
    Number.isFinite(node.ratio) &&
    isSerializedNode(node.a, depth + 1) &&
    isSerializedNode(node.b, depth + 1)
  );
}

function isDeletedWorkspace(value: unknown): value is DeletedWorkspace {
  if (!value || typeof value !== "object") return false;
  const saved = value as Record<string, unknown>;
  return (
    typeof saved.id === "string" &&
    !!saved.id &&
    typeof saved.name === "string" &&
    !!saved.name &&
    (saved.shellKind === "default" || saved.shellKind === "powershell" || saved.shellKind === "cmd") &&
    typeof saved.broadcast === "boolean" &&
    typeof saved.deletedAt === "number" &&
    Number.isFinite(saved.deletedAt) &&
    isSerializedNode(saved.root)
  );
}

function paneCount(node: SerializedNode): number {
  return node.kind === "leaf" ? 1 : paneCount(node.a) + paneCount(node.b);
}

function deletedDate(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(getLang(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function resetTransientState() {
  clearArmed = false;
  errorEl.hidden = true;
}

function removeRestored(saved: DeletedWorkspace) {
  const index = deletedWorkspaces.indexOf(saved);
  if (index >= 0) deletedWorkspaces.splice(index, 1);
  options?.onChange();
  renderSessionTrashTexts();
}

function renderList() {
  listEl.textContent = "";
  emptyEl.hidden = deletedWorkspaces.length > 0;
  clearBtn.hidden = deletedWorkspaces.length === 0;
  clearCancelBtn.hidden = !clearArmed;
  clearBtn.classList.toggle("is-confirm", clearArmed);
  clearBtn.textContent = clearArmed ? t("trash.clearConfirm") : t("trash.clear");
  clearCancelBtn.textContent = t("trash.cancel");

  for (const saved of deletedWorkspaces) {
    const row = document.createElement("div");
    row.className = "session-trash-row";
    row.setAttribute("role", "listitem");

    const info = document.createElement("div");
    info.className = "session-trash-info";
    const name = document.createElement("div");
    name.className = "session-trash-name";
    name.textContent = saved.name;
    const note = document.createElement("div");
    note.className = "session-trash-note";
    note.textContent = normalizeWorkspaceNote(saved.note) ?? "";
    note.title = note.textContent;
    note.hidden = !note.textContent;
    const meta = document.createElement("div");
    meta.className = "session-trash-meta";
    meta.textContent = t("trash.itemMeta", {
      date: deletedDate(saved.deletedAt),
      n: String(paneCount(saved.root)),
    });
    info.append(name, note, meta);

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "session-trash-restore";
    restore.textContent = t("trash.restore");
    restore.title = t("trash.restoreTitle");
    // 復元だけソフトロック対象（退避保存 archiveWorkspace は Locked でも動き続けるので、
    // ロック中に閉じたセッションも購入後に取り戻せる = データを失わせない）
    lockClass(restore);
    restore.onclick = () => {
      if (!requireFeature()) return;
      errorEl.hidden = true;
      if (!options?.restore(saved)) {
        errorEl.textContent = t("trash.restoreFailed");
        errorEl.hidden = false;
        return;
      }
      removeRestored(saved);
      closeHistoryDialog();
    };

    row.append(info, restore);
    listEl.append(row);
  }
}

export function renderSessionTrashTexts() {
  const clearPaneLabel = t("trash.clearPane");
  clearPaneBtn.title = clearPaneLabel;
  clearPaneBtn.setAttribute("aria-label", clearPaneLabel);
  const historyLabel = t("trash.open");
  openBtn.title = historyLabel;
  openBtn.setAttribute("aria-label", historyLabel);
  hintEl.textContent = t("trash.hint");
  emptyEl.textContent = t("trash.empty");
  renderList();
}

export function getDeletedWorkspaces(): DeletedWorkspace[] {
  return deletedWorkspaces.map((saved) => ({ ...saved }));
}

/** boot() から保存データを読み込む。不正な項目は他のセッションを巻き込まず捨てる。 */
export function setDeletedWorkspaces(value: unknown) {
  deletedWorkspaces = Array.isArray(value)
    ? value.filter(isDeletedWorkspace).slice(0, MAX_DELETED_WORKSPACES)
    : [];
  renderSessionTrashTexts();
}

export function addDeletedWorkspace(saved: DeletedWorkspace) {
  deletedWorkspaces = [
    saved,
    ...deletedWorkspaces.filter((entry) => entry.id !== saved.id),
  ].slice(0, MAX_DELETED_WORKSPACES);
  renderSessionTrashTexts();
}

export function initSessionTrash(deps: SessionTrashOptions): HistoryDialogTabController {
  options = deps;
  renderSessionTrashTexts();
  return {
    activate: () => {
      resetTransientState();
      renderSessionTrashTexts();
      return true;
    },
    deactivate: () => {
      resetTransientState();
      renderSessionTrashTexts();
    },
    reset: resetTransientState,
  };
}

clearPaneBtn.onclick = () => options?.clearPane();
clearBtn.onclick = () => {
  if (!clearArmed) {
    clearArmed = true;
    renderSessionTrashTexts();
    return;
  }
  deletedWorkspaces = [];
  clearArmed = false;
  options?.onChange();
  renderSessionTrashTexts();
};
clearCancelBtn.onclick = () => {
  clearArmed = false;
  renderSessionTrashTexts();
};
