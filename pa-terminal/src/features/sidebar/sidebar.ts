import { onWorkspaceActivityChange, wsActivityState, wsActivityText } from "../../app/activity";
import { AVATAR_COLORS, SHELL_CHOICES } from "../../shared/constants";
import { closeGroupMenu } from "../../shared/ctx-menu";
import {
  groupById,
  groupDescendantIds,
  groupPath,
  isWorkspaceEntry,
  moveGroup,
  refreshGroupDatalist,
  renameGroup,
  resolveGroupInput,
  setSidebarEntryOrder,
  sidebarEntries,
} from "../../workspace/groups";
import { t } from "../../i18n";
import { requireFeature } from "../license/license";
import { startInlineEdit } from "../../shared/inline-edit";
import { getRafId, layout, place, setRafId } from "../../terminal/layout";
import { scheduleSave } from "../../app/session";
import { openGroupHeadMenu, openGroupMenu, openListCtxMenu } from "./sidebar-menu";
import {
  actionTargets,
  additiveClick,
  clearWsSelection,
  renderSelectionBar,
  selectWsRange,
  setWsSelection,
  toggleWsSelection,
  visibleWsIds,
} from "./sidebar-selection";
import {
  collapsedGroups,
  getActiveWs,
  getHostOs,
  groups,
  selectedWsIds,
  workspaces,
} from "../../workspace/state";
import type { Workspace, WorkspaceGroup } from "../../workspace/types";
import {
  closeWorkspace,
  compactWsPath,
  createWorkspace,
  newSessionCwd,
  nextSessionName,
  placeAfter,
  quickCreateWorkspace,
  renameWorkspace,
  setActive,
  toggleWorkspaceArchived,
  toggleWorkspacePinned,
  updateWorkspaceNote,
  wsSubtitle,
} from "../../workspace/workspace";
import { buildWsGitEl } from "./ws-git";
import { createSessionNoteField } from "./session-note";
import {
  initSessionStatusFilter,
  isSessionStatusFilterActive,
  isWorkspaceInSessionFilterScope,
  markSessionArchived,
  matchesSessionStatusFilter,
  renderSessionStatusFilterTexts,
} from "./session-status-filter";
import {
  buildRecentSortButton,
  initSessionRecentSort,
  isRecentSortActive,
  sortByRecentOp,
} from "./session-sort";
import { attachLocationFlyout } from "./new-session-location";

const sidebarEl = document.querySelector<HTMLDivElement>("#sidebar")!;
const sidebarCollapseBtn = document.querySelector<HTMLButtonElement>("#sidebar-collapse")!;
const sidebarReopenBtn = document.querySelector<HTMLButtonElement>("#sidebar-reopen")!;
const sidebarResizeEl = document.querySelector<HTMLDivElement>("#sidebar-resize")!;
const wsList = document.querySelector<HTMLDivElement>("#ws-list")!;
const wsSearch = document.querySelector<HTMLInputElement>("#ws-search")!;
const wsNewBtn = document.querySelector<HTMLButtonElement>("#ws-new")!;
const wsNewForm = document.querySelector<HTMLDivElement>("#ws-new-form")!;
const wsNewName = document.querySelector<HTMLInputElement>("#ws-new-name")!;
const wsNewGroup = document.querySelector<HTMLInputElement>("#ws-new-group")!;
const wsNewShells = document.querySelector<HTMLDivElement>("#ws-new-shells")!;
const wsNewLocBtn = document.querySelector<HTMLButtonElement>("#ws-new-loc")!;

// ============================================================
// サイドバーのドラッグ&ドロップ並べ替え
// セッションとグループは同じ親階層で混在した sidebarOrder を持つ。
// 項目の前後に落とす = そのグループに加入、未分類項目の前後に落とす = 未分類化。
// グループ見出しは配下のセッション・子グループを保ったまま移動する。
// ============================================================

/** ドラッグ中のセッション（複数選択をまとめて掴んだときは全部入る。表示順） */
let draggingWs: Workspace[] = [];
/** ドラッグ中のグループ。子孫は groupDescendantIds から移動時にまとめて得る。 */
let draggingGroup: WorkspaceGroup | null = null;

export function getDraggingWorkspaces(): Workspace[] {
  return draggingWs;
}

// tauri.conf.json で dragDropEnabled:false にしている（true だと wry のネイティブ
// ファイルドロップハンドラが HTML5 の dragover/drop を横取りし、サイドバーの DnD が
// 一切動かない）。その代償として OS からのファイルドロップが WebView 素通しになるので、
// ページ遷移（ドロップしたファイルの表示）だけはここで抑止する。
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

function clearDropMarks() {
  for (const el of wsList.querySelectorAll(".drop-before, .drop-after, .drop-into"))
    el.classList.remove("drop-before", "drop-after", "drop-into");
  wsList.classList.remove("drop-end");
}

