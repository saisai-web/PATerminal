/** サイドバー表示を崩さず、session.json の肥大化も防ぐ上限。 */
export const WORKSPACE_NOTE_MAX_LENGTH = 120;

/**
 * 保存データを含む外部入力をセッションメモへ正規化する。
 * 改行は LF に揃えて保持し、各行の連続する空白だけを従来どおり1つへまとめる。
 */
export function normalizeWorkspaceNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const note = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim()
    .slice(0, WORKSPACE_NOTE_MAX_LENGTH)
    .trim();
  return note || undefined;
}
