// ============================================================
// メモ欄の自動入力（入力履歴の最初の入力をメモにする）
//
// メモが空で、まだ一度もメモを触っていないセッションに限り、入力履歴
// （Workspace.agentHistory の古い会話から順）で最初に見つかった通常の入力を
// メモへ入れる。一度入れた・ユーザーが編集した（空へ消した場合も含む）セッションは
// Workspace.noteTouched が立ち、以後は自動入力しない。
//
// 本文は入力履歴ダイアログと同じ agent_session_prompts で読む。1会話ずつ直列に
// 読み、並列 invoke を作らない。起動直後の1巡と、エージェント検知
// （features/agents/watch.ts）の契機でだけ動く（独自のポーリングは持たない）。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { isLocked } from "../license/license";
import { isNoteEditing } from "../sidebar/session-note";
import { renderSidebar } from "../sidebar/sidebar";
import { WORKSPACE_NOTE_MAX_LENGTH } from "../../workspace/note";
import { workspaces } from "../../workspace/state";
import type { AgentConversationRef, Workspace } from "../../workspace/types";
import { updateWorkspaceNote } from "../../workspace/workspace";

type ConversationPrompts = {
  kind: string;
  id: string;
  found: boolean;
  prompts: { text: string; command: boolean }[];
};

/** 実行中エージェントの検知は5秒ごと。同じセッションの読み直しはこれ以上空ける */
const RETRY_MS = 15_000;
/** 起動直後の復元・再開コマンドの入力と重ならないよう、初回の1巡を遅らせる */
const BOOT_DELAY_MS = 3_000;

/** 入力が無いと確定した会話（"kind:id"）。以後は読まない */
const exhausted = new Set<string>();
/** wsId → 最後に読みに行った時刻 */
const lastTryAt = new Map<string, number>();
/** 読む順番待ちのセッション */
const queue: string[] = [];
let draining = false;

const refKey = (kind: string, id: string) => `${kind}:${id}`;

function eligible(ws: Workspace): boolean {
  return !ws.note && !ws.noteTouched && !!ws.agentHistory?.length && workspaces.includes(ws);
}

/** 起動後の1巡。保存済みの履歴があるのにメモが空のセッションを埋める */
export function initAutoNote(): void {
  window.setTimeout(() => {
    for (const ws of workspaces) requestAutoNote(ws, true);
  }, BOOT_DELAY_MS);
}

/**
 * セッションのメモ自動入力を予約する。
 * immediate=false（検知スイープからの呼び出し）は RETRY_MS で間引く
 */
export function requestAutoNote(ws: Workspace, immediate = false): void {
  if (!eligible(ws) || queue.includes(ws.id)) return;
  const now = Date.now();
  if (!immediate && now - (lastTryAt.get(ws.id) ?? 0) < RETRY_MS) return;
  lastTryAt.set(ws.id, now);
  queue.push(ws.id);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const ws = workspaces.find((w) => w.id === queue[0]);
      queue.shift();
      if (ws) await fill(ws);
    }
  } finally {
    draining = false;
  }
}

/** 実行中の会話は、まだ最初の入力が書かれていないだけかもしれない */
function liveConversations(ws: Workspace): Set<string> {
  const keys = new Set<string>();
  for (const pane of ws.panes.values()) {
    const agent = pane.spec.agent;
    if (pane.alive && agent?.sessionId) keys.add(refKey(agent.kind, agent.sessionId));
  }
  return keys;
}

async function fill(ws: Workspace): Promise<void> {
  const live = liveConversations(ws);
  const refs: AgentConversationRef[] = (ws.agentHistory ?? []).filter(
    (r) => !exhausted.has(refKey(r.kind, r.sessionId)),
  );
  for (const ref of refs) {
    if (isLocked() || !eligible(ws)) return;
    let got: ConversationPrompts[];
    try {
      got = await invoke<ConversationPrompts[]>("agent_session_prompts", {
        refs: [{ kind: ref.kind, id: ref.sessionId }],
      });
    } catch {
      return; // 旧バイナリ等。次の契機で再試行する
    }
    const conv = Array.isArray(got) ? got[0] : undefined;
    const text = firstPrompt(conv);
    if (text) {
      // await 中にユーザーがメモを書いた・編集を始めた場合は上書きしない
      if (isLocked() || !eligible(ws) || isNoteEditing()) return;
      updateWorkspaceNote(ws, text);
      renderSidebar();
      return;
    }
    const key = refKey(ref.kind, ref.sessionId);
    // 実行中の会話は後から入力が書かれるので、この会話で止めて次の契機を待つ
    if (live.has(key)) return;
    exhausted.add(key);
  }
}

/** スラッシュコマンドを除いた最初の入力を、メモ欄に収まる1行へ */
function firstPrompt(conv: ConversationPrompts | undefined): string | null {
  const prompts = conv && Array.isArray(conv.prompts) ? conv.prompts : [];
  for (const prompt of prompts) {
    if (prompt.command || typeof prompt.text !== "string") continue;
    const line = prompt.text.replace(/\s+/g, " ").trim();
    if (!line) continue;
    return line.length > WORKSPACE_NOTE_MAX_LENGTH
      ? `${line.slice(0, WORKSPACE_NOTE_MAX_LENGTH - 1).trimEnd()}…`
      : line;
  }
  return null;
}