/** srcs（1件でも複数選択でも）を target の前(before=true)/後ろへまとめて移し、
    group を付け替える。移動する側の相対順は表示順のまま維持する */
function moveWorkspaces(
  srcs: Workspace[],
  target: Workspace,
  before: boolean,
  group: string | undefined,
) {
  const moving = workspaces.filter((w) => srcs.includes(w)); // 表示順に正規化
  if (!moving.length || moving.includes(target)) return;
  const sidebarRest = sidebarEntries(group).filter(
    (entry) => !isWorkspaceEntry(entry) || !moving.includes(entry),
  );
  let sidebarTo = sidebarRest.indexOf(target);
  if (sidebarTo < 0) return;
  if (!before) sidebarTo += 1;
  sidebarRest.splice(sidebarTo, 0, ...moving);
  const rest = workspaces.filter((w) => !moving.includes(w));
  let to = rest.indexOf(target);
  if (to < 0) return; // 不整合時は何もしない（workspaces は未変更のまま）
  if (!before) to += 1;
  rest.splice(to, 0, ...moving);
  workspaces.splice(0, workspaces.length, ...rest);
  for (const w of moving) w.group = group;
  setSidebarEntryOrder(sidebarRest);
  renderSidebar();
  scheduleSave();
}

/** 一斉入力の追加送信先か。表示中セッションが一斉入力中のときだけ意味を持つ */
function isBroadcastTarget(id: string | undefined): boolean {
  const active = getActiveWs();
  return !!id && !!active?.broadcast && active.broadcastTargets.has(id);
}

/** 送信先マークだけを外科的に更新する（refreshSelectionMarks と同じ理由で
    renderSidebar は呼ばない: インライン編集ガードと DnD 中の DOM を壊さない） */
export function refreshBroadcastMarks() {
  for (const el of wsList.querySelectorAll<HTMLElement>(".ws-item")) {
    el.classList.toggle("is-bc-target", isBroadcastTarget(el.dataset.wsId));
  }
}

