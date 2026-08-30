/** サイドバーの一行表示を崩さず、session.json の肥大化も防ぐ上限。 */
export const WORKSPACE_NOTE_MAX_LENGTH = 120;

/** 保存データを含む外部入力を、一行のセッションメモへ正規化する。 */
export function normalizeWorkspaceNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const note = value.replace(/\s+/g, " ").trim().slice(0, WORKSPACE_NOTE_MAX_LENGTH).trim();
  return note || undefined;
}
