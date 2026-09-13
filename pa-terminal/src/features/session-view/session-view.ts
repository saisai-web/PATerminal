import { t, type MsgKey } from "../../i18n";
import { scheduleSave } from "../../app/session";
import { layout, placeVisibleWorkspaces } from "../../terminal/layout";
import { initWorkspaceLayout } from "../../terminal/workspace-layout";
import { getActiveWs, getFocusedId, selectedWsIds, workspaces } from "../../workspace/state";
import { addWorkspacesToView, arrangeWorkspaces, displayedWorkspaces, getActiveWorkspaceView, removeWorkspaceFromView, viewIds, type WorkspaceView } from "../../workspace/view";
import { onActiveWorkspaceChange, setActive } from "../../workspace/workspace";
import { groupById, groupPath } from "../../workspace/groups";
import type { Workspace } from "../../workspace/types";
import { initSessionViewDrop } from "./session-view-drop";

const openButton = document.querySelector<HTMLButtonElement>("#session-view-open")!;
const soloButton = document.querySelector<HTMLButtonElement>("#session-view-solo")!;

function focusTerminal() {
  const ws = getActiveWs(), id = getFocusedId();
  if (ws && id) ws.panes.get(id)?.focus();
}

function solo(ws: Workspace) {
  arrangeWorkspaces([], "grid");
  setActive(ws); scheduleSave();
}

function remove(ws: Workspace) {
  const remaining = displayedWorkspaces().filter((w) => w !== ws);
  removeWorkspaceFromView(ws.id);
  const active = getActiveWs();
  const next = active && active !== ws ? active : remaining[0];
  if (next) setActive(next);
  scheduleSave();
}

export function renderSessionView() {
  soloButton.hidden = !getActiveWorkspaceView();
  soloButton.setAttribute("aria-label", t("view.solo"));
  openButton.classList.toggle("is-on", !!getActiveWorkspaceView());
  for (const [selector, key] of [[".workspace-view-solo", "view.solo"], [".workspace-view-remove", "view.remove"], [".workspace-divider", "view.resize"]] as const) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      el.title = t(key); el.setAttribute("aria-label", t(key));
    }
  }
}

/** Session selection changes only the view; no panes or PTYs are copied or restarted. */
export function initSessionView(deps: { dragged: () => Workspace[] }) {
  initWorkspaceLayout({ activate: setActive, solo, remove, place: placeVisibleWorkspaces, layout: () => layout() });
  initSessionViewDrop({ dragged: deps.dragged, add: ({ target, added, edge }) => {
    const ids = addWorkspacesToView(target.id, added.map((w) => w.id), edge);
    const first = workspaces.find((w) => w.id === ids[0]);
    if (first) { setActive(first); scheduleSave(); }
  } });
  onActiveWorkspaceChange(renderSessionView);
  soloButton.onclick = () => { const ws = getActiveWs(); if (ws) solo(ws); };

  const overlay = document.createElement("div");
  overlay.id = "session-view-overlay";
  overlay.className = "git-action-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div id="session-view-panel" class="git-action-panel" role="dialog" aria-modal="true" aria-labelledby="session-view-title" aria-describedby="session-view-description">
    <div class="git-action-head"><span id="session-view-title" data-i18n="view.title"></span><button id="session-view-close" type="button">×</button></div>
    <div class="git-action-body">
      <p id="session-view-description" data-i18n="view.description"></p>
      <div id="session-view-modes" role="group"></div>
      <input id="session-view-search" type="search" data-i18n-placeholder="sidebar.searchPlaceholder" />
      <div id="session-view-list"></div>
      <p id="session-view-count" aria-live="polite"></p>
    </div>
    <div class="git-action-foot"><button id="session-view-cancel" type="button" data-i18n="bc.cancel"></button><button id="session-view-apply" class="primary" type="button" data-i18n="view.show"></button></div>
  </div>`;
  document.body.append(overlay);
  const find = <T extends HTMLElement>(id: string) => overlay.querySelector<T>(`#${id}`)!;
  const search = find<HTMLInputElement>("session-view-search");
  const modes = find("session-view-modes");
  const list = find("session-view-list");
  const apply = find<HTMLButtonElement>("session-view-apply");
  const picked = new Set<string>();
  let mode: WorkspaceView["mode"] = "grid";
  const chosen = () => [...picked].filter((id) => workspaces.some((w) => w.id === id));
  const count = () => {
    const n = chosen().length;
    find("session-view-count").textContent = n < 2 ? t("view.choose") : t("bc.count", { n: String(n) });
    apply.disabled = n < 2;
  };
  const renderModes = () => {
    modes.replaceChildren();
    for (const value of ["grid", "row", "col"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.mode = value;
      button.textContent = t(`view.${value}`);
      button.setAttribute("aria-pressed", String(mode === value));
      button.onclick = () => { mode = value; renderModes(); modes.querySelector<HTMLButtonElement>(`[data-mode="${value}"]`)?.focus(); };
      modes.append(button);
    }
  };
  const renderList = () => {
    list.replaceChildren();
    const query = search.value.toLocaleLowerCase();
    for (const ws of workspaces) {
      if (ws.archived && !picked.has(ws.id)) continue;
      const group = groupById(ws.group);
      const path = group ? groupPath(group) : "";
      if (!`${ws.name} ${path}`.toLocaleLowerCase().includes(query)) continue;
      const row = document.createElement("label");
      row.className = "bc-row";
      row.dataset.wsId = ws.id;
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = picked.has(ws.id);
      check.onchange = () => { if (check.checked) picked.add(ws.id); else picked.delete(ws.id); count(); };
      const text = document.createElement("span");
      text.className = "bc-row-text";
      const name = document.createElement("span");
      name.className = "bc-row-name"; name.textContent = ws.name;
      const sub = document.createElement("span");
      sub.className = "bc-row-sub";
      sub.textContent = [path, t("bc.panes", { n: String(ws.panes.size) })].filter(Boolean).join(" · ");
      text.append(name, sub); row.append(check, text); list.append(row);
    }
    count();
  };
  const close = () => {
    overlay.hidden = true;
    openButton.setAttribute("aria-expanded", "false");
    focusTerminal();
  };
  const open = (ids?: string[]) => {
    picked.clear();
    for (const id of ids ?? (getActiveWorkspaceView() ? viewIds() : [getActiveWs()?.id ?? ""])) picked.add(id);
    mode = getActiveWorkspaceView()?.mode ?? "grid";
    search.value = "";
    for (const el of overlay.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n as MsgKey);
    search.placeholder = t("sidebar.searchPlaceholder");
    search.setAttribute("aria-label", search.placeholder);
    find("session-view-close").setAttribute("aria-label", t("bc.close"));
    modes.setAttribute("aria-label", t("view.title"));
    renderModes(); renderList();
    overlay.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
    search.focus();
  };
  openButton.onclick = () => open(selectedWsIds.size > 1 ? [...selectedWsIds] : undefined);
  document.querySelector<HTMLButtonElement>("#ws-selection-view")!.onclick = () => open([...selectedWsIds]);
  find("session-view-close").onclick = find("session-view-cancel").onclick = close;
  search.oninput = renderList;
  apply.onclick = () => {
    const ids = chosen();
    if (ids.length < 2) { renderList(); return; }
    const active = getActiveWs();
    arrangeWorkspaces(ids, mode);
    close();
    setActive(active && ids.includes(active.id) ? active : workspaces.find((w) => w.id === ids[0])!);
    scheduleSave();
  };
  overlay.onpointerdown = (e) => { if (e.target === overlay) close(); };
  overlay.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") {
      const controls = [...overlay.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
}
