// ============================================================
// OS（Finder / Explorer）からのファイルドロップをターミナルへのパス入力にする
// ネイティブ側（src-tauri/src/system/drop.rs）が、ファイルパスを持つドラッグだけを
// 横取りして `filedrop:drag` / `filedrop:drop` を送ってくる。座標は WebView 左上原点の
// CSS px なので、そのまま elementFromPoint で落とし先のペインを決める。
// 入力の形（引用・空白区切り・末尾の空白）は path-attachments.ts の添付ボタンと同じ。
// ============================================================

import { listen } from "@tauri-apps/api/event";
import { quotePathFor } from "../explorer/paths";
import { broadcastWrite, setFocused } from "../../terminal/focus";
import type { Pane } from "../../terminal/pane";
import { getFocusedId, panes } from "../../workspace/state";

type DragPayload = { kind: "enter" | "over" | "leave"; x: number; y: number };
type DropPayload = { paths: string[]; x: number; y: number };

const DROP_TARGET_CLASS = "is-drop-target";
let hovered: Pane | null = null;

/** 座標直下の表示中ペイン。非表示セッションのレイヤは display:none なので当たらない */
function paneAt(x: number, y: number): Pane | undefined {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pane");
  const id = el?.dataset.paneId;
  return id ? panes.get(id) : undefined;
}

function setHovered(pane: Pane | null): void {
  if (hovered === pane) return;
  hovered?.el.classList.remove(DROP_TARGET_CLASS);
  hovered = pane;
  hovered?.el.classList.add(DROP_TARGET_CLASS);
}

function dropPaths({ paths, x, y }: DropPayload): void {
  setHovered(null);
  const pane = paneAt(x, y);
  if (!pane || !paths.length || !pane.alive) return;
  // ドロップは mousedown を生まないので、落とし先を自分でフォーカスする
  if (getFocusedId() !== pane.id) setFocused(pane.id);
  // macOS の Terminal と同じく、次の入力を続けられる空白を末尾に置く。
  // xterm の入力経路（term.input / paste）は通さず PTY へ直接書く。
  const data = `${paths.map((path) => quotePathFor(pane, path)).join(" ")} `;
  if (pane.ws.broadcast) broadcastWrite(pane.ws, data);
  else pane.write(data);
  pane.focus();
}

export function initDropPaths(): void {
  void listen<DragPayload>("filedrop:drag", (e) => {
    const { kind, x, y } = e.payload;
    setHovered(kind === "leave" ? null : (paneAt(x, y) ?? null));
  });
  void listen<DropPayload>("filedrop:drop", (e) => dropPaths(e.payload));
}
