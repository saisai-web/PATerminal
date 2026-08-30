// ============================================================
// レイアウト（絶対配置 + 永続ディバイダ）
// ============================================================

import { DIVIDER, MAX_RATIO, MIN_RATIO } from "../shared/constants";
import { scheduleSave } from "../app/session";
import { getActiveWs } from "../workspace/state";
import type { SplitNode, TreeNode } from "./tree";
import type { Rect, Workspace } from "../workspace/types";

let rafId = 0;

/** ドラッグ中の place を rAF 1本にまとめるためのハンドル。
    サイドバー / エクスプローラーのリサイズも同じ枠を使う */
export function getRafId(): number {
  return rafId;
}

export function setRafId(id: number) {
  rafId = id;
}

// ディバイダ要素はドラッグ中に作り直すとポインタキャプチャが切れて
// pointerup を取りこぼし、body.dragging が残留して全ペインが
// pointer-events: none のまま操作不能になる。split ノードごとに
// 要素を使い回し、レイアウトでは位置だけ更新する。
export const dividerEls = new Map<SplitNode, HTMLDivElement>();
/** ドラッグ計算用: 各 split が占める矩形の最新値 */
export const splitRects = new Map<SplitNode, Rect>();

export function layout(ws: Workspace | null = getActiveWs()) {
  if (!ws) return;
  // 1ペインだけのときは閉じるボタンを隠す（最後の1枚は閉じられない）
  ws.layer.classList.toggle("single-pane", ws.root?.kind === "leaf");
  const r = ws.layer.getBoundingClientRect();
  const live = new Set<SplitNode>();
  if (ws.root) place(ws, ws.root, { x: 0, y: 0, w: r.width, h: r.height }, live);
  // このワークスペースのツリーから消えた split のディバイダを回収
  for (const [split, el] of [...dividerEls]) {
    if (el.parentElement === ws.layer && !live.has(split)) {
      el.remove();
      dividerEls.delete(split);
      splitRects.delete(split);
    }
  }
  for (const pane of ws.panes.values()) pane.refit();
}

/** ウィンドウのドラッグリサイズ用。ディバイダのドラッグと同じ考え方で、
    進行中は rAF で矩形だけ追従させ、止まってから1回だけ refit する。
    resize イベントには「終わり」が無いのでトレーリングのタイマーで確定を判断する。
    毎イベントで refit すると xterm が folding を繰り返し、TUI には SIGWINCH が
    連射される（TUI が欲しいのは落ち着いた1回だけ）。 */
let layoutTimer = 0;
export function scheduleLayout(ws: Workspace | null = getActiveWs()) {
  if (!ws) return;
  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!ws.root) return;
      const r = ws.layer.getBoundingClientRect();
      place(ws, ws.root, { x: 0, y: 0, w: r.width, h: r.height });
    });
  }
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => {
    layoutTimer = 0;
    layout(ws);
  }, LAYOUT_SETTLE_MS);
}

const LAYOUT_SETTLE_MS = 120;

export function place(ws: Workspace, node: TreeNode, rect: Rect, live?: Set<SplitNode>) {
  if (node.kind === "leaf") {
    node.pane.setRect(rect);
    return;
  }
  live?.add(node);
  splitRects.set(node, rect);
  if (node.dir === "row") {
    const aw = Math.round((rect.w - DIVIDER) * node.ratio);
    place(ws, node.a, { ...rect, w: aw }, live);
    placeDivider(ws, node, { x: rect.x + aw, y: rect.y, w: DIVIDER, h: rect.h });
    place(ws, node.b, { x: rect.x + aw + DIVIDER, y: rect.y, w: rect.w - aw - DIVIDER, h: rect.h }, live);
  } else {
    const ah = Math.round((rect.h - DIVIDER) * node.ratio);
    place(ws, node.a, { ...rect, h: ah }, live);
    placeDivider(ws, node, { x: rect.x, y: rect.y + ah, w: rect.w, h: DIVIDER });
    place(ws, node.b, { x: rect.x, y: rect.y + ah + DIVIDER, w: rect.w, h: rect.h - ah - DIVIDER }, live);
  }
}

function placeDivider(ws: Workspace, split: SplitNode, rect: Rect) {
  let el = dividerEls.get(split);
  if (!el) {
    el = createDivider(ws, split);
    dividerEls.set(split, el);
    ws.layer.append(el);
  }
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
}

function createDivider(ws: Workspace, split: SplitNode): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `divider dir-${split.dir}`;

  el.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    try {
      el.setPointerCapture(down.pointerId);
    } catch {
      /* キャプチャ不可でも move は el に届く範囲で動く */
    }
    el.classList.add("is-dragging");
    document.body.classList.add("dragging");
    const layerRect = ws.layer.getBoundingClientRect();

    const move = (ev: PointerEvent) => {
      const container = splitRects.get(split);
      if (!container) return;
      const pos =
        split.dir === "row"
          ? ev.clientX - layerRect.left - container.x
          : ev.clientY - layerRect.top - container.y;
      const size = split.dir === "row" ? container.w : container.h;
      split.ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, pos / size));
      // ドラッグ中は矩形の更新だけ rAF で回す（refit は確定時にまとめて）
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (!ws.root) return;
          const r = ws.layer.getBoundingClientRect();
          place(ws, ws.root, { x: 0, y: 0, w: r.width, h: r.height });
        });
      }
    };
    const finish = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      el.removeEventListener("lostpointercapture", finish);
      el.classList.remove("is-dragging");
      document.body.classList.remove("dragging");
      layout(ws); // 確定時に refit まで含めてやり直す
      scheduleSave();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("lostpointercapture", finish);
  });

  return el;
}