export function buildWsItem(w: Workspace): HTMLDivElement {
  const item = document.createElement("div");
  const active = w === getActiveWs();
  // active は操作用の複数選択とは別に、常に左バーで選択表示する。
  const selected = selectedWsIds.has(w.id) || active;
  item.className =
    "ws-item" +
    (active ? " is-active" : "") +
    (selected ? " is-selected" : "") +
    (isBroadcastTarget(w.id) ? " is-bc-target" : "") +
    (w.pinned ? " is-pinned" : "");
  item.dataset.wsId = w.id; // 複製直後のリネーム等、再描画後に項目を探すためのフック
  if (w.backgroundColor) item.dataset.wsColor = w.backgroundColor;
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", String(selected));
  // 最近操作した順の表示中は並びが合成順なので、保存順を壊す DnD 並べ替えを止める。
  // ドラッグ自体が始まらなければ既存の dragover / drop ハンドラは何もしない
  item.draggable = !isRecentSortActive();
  item.addEventListener("dragstart", (e) => {
    // インライン編集中はテキスト選択を優先し、項目ドラッグにしない
    if ((e.target as HTMLElement).closest?.(".inline-edit")) {
      e.preventDefault();
      return;
    }
    // 選択外の項目を掴んだらその項目だけの選択に切り替える（一般的なリストの挙動）
    if (!selectedWsIds.has(w.id)) setWsSelection([w], w);
    draggingWs = actionTargets(w);
    e.dataTransfer?.setData("text/plain", w.id); // WebKit はデータ無しだと drop が発火しない
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    for (const dragged of draggingWs) {
      wsList
        .querySelector(`.ws-item[data-ws-id="${dragged.id}"]`)
        ?.classList.add("is-drag-src");
    }
  });
  item.addEventListener("dragend", () => {
    draggingWs = [];
    for (const el of wsList.querySelectorAll(".is-drag-src")) el.classList.remove("is-drag-src");
    clearDropMarks();
    flushPendingFilteredRender();
  });
  item.addEventListener("dragover", (e) => {
    if (!draggingWs.length || draggingWs.includes(w)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = item.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    clearDropMarks();
    item.classList.add(before ? "drop-before" : "drop-after");
  });
  item.addEventListener("dragleave", () => {
    item.classList.remove("drop-before", "drop-after");
  });
  item.addEventListener("drop", (e) => {
    if (!draggingWs.length || draggingWs.includes(w)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = item.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    clearDropMarks();
    const srcs = draggingWs;
    draggingWs = [];
    moveWorkspaces(srcs, w, before, w.group);
  });

  // 稼働表示のクラスは Pane.busy / attention から再導出（DOM からは読まない。
  // 再構築で消えないように）。ライブ更新は updateWsActivity が外科的にトグルする
  const busy = [...w.panes.values()].some((p) => p.busy);
  if (busy) item.classList.add("is-busy");
  if (!busy && [...w.panes.values()].some((p) => p.waiting)) item.classList.add("is-wait");
  if (w.attention) item.classList.add("is-attn");

  const av = document.createElement("span");
  av.className = "ws-avatar";
  av.style.background = AVATAR_COLORS[Math.max(0, workspaces.indexOf(w)) % AVATAR_COLORS.length];
  av.textContent = (w.name[0] ?? "S").toUpperCase();

  const meta = document.createElement("div");
  meta.className = "ws-meta";
  const name = document.createElement("div");
  name.className = "ws-name";
  name.textContent = w.name;
  const status = document.createElement("span");
  status.className = "ws-status";
  const activity = wsActivityState(w, busy);
  status.dataset.status = activity;
  status.textContent = wsActivityText(activity);
  const head = document.createElement("div");
  head.className = "ws-head";
  head.append(name, status);
  const noteInput = createSessionNoteField(
    w.name,
    w.note,
    (value) => updateWorkspaceNote(w, value),
    // メモ欄は項目の中央を広く覆うため、飲み込んだままだと項目クリックでの
    // セッション切替・選択が効かなくなる。項目クリックと同じ規則で振り分け、
    // アクティブなセッションの素クリックだけをメモ編集に使う
    (e) => {
      if (e.shiftKey) {
        selectWsRange(w, additiveClick(e));
        return true;
      }
      if (additiveClick(e)) {
        toggleWsSelection(w);
        return true;
      }
      if (w === getActiveWs()) return false;
      setWsSelection([w], w);
      setActive(w);
      return true;
    },
  );
  const sub = document.createElement("div");
  sub.className = "ws-sub";
  const subtitle = wsSubtitle(w);
  sub.textContent = compactWsPath(subtitle);
  sub.title = subtitle;
  meta.append(head, noteInput, sub, buildWsGitEl(w.id));

  // 未ピン留め項目にはピン自体を出さない。ピン留めは右クリックメニューから行い、
  // 固定済みであることを示すときだけ解除ボタンとして表示する。
  const pin = w.pinned ? document.createElement("button") : null;
  if (pin) {
    pin.className = "ws-pin";
    pin.textContent = "📌";
    pin.title = t("ctx.unpin");
    pin.setAttribute("aria-label", pin.title);
    pin.setAttribute("aria-pressed", "true");
    pin.onclick = (e) => {
      e.stopPropagation();
      toggleWorkspacePinned(w);
    };
  }

  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "ws-archive";
  archive.innerHTML = w.archived
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h16v11H4z"/><path d="M3 5h18v3H3z"/><path d="M12 16v-5m-3 3 3-3 3 3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h16v11H4z"/><path d="M3 5h18v3H3z"/><path d="M12 11v5m-3-3 3 3 3-3"/></svg>';
  archive.title = t(w.archived ? "ws.unarchiveTitle" : "ws.archiveTitle");
  archive.setAttribute("aria-label", archive.title);
  archive.setAttribute("aria-pressed", String(w.archived === true));
  archive.onclick = (e) => {
    e.stopPropagation();
    const archiving = w.archived !== true;
    toggleWorkspaceArchived(w);
    if (archiving) markSessionArchived();
  };

  const close = document.createElement("button");
  close.className = "ws-close";
  close.textContent = "×";
  close.title = t("ws.closeTitle");
  close.onclick = (e) => {
    e.stopPropagation();
    void closeWorkspace(w);
  };

  item.append(av, meta);
  if (pin) item.append(pin);
  item.append(archive, close);
  item.onclick = (e) => {
    if (e.target instanceof HTMLInputElement) return; // インライン編集中は切り替えない
    // Shift = 範囲選択、Ctrl/Cmd = 増減。どちらもセッションは切り替えない
    if (e.shiftKey) {
      selectWsRange(w, additiveClick(e));
      return;
    }
    if (additiveClick(e)) {
      toggleWsSelection(w);
      return;
    }
    setWsSelection([w], w); // 修飾なしクリックは選択をこの1つに戻す
    if (w !== getActiveWs()) setActive(w);
  };
  // ダブルクリックでその場リネーム
  name.ondblclick = (e) => {
    e.stopPropagation();
    startInlineEdit(name, w.name, (v) => renameWorkspace(w, v));
  };
  // 右クリックで複製・リネーム・パス系・閉じる
  item.oncontextmenu = (e) => {
    e.preventDefault();
    // 選択外を右クリックしたらその項目へ選択を移す（選択中なら選択全体が対象）
    if (!selectedWsIds.has(w.id)) setWsSelection([w], w);
    openGroupMenu(w, e.clientX, e.clientY, name);
  };
  return item;
}

function buildCreateButton(open: (x: number, y: number) => void): HTMLButtonElement {
  const create = document.createElement("button");
  create.type = "button";
  create.className = "ws-group-create";
  create.textContent = "+";
  const createLabel = `${t("ctx.createSession")} / ${t("ctx.createGroup")}`;
  create.title = createLabel;
  create.setAttribute("aria-label", createLabel);
  create.setAttribute("aria-haspopup", "menu");
  create.onclick = (e) => {
    e.stopPropagation();
    const rect = create.getBoundingClientRect();
    open(rect.left, rect.bottom + 2);
  };
  return create;
}

function buildGroupHeader(
  group: WorkspaceGroup,
  count: number,
  membersDiv: HTMLDivElement,
): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "ws-group";
  head.dataset.groupId = group.id;
  head.draggable = true;
  const arrow = document.createElement("span");
  arrow.className = "ws-group-arrow";
  arrow.textContent = membersDiv.hidden ? "▸" : "▾";
  const name = document.createElement("span");
  name.className = "ws-group-name";
  name.textContent = group.name;
  const cnt = document.createElement("span");
  cnt.className = "ws-group-count";
  cnt.textContent = String(count);
  // グループ行の開閉・ドラッグとは別の、明示的な作成先ボタンとして扱う。
  const create = buildCreateButton((x, y) => openGroupHeadMenu(group, x, y));
  head.append(arrow, name, cnt, create);
  // 開閉は DOM の表示切替だけで行い再描画しない（再描画するとダブルクリックの
  // リネームが2回目のクリックで別要素になり成立しなくなる）
  head.onclick = () => {
    const collapsed = !membersDiv.hidden;
    membersDiv.hidden = collapsed;
    arrow.textContent = collapsed ? "▸" : "▾";
    if (collapsed) collapsedGroups.add(group.id);
    else collapsedGroups.delete(group.id);
    scheduleSave(); // 折りたたみ状態も保存する
  };
  // グループ名のダブルクリックで一括リネーム
  name.ondblclick = (e) => {
    e.stopPropagation();
    startInlineEdit(name, group.name, (v) => renameGroup(group, v));
  };
  // 右クリックで新規作成 / グループ操作メニュー
  head.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openGroupHeadMenu(group, e.clientX, e.clientY);
  };
  head.addEventListener("dragstart", (e) => {
    // インライン編集の文字選択を優先する（見出し名のダブルクリック編集と両立させる）。
    if ((e.target as HTMLElement).closest?.(".inline-edit, .ws-group-create")) {
      e.preventDefault();
      return;
    }
    draggingGroup = group;
    e.dataTransfer?.setData("text/plain", `group:${group.id}`); // WebKit はデータ無しだと drop が発火しない
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    head.classList.add("is-drag-src");
  });
  head.addEventListener("dragend", () => {
    draggingGroup = null;
    for (const el of wsList.querySelectorAll(".is-drag-src")) el.classList.remove("is-drag-src");
    clearDropMarks();
    flushPendingFilteredRender();
  });
  // セッション項目を見出しに落とす → そのグループの先頭に加入（複数選択はまとめて）
  head.addEventListener("dragover", (e) => {
    if (draggingGroup) {
      // 自分自身・子孫へのドロップは循環になるため受け付けない。
      if (groupDescendantIds(draggingGroup.id).has(group.id)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const r = head.getBoundingClientRect();
      const position =
        e.clientY < r.top + r.height * 0.25
          ? "before"
          : e.clientY > r.bottom - r.height * 0.25
            ? "after"
            : "inside";
      clearDropMarks();
      head.classList.add(
        position === "before" ? "drop-before" : position === "after" ? "drop-after" : "drop-into",
      );
      return;
    }
    if (!draggingWs.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    head.classList.add("drop-into");
  });
  head.addEventListener("dragleave", () => {
    head.classList.remove("drop-before", "drop-after", "drop-into");
  });
  head.addEventListener("drop", (e) => {
    if (draggingGroup) {
      const source = draggingGroup;
      const r = head.getBoundingClientRect();
      const position =
        e.clientY < r.top + r.height * 0.25
          ? "before"
          : e.clientY > r.bottom - r.height * 0.25
            ? "after"
            : "inside";
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks();
      draggingGroup = null;
      const nextParentId = position === "inside" ? group.id : group.parentId;
      // 現在と異なる親へ入れる操作は、見出しの端へのドロップでも新しいネストになりうる。
      // 既存親内での並べ替え・トップレベルへ戻す操作は無料枠のままにする。
      if (nextParentId && source.parentId !== nextParentId && !requireFeature()) return;
      moveGroup(source, group, position);
      return;
    }
    if (!draggingWs.length) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    const srcs = draggingWs;
    draggingWs = [];
    const first = sidebarEntries(group.id).find(
      (entry): entry is Workspace => isWorkspaceEntry(entry) && !srcs.includes(entry),
    );
    if (first) {
      moveWorkspaces(srcs, first, true, group.id);
    } else {
      for (const src of srcs) src.group = group.id;
      setSidebarEntryOrder([
        ...srcs,
        ...sidebarEntries(group.id).filter(
          (entry) => !isWorkspaceEntry(entry) || !srcs.includes(entry),
        ),
      ]);
      collapsedGroups.delete(group.id);
      renderSidebar();
      scheduleSave();
    }
  });
  return head;
}

/** 保存上のグループを増やさず、トップレベル全体を操作できる仮想の Whole 枠。 */
function buildWholeGroup(q: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "ws-whole-group";
  section.setAttribute("aria-label", "Whole");

  const head = document.createElement("div");
  head.className = "ws-whole-head";
  const name = document.createElement("span");
  name.className = "ws-whole-name";
  name.textContent = "Whole";
  const count = document.createElement("span");
  count.className = "ws-group-count";
  count.textContent = String(workspaces.filter(isWorkspaceInSessionFilterScope).length);
  const create = buildCreateButton((x, y) => openListCtxMenu(x, y, 0));
  // 右側コントロール群（件数・+）の一番左に「最近操作した順」トグルを置く
  head.append(name, buildRecentSortButton(), count, create);

  const members = document.createElement("div");
  members.className = "ws-whole-members";
  if (isRecentSortActive()) {
    // 最近操作した順はグループ階層を描かず、全セッションをフラットな新しい順で出す。
    // 保存上の並び・グループ所属・折りたたみ状態には触れない（OFF で完全に元へ戻る）。
    // 検索・状態絞り込みは通常表示と同じ条件で AND する
    for (const entry of sortByRecentOp(workspaces)) {
      if (workspaceMatchesDisplay(entry, q)) members.append(buildWsItem(entry));
    }
  } else {
    for (const entry of pinnedFirst(sidebarEntries())) {
      if (isWorkspaceEntry(entry)) {
        if (workspaceMatchesDisplay(entry, q)) members.append(buildWsItem(entry));
      } else {
        appendGroup(members, entry, q);
      }
    }
  }
  section.append(head, members);
  return section;
}

function groupHasDisplayMatch(
  group: WorkspaceGroup,
  q: string,
  ancestorMatched = false,
  seen = new Set<string>(),
): boolean {
  if (seen.has(group.id)) return false;
  seen.add(group.id);
  const ownMatched = ancestorMatched || (!!q && group.name.toLowerCase().includes(q));
  // 従来の「すべて」では空グループも残し、検索で親名が一致したら配下を丸ごと見せる。
  // 状態絞り込み中だけは、一致セッションを持たない空の枝を落とす。
  if (!isSessionStatusFilterActive() && (!q || ownMatched)) return true;
  if (
    workspaces.some(
      (workspace) =>
        workspace.group === group.id && workspaceMatchesDisplay(workspace, q, ownMatched),
    )
  ) {
    return true;
  }
  return groups
    .filter((child) => child.parentId === group.id)
    .some((child) => groupHasDisplayMatch(child, q, ownMatched, new Set(seen)));
}

function workspaceMatchesSearch(workspace: Workspace, query: string): boolean {
  return (
    workspace.name.toLowerCase().includes(query) ||
    (workspace.note?.toLowerCase().includes(query) ?? false)
  );
}

function workspaceMatchesDisplay(
  workspace: Workspace,
  query: string,
  ancestorMatched = false,
): boolean {
  return (
    matchesSessionStatusFilter(workspace, wsActivityState(workspace)) &&
    (!query || ancestorMatched || workspaceMatchesSearch(workspace, query))
  );
}

/** 保存している混在行順を保ったまま、ピン済みセッションだけを先頭へ出す。 */
function pinnedFirst(list: Array<Workspace | WorkspaceGroup>): Array<Workspace | WorkspaceGroup> {
  return [
    ...list.filter((entry) => isWorkspaceEntry(entry) && entry.pinned),
    ...list.filter((entry) => !isWorkspaceEntry(entry) || !entry.pinned),
  ];
}

/** グループ見出しと直下のセッション / 子グループを再帰的に描画する */
function appendGroup(
  container: HTMLElement,
  group: WorkspaceGroup,
  q: string,
  ancestorMatched = false,
) {
  const ownMatched = ancestorMatched || (!!q && group.name.toLowerCase().includes(q));
  if (!groupHasDisplayMatch(group, q, ancestorMatched)) return;

  const membersDiv = document.createElement("div");
  membersDiv.className = "ws-group-members";
  // 検索・状態絞り込み中は、一致したセッションが隠れないよう祖先を展開して見せる。
  membersDiv.hidden =
    !q && !isSessionStatusFilterActive() && collapsedGroups.has(group.id);
  for (const entry of pinnedFirst(sidebarEntries(group.id))) {
    if (isWorkspaceEntry(entry)) {
      if (workspaceMatchesDisplay(entry, q, ownMatched)) {
        membersDiv.append(buildWsItem(entry));
      }
    } else {
      appendGroup(membersDiv, entry, q, ownMatched);
    }
  }

  const descendantIds = groupDescendantIds(group.id);
  const count = workspaces.filter(
    (w) => w.group && descendantIds.has(w.group) && isWorkspaceInSessionFilterScope(w),
  ).length;
  container.append(buildGroupHeader(group, count, membersDiv), membersDiv);
}

export function renderSidebar() {
  // 名前のインライン編集中に OSC 7 等で再描画されると、編集欄とフォーカスが消える。
  // 確定（blur）の後に描き直す。メモ編集はサイドバー外のポップオーバーなので影響しない。
  if (wsList.querySelector(".inline-edit")) {
    pendingFilteredRender = true;
    return;
  }
  pendingFilteredRender = false;
  // innerHTML で項目を組み直すとブラウザによってはスクロール位置が先頭へ戻る。
  // グループ内での作成や並べ替えで、見ていた位置からサイドバーを動かさない。
  const scrollTop = wsList.scrollTop;
  const q = wsSearch.value.trim().toLowerCase();
  wsList.innerHTML = "";
  wsList.append(buildWholeGroup(q));
  wsList.scrollTop = scrollTop;
  renderSessionStatusFilterTexts();
  renderSelectionBar(); // 件数表示と言語切替への追従（項目自体は buildWsItem が反映済み）
}

let pendingFilteredRender = false;

/** activity の遷移中に DnD / インライン編集を壊さず、絞り込み結果だけ追従させる。 */
function refreshFilteredSidebar(): void {
  if (!isSessionStatusFilterActive()) return;
  if (draggingWs.length || draggingGroup || wsList.querySelector(".inline-edit")) {
    pendingFilteredRender = true;
    return;
  }
  renderSidebar();
}

function flushPendingFilteredRender(): void {
  if (!pendingFilteredRender || draggingWs.length || draggingGroup || wsList.querySelector(".inline-edit")) {
    return;
  }
  renderSidebar();
}

let statusFilterInitialized = false;

/** composition root から、全モジュールの評価完了後に接続する（activity との循環初期化を避ける）。 */
export function initSidebarStatusFilter(): void {
  if (statusFilterInitialized) return;
  statusFilterInitialized = true;
  initSessionStatusFilter(renderSidebar);
  onWorkspaceActivityChange(refreshFilteredSidebar);
  wsList.addEventListener("focusout", () => queueMicrotask(flushPendingFilteredRender));
}

/** Whole 行の「最近操作した順」トグルを renderSidebar へ接続する（同上の理由で main.ts から）。 */
export function initSidebarRecentSort(): void {
  initSessionRecentSort(renderSidebar);
}

/** 前後移動の並び = サイドバーの表示順。折りたたみ中のグループ内や検索で消えている
    項目は「見えていないもの」なので飛ばす。見えている項目が1つ以下のとき
    （検索で絞り込みすぎた等）は全セッションの並びに退化して必ず移動できるようにする */
function switchOrder(): Workspace[] {
  const visible = visibleWsIds()
    .map((id) => workspaces.find((w) => w.id === id))
    .filter((w): w is Workspace => !!w);
  return visible.length > 1 ? visible : workspaces.filter(isWorkspaceInSessionFilterScope);
}

/** 指定セッションのサイドバー項目（= 光っている active 項目になりうるもの）を
    スクロールして見える位置へ送る。renderSidebar 後に呼ぶこと */
export function scrollWsIntoView(w: Workspace): void {
  const item = wsList.querySelector<HTMLElement>(`.ws-item[data-ws-id="${w.id}"]`);
  if (!item) return;
  item.scrollIntoView({ block: "nearest" });
  // Chromium / WebKit は入れ子のグループを再描画した直後、nearest の計算が数px不足して
  // 選択行の端をスクロール枠外へ残すことがある。実際の枠との距離で同期的に補正する。
  const listRect = wsList.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  // scrollTop はこの環境では整数へ丸められるため、0.x px の不足も最低1px動かす。
  if (itemRect.top < listRect.top) wsList.scrollTop -= Math.ceil(listRect.top - itemRect.top);
  else if (itemRect.bottom > listRect.bottom)
    wsList.scrollTop += Math.ceil(itemRect.bottom - listRect.bottom);
}

/** キーボードで前後のセッションへ移動する（Ctrl+Tab / Cmd(+Ctrl)+Shift+↑↓）。
    ショートカットは window の keydown で拾うので、ターミナルにカーソルがあっても
    マウスへ持ち替えずに切り替えられる。端では巻き戻す */
export function stepActiveWorkspace(dir: 1 | -1) {
  const order = switchOrder();
  if (order.length < 2) return;
  const current = getActiveWs();
  const at = current ? order.indexOf(current) : -1;
  // 表示中セッションが並びに無い（検索で消えている等）ときは進行方向の端から入る
  const next =
    at < 0 ? order[dir > 0 ? 0 : order.length - 1] : order[(at + dir + order.length) % order.length];
  if (!next || next === current) return;
  setWsSelection([next], next); // 修飾なしクリックと同じく操作対象もこの1件に戻す
  setActive(next); // 表示・位置合わせを一元化する
}

// リストの余白クリックで選択解除（項目の上のクリックは buildWsItem 側が処理する）
wsList.addEventListener("click", (e) => {
  if (e.target === wsList) clearWsSelection();
});

// リストの余白（項目の外）に落とす → 末尾へ移動して未分類にする
wsList.addEventListener("dragover", (e) => {
  if ((!draggingWs.length && !draggingGroup) || e.target !== wsList) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  wsList.classList.add("drop-end");
});
wsList.addEventListener("dragleave", (e) => {
  if (e.target === wsList) wsList.classList.remove("drop-end");
});
wsList.addEventListener("drop", (e) => {
  if ((!draggingWs.length && !draggingGroup) || e.target !== wsList) return;
  e.preventDefault();
  clearDropMarks();
  if (draggingGroup) {
    const source = draggingGroup;
    draggingGroup = null;
    moveGroup(source, null, "root");
    return;
  }
  const srcs = draggingWs;
  draggingWs = [];
  const moving = workspaces.filter((workspace) => srcs.includes(workspace));
  const rootRest = sidebarEntries().filter(
    (entry) => !isWorkspaceEntry(entry) || !moving.includes(entry),
  );
  // 表示順で末尾へ押し出す（複数選択でも相対順は保たれる）
  for (const src of moving) {
    workspaces.splice(workspaces.indexOf(src), 1);
    workspaces.push(src);
    src.group = undefined;
  }
  setSidebarEntryOrder([...rootRest, ...moving]);
  renderSidebar();
  scheduleSave();
});

/** フォームの「場所」欄で選んだ作成先。undefined = 既定（表示中ペインと同じ場所） */
let wsNewFormCwd: string | undefined;

function setFormCwd(cwd: string | undefined) {
  wsNewFormCwd = cwd;
  wsNewLocBtn.textContent = cwd ?? t("form.locationDefault");
  wsNewLocBtn.title = cwd ?? t("loc.pickTitle");
}

// 場所欄はホバーでもクリックでも場所フライアウトを開き、選ぶと欄の表示だけ差し替える
// （作成はシェル選択ボタンのまま）
attachLocationFlyout(wsNewLocBtn, (cwd) => setFormCwd(cwd), { openOnClick: true });

/** 名前・シェル・グループを指定して作る詳細フォーム。
    Cmd/Ctrl+T と、Windows の検索欄横 + で場所を選んだ後に開く */
export function openNewSessionForm(groupId?: string, cwd?: string) {
  // 作成フォームを開いた時点の表示中セッションを配置基準として保持する。
  // ユーザーがグループ欄を変更した場合は、その明示指定を優先する。
  const ref = getActiveWs();
  const defaultGroup =
    groupById(groupId) ?? (groupId === undefined ? groupById(ref?.group) : undefined);
  wsNewForm.hidden = false;
  wsNewName.value = "";
  wsNewName.placeholder = t("form.sessionName");
  wsNewGroup.hidden = false;
  wsNewGroup.value = defaultGroup ? groupPath(defaultGroup) : "";
  setFormCwd(cwd); // 通常は既定へ戻し、+ の場所フライアウトから開いた場合だけ選択値を引き継ぐ
  wsNewShells.hidden = false;
  refreshGroupDatalist(); // 既存グループ名を入力補完に出す
  wsNewShells.innerHTML = "";
  for (const c of SHELL_CHOICES) {
    if (c.os && !c.os.includes(getHostOs())) continue;
    const b = document.createElement("button");
    b.textContent = c.label();
    b.onclick = () => {
      const name = wsNewName.value.trim() || nextSessionName();
      const pickedCwd = wsNewFormCwd;
      wsNewForm.hidden = true;
      const group = resolveGroupInput(wsNewGroup.value);
      // 場所欄で選んでいればそのディレクトリ、既定なら他の作成入口と揃えて
      // 表示中ペインと同じ場所にする
      void (pickedCwd !== undefined ? Promise.resolve(pickedCwd) : newSessionCwd()).then((cwd) => {
        const ws = createWorkspace(name, c.kind, { group, cwd });
        if (ref && ref.group === group) placeAfter(ws, ref);
      });
    };
    wsNewShells.append(b);
  }
  wsNewName.focus();
}
// サイドバー（セッション一覧）の開閉。エクスプローラーと同じく、たたんだ分だけ
// グリッド幅が変わるので layout()（= refit）まで通す。開閉状態は保存しない
// （エクスプローラーと揃えて、起動時は常に開いた状態にする）
let sidebarOpen = true;

export function isSidebarOpen(): boolean {
  return sidebarOpen;
}

export function setSidebarOpen(open: boolean) {
  sidebarOpen = open;
  sidebarEl.hidden = !open;
  sidebarReopenBtn.hidden = open; // たたんでいる間だけ左端タブを出す
  sidebarCollapseBtn.setAttribute("aria-expanded", String(open));
  if (!open) closeGroupMenu(); // サイドバー由来の右クリックメニューを宙に浮かせない
  layout();
}

sidebarCollapseBtn.onclick = () => setSidebarOpen(false);
sidebarReopenBtn.onclick = () => setSidebarOpen(true);

// 右端ハンドルのドラッグで幅を変更。エクスプローラー（#exp-resize）の左右対称で、
// 最小幅よりさらに左へ押し込んで離すとたたむ。ドラッグ中は rAF で place のみ回し、
// refit は確定時にまとめて行う（ペイン用ディバイダと同じ）。幅は保存しない
const SIDEBAR_MIN_W = 150;
const SIDEBAR_DEFAULT_W = 320; // sidebar.css の #sidebar { width } と同じ値
const SIDEBAR_CLOSE_W = 90; // 要求幅がこれ未満のまま離したらたたむ

sidebarResizeEl.addEventListener("pointerdown", (down) => {
  down.preventDefault();
  try {
    sidebarResizeEl.setPointerCapture(down.pointerId);
  } catch {
    /* キャプチャ不可でも move は届く範囲で動く */
  }
  sidebarResizeEl.classList.add("is-dragging");
  document.body.classList.add("dragging");
  const left = sidebarEl.getBoundingClientRect().left;
  const maxW = Math.max(SIDEBAR_MIN_W, Math.round(window.innerWidth * 0.6));
  let requested = sidebarEl.getBoundingClientRect().width;

  const move = (ev: PointerEvent) => {
    requested = ev.clientX - left;
    const w = Math.min(maxW, Math.max(SIDEBAR_MIN_W, Math.round(requested)));
    sidebarEl.style.width = `${w}px`;
    sidebarEl.classList.toggle("will-close", requested < SIDEBAR_CLOSE_W);
    if (!getRafId()) {
      setRafId(
        requestAnimationFrame(() => {
          setRafId(0);
          const ws = getActiveWs();
          if (!ws?.root) return;
          const r = ws.layer.getBoundingClientRect();
          place(ws, ws.root, { x: 0, y: 0, w: r.width, h: r.height });
        }),
      );
    }
  };
  const finish = () => {
    sidebarResizeEl.removeEventListener("pointermove", move);
    sidebarResizeEl.removeEventListener("pointerup", finish);
    sidebarResizeEl.removeEventListener("pointercancel", finish);
    sidebarResizeEl.removeEventListener("lostpointercapture", finish);
    sidebarResizeEl.classList.remove("is-dragging");
    document.body.classList.remove("dragging");
    sidebarEl.classList.remove("will-close");
    if (requested < SIDEBAR_CLOSE_W) setSidebarOpen(false);
    else layout(); // 確定時に refit まで含めてやり直す
  };
  sidebarResizeEl.addEventListener("pointermove", move);
  sidebarResizeEl.addEventListener("pointerup", finish);
  sidebarResizeEl.addEventListener("pointercancel", finish);
  sidebarResizeEl.addEventListener("lostpointercapture", finish);
});

// ダブルクリックで既定幅に戻す
sidebarResizeEl.addEventListener("dblclick", () => {
  sidebarEl.style.width = `${SIDEBAR_DEFAULT_W}px`;
  layout();
});
// 検索欄の隣にある左上の + だけは、クリックで場所フライアウトを開く。先頭の
// 「表示中ペインと同じ場所」が従来の + と同じ動作で、ほかの行は cwd だけを差し替える。
// Windows はどの場所を選んでもシェル選択が必要なので、選択値を詳細フォームへ引き継ぐ。
function createFromTopPlus(cwd?: string) {
  if (getHostOs() === "windows") {
    openNewSessionForm(undefined, cwd);
    return;
  }
  wsNewForm.hidden = true;
  const ref = getActiveWs();
  void quickCreateWorkspace({ group: ref?.group, after: ref, ...(cwd === undefined ? {} : { cwd }) });
}
attachLocationFlyout(wsNewBtn, (cwd) => createFromTopPlus(cwd), {
  openOnClick: true,
  openOnHover: false,
  defaultAction: () => createFromTopPlus(),
});
wsNewName.onkeydown = (e) => {
  if (e.key === "Escape") wsNewForm.hidden = true;
};
wsNewGroup.onkeydown = (e) => {
  if (e.key === "Escape") wsNewForm.hidden = true;
};
wsSearch.oninput = () => renderSidebar();
