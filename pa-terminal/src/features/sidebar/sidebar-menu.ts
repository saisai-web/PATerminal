// ============================================================
// 右クリックメニュー共通アクション（サイドバー / エクスプローラー）
// ============================================================

import { copyText } from "../../shared/clipboard";
import { closeGroupMenu, getCtxMenuEl, showCtxMenu } from "../../shared/ctx-menu";
import { revealInOs, revealLabel } from "../explorer/explorer-menu";
import {
  createGroup,
  createParentGroup,
  groupDescendantIds,
  nextGroupName,
  renameGroup,
} from "../../workspace/groups";
import { t } from "../../i18n";
import type { MsgKey } from "../../i18n";
import { startInlineEdit } from "../../shared/inline-edit";
import { lockClass, requireFeature } from "../license/license";
import { scheduleSave } from "../../app/session";
import {
  actionTargets,
  clearWsSelection,
} from "./sidebar-selection";
import { renderSidebar } from "./sidebar";
import { collapsedGroups, groups, workspaces } from "../../workspace/state";
import {
  WORKSPACE_BACKGROUND_COLORS,
  type Workspace,
  type WorkspaceBackgroundColor,
  type WorkspaceGroup,
} from "../../workspace/types";
import {
  MAX_DUPLICATE_COUNT,
  closeWorkspace,
  closeWorkspaces,
  duplicateWorkspace,
  quickCreateWorkspace,
  renameWorkspace,
  setWorkspaceBackgroundColor,
  toggleWorkspacePinned,
  workspaceCwd,
} from "../../workspace/workspace";

const wsList = document.querySelector<HTMLDivElement>("#ws-list")!;

const backgroundColorLabelKeys: Record<WorkspaceBackgroundColor, MsgKey> = {
  red: "ctx.colorRed",
  orange: "ctx.colorOrange",
  yellow: "ctx.colorYellow",
  green: "ctx.colorGreen",
  blue: "ctx.colorBlue",
  purple: "ctx.colorPurple",
};

/** テーマ対応の背景色スウォッチ。「なし」を先頭に置き、現在値はリングとチェックで示す。 */
function buildBackgroundPicker(targets: readonly Workspace[]): HTMLDivElement {
  const picker = document.createElement("div");
  picker.className = "ctx-color-picker";
  const label = document.createElement("span");
  label.className = "ctx-color-label";
  label.textContent = t("ctx.backgroundColor");

  const options = document.createElement("div");
  options.className = "ctx-color-options";
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", label.textContent);

  const colors: Array<WorkspaceBackgroundColor | undefined> = [
    undefined,
    ...WORKSPACE_BACKGROUND_COLORS,
  ];
  for (const color of colors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctx-color-option";
    button.dataset.wsColor = color ?? "default";
    const choiceLabel = color ? t(backgroundColorLabelKeys[color]) : t("ctx.backgroundDefault");
    button.title = choiceLabel;
    button.setAttribute("aria-label", choiceLabel);
    const current = targets.every((target) => target.backgroundColor === color);
    button.classList.toggle("is-current", current);
    button.setAttribute("aria-pressed", String(current));
    button.onclick = () => {
      closeGroupMenu();
      setWorkspaceBackgroundColor(targets, color);
    };
    options.append(button);
  }
  picker.append(label, options);
  return picker;
}

/** セッション項目の右クリックで開くメニュー（親グループ作成 / 複製 / リネーム / パス系 / 閉じる）。
    親グループ作成は対象セッションをその場で新しいグループに包む。
    nameEl はその項目のインライン編集ホスト。 */
