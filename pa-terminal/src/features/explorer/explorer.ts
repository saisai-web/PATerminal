// ============================================================
// 右パネル: フォーカス中ペインの現在地 + git セクション
//
// ファイルの閲覧・移動はペイン下部のパスバー（features/agents/path-bar.ts）の
// フォルダーブラウザーへ一本化した。このパネルは現在地の表示と、そのブラウザーを
// 開く入口だけを持ち、下部の git セクション（features/git）がパネルの残りを使う。
// 現在地はフォーカス中ペインの cwd に追従する（フォーカス移動・OSC 7・pty_cwd
// ポーリング → explorerFollow）。
//
// お気に入り（expFavorites）は session.json に永続し、パスバーのお気に入りと
// 新規セッションの場所フライアウトが読む。このモジュールが所有して accessor を export する。
// ============================================================

import { updateGitWatch } from "../git/agent-panel";
import { displayPath, openPathBrowser } from "../agents/path-bar";
import { layout, getRafId, placeVisibleWorkspaces, setRafId } from "../../terminal/layout";
import { scheduleSave } from "../../app/session";
import { normPath, parentPath, pathBasename } from "./paths";
import { getFocusedId, panes } from "../../workspace/state";

const explorerEl = document.querySelector<HTMLDivElement>("#explorer")!;
const expCloseBtn = document.querySelector<HTMLButtonElement>("#exp-close")!;
const expReopenBtn = document.querySelector<HTMLButtonElement>("#exp-reopen")!;
const expResizeEl = document.querySelector<HTMLDivElement>("#exp-resize")!;
const expFolderBtn = document.querySelector<HTMLButtonElement>("#exp-folder")!;
const expFolderNameEl = document.querySelector<HTMLSpanElement>("#exp-folder-name")!;
const expFolderParentEl = document.querySelector<HTMLSpanElement>("#exp-folder-parent")!;

let expOpen = false;
/** フォーカス中ペインの cwd（閉じている間の追従も覚えておき、開いたときに描く） */
let expFollowed: string | null = null;
let expFavorites: string[] = []; // お気に入りディレクトリ（絶対パス、登録順）。session.json に保存

export function isExplorerOpen(): boolean {
  return expOpen;
}

/** session.json への保存時に読む（永続するのはお気に入りだけ） */
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

/** フォーカス中ペインの既知の cwd。まだ分からなければ null */
export function focusedCwd(): string | null {
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  const p = pane?.cwd ?? pane?.spec.cwd;
  return p ? normPath(p) : null;
}

/** フォーカス中ペインの cwd に見出しを追従させる。同じ値の再通知では何もしない */
export function explorerFollow(cwd: string) {
  const p = normPath(cwd);
  if (p === expFollowed) return;
  expFollowed = p;
  renderExplorerFolder();
}

function renderExplorerFolder() {
  const p = expFollowed ?? focusedCwd();
  expFolderBtn.disabled = !p;
  if (!p) {
    expFolderNameEl.textContent = "";
    expFolderParentEl.textContent = "";
    expFolderBtn.removeAttribute("data-path");
    return;
  }
  const shown = displayPath(p);
  const parent = parentPath(p);
  expFolderNameEl.textContent = pathBasename(shown);
  // rtl で先頭側を省略しても / や ~ が入れ替わらないよう LRM で囲む
  // ~ 自体は親を出さない（/Users 等はホームの見出しとして冗長）
  expFolderParentEl.textContent = parent && shown !== "~" ? `\u200e${displayPath(parent)}\u200e` : "";
  expFolderBtn.dataset.path = p;
  expFolderBtn.title = p;
}

export function setExplorerOpen(open: boolean, opts: { save?: boolean } = {}) {
  expOpen = open;
  explorerEl.hidden = !open;
  expReopenBtn.hidden = open; // 閉じている間だけ右端アイコンを出す
  // パネルの分だけグリッド幅が変わるので即レイアウト（refit で TUI にも resize が飛ぶ）
  layout();
  if (open) {
    renderExplorerFolder();
    updateGitWatch(); // 下部の git セクションも即 populate（3秒ポーリングを待たない）
  }
  if (opts.save !== false) scheduleSave();
}

expCloseBtn.onclick = () => setExplorerOpen(false);
expReopenBtn.onclick = () => setExplorerOpen(true);

// 現在地のカードからフォーカス中ペインのフォルダーブラウザーを開く
expFolderBtn.onclick = (e) => {
  e.stopPropagation();
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  if (pane?.alive) openPathBrowser(pane);
};

// 左端ハンドルのドラッグで幅を変更。最小幅よりさらに右へ押し込んで離すと閉じる。
// ペイン用ディバイダと同じく、ドラッグ中は rAF で place のみ回し refit は確定時に行う
const EXP_MIN_W = 180;
const EXP_DEFAULT_W = 260;
const EXP_CLOSE_W = 110; // 要求幅がこれ未満のまま離したら閉じる

expResizeEl.addEventListener("pointerdown", (down) => {
  down.preventDefault();
  try {
    expResizeEl.setPointerCapture(down.pointerId);
  } catch {
    /* キャプチャ不可でも move は届く範囲で動く */
  }
  expResizeEl.classList.add("is-dragging");
  document.body.classList.add("dragging");
  const right = explorerEl.getBoundingClientRect().right;
  const maxW = Math.max(EXP_MIN_W, Math.round(window.innerWidth * 0.6));
  let requested = explorerEl.getBoundingClientRect().width;

  const move = (ev: PointerEvent) => {
    requested = right - ev.clientX;
    const w = Math.min(maxW, Math.max(EXP_MIN_W, Math.round(requested)));
    explorerEl.style.width = `${w}px`;
    explorerEl.classList.toggle("will-close", requested < EXP_CLOSE_W);
    if (!getRafId()) {
      setRafId(
        requestAnimationFrame(() => {
          setRafId(0);
          placeVisibleWorkspaces();
        }),
      );
    }
  };
  const finish = () => {
    expResizeEl.removeEventListener("pointermove", move);
    expResizeEl.removeEventListener("pointerup", finish);
    expResizeEl.removeEventListener("pointercancel", finish);
    expResizeEl.removeEventListener("lostpointercapture", finish);
    expResizeEl.classList.remove("is-dragging");
    document.body.classList.remove("dragging");
    explorerEl.classList.remove("will-close");
    if (requested < EXP_CLOSE_W) setExplorerOpen(false);
    else layout(); // 確定時に refit まで含めてやり直す
  };
  expResizeEl.addEventListener("pointermove", move);
  expResizeEl.addEventListener("pointerup", finish);
  expResizeEl.addEventListener("pointercancel", finish);
  expResizeEl.addEventListener("lostpointercapture", finish);
});

// ダブルクリックで既定幅に戻す
expResizeEl.addEventListener("dblclick", () => {
  explorerEl.style.width = `${EXP_DEFAULT_W}px`;
  layout();
});
