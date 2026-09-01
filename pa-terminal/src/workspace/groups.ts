// ============================================================
// セッショングループ
// ============================================================

import { renderSidebar } from "../features/sidebar/sidebar";
import { scheduleSave } from "../app/session";
import { requireFeature } from "../features/license/license";
import { collapsedGroups, groups, workspaces } from "./state";
import type { Workspace, WorkspaceGroup } from "./types";

const groupDatalist = document.querySelector<HTMLDataListElement>("#ws-group-list")!;

export type SidebarEntry = Workspace | WorkspaceGroup;

export function isWorkspaceEntry(entry: SidebarEntry): entry is Workspace {
  return "panes" in entry;
}

/** 同じ親階層のセッションとグループを、共通の表示順で返す。
    旧データに sidebarOrder が無い間は、従来どおりセッション→グループの順にする。 */
export function sidebarEntries(parentId?: string): SidebarEntry[] {
  const entries: SidebarEntry[] = [
    ...workspaces.filter((workspace) => workspace.group === parentId),
    ...groups.filter((group) => group.parentId === parentId),
  ];
  const fallbackOrder = (entry: SidebarEntry) =>
    isWorkspaceEntry(entry) ? workspaces.indexOf(entry) : workspaces.length + groups.indexOf(entry);
  return entries.sort((a, b) => {
    const aOrder = Number.isFinite(a.sidebarOrder) ? a.sidebarOrder! : fallbackOrder(a);
    const bOrder = Number.isFinite(b.sidebarOrder) ? b.sidebarOrder! : fallbackOrder(b);
    return aOrder - bOrder;
  });
}

/** 同じ親階層の混在した行順を確定する。新規作成・DnD・解散で共通利用する。 */
export function setSidebarEntryOrder(entries: readonly SidebarEntry[]) {
  entries.forEach((entry, index) => {
    entry.sidebarOrder = index;
  });
}

/** entry を親階層の指定位置へ置く。位置はセッションとグループを混在させた行単位。 */
export function placeSidebarEntryAt(entry: SidebarEntry, parentId: string | undefined, index: number) {
  const entries = sidebarEntries(parentId).filter((sibling) => sibling !== entry);
  entries.splice(Math.max(0, Math.min(index, entries.length)), 0, entry);
  setSidebarEntryOrder(entries);
}

/** 同じ親階層の ref の直後に entry を置く。 */
export function placeSidebarEntryAfter(entry: SidebarEntry, ref: SidebarEntry) {
  const parentId = isWorkspaceEntry(ref) ? ref.group : ref.parentId;
  const entries = sidebarEntries(parentId).filter((sibling) => sibling !== entry);
  const at = entries.indexOf(ref);
  if (at < 0) return;
  entries.splice(at + 1, 0, entry);
  setSidebarEntryOrder(entries);
}

/** 新規エントリを親階層の末尾へ置く。 */
export function appendSidebarEntry(entry: SidebarEntry, parentId?: string) {
  placeSidebarEntryAt(entry, parentId, sidebarEntries(parentId).filter((sibling) => sibling !== entry).length);
}

export function newGroupId(): string {
  let id = "";
  do id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  while (groups.some((g) => g.id === id));
  return id;
}

export function groupById(id: string | undefined): WorkspaceGroup | undefined {
  return id ? groups.find((g) => g.id === id) : undefined;
}

/** ルートからの表示パス。同名グループが別階層にあっても入力補完で区別できる */
export function groupPath(group: WorkspaceGroup): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: WorkspaceGroup | undefined = group;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = groupById(cur.parentId);
  }
  return names.join(" / ");
}