export function openGroupMenu(
  w: Workspace,
  x: number,
  y: number,
  nameEl: HTMLElement,
) {
  closeGroupMenu();
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  // 複数選択中に選択内を右クリックしたときは、グループ化・閉じるを選択全体に効かせる
  const targets = actionTargets(w);
  const multi = targets.length > 1;
  const n = String(targets.length);

  const grp = document.createElement("button");
  grp.textContent = multi ? t("ctx.groupSelected", { n }) : t("ctx.createGroup");
  grp.title = multi ? t("ctx.groupSelectedTitle") : t("ctx.createParentGroupTitle");
  // グループ所属セッションを包むと子グループになる = そのときだけロック対象
  if (targets[0]?.group) lockClass(grp);
  grp.onclick = () => {
    closeGroupMenu();
    createParentGroup(targets);
  };

  const createSep = document.createElement("div");
  createSep.className = "ctx-sep";

  // 複製は「数」を選んでから1クリックで作る。フォームやモーダルは出さず、
  // メニュー内のステッパー（− / + ）で数だけ決めてボタンのラベルに反映する
  let dupCount = 1;
  const dup = document.createElement("button");
  dup.onclick = () => {
    closeGroupMenu();
    void duplicateWorkspace(w, dupCount);
  };

  const countRow = document.createElement("div");
  countRow.className = "ctx-count";
  const countLabel = document.createElement("span");
  countLabel.className = "ctx-count-label";
  countLabel.textContent = t("ctx.duplicateCount");
  const less = document.createElement("button");
  less.className = "ctx-count-btn";
  less.textContent = "−";
  less.title = t("ctx.duplicateFewer");
  less.setAttribute("aria-label", t("ctx.duplicateFewer"));
  const countValue = document.createElement("span");
  countValue.className = "ctx-count-value";
  const more = document.createElement("button");
  more.className = "ctx-count-btn";
  more.textContent = "+";
  more.title = t("ctx.duplicateMore");
  more.setAttribute("aria-label", t("ctx.duplicateMore"));

  const renderDupCount = () => {
    const n = String(dupCount);
    countValue.textContent = n;
    dup.textContent = dupCount > 1 ? t("ctx.duplicateN", { n }) : t("ctx.duplicate");
    dup.title = dupCount > 1 ? t("ctx.duplicateNTitle", { n }) : t("ctx.duplicateTitle");
    less.disabled = dupCount <= 1;
    more.disabled = dupCount >= MAX_DUPLICATE_COUNT;
  };
  // メニューは閉じない（数を決めてから複製ボタンを押す操作なので押しっぱなしで増減できる）
  const stepDupCount = (delta: number) => {
    dupCount = Math.max(1, Math.min(MAX_DUPLICATE_COUNT, dupCount + delta));
    renderDupCount();
  };
  less.onclick = () => stepDupCount(-1);
  more.onclick = () => stepDupCount(1);
  renderDupCount();
  countRow.append(countLabel, less, countValue, more);

  const ren = document.createElement("button");
  ren.textContent = t("ctx.rename");
  ren.onclick = () => {
    closeGroupMenu();
    startInlineEdit(nameEl, w.name, (v) => renameWorkspace(w, v));
  };

  // 複数選択中は対象が曖昧になるため、ピン操作は単独メニューと行内ボタンだけに出す
  const pinItems: HTMLElement[] = [];
  if (!multi) {
    const pin = document.createElement("button");
    pin.textContent = t(w.pinned ? "ctx.unpin" : "ctx.pin");
    lockClass(pin); // ピン留めはソフトロック対象（ガードは toggleWorkspacePinned 側）
    pin.onclick = () => {
      closeGroupMenu();
      toggleWorkspacePinned(w);
    };
    pinItems.push(pin);
  }

  // 背景色は複数選択にも一括適用できる。混在中はどのスウォッチも未選択で表示する。
  const backgroundPicker = buildBackgroundPicker(targets);

  // 代表ディレクトリ（フォーカス中 or 先頭ペインの cwd）が分かる場合のみ
  // パス系の項目を出す
  const cwd = workspaceCwd(w);
  const pathItems: HTMLElement[] = [];
  if (cwd) {
    const cp = document.createElement("button");
    cp.textContent = t("ctx.copyPath");
    cp.title = cwd;
    cp.onclick = () => {
      closeGroupMenu();
      void copyText(cwd);
    };
    const rv = document.createElement("button");
    rv.textContent = revealLabel();
    rv.title = cwd;
    rv.onclick = () => {
      closeGroupMenu();
      revealInOs(cwd);
    };
    pathItems.push(cp, rv);
  }

  const sep = document.createElement("div");
  sep.className = "ctx-sep";

  // サイドバーの × と同じ（全ペイン終了）。確認なしなのも × に合わせる
  const closeBtn = document.createElement("button");
  closeBtn.textContent = multi ? t("ctx.closeSelected", { n }) : t("ctx.closeSession");
  closeBtn.title = multi ? t("ctx.closeSelectedTitle") : t("ws.closeTitle");
  closeBtn.onclick = () => {
    closeGroupMenu();
    void closeWorkspaces(targets);
  };

  const selItems: HTMLElement[] = [];
  if (multi) {
    const clear = document.createElement("button");
    clear.textContent = t("ctx.clearSelection");
    clear.title = t("sel.clearTitle");
    clear.onclick = () => {
      closeGroupMenu();
      clearWsSelection();
    };
    selItems.push(clear);
  }

  menu.append(
    grp,
    createSep,
    dup,
    countRow,
    ...pinItems,
    backgroundPicker,
    ren,
    ...pathItems,
    sep,
    closeBtn,
    ...selItems,
  );
  showCtxMenu(menu, x, y);
}

/** グループ見出しの右クリックメニュー。
    新規セッションはそのグループへ、新規グループは子階層へ、いずれもクイック作成として
    フォームを出さず自動採番の名前で即時作成する。
    「解散」= 直下のセッションと子グループを親へ移す（セッションは閉じない）。
    「グループごと全セッションを閉じる」= 子階層のセッションも全部閉じる（× と同じ・確認なし） */
