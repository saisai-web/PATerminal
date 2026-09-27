// ============================================================
// お気に入りフォルダー（expFavorites）
//
// session.json に永続し、ペイン下部のパスバー（features/agents/path-bar.ts）のお気に入りと
// 新規セッションの場所フライアウトが読む。このモジュールが所有して accessor を export する。
// （以前の右パネルは廃止し、Git 機能はツールバーの Git ウィンドウ（features/git）へ移した）
// ============================================================

import { scheduleSave } from "../../app/session";

let expFavorites: string[] = []; // お気に入りディレクトリ（絶対パス、登録順）。session.json に保存

/** session.json への保存時に読む */
export function getExplorerFavorites(): string[] {
  return expFavorites;
}

/** boot() の復元時に入れる */
export function setExplorerFavorites(list: string[]) {
  expFavorites = list;
}

export function toggleExpFavorite(path: string) {
  expFavorites = expFavorites.includes(path)
    ? expFavorites.filter((p) => p !== path)
    : [...expFavorites, path];
  scheduleSave();
}