export function groupDescendantIds(groupId: string): Set<string> {
  const ids = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.parentId && ids.has(group.parentId) && !ids.has(group.id)) {
        ids.add(group.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function uniqueGroupName(base: string, parentId?: string, exceptId?: string): string {
  const used = new Set(
    groups
      .filter((g) => g.parentId === parentId && g.id !== exceptId)
      .map((g) => g.name),
  );
  if (!used.has(base)) return base;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
  return name;
}

/** 右クリックメニューの「グループを作成」で使う、自動採番されたデフォルトグループ名。
    名前を訊かずに黙って作るための既定値（現在の最大番号の次）。 */
export function nextGroupName(): string {
  let max = 0;
  for (const group of groups) {
    const match = /^Group (\d+)$/.exec(group.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Group ${max + 1}`;
}

export function addGroup(name: string, parentId?: string): WorkspaceGroup {
  const validParent = groupById(parentId)?.id;
  const group: WorkspaceGroup = {
    id: newGroupId(),
    name: uniqueGroupName(name, validParent),
    parentId: validParent,
  };
  groups.push(group);
  appendSidebarEntry(group, validParent);
  if (validParent) collapsedGroups.delete(validParent);
  return group;
}

export function createGroup(name: string, parentId?: string, at?: number): WorkspaceGroup {
  const group = addGroup(name, parentId);
  if (at !== undefined) placeSidebarEntryAt(group, group.parentId, at);
  renderSidebar();
  scheduleSave();
  return group;
}

export type GroupMovePosition = "before" | "after" | "inside" | "root";

/** グループを配下の子グループごと移動する。
    before / after は target と同じ親階層へ、inside は target の子階層へ、root は
    トップレベルの末尾へ移す。子グループの parentId は変えないため、ツリー全体を
    まとめて運べる。自分自身や子孫を親にする循環は拒否する。 */
export function moveGroup(
  source: WorkspaceGroup,
  target: WorkspaceGroup | null,
  position: GroupMovePosition,
): boolean {
  const movingRoot = groupById(source.id);
  const targetGroup = target ? groupById(target.id) : undefined;
  if (!movingRoot || (target && !targetGroup)) return false;

  const movingIds = groupDescendantIds(movingRoot.id);
  if (targetGroup && movingIds.has(targetGroup.id)) return false;
  if (!targetGroup && position !== "root") return false;

  // groups 配列は親ごとの表示順を兼ねる。対象ツリーをいったん外してから挿し込むと、
  // 親子の parentId を壊さず、移動元ツリーも連続したブロックとして保てる。
  const moving = groups.filter((group) => movingIds.has(group.id));
  const rest = groups.filter((group) => !movingIds.has(group.id));
  if (!moving.length) return false;

  let parentId: string | undefined;
  let at = rest.length;
  let sidebarAt = 0;
  if (targetGroup) {
    if (position === "inside") {
      parentId = targetGroup.id;
      sidebarAt = sidebarEntries(parentId).filter((entry) => entry !== movingRoot).length;
    } else {
      parentId = targetGroup.parentId;
      const targetAt = rest.indexOf(targetGroup);
      if (targetAt < 0) return false;
      at = position === "before" ? targetAt : targetAt + 1;
      const siblings = sidebarEntries(parentId).filter((entry) => entry !== movingRoot);
      const targetSidebarAt = siblings.indexOf(targetGroup);
      if (targetSidebarAt < 0) return false;
      sidebarAt = position === "before" ? targetSidebarAt : targetSidebarAt + 1;
    }
  } else {
    sidebarAt = sidebarEntries().filter((entry) => entry !== movingRoot).length;
  }
  movingRoot.parentId = parentId;
  groups.splice(0, groups.length, ...rest);
  groups.splice(at, 0, ...moving);
  placeSidebarEntryAt(movingRoot, parentId, sidebarAt);
  if (parentId) collapsedGroups.delete(parentId);
  renderSidebar();
  scheduleSave();
  return true;
}

/** 対象セッション（複数可）の現在位置に親グループを作る。
    複数を包むときは先頭セッションの所属を新グループの親にする。
    名前は自動採番のみで、インライン編集は開かない（クイック作成と同じ「黙って作る」挙動。
    リネームは見出しのダブルクリック / 右クリックの「名前を変更」から） */
export function createParentGroup(targets: Workspace[]) {
  const members = workspaces.filter((w) => targets.includes(w));
  if (!members.length) return;
  // 既にグループ所属のセッションを包むと子グループ（ネスト階層）になる = ソフトロック対象。
  // トップレベルのグループ化は無料枠のまま
  if (members[0].group && !requireFeature()) return;
  const parentId = members[0].group;
  const oldSiblings = sidebarEntries(parentId);
  const firstAt = oldSiblings.indexOf(members[0]);
  const group = addGroup(nextGroupName(), parentId);
  for (const w of members) w.group = group.id;
  // 親グループの見出しは、包む先頭セッションがあった行を引き継ぐ。
  placeSidebarEntryAt(group, parentId, firstAt < 0 ? oldSiblings.length : firstAt);
  // グループ内では選択されたセッションの相対順を保つ。
  setSidebarEntryOrder(members);
  renderSidebar();
  scheduleSave();
}

/** 入力補完のパスをIDへ解決。未登録名なら従来互換でトップレベルグループを作る */
export function resolveGroupInput(value: string): string | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const exactPath = groups.find((g) => groupPath(g) === input);
  if (exactPath) return exactPath.id;
  const byName = groups.filter((g) => g.name === input);
  if (byName.length === 1) return byName[0].id;
  return createGroup(input).id;
}

/** 新規セッションフォームとコンテキストメニューの入力補完候補を更新する */
export function refreshGroupDatalist() {
  groupDatalist.innerHTML = "";
  for (const group of groups) {
    const o = document.createElement("option");
    o.value = groupPath(group);
    groupDatalist.append(o);
  }
}

/** IDは変えず表示名だけを変更するため、所属セッション・子階層はそのまま維持される */
export function renameGroup(group: WorkspaceGroup, newName: string) {
  group.name = uniqueGroupName(newName, group.parentId, group.id);
  renderSidebar();
  scheduleSave();
}
