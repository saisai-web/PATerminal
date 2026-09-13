import { t } from "../../i18n";
import { workspaces } from "../../workspace/state";
import { displayedWorkspaces, type ViewDropEdge } from "../../workspace/view";
import type { Workspace } from "../../workspace/types";

type Drop = { target: Workspace; added: Workspace[]; edge: ViewDropEdge };

export function initSessionViewDrop(deps: {
  dragged: () => Workspace[];
  add: (drop: Drop) => void;
}) {
  const grid = document.querySelector<HTMLDivElement>("#grid")!;
  const preview = document.createElement("div");
  preview.id = "session-view-drop-preview";
  preview.hidden = true;
  preview.setAttribute("role", "status");
  grid.append(preview);

  function destination(e: DragEvent): Drop | null {
    // Only accept live sidebar session drags, never external text, files, or group drags.
    const visible = displayedWorkspaces();
    const added = deps.dragged().filter((w) => workspaces.includes(w) && !visible.includes(w));
    if (!added.length) return null;
    const el = e.target instanceof Element ? e.target.closest(".workspace-layer") : null;
    const target = visible.find((w) => w.layer === el);
    if (!target) return null;
    const rect = target.layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    let edge: ViewDropEdge = "right"; // Dropping in the center adds beside the existing session.
    if (x < 0.25 || x > 0.75 || y < 0.25 || y > 0.75) {
      const distances: Array<[ViewDropEdge, number]> = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
      edge = distances.sort((a, b) => a[1] - b[1])[0][0];
    }
    return { target, added, edge };
  }

  const clear = () => { preview.hidden = true; };
  grid.addEventListener("dragover", (e) => {
    const drop = destination(e);
    if (!drop) {
      clear();
      if (deps.dragged().length) {
        e.preventDefault(); e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = drop.target.layer.getBoundingClientRect(), g = grid.getBoundingClientRect();
    const horizontal = drop.edge === "left" || drop.edge === "right";
    const width = horizontal ? r.width / 2 : r.width;
    const height = horizontal ? r.height : r.height / 2;
    Object.assign(preview.style, {
      left: `${r.left - g.left + (drop.edge === "right" ? width : 0)}px`,
      top: `${r.top - g.top + (drop.edge === "bottom" ? height : 0)}px`,
      width: `${width}px`, height: `${height}px`,
    });
    preview.dataset.edge = drop.edge;
    const arrow = { left: "←", right: "→", top: "↑", bottom: "↓" }[drop.edge];
    preview.textContent = `${arrow} ${t("view.show")} · ${drop.added.map((w) => w.name).join(", ")}`;
    preview.hidden = false;
  }, true);
  grid.addEventListener("dragleave", (e) => {
    if (!(e.relatedTarget instanceof Node) || !grid.contains(e.relatedTarget)) clear();
  });
  grid.addEventListener("drop", (e) => {
    const drop = destination(e);
    clear();
    if (deps.dragged().length) { e.preventDefault(); e.stopPropagation(); }
    if (!drop) return;
    // Let the sidebar finish dragend cleanup before its DOM is rebuilt by setActive.
    window.setTimeout(() => deps.add(drop), 0);
  }, true);
  window.addEventListener("dragend", clear, true);
  window.addEventListener("blur", clear);
}