export function openGroupHeadMenu(group: WorkspaceGroup, x: number, y: number) {
  closeGroupMenu();
  const menu = document.createElement("div");
  menu.id = "ctx-menu";

  const session = document.createElement("button");
  session.textContent = t("ctx.createSession");
  session.title = t("ctx.createSessionInGroupTitle");
  session.onclick = () => {
    closeGroupMenu();
    void quickCreateWorkspace({ group: group.id });
  };

  const child = document.createElement("button");
  child.textContent = t("ctx.createGroup");
  child.title = t("ctx.createChildGroupTitle");
  lockClass(child); // 子グループ（ネスト）はソフトロック対象
  child.onclick = () => {
    closeGroupMenu();
    if (!requireFeature()) return;
    createGroup(nextGroupName(), group.id);
  };

  const renameBtn = document.createElement("button");
  renameBtn.textContent = t("ctx.rename");
  renameBtn.onclick = () => {
    closeGroupMenu();
    const nameEl = wsList.querySelector<HTMLElement>(
      `.ws-group[data-group-id="${group.id}"] .ws-group-name`,
    );
    if (nameEl) startInlineEdit(nameEl, group.name, (v) => renameGroup(group, v));
  };

  const createSep = document.createElement("div");
  createSep.className = "ctx-sep";
  const dissolve = document.createElement("button");
  dissolve.textContent = t("ctx.dissolveGroup");
  dissolve.title = t("ctx.dissolveGroupTitle");
  dissolve.onclick = () => {
    closeGroupMenu();
    for (const w of workspaces) if (w.group === group.id) w.group = group.parentId;
    for (const childGroup of groups) {
      if (childGroup.parentId === group.id) childGroup.parentId = group.parentId;
    }
    const index = groups.indexOf(group);
    if (index >= 0) groups.splice(index, 1);
    collapsedGroups.delete(group.id);
    renderSidebar();
    scheduleSave();
  };
  const sep = document.createElement("div");
  sep.className = "ctx-sep";
  const closeAll = document.createElement("button");
  closeAll.textContent = t("ctx.closeGroupAll");
  closeAll.title = t("ctx.closeGroupAllTitle");
  closeAll.onclick = () => {
    closeGroupMenu();
    const ids = groupDescendantIds(group.id);
    for (const id of ids) collapsedGroups.delete(id);
    for (let i = groups.length - 1; i >= 0; i--) {
      if (ids.has(groups[i].id)) groups.splice(i, 1);
    }
    // closeWorkspace は workspaces を書き換えるので、先に対象を確定してから順に閉じる
    const members = workspaces.filter((w) => w.group && ids.has(w.group));
    void (async () => {
      for (const w of members) await closeWorkspace(w);
      renderSidebar();
      scheduleSave();
    })();
  };
  menu.append(session, child, createSep, renameBtn, dissolve, sep, closeAll);
  showCtxMenu(menu, x, y);
}

/** サイドバー余白（項目の外）の右クリックメニュー。
    新規セッションは表示中セッションと同じ階層へ作り、新規グループはトップレベルへ作る。
    どちらもフォームを出さず自動採番の名前で即時作成する */
export function openListCtxMenu(x: number, y: number) {
  closeGroupMenu();
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  const session = document.createElement("button");
  session.textContent = t("ctx.createSession");
  session.title = t("ctx.createSessionTitle");
  session.onclick = () => {
    closeGroupMenu();
    void quickCreateWorkspace();
  };
  const group = document.createElement("button");
  group.textContent = t("ctx.createGroup");
  group.title = t("ctx.createGroupTitle");
  group.onclick = () => {
    closeGroupMenu();
    createGroup(nextGroupName());
  };
  menu.append(session, group);
  showCtxMenu(menu, x, y);
}

// メニュー外クリックで閉じる
window.addEventListener(
  "mousedown",
  (e) => {
    const menu = getCtxMenuEl();
    if (menu && !menu.contains(e.target as Node)) closeGroupMenu();
  },
  true,
);

// サイドバーの余白（項目の外）を右クリック → グループ作成メニュー
wsList.addEventListener("contextmenu", (e) => {
  if (e.target !== wsList) return; // 項目・見出しの上はそれぞれのメニューに任せる
  e.preventDefault();
  openListCtxMenu(e.clientX, e.clientY);
});
// セッションの右クリックメニューは Escape で閉じる（入力欄以外にフォーカスが
// あっても効くように window 側で受ける）
window.addEventListener(
  "keydown",
  (e) => {
    if (getCtxMenuEl() && e.key === "Escape") {
      e.stopPropagation();
      closeGroupMenu();
    }
  },
  true,
);
window.addEventListener("blur", () => {
  closeGroupMenu();
});
window.addEventListener("resize", () => {
  closeGroupMenu();
});
