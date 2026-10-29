// ============================================================
// OS（Finder / Explorer）からのファイルドロップをターミナルへのパス入力にする
// ネイティブ側（src-tauri/src/system/drop.rs）が、ファイルパスを持つドラッグだけを
// 横取りして `filedrop:drag` / `filedrop:drop` を送ってくる。座標は WebView 左上原点の
// CSS px なので、そのまま elementFromPoint で落とし先のペインを決める。
// パスをシェル向けに引用し、空白区切り・末尾の空白付きで入力する。
// Windows の WebView2 はネイティブの差し替えが効かず HTML5 の drop として届くので、
// File を chrome.webview.postMessageWithAdditionalObjects でネイティブへ送り、
// パスに直した `filedrop:drop` を受け取る（ホバー表示は dragover から直接出す）。
// 開いているフォルダーブラウザー（features/agents/path-bar.ts）の上ではペインより先に
// そちらへ渡し、ブラウザーがフォルダーへのコピーとして受け取る。
// ============================================================

import { listen } from "@tauri-apps/api/event";
import { quotePathFor } from "../explorer/paths";
import { broadcastWrite, setFocused } from "../../terminal/focus";
import type { Pane } from "../../terminal/pane";
import { getFocusedId, panes } from "../../workspace/state";

type DragPayload = { kind: "enter" | "over" | "leave"; x: number; y: number };
type DropPayload = { paths: string[]; x: number; y: number };

/** ペインより優先する落とし先。座標が自分の上なら true を返して受け取る */
export type FileDropZone = {
  /** null はドラッグが離れた / 終わった */
  hover: (point: { x: number; y: number } | null) => boolean;
  drop: (paths: string[], x: number, y: number) => boolean;
};

const DROP_TARGET_CLASS = "is-drop-target";
let hovered: Pane | null = null;
let zone: FileDropZone | null = null;

/** 開いている間だけ登録する。戻り値で解除（後から登録されたものが残っていれば触らない） */
export function setFileDropZone(next: FileDropZone): () => void {
  zone?.hover(null);
  zone = next;
  return () => {
    if (zone !== next) return;
    next.hover(null);
    zone = null;
  };
}

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
  if (zone?.drop(paths, x, y)) return;
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

function hoverAt({ kind, x, y }: DragPayload): void {
  if (zone?.hover(kind === "leave" ? null : { x, y })) setHovered(null);
  else setHovered(kind === "leave" ? null : (paneAt(x, y) ?? null));
}

type WebView2 = {
  postMessageWithAdditionalObjects?: (message: unknown, objects: FileList) => void;
};

/** WebView2 だけが持つ。ほかの WebView では undefined */
function webView2(): WebView2 | undefined {
  return (window as { chrome?: { webview?: WebView2 } }).chrome?.webview;
}

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes("Files");
}

/** WebView2 で HTML5 として届く OS からのファイルドロップを受ける */
function initWebView2Drop(webview: Required<WebView2>): void {
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    hoverAt({ kind: "over", x: e.clientX, y: e.clientY });
  });
  window.addEventListener("dragleave", (e) => {
    if (hasFiles(e) && !e.relatedTarget) hoverAt({ kind: "leave", x: 0, y: 0 });
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hoverAt({ kind: "leave", x: 0, y: 0 });
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    webview.postMessageWithAdditionalObjects({ type: "filedrop", x: e.clientX, y: e.clientY }, files);
  });
}

export function initDropPaths(): void {
  void listen<DragPayload>("filedrop:drag", (e) => hoverAt(e.payload));
  void listen<DropPayload>("filedrop:drop", (e) => dropPaths(e.payload));
  const webview = webView2();
  if (webview?.postMessageWithAdditionalObjects) initWebView2Drop(webview as Required<WebView2>);
}
