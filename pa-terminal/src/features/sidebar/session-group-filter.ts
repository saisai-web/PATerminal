import { t } from "../../i18n";
import { groupById, isWorkspaceEntry, sidebarEntries } from "../../workspace/groups";
import type { Workspace, WorkspaceGroup } from "../../workspace/types";

// 表示専用のランタイム状態。ステータスフィルタ・最近順と同じ流儀で保存せず、
// 起動時は常に絞り込みなしへ戻す。選ぶのはトップレベルのグループで、配下の
// 子グループのセッションも含める。
const selectedGroupIds = new Set<string>();

let notifyChange: ((selectedGroupId?: string) => void) | null = null;

/** composition root から renderSidebar を接続する（sidebar との循環初期化を避ける）。
    チップを ON にしたときだけ、そのグループ ID を渡す。 */
export function initSessionGroupFilter(onChange: (selectedGroupId?: string) => void): void {
  notifyChange = onChange;
}

/** 解散・削除・子グループ化で選べなくなったグループを選択から外す。 */
function pruneSelection(): void {
  for (const id of selectedGroupIds) {
    const group = groupById(id);
    if (!group || group.parentId !== undefined) selectedGroupIds.delete(id);
  }
}

export function isSessionGroupFilterActive(): boolean {
  pruneSelection();
  return selectedGroupIds.size > 0;
}

/** 所属をたどった先のトップレベルグループ ID。未所属や壊れた親参照は undefined。 */
function topLevelGroupId(groupId: string | undefined): string | undefined {
  const seen = new Set<string>();
  let group = groupById(groupId);
  while (group && group.parentId !== undefined && !seen.has(group.id)) {
    seen.add(group.id);
    group = groupById(group.parentId);
  }
  return group?.parentId === undefined ? group?.id : undefined;
}

function inSelectedBranch(groupId: string | undefined): boolean {
  if (!isSessionGroupFilterActive()) return true;
  const top = topLevelGroupId(groupId);
  return top !== undefined && selectedGroupIds.has(top);
}

/** 絞り込み中は、選んだグループ（とその子グループ）のセッションだけを通す。 */
export function matchesSessionGroupFilter(workspace: Workspace): boolean {
  return inSelectedBranch(workspace.group);
}

/** 絞り込み中は、選んだグループの枝だけを描く。 */
export function groupMatchesSessionGroupFilter(group: WorkspaceGroup): boolean {
  return inSelectedBranch(group.id);
}

function topLevelGroups(): WorkspaceGroup[] {
  return sidebarEntries().filter((entry): entry is WorkspaceGroup => !isWorkspaceEntry(entry));
}

// チップ欄の開閉も表示専用のランタイム状態。グループが10〜20個あると欄だけで数行を
// 使うので、起動時は閉じておき、必要なときだけ開く。
let panelOpen = false;

/** Whole 行の名前のすぐ右に置く開閉トグル。閉じていても絞り込み中と分かるよう、
    選択数を添えて強調する。グループが無ければ null。 */
export function buildGroupFilterToggle(): HTMLButtonElement | null {
  pruneSelection();
  if (!topLevelGroups().length) return null;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ws-group-filter-toggle";
  toggle.title = t("ws.filterGroupsTitle");
  toggle.setAttribute("aria-label", t("ws.filterGroupsTitle"));
  toggle.setAttribute("aria-expanded", String(panelOpen));
  toggle.dataset.active = String(selectedGroupIds.size > 0);
  const label = document.createElement("span");
  label.textContent = t("ws.filterGroups");
  toggle.append(label);
  if (selectedGroupIds.size) {
    const count = document.createElement("span");
    count.className = "ws-group-filter-count";
    count.textContent = String(selectedGroupIds.size);
    toggle.append(count);
  }
  const arrow = document.createElement("span");
  arrow.className = "ws-group-filter-arrow";
  arrow.textContent = panelOpen ? "▾" : "▸";
  toggle.append(arrow);
  toggle.onclick = (e) => {
    e.stopPropagation();
    panelOpen = !panelOpen;
    notifyChange?.();
  };
  return toggle;
}

/** Whole 行のすぐ下に開くグループ名チップ欄。renderSidebar のたびに作り直す。
    複数を同時に ON にでき、すべて OFF で絞り込みなしへ戻る。閉じている間やグループが
    無いときは null。 */
export function buildGroupFilterChips(): HTMLElement | null {
  pruneSelection();
  const topGroups = topLevelGroups();
  if (!panelOpen || !topGroups.length) return null;

  const row = document.createElement("div");
  row.className = "ws-group-filter";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", t("ws.filterLabel"));
  for (const group of topGroups) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ws-group-filter-chip";
    chip.dataset.groupFilter = group.id;
    chip.textContent = group.name;
    chip.title = group.name;
    chip.setAttribute("aria-pressed", String(selectedGroupIds.has(group.id)));
    chip.onclick = (e) => {
      e.stopPropagation();
      const selecting = !selectedGroupIds.has(group.id);
      if (selecting) selectedGroupIds.add(group.id);
      else selectedGroupIds.delete(group.id);
      notifyChange?.(selecting ? group.id : undefined);
    };
    row.append(chip);
  }
  return row;
}
