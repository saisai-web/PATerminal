// ============================================================
// アーカイブしたセッションの保持期限
// ============================================================

/** アーカイブへ移してから自動削除するまでの期間。 */
export const ARCHIVED_WORKSPACE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/** 旧保存データや手編集された値を、安全に現在時刻へ移行する。未来の日時も、
    時計を戻したあとに60日を超えて残り続けないよう現在時刻へ丸める。 */
export function normalizeArchivedAt(value: unknown, now: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : now;
}

export function isArchivedWorkspaceExpired(archivedAt: number, now: number): boolean {
  return now - archivedAt >= ARCHIVED_WORKSPACE_RETENTION_MS;
}
