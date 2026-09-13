import { MAX_RATIO, MIN_RATIO } from "../shared/constants";
import { getActiveWs, workspaces } from "./state";
import type { Workspace } from "./types";

/** Separate from each session's pane tree: leaves only reference existing sessions. */
export type WorkspaceViewNode =
  | { kind: "leaf"; workspaceId: string; color?: number }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: WorkspaceViewNode; b: WorkspaceViewNode };
export type WorkspaceView = { mode: "grid" | "row" | "col"; root: WorkspaceViewNode };
export type ViewDropEdge = "left" | "right" | "top" | "bottom";

let view: WorkspaceView | undefined;
/** The saved membership and arrangement survive navigation to unrelated sessions. */
export function getWorkspaceView(): WorkspaceView | undefined { return view; }

/** Only members open the saved split view; other sessions use their own full-size layer. */
export function getActiveWorkspaceView(): WorkspaceView | undefined {
  const active = getActiveWs();
  return active && viewLeaf(active.id) ? view : undefined;
}

export function viewIds(node: WorkspaceViewNode | undefined = view?.root): string[] {
  if (!node) return [];
  return node.kind === "leaf" ? [node.workspaceId] : [...viewIds(node.a), ...viewIds(node.b)];
}

function viewLeaf(id: string, node: WorkspaceViewNode | undefined = view?.root): Extract<WorkspaceViewNode, { kind: "leaf" }> | undefined {
  if (!node) return undefined;
  if (node.kind === "leaf") return node.workspaceId === id ? node : undefined;
  return viewLeaf(id, node.a) ?? viewLeaf(id, node.b);
}

/** Shared by sidebar and terminal borders. Slots survive removal and saved-view restoration. */
export function workspaceViewColor(id: string): string | undefined {
  const leaf = viewLeaf(id);
  if (!leaf) return undefined;
  const slot = leaf.color ?? viewIds().indexOf(id);
  const palette = ["blue", "orange", "purple", "green", "red", "yellow"];
  return slot < palette.length ? `var(--ws-color-${palette[slot]})`
    : `color-mix(in srgb, hsl(${(slot * 137.508) % 360} 70% 60%) 80%, var(--text))`;
}

/** Also validates saved data; bad/deleted/duplicate references collapse to their sibling. */
export function restoreWorkspaceView(value: unknown): void {
  const seen = new Set<string>();
  const colors = new Set<number>();
  const valid = new Set(workspaces.filter((w) => !w.archived).map((w) => w.id));
  function read(value: unknown, depth = 0): WorkspaceViewNode | null {
    if (!value || typeof value !== "object" || depth > 32) return null;
    const node = value as Record<string, unknown>;
    if (node.kind === "leaf") {
      const id = node.workspaceId;
      if (typeof id !== "string" || !valid.has(id) || seen.has(id)) return null;
      seen.add(id);
      let color = typeof node.color === "number" && Number.isInteger(node.color) && node.color >= 0 && node.color < 1024
        ? node.color : 0;
      while (colors.has(color)) color++;
      colors.add(color);
      return { kind: "leaf", workspaceId: id, color };
    }
    if (node.kind !== "split" || (node.dir !== "row" && node.dir !== "col")) return null;
    const a = read(node.a, depth + 1), b = read(node.b, depth + 1);
    if (!a || !b) return a ?? b;
    const ratio = typeof node.ratio === "number" && Number.isFinite(node.ratio) ? node.ratio : 0.5;
    return { kind: "split", dir: node.dir, ratio: Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio)), a, b };
  }
  const saved = value as Partial<WorkspaceView> | null;
  const root = read(saved?.root);
  view = root?.kind === "split"
    ? { mode: saved?.mode === "row" || saved?.mode === "col" ? saved.mode : "grid", root }
    : undefined;
}

export function arrangeWorkspaces(ids: string[], mode: WorkspaceView["mode"]): void {
  const unique = [...new Set(ids)].filter((id) => workspaces.some((w) => w.id === id));
  if (unique.length < 2) { view = undefined; return; }
  if (view?.mode === mode && JSON.stringify(viewIds()) === JSON.stringify(unique)) return;
  const colors = new Map(unique.flatMap((id) => {
    const color = viewLeaf(id)?.color;
    return color === undefined ? [] : [[id, color] as const];
  }));
  const used = new Set(colors.values());
  for (const id of unique) {
    if (colors.has(id)) continue;
    let color = 0;
    while (used.has(color)) color++;
    colors.set(id, color); used.add(color);
  }
  function build(ids: string[], dir: "row" | "col"): WorkspaceViewNode {
    if (ids.length === 1) return { kind: "leaf", workspaceId: ids[0], color: colors.get(ids[0]) };
    const mid = Math.ceil(ids.length / 2);
    const next = mode === "grid" ? (dir === "row" ? "col" : "row") : dir;
    return { kind: "split", dir, ratio: mid / ids.length,
      a: build(ids.slice(0, mid), next), b: build(ids.slice(mid), next) };
  }
  view = { mode, root: build(unique, mode === "col" ? "col" : "row") };
}

export function removeWorkspaceFromView(id: string): void {
  function remove(node: WorkspaceViewNode): WorkspaceViewNode | null {
    if (node.kind === "leaf") return node.workspaceId === id ? null : node;
    const a = remove(node.a), b = remove(node.b);
    if (!a || !b) return a ?? b;
    node.a = a; node.b = b;
    return node;
  }
  const root = view && remove(view.root);
  view = view && root?.kind === "split" ? { ...view, root } : undefined;
}

/** Split only the target session's tile; existing pane trees and other view ratios stay intact. */
export function addWorkspacesToView(targetId: string, ids: string[], edge: ViewDropEdge): string[] {
  const current = displayedWorkspaces().map((w) => w.id);
  if (!current.includes(targetId)) return [];
  const added = [...new Set(ids)].filter((id) => !current.includes(id) && workspaces.some((w) => w.id === id));
  if (!added.length) return [];
  const activeView = getActiveWorkspaceView();
  const root: WorkspaceViewNode = activeView?.root ?? { kind: "leaf", workspaceId: targetId, color: 0 };
  const colors = new Set(current.map((id) => activeView ? viewLeaf(id)?.color ?? 0 : 0));
  const leaves: WorkspaceViewNode[] = added.map((workspaceId) => {
    let color = 0;
    while (colors.has(color)) color++;
    colors.add(color);
    return { kind: "leaf", workspaceId, color };
  });
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  function build(nodes: WorkspaceViewNode[]): WorkspaceViewNode {
    if (nodes.length === 1) return nodes[0];
    const mid = Math.ceil(nodes.length / 2);
    return { kind: "split", dir, ratio: mid / nodes.length, a: build(nodes.slice(0, mid)), b: build(nodes.slice(mid)) };
  }
  function insert(node: WorkspaceViewNode): WorkspaceViewNode {
    if (node.kind === "leaf") {
      if (node.workspaceId !== targetId) return node;
      return build(edge === "left" || edge === "top" ? [...leaves, node] : [node, ...leaves]);
    }
    node.a = insert(node.a); node.b = insert(node.b);
    return node;
  }
  view = { mode: "grid", root: insert(root) };
  return added;
}

export function displayedWorkspaces(): Workspace[] {
  if (!getActiveWorkspaceView()) { const active = getActiveWs(); return active ? [active] : []; }
  return viewIds().flatMap((id) => workspaces.find((w) => w.id === id) ?? []);
}
