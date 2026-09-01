// ============================================================
// 新規セッションの「最近使った場所」（セッション作成時の cwd 履歴）
// 場所フライアウト（new-session-location.ts）の一覧に出す。
// session.json の settings.recentDirs に保存するため accessor を export する。
// ============================================================

import { normPath } from "../explorer/paths";

/** 保存・表示する最大件数。フライアウトの一覧が縦に伸びすぎない程度に留める */
export const RECENT_DIRS_MAX = 8;

let recentDirs: string[] = []; // 新しい順・正規化済みの絶対パス

export function getRecentDirs(): string[] {
  return recentDirs;
}

/** session.json からの復元用。文字列以外・重複・超過分だけ落としてそのまま受け入れる */
export function setRecentDirs(list: unknown) {
  const next: string[] = [];
  if (Array.isArray(list)) {
    for (const p of list) {
      if (typeof p !== "string" || !p) continue;
      const n = normPath(p);
      if (next.includes(n)) continue;
      next.push(n);
      if (next.length >= RECENT_DIRS_MAX) break;
    }
  }
  recentDirs = next;
}

/** セッションが cwd 付きで作られるたびに先頭へ記録する（保存は作成側の scheduleSave に相乗り） */
export function recordRecentDir(path: string) {
  const n = normPath(path);
  if (!n) return;
  recentDirs = [n, ...recentDirs.filter((p) => p !== n)].slice(0, RECENT_DIRS_MAX);
}
