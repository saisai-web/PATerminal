import { t } from "../i18n";
import { DIVIDER, MIN_RATIO, MAX_RATIO } from "../shared/constants";
import { scheduleSave } from "../app/session";
import { getActiveWs, workspaces } from "../workspace/state";
import { getActiveWorkspaceView, workspaceViewColor, type WorkspaceViewNode } from "../workspace/view";
import type { Rect, Workspace } from "../workspace/types";

type Split = Extract<WorkspaceViewNode, { kind: "split" }>;
type Actions = {
  activate: (ws: Workspace) => void;
  solo: (ws: Workspace) => void;
  remove: (ws: Workspace) => void;
  place: () => void;
  layout: () => void;
};
let actions: Actions;
export function initWorkspaceLayout(a: Actions) { actions = a; }
const grid = document.querySelector<HTMLDivElement>("#grid")!;
const dividers = new Map<Split, HTMLDivElement>();
const rects = new Map<Split, Rect>();
const headers = new Map<Workspace, HTMLDivElement>();
export const WORKSPACE_HEADER_HEIGHT = 28;

function position(el: HTMLElement, r: Rect) {
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

/** Positions the session layers only; callers place pane trees before refitting. */
export function placeWorkspaceLayers() {
  const view = getActiveWorkspaceView();
  const live = new Set<Split>();
  grid.classList.toggle("multi-session", !!view);
  for (const [ws, header] of headers) {
    if (!view || ws.layer.hidden || !workspaces.includes(ws)) {
      header.remove(); headers.delete(ws);
    }
  }
  for (const ws of workspaces) {
    const color = workspaceViewColor(ws.id);
    if (color) ws.layer.style.setProperty("--session-color", color);
    else ws.layer.style.removeProperty("--session-color");
    if (!view) {
      ws.layer.style.left = ws.layer.style.top = ws.layer.style.width = ws.layer.style.height = "";
    }
    ws.layer.classList.toggle("is-active-workspace", ws === getActiveWs());
  }
  function place(node: WorkspaceViewNode, r: Rect) {
    if (node.kind === "leaf") {
      const ws = workspaces.find((w) => w.id === node.workspaceId);
      if (!ws) return;
      position(ws.layer, r);
      let header = headers.get(ws);
      if (!header) {
        header = document.createElement("div");
        header.className = "workspace-view-header";
        const name = document.createElement("button");
        name.className = "workspace-view-name";
        name.onclick = () => actions.activate(ws);
        const solo = document.createElement("button");
        solo.className = "workspace-view-solo";
        solo.textContent = "⛶";
        solo.onclick = () => actions.solo(ws);
        const remove = document.createElement("button");
        remove.className = "workspace-view-remove";
        remove.textContent = "×";
        remove.onclick = () => actions.remove(ws);
        header.append(name, solo, remove);
        ws.layer.append(header);
        headers.set(ws, header);
      }
      const [name, solo, remove] = [...header.children] as HTMLButtonElement[];
      name.textContent = ws.name;
      name.title = ws.name;
      name.setAttribute("aria-pressed", String(ws === getActiveWs()));
      for (const [button, key] of [[solo, "view.solo"], [remove, "view.remove"]] as const) {
        button.dataset.i18nTitle = button.dataset.i18nAriaLabel = key;
        button.title = t(key); button.setAttribute("aria-label", t(key));
      }
      return;
    }
    live.add(node); rects.set(node, r);
    let el = dividers.get(node);
    if (!el) {
      el = createDivider(node);
      dividers.set(node, el); grid.append(el);
    }
    const size = Math.max(0, (node.dir === "row" ? r.w : r.h) - DIVIDER);
    const a = Math.round(size * node.ratio);
    if (node.dir === "row") {
      place(node.a, { ...r, w: a });
      position(el, { x: r.x + a, y: r.y, w: DIVIDER, h: r.h });
      place(node.b, { ...r, x: r.x + a + DIVIDER, w: size - a });
    } else {
      place(node.a, { ...r, h: a });
      position(el, { x: r.x, y: r.y + a, w: r.w, h: DIVIDER });
      place(node.b, { ...r, y: r.y + a + DIVIDER, h: size - a });
    }
    el.setAttribute("aria-valuenow", String(Math.round(node.ratio * 100)));
    el.setAttribute("aria-label", t("view.resize"));
  }
  if (view) place(view.root, { x: 0, y: 0, w: grid.clientWidth, h: grid.clientHeight });
  for (const [split, el] of dividers) {
    if (!live.has(split)) { el.remove(); dividers.delete(split); rects.delete(split); }
  }
}

function createDivider(split: Split) {
  const el = document.createElement("div");
  el.className = `divider workspace-divider dir-${split.dir}`;
  el.tabIndex = 0;
  el.setAttribute("role", "separator");
  el.dataset.i18nAriaLabel = "view.resize";
  el.setAttribute("aria-orientation", split.dir === "row" ? "vertical" : "horizontal");
  el.setAttribute("aria-valuemin", String(MIN_RATIO * 100));
  el.setAttribute("aria-valuemax", String(MAX_RATIO * 100));
  el.addEventListener("keydown", (e) => {
    const keys = split.dir === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    split.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, split.ratio + (e.key === keys[0] ? -0.05 : 0.05)));
    actions.layout(); scheduleSave();
  });
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    el.classList.add("is-dragging");
    let raf = 0;
    const move = (e: PointerEvent) => {
      const rect = rects.get(split);
      if (!rect) return;
      const gridRect = grid.getBoundingClientRect();
      const size = (split.dir === "row" ? rect.w : rect.h) - DIVIDER;
      if (size <= 0) return;
      const pos = split.dir === "row" ? e.clientX - gridRect.left - rect.x : e.clientY - gridRect.top - rect.y;
      split.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, pos / size));
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; actions.place(); });
    };
    const finish = () => {
      el.removeEventListener("pointermove", move);
      for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) el.removeEventListener(event, finish);
      cancelAnimationFrame(raf);
      document.body.classList.remove("dragging"); el.classList.remove("is-dragging");
      actions.layout(); scheduleSave();
    };
    el.addEventListener("pointermove", move);
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(event, finish);
  });
  return el;
}
