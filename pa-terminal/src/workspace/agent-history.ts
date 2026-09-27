// ============================================================
// セッションごとの AI エージェント会話の記録（入力履歴ダイアログの索引）
//
// PaneSpec.agent は「いま動いている会話」だけを持ち、エージェントが終わると
// 消える。入力履歴はそのセッションで過去に行われた会話も対象にするため、
// 解決できた会話 ID をワークスペース単位で時系列に貯めて session.json へ保存する。
// 本文は保存しない（CLI 自身の保存ファイルから都度読む = features/history/prompt-history.ts）。
// ============================================================

import type { AgentConversationRef, SerializedNode, Workspace } from "./types";

/** 1セッションあたりの記録上限（古いものから捨てる。Rust 側 MAX_REFS と揃える） */
export const AGENT_HISTORY_MAX = 64;

const KINDS = new Set(["claude", "codex"]);
/** features/agents/agents.ts の isValidSessionId と同じ形式 */
const SESSION_ID_RE = /^(?=.*[0-9a-fA-F])[0-9a-fA-F-]{8,64}$/;

function isRef(value: unknown): value is AgentConversationRef {
  const ref = value as AgentConversationRef | null;
  return (
    !!ref &&
    typeof ref.kind === "string" &&
    KINDS.has(ref.kind) &&
    typeof ref.sessionId === "string" &&
    SESSION_ID_RE.test(ref.sessionId) &&
    Number.isFinite(ref.seenAt)
  );
}

/** 保存データ（手編集の可能性あり）を検証し、重複と上限を整える */
export function normalizeAgentHistory(value: unknown): AgentConversationRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: AgentConversationRef[] = [];
  for (const item of value) {
    if (!isRef(item)) continue;
    const key = `${item.kind}:${item.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: item.kind, sessionId: item.sessionId, seenAt: item.seenAt });
  }
  return out.length ? out.slice(-AGENT_HISTORY_MAX) : undefined;
}

/** 会話を記録する。新しく足したときだけ true（呼び出し側が保存を予約する） */
export function rememberAgentConversation(
  ws: Workspace,
  kind: string,
  sessionId: string,
  seenAt = Date.now(),
): boolean {
  const ref = { kind, sessionId, seenAt };
  if (!isRef(ref)) return false;
  const list = (ws.agentHistory ??= []);
  if (list.some((r) => r.kind === kind && r.sessionId === sessionId)) return false;
  list.push(ref);
  if (list.length > AGENT_HISTORY_MAX) list.splice(0, list.length - AGENT_HISTORY_MAX);
  return true;
}

/** 記録機能より前の保存データでも、ペインに残る再開情報から索引を補う */
export function seedAgentHistory(ws: Workspace, node: SerializedNode, seenAt: number): void {
  if (node.kind === "leaf") {
    const agent = node.agent;
    if (agent?.sessionId) rememberAgentConversation(ws, agent.kind, agent.sessionId, seenAt);
    return;
  }
  seedAgentHistory(ws, node.a, seenAt);
  seedAgentHistory(ws, node.b, seenAt);
}
