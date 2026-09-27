// ============================================================
// 新規セッションの作成場所（Issue #192）
//
// - 作成入口（サイドバー左上の +、グループ見出し / Whole 枠の + と右クリック、サイドバー余白の
//   右クリックの「セッションを作成」）は、場所を尋ねずにルート（ホーム = 新規ターミナルの
//   既定の起動場所）へ即作成する。作業フォルダーへは作成後にペイン下部のパスバーの
//   フォルダーブラウザー（「ここへ移動」）で移る
// - 作ったセッションはパスバーのフォルダーブラウザーを開いた状態で始まり、そのまま移動先を選べる
// - 各入口の既存の配置規則（グループ・挿入位置）はそのまま
// - 詳細フォーム（Cmd/Ctrl+T）の場所欄だけは、パスバーと同じアプリ内フォルダーブラウザー
//   （openFolderPicker）で場所を選ぶ
// ============================================================

import { homeDir } from "@tauri-apps/api/path";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { closeGroupMenu } from "../../shared/ctx-menu";
import { newSessionCwd } from "../../workspace/workspace";
import { openFolderPicker, openPathBrowserAfterCreate } from "../agents/path-bar";
import type { Workspace } from "../../workspace/types";
import { normPath } from "../explorer/paths";

export type LocationPick = (cwd: string) => void;


/** OS のフォルダ選択ダイアログを開き、選んだフォルダを正規化して返す（キャンセルは null）。
    ダイアログ表示でウィンドウが blur してメニューやブラウザーが閉じても、
    Promise はそのまま解決するので呼び出し側の作成処理は続行できる */
export function pickFolderFromOs(): Promise<string | null> {
  return openFolderDialog({ directory: true }).then((picked) =>
    typeof picked === "string" && picked ? normPath(picked) : null,
  );
}

/** 作成入口のクリックで、ルート（ホーム）を onCreate に渡して即作成し、作ったセッションの
    フォルダーブラウザーを開く（onCreate が作らなかった場合は何もしない）。
    menuItem は右クリックメニューの項目（先にメニューを閉じる） */
export function attachRootCreate(
  anchor: HTMLElement,
  onCreate: (cwd: string) => Promise<Workspace | undefined> | undefined,
  opts: { menuItem?: boolean } = {},
) {
  anchor.addEventListener("click", (e) => {
    e.stopPropagation();
    if (opts.menuItem) closeGroupMenu();
    void homeDir()
      .then((home) => onCreate(normPath(home)))
      .then(
        (ws) => {
          const pane = ws ? [...ws.panes.values()][0] : undefined;
          if (pane) openPathBrowserAfterCreate(pane);
        },
        (err) => console.error("root create failed:", err),
      );
  });
}

/** 詳細フォームの場所欄: アプリ内フォルダーブラウザーを表示中ペインの場所（無ければホーム）から
    開き、主ボタンで選んだ場所を onPick に渡す。文言は言語切替に追従するよう開くたびに読む */
export function attachLocationPicker(anchor: HTMLElement, onPick: LocationPick, pickLabel: () => string) {
  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.addEventListener("click", (e) => {
    e.stopPropagation();
    void newSessionCwd()
      .then((cwd) => cwd ?? homeDir())
      .then(
        (start) => openFolderPicker(anchor, start, pickLabel(), (path) => onPick(normPath(path))),
        (err) => console.error("homeDir failed:", err),
      );
  });
}
