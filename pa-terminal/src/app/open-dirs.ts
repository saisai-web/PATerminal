// ============================================================
// Finder から渡されたフォルダを新規セッションにする
// （「このアプリケーションで開く」/ Dock へのドロップ / クイックアクション「PATerminalで開く」）
//
// Rust は RunEvent::Opened で受けたフォルダを溜めて `app:open-dirs` を出すだけで、
// 中身はこちらが `take_pending_open_dirs` で取り出す。起動前に渡された分はフロントの
// 準備前にイベントが来るので、復元完了（boot 後）まで取り出しを保留する。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pathBasename } from "../features/explorer/paths";
import { renderSidebar } from "../features/sidebar/sidebar";
import { createWorkspaceBesideActive } from "../workspace/workspace";

let ready = false;
let draining = false;

async function drain(): Promise<void> {
  if (!ready || draining) return;
  draining = true;
  try {
    const dirs = await invoke<string[]>("take_pending_open_dirs").catch(() => [] as string[]);
    for (const dir of dirs) {
      if (typeof dir !== "string" || !dir) continue;
      // エクスプローラーの「新規セッションで開く」と同じく、フォルダ名を初期名にする
      createWorkspaceBesideActive(pathBasename(dir) || dir, "default", { cwd: dir });
    }
    if (dirs.length) renderSidebar();
  } finally {
    draining = false;
  }
}

/** 復元完了後に呼ぶ。以降はイベントごとに取り出し、溜まっていた分もここで流す */
export function flushPendingOpenDirs(): void {
  ready = true;
  void drain();
}

void listen("app:open-dirs", () => {
  void drain();
});
