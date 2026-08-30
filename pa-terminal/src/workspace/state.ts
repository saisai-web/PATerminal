// ============================================================
// 状態
// ここに置くのは「複数のモジュールが横断して読む状態」だけ。
// 機能ごとの状態（お気に入り・テーマ・通知 ON/OFF など）は、その機能の
// モジュールが所有して accessor を export する（getQuickPhrases() 等と同じ流儀）。
// ============================================================

import type { Pane } from "../terminal/pane";
import type { Workspace, WorkspaceGroup } from "./types";

export const workspaces: Workspace[] = []; // サイドバーの表示順
export const groups: WorkspaceGroup[] = []; // グループの表示順（親ごとに配列順を維持）
export const panes = new Map<string, Pane>(); // 全セッション横断の逆引き（pty:exit 用）
/** 折りたたみ中の WorkspaceGroup.id。保存形式 v4 に含めて再起動後も維持する */
export const collapsedGroups = new Set<string>();
/** サイドバーで複数選択中のセッション ID。表示中（アクティブ）セッションとは独立した
    「まとめて操作する対象」で、保存はしない（起動時は常に空） */
export const selectedWsIds = new Set<string>();

let activeWs: Workspace | null = null;
let appFocused = document.hasFocus(); // 通知ゲート用（フォーカス中のアクティブ ws には通知しない）
let hostOs = "macos"; // boot() で host_os の結果を入れる
let focusedId: string | null = null;
/** Shift 範囲選択の起点セッション ID */
let selectionAnchor: string | null = null;

export function getActiveWs(): Workspace | null {
  return activeWs;
}

export function setActiveWs(ws: Workspace | null) {
  activeWs = ws;
}

export function isAppFocused(): boolean {
  return appFocused;
}

export function setAppFocused(v: boolean) {
  appFocused = v;
}

export function getHostOs(): string {
  return hostOs;
}

export function setHostOs(os: string) {
  hostOs = os;
}

export function getFocusedId(): string | null {
  return focusedId;
}

export function setFocusedId(id: string | null) {
  focusedId = id;
}

export function getSelectionAnchor(): string | null {
  return selectionAnchor;
}

export function setSelectionAnchor(id: string | null) {
  selectionAnchor = id;
}
