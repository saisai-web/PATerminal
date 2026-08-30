// ============================================================
// AI エージェント（claude / codex）の再開コマンド表
//
// Rust 側の検知（pty_agents = pty/agent.rs の AGENT_NAMES）と対で、
// ここにあるエージェントだけが「復元時の自動再開」「終了バナー」の対象になる。
// エージェントを追加するときは両方へ1行ずつ足す。
// ============================================================

import type { PaneAgentInfo } from "../../workspace/types";

/** セッション ID はシェルへ入力するコマンドの一部になるため、
    uuid 系の形式（16進 + ハイフン）を通ったものしか使わない
    （Rust 側 agents/mod.rs の valid_session_id と同じ制約） */
const SESSION_ID_RE = /^(?=.*[0-9a-fA-F])[0-9a-fA-F-]{8,64}$/;

const RESUME_COMMANDS: Record<string, (sessionId?: string) => string> = {
  // claude: --resume <id> で特定の会話、--continue はその cwd の最後の会話
  claude: (id) => (id ? `claude --resume ${id}` : "claude --continue"),
  // codex: resume <id> で特定の会話、resume --last は最後の会話
  codex: (id) => (id ? `codex resume ${id}` : "codex resume --last"),
};

export function isKnownAgent(kind: unknown): kind is string {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(RESUME_COMMANDS, kind);
}

/** シェルへ入力しても安全な形式のセッション ID か（引き継ぎピッカーは
    ID 無しの退化で別の会話を掴まないよう、これを通らない項目ごと落とす） */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

/** 保存データ（手編集の可能性あり）から安全な再開コマンドを組み立てる。
    未知のエージェント・不正な ID は null / ID 無し扱いに落とす */
export function resumeCommandFor(agent: PaneAgentInfo | undefined): string | null {
  if (!agent || !isKnownAgent(agent.kind)) return null;
  const id = isValidSessionId(agent.sessionId) ? agent.sessionId : undefined;
  return RESUME_COMMANDS[agent.kind](id);
}
