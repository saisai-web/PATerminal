// ============================================================
// フォーカス / ブロードキャスト
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { updateWsActivity } from "../app/activity";
import { updateGitWatch } from "../features/git/agent-panel";
import { explorerFollow, focusedCwd, renderExplorerFavs } from "../features/explorer/explorer";
import { scheduleSave } from "../app/session";
import { requireFeature } from "../features/license/license";
import { getActiveWs, setFocusedId, workspaces } from "../workspace/state";
import type { Workspace } from "../workspace/types";
import { setActive } from "../workspace/workspace";

/** ブロードキャスト入力の直列化キュー（pty_write と同じ理由） */
let broadcastChain: Promise<void> = Promise.resolve();
const paneActions = document.querySelector<HTMLDivElement>("#pane-actions")!;

/** 送信対象のセッション。起点セッションは常に含み、`broadcastTargets` で指定された
    追加セッションを **workspaces 配列を走査して**足す（閉じられた ID はここで落ちる
    ので、セッション終了時に集合を掃除する必要が無い）。 */
export function broadcastWorkspaces(ws: Workspace): Workspace[] {
  // 自動Enter は一斉入力 OFF でも broadcastWrite を通るので、送信先はここでも明示的に
  // 「一斉入力中だけ効く」ことにする（自動Enter はセッション内に閉じたまま）
  if (!ws.broadcast || !ws.broadcastTargets.size) return [ws];
  const list = [ws];
  for (const w of workspaces) {
    if (w !== ws && ws.broadcastTargets.has(w.id)) list.push(w);
  }
  return list;
}

/** 起点セッション + 選ばれた送信先セッションの全ペインへ流す。**非表示セッションの
    ペインへ書いても問題ない**（PTY への書き込みで、出力は Rust 側にバッファされて
    表示時にまとめて流れる）。write() と同じ理由でキーイベントのハンドラから
    タスクを分けて送る。1回の IPC にまとめる（ルール3/5）。 */
export function broadcastWrite(ws: Workspace, data: string, marksActivity = true) {
  const targets = broadcastWorkspaces(ws);
  const ids: string[] = [];
  for (const w of targets) {
    for (const [id, pane] of w.panes) {
      ids.push(id);
      if (!marksActivity) continue;
      pane.activityEngaged = true;
      pane.activityReady = true;
      pane.busy = true;
    }
    if (marksActivity) updateWsActivity(w);
  }
  window.setTimeout(() => {
    broadcastChain = broadcastChain.then(async () => {
      try {
        await invoke("pty_broadcast", { ids, data });
      } catch (e) {
        console.error("pty_broadcast failed:", e);
      }
    });
  }, 0);
}

export function setFocused(id: string) {
  setFocusedId(id);
  const activeWs = getActiveWs();
  if (!activeWs) return;
  for (const [pid, pane] of activeWs.panes) {
    pane.el.classList.toggle("is-focused", pid === id);
  }
  const focusedPane = activeWs.panes.get(id);
  if (focusedPane) {
    const bar = focusedPane.el.querySelector<HTMLDivElement>(".pane-bar");
    if (bar) {
      if (paneActions.parentElement !== bar) {
        const close = bar.querySelector<HTMLButtonElement>(".pane-close");
        if (close) bar.insertBefore(paneActions, close);
        else bar.append(paneActions);
      }
      paneActions.hidden = false;
    }
    focusedPane.focus();
  }
  renderExplorerFavs(); // 「セッションの現在地」ピンをフォーカス先の cwd に追従させる
  updateGitWatch(); // 変更ストリップの監視先もフォーカス先に即追従（定期ポーリングを待たない）
  // エクスプローラーもフォーカス先の cwd へ。既知なら即時、実 cwd は updateGitWatch
  // 経由の pty_cwd（resolveWatchCwd）が追って補正する
  const c = focusedCwd();
  if (c) explorerFollow(c);
}

/** 一斉入力を開始する。targetIds は自セッション以外の送信先（空ならセッション内で閉じる）。
    送信先はランタイム専用で保存しない（session.json には broadcast フラグだけが残る）。 */
export function startBroadcast(ws: Workspace, targetIds: Iterable<string> = []) {
  // ソフトロック対象（モーダル経由・ショートカット経由の両方がここを通る）。
  // 停止側（stopBroadcast）はゲートしない: Locked でも必ず止められる
  if (!requireFeature()) return;
  ws.broadcastTargets = new Set([...targetIds].filter((id) => id !== ws.id));
  ws.broadcast = true;
  setActive(ws); // 表示反映を setActive に一元化
  scheduleSave();
}

export function stopBroadcast(ws: Workspace) {
  ws.broadcastTargets.clear();
  ws.broadcast = false;
  setActive(ws);
  scheduleSave();
}

/** Cmd/Ctrl+Shift+B。モーダルを開かずに即 ON/OFF する（ON はセッション内のみ）。 */
export function toggleBroadcast() {
  const activeWs = getActiveWs();
  if (!activeWs) return;
  if (activeWs.broadcast) stopBroadcast(activeWs);
  else startBroadcast(activeWs);
}
