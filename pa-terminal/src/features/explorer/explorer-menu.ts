// ============================================================
// 右クリックメニュー共通アクション（サイドバー / エクスプローラー）と
// エクスプローラーの右クリックメニュー（フォルダ / ファイル / 一覧の余白）
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../../shared/clipboard";
// explorer.ts とは相互 import になるが、参照するのはすべて関数宣言なので巻き上げで
// 解決する（トップレベル const を跨いで読まない）
import {
  explorerNewSession,
  isExpFavorite,
  openExplorerImport,
  openExplorerMkdir,
  toggleExpFavorite,
  trashExplorerEntry,
} from "./explorer";
import { openFileViewer } from "./file-viewer";
import { t } from "../../i18n";
import { cdCommandFor, parentPath, pathBasename } from "./paths";
import { getActiveWs, getFocusedId, getHostOs, panes } from "../../workspace/state";
import { splitPane } from "../../terminal/tree";

const expCtxEl = document.querySelector<HTMLDivElement>("#exp-ctx")!;

/** 「Finder で表示」のラベル。OS のファイルマネージャー名に合わせる */
export function revealLabel(): string {
  if (getHostOs() === "macos") return t("ctx.revealMac");
  if (getHostOs() === "windows") return t("ctx.revealWin");
  return t("ctx.revealOther");
}

/** OS のファイルマネージャーでパスを表示（ファイルは選択状態で親フォルダを開く） */
export function revealInOs(path: string) {
  void invoke("reveal_path", { path }).catch((e) => console.error("reveal_path failed:", e));
}

/** OS の既定アプリでファイルを開く */
export function openInOs(path: string) {
  void invoke("open_path", { path }).catch((e) => console.error("open_path failed:", e));
}

/** フォーカス中ペインのシェルに cd を打ち込み、ターミナル自体をそのフォルダへ移動させる。
    エクスプローラーの表示は動かさない（cwd は OSC 7 で追って反映される） */
export function terminalCdTo(path: string) {
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  if (!pane) return;
  pane.write(`${cdCommandFor(pane, path)}\r`);
}

// フォルダ / ファイルの右クリックメニュー
export function openExpCtxMenu(
  x: number,
  y: number,
  path: string,
  isDir: boolean,
  mkdirParent: string | null,
  deletable: boolean,
) {
  expCtxEl.innerHTML = "";
  const item = (labelText: string, onClick: () => void, title?: string) => {
    const b = document.createElement("button");
    b.className = "exp-ctx-item";
    b.textContent = labelText;
    if (title) b.title = title;
    b.onclick = () => {
      closeExpCtxMenu();
      onClick();
    };
    expCtxEl.append(b);
  };
  const sep = () => {
    const d = document.createElement("div");
    d.className = "exp-ctx-sep";
    expCtxEl.append(d);
  };
  // どの項目のメニューかを示すヘッダ（ホバーでフルパス）
  const head = document.createElement("div");
  head.className = "exp-ctx-title";
  head.textContent = pathBasename(path);
  head.title = path;
  expCtxEl.append(head);

  // ファイル一覧の行・余白から開いたメニューだけに出す。ツリーのフォルダ行では
  // そのフォルダ、ファイル行と一覧余白ではそれらを含むフォルダが作成・インポート先になる。
  if (mkdirParent) {
    item(t("exp.mkdir"), () => openExplorerMkdir(mkdirParent));
    item(t("exp.importFiles"), () => void openExplorerImport(mkdirParent, false));
    item(t("exp.importFolders"), () => void openExplorerImport(mkdirParent, true));
    sep();
  }

  if (isDir) {
    item(t("exp.cdHere"), () => terminalCdTo(path), t("exp.cdHereTitle"));
    item(t("exp.ctxNewPane"), () => {
      const ws = getActiveWs();
      const fid = getFocusedId();
      if (ws && fid) splitPane(ws, fid, "row", { title: "shell", cwd: path });
    });
    item(t("exp.ctxNewSession"), () => explorerNewSession(path));
    sep();
    item(t("ctx.copyPath"), () => void copyText(path), path);
    item(revealLabel(), () => revealInOs(path));
    sep();
    item(isExpFavorite(path) ? t("exp.favDel") : t("exp.favAdd"), () => toggleExpFavorite(path));
  } else {
    item(t("exp.ctxViewEdit"), () => void openFileViewer(path));
    item(t("exp.openFile"), () => openInOs(path));
    // 「ここ」系 = ファイルのあるフォルダを対象にする（cd / 新規セッション）
    const dir = parentPath(path);
    if (dir) {
      item(t("exp.cdHere"), () => terminalCdTo(dir), t("exp.cdHereFileTitle"));
      item(
        t("exp.ctxNewSession"),
        () => explorerNewSession(dir),
        t("exp.ctxNewSessionFileTitle"),
      );
    }
    item(revealLabel(), () => revealInOs(path));
    sep();
    item(t("ctx.copyPath"), () => void copyText(path), path);
    item(t("exp.copyName"), () => void copyText(pathBasename(path)));
  }
  // ファイル一覧の実在エントリ（ツリー行・配下検索の行）だけに出す。`..`・パンくず・
  // お気に入り・現在地ピン由来のメニューでは表示中フォルダ自身や祖先を消せてしまうので出さない。
  // 恒久削除ではなく OS のゴミ箱行きなので確認は挟まない
  if (deletable) {
    sep();
    item(t("exp.trash"), () => void trashExplorerEntry(path));
  }
  expCtxEl.hidden = false;
  // 表示後の実寸で画面内にクランプ
  const r = expCtxEl.getBoundingClientRect();
  expCtxEl.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
  expCtxEl.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

export function closeExpCtxMenu() {
  expCtxEl.hidden = true;
}

/** 右クリックでメニューを出す共通ハンドラ */
export function expCtxHandler(
  path: string,
  isDir = true,
  mkdirParent: string | null = null,
  deletable = false,
) {
  return (e: MouseEvent) => {
    e.preventDefault();
    openExpCtxMenu(e.clientX, e.clientY, path, isDir, mkdirParent, deletable);
  };
}

// メニュー外のどこかを押したら閉じる（メニュー項目の click は妨げない）
window.addEventListener(
  "pointerdown",
  (e) => {
    if (!expCtxEl.hidden && !expCtxEl.contains(e.target as Node)) closeExpCtxMenu();
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (!expCtxEl.hidden && e.key === "Escape") {
      e.stopPropagation(); // シェルや検索ボックスに Escape を流さない
      closeExpCtxMenu();
    }
  },
  true,
);
window.addEventListener("blur", () => {
  closeExpCtxMenu();
});
window.addEventListener("resize", () => {
  closeExpCtxMenu();
});
