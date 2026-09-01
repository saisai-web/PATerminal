// ============================================================
// エクスプローラーパネル（インラインツリー・表示起点の移動・更新・フォルダ作成）
// フォーカス中ペインの cwd に追従する: フォーカス移動・シェルの cd（OSC 7、
// 無ければ git 監視の pty_cwd 3秒ポーリング）で表示先が移る。手動ナビゲートも
// 可能だが、ターミナルが移動すればそこへ戻る。パネル側の操作でペインの cwd は
// 変更しない。
//
// 開閉（expOpen）・隠しファイル表示（expShowHidden）は保存しない（起動時は常に
// 閉じた状態 + 隠しファイル ON）。お気に入り（expFavorites）だけ session.json に永続
// するので、このモジュールが所有して accessor を export する。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { updateGitWatch } from "../git/agent-panel";
// explorer-menu.ts とは相互 import になるが、参照するのはすべて関数宣言なので
// 巻き上げで解決する（トップレベル const を跨いで読まない）
import { expCtxHandler } from "./explorer-menu";
// new-session-location.ts（お気に入りを読むため explorer を import する）とも相互 import。
// こちらも参照は関数宣言のみで巻き上げで解決する
import { attachLocationFlyout } from "../sidebar/new-session-location";
import { openFileViewer } from "./file-viewer";
import { t } from "../../i18n";
import { getRafId, layout, place, setRafId } from "../../terminal/layout";
import { scheduleSave } from "../../app/session";
import {
  compactExplorerPath,
  explorerParentContext,
  explorerPathContext,
  fsDefaultRoot,
  joinPath,
  normPath,
  parentPath,
  pathBasename,
  relativeFromCwd,
} from "./paths";
import { getActiveWs, getFocusedId, panes } from "../../workspace/state";
import { splitPane } from "../../terminal/tree";
import type { FsEntry, FsListing, FsMatch, FsSearchResult, ShellKind } from "../../workspace/types";

/** main.ts に残っているセッション生成（→ PR9 でサイドバー側へ移ったら直接 import へ） */
export type ExplorerDeps = {
  createWorkspace: (name: string, shellKind: ShellKind, opts: { cwd: string }) => void;
};

let deps: ExplorerDeps;

export function initExplorer(d: ExplorerDeps) {
  deps = d;
}

/** 表示中のパスを cwd にした新規セッション。名前はディレクトリ名を初期値にする */
export function explorerNewSession(cwd: string) {
  deps.createWorkspace(pathBasename(cwd), "default", { cwd });
}

const explorerEl = document.querySelector<HTMLDivElement>("#explorer")!;
const expPathEl = document.querySelector<HTMLDivElement>("#exp-path")!;
const expListEl = document.querySelector<HTMLDivElement>("#exp-list")!;
const expRefreshBtn = document.querySelector<HTMLButtonElement>("#exp-refresh")!;
const expCloseBtn = document.querySelector<HTMLButtonElement>("#exp-close")!;
const expFilterEl = document.querySelector<HTMLInputElement>("#exp-filter")!;
const expReopenBtn = document.querySelector<HTMLButtonElement>("#exp-reopen")!;
const expResizeEl = document.querySelector<HTMLDivElement>("#exp-resize")!;
const expHiddenBtn = document.querySelector<HTMLButtonElement>("#exp-hidden")!;
const expRootBtn = document.querySelector<HTMLButtonElement>("#exp-root")!;
const expFavBtn = document.querySelector<HTMLButtonElement>("#exp-fav")!;
const expFavsEl = document.querySelector<HTMLDivElement>("#exp-favs")!;
const expNewPaneBtn = document.querySelector<HTMLButtonElement>("#exp-new-pane")!;
const expNewSessionBtn = document.querySelector<HTMLButtonElement>("#exp-new-session")!;

let expOpen = false;
let expShowHidden = true; // 隠しファイルはデフォルト表示
/** 配下検索を投げるまでの待ち時間（打鍵中にディレクトリ走査を始めない） */
const EXP_SEARCH_DEBOUNCE = 250;
/** 最後に追従した cwd。同じ値の再通知で表示をリセットしないための記録 */
let expFollowed: string | null = null;
let expCwd: string | null = null;
let expLast: FsListing | null = null;
let expErr: string | null = null;
let expListToken = 0; // 遅れて返った古い一覧で新しい表示を上書きしないための番号
// 表示起点（expCwd）は変えず、フォルダ行の配下をその場で開くツリー状態。
// 一覧は必要になったフォルダだけ fs_list し、起点の移動時にまとめて破棄する。
const expExpandedDirs = new Set<string>();
const expTreeListings = new Map<string, FsListing>();
const expTreeErrors = new Map<string, string>();
const expTreeLoading = new Set<string>();
const expTreeRequests = new Map<string, number>();
let expTreeRequestToken = 0;
let expFilter = ""; // 一覧の名前絞り込み（小文字化済み）。ディレクトリ移動でリセット
// 配下（サブフォルダ）検索の状態。直下の絞り込みは即時、配下は fs_search を
// デバウンスして後から追記する（打鍵ごとにディレクトリ走査を走らせない）
let expSearchTimer: number | null = null;
let expSearchToken = 0; // 遅れて返った古い検索結果を捨てるための番号
let expSearchDeep: FsMatch[] = []; // depth>=2 のヒット（幅優先＝浅い順）
let expSearchTruncated = false;
let expSearchBusy = false;
let expSearchErr: string | null = null;
let expFavorites: string[] = []; // お気に入りディレクトリ（絶対パス、登録順）。session.json に保存
let expMkdirParent: string | null = null; // 右クリック時点で表示していた作成先フォルダ
let expMkdirDraft = "";
let expMkdirError: string | null = null;
let expMkdirBusy = false;
let expMkdirToken = 0; // 作成中に移動・取消されたとき、古い完了処理で一覧を戻さない
let expMkdirInput: HTMLInputElement | null = null;
let expMkdirErrorEl: HTMLDivElement | null = null;
let expMkdirRendering = false; // 一覧再描画による input の blur では作成を確定しない
let expImportBusy = false;
// DnD 移動の移動元。dragover では dataTransfer を読めない（drop 時のみ）ため状態で持つ
let expDragPath: string | null = null;
let expOpError: string | null = null; // 削除・移動の失敗表示（一定時間で自動的に消える）
let expOpErrorTimer: number | null = null;
const EXP_OP_ERROR_MS = 10000;

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

export function isExpFavorite(path: string): boolean {
  return expFavorites.includes(path);
}

/** フォーカス中ペインの既知の cwd。まだ分からなければ null */
export function focusedCwd(): string | null {
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  const p = pane?.cwd ?? pane?.spec.cwd;
  return p ? normPath(p) : null;
}

/** 絶対パスを各階層へ直接戻れるパンくずとして描画する。textContent は元のパスと一致させる。 */
function renderExplorerPath(path: string) {
  expPathEl.innerHTML = "";
  expPathEl.title = path;
  const crumbs: Array<{ label: string; target: string }> = [];
  const drive = path.match(/^([A-Za-z]:\/)(.*)$/);
  if (drive) {
    crumbs.push({ label: drive[1], target: drive[1] });
    let target = drive[1];
    for (const part of drive[2].split("/").filter(Boolean)) {
      target = joinPath(target, part);
      crumbs.push({ label: part, target });
    }
  } else if (path.startsWith("/")) {
    crumbs.push({ label: "/", target: "/" });
    let target = "/";
    for (const part of path.slice(1).split("/").filter(Boolean)) {
      target = joinPath(target, part);
      crumbs.push({ label: part, target });
    }
  } else {
    let target = "";
    for (const part of path.split("/").filter(Boolean)) {
      target = target ? joinPath(target, part) : part;
      crumbs.push({ label: part, target });
    }
  }
  crumbs.forEach((crumb, i) => {
    // ルート表記自体が / で終わるため、最初の子の前には区切りを足さない。
    if (i > 1 || (i === 1 && !crumbs[0].label.endsWith("/"))) {
      const sep = document.createElement("span");
      sep.className = "exp-path-sep";
      sep.textContent = "/";
      expPathEl.append(sep);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "exp-path-part";
    b.textContent = crumb.label;
    b.title = crumb.target;
    if (i === crumbs.length - 1) b.setAttribute("aria-current", "location");
    b.onclick = () => explorerNavigate(crumb.target);
    expPathEl.append(b);
  });
  requestAnimationFrame(() => { expPathEl.scrollLeft = expPathEl.scrollWidth; });
}

/** フォーカス中ペインの cwd にエクスプローラーを追従させる。
    同じ cwd の再通知（3秒ポーリング・プロンプト毎の OSC 7）では何もしないので、
    手動ナビゲート中の表示はターミナルが実際に移動するまで保持される */
export function explorerFollow(cwd: string) {
  const p = normPath(cwd);
  if (p === expFollowed) return;
  expFollowed = p;
  if (!expOpen) return; // 閉じている間は覚えるだけ（開いたとき setExplorerOpen が反映）
  void explorerShow(p);
}

async function explorerShow(path: string) {
  closeExplorerMkdir(false);
  await loadExplorer(path, true);
}

function clearExplorerTree() {
  expExpandedDirs.clear();
  expTreeListings.clear();
  expTreeErrors.clear();
  expTreeLoading.clear();
  expTreeRequests.clear();
  expTreeRequestToken++;
}

function isBelowExplorerRoot(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

/** 一覧を再取得する。移動時だけ検索条件を解除し、更新時は条件とスクロール位置を保つ。 */
async function loadExplorer(path: string, resetFilter: boolean) {
  const normalized = normPath(path);
  const scrollTop = resetFilter ? 0 : expListEl.scrollTop;
  expCwd = normalized;
  renderExplorerPath(normalized);
  updateExpFavBtn();
  if (resetFilter) {
    // 絞り込みはディレクトリごと。移動したら解除する
    expFilter = "";
    expFilterEl.value = "";
    cancelExplorerSearch();
    clearExplorerTree();
    expLast = null;
    expErr = null;
  }
  const token = ++expListToken;
  expRefreshBtn.disabled = true;
  let listing: FsListing | null = null;
  let err: string | null = null;
  try {
    listing = await invoke<FsListing>("fs_list", { path: normalized });
  } catch (e) {
    // 読めないディレクトリはエラー表示のみ。アプリは落とさない
    err = String(e);
  }
  if (token !== expListToken) return; // 追い越された古い結果は捨てる
  expLast = listing;
  expErr = err;
  if (!resetFilter) await reloadExpandedDirectories(token);
  if (token !== expListToken) return;
  expRefreshBtn.disabled = false;
  // 更新（⟳）で検索条件が残っている場合は配下も取り直す
  if (!resetFilter && expFilter) scheduleExplorerSearch();
  renderExplorerList();
  if (!resetFilter) expListEl.scrollTop = scrollTop;
}

/** 明示更新では、開いている枝も開閉状態を保ったまま取り直す。 */
async function reloadExpandedDirectories(listToken: number) {
  const root = expCwd;
  if (!root) return;
  const paths = [...expExpandedDirs].filter((path) => isBelowExplorerRoot(path, root));
  expTreeListings.clear();
  expTreeErrors.clear();
  expTreeLoading.clear();
  expTreeRequests.clear();
  for (const path of paths) expTreeLoading.add(path);
  renderExplorerList();
  for (const path of paths) {
    if (listToken !== expListToken) return;
    await loadExplorerDirectory(path, listToken, false);
  }
}

/** 展開された1フォルダだけを読み込む。起点変更後に返った結果は捨てる。 */
async function loadExplorerDirectory(
  path: string,
  listToken = expListToken,
  renderLoading = true,
) {
  const request = ++expTreeRequestToken;
  expTreeRequests.set(path, request);
  expTreeLoading.add(path);
  expTreeErrors.delete(path);
  if (renderLoading) renderExplorerList();
  let listing: FsListing | null = null;
  let err: string | null = null;
  try {
    listing = await invoke<FsListing>("fs_list", { path });
  } catch (e) {
    err = String(e);
  }
  if (listToken !== expListToken || expTreeRequests.get(path) !== request) return;
  expTreeLoading.delete(path);
  if (listing) expTreeListings.set(path, listing);
  else expTreeListings.delete(path);
  if (err) expTreeErrors.set(path, err);
  else expTreeErrors.delete(path);
  renderExplorerList();
}

function toggleExplorerDirectory(path: string) {
  if (expExpandedDirs.delete(path)) {
    renderExplorerList();
    return;
  }
  expExpandedDirs.add(path);
  if (expTreeListings.has(path) || expTreeErrors.has(path)) {
    renderExplorerList();
    return;
  }
  void loadExplorerDirectory(path);
}

function explorerDirectoryChain(root: string, target: string): string[] {
  if (!isBelowExplorerRoot(target, root) || target === root) return [];
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const parts = target.slice(prefix.length).split("/").filter(Boolean);
  const result: string[] = [];
  let current = root;
  for (const part of parts) {
    current = joinPath(current, part);
    result.push(current);
  }
  return result;
}

/** 検索ヒットのフォルダは起点へ移動せず、祖先を順に開いてツリー内へ表示する。 */
async function revealExplorerDirectory(path: string) {
  const root = expCwd;
  const target = normPath(path);
  if (!root || !isBelowExplorerRoot(target, root)) {
    explorerNavigate(target);
    return;
  }
  expFilter = "";
  expFilterEl.value = "";
  cancelExplorerSearch();
  const listToken = expListToken;
  for (const dir of explorerDirectoryChain(root, target)) {
    expExpandedDirs.add(dir);
    if (!expTreeListings.has(dir) && !expTreeErrors.has(dir)) {
      await loadExplorerDirectory(dir, listToken);
      if (listToken !== expListToken) return;
    }
  }
  renderExplorerList();
  requestAnimationFrame(() => {
    const row = [...expListEl.querySelectorAll<HTMLElement>(".exp-row[data-exp-path]")]
      .find((el) => el.dataset.expPath === target);
    if (!row) return;
    row.classList.add("is-revealed");
    row.scrollIntoView({ block: "nearest" });
    window.setTimeout(() => row.classList.remove("is-revealed"), 1200);
  });
}

/** 配下検索の待機・結果をすべて捨てる（移動・条件クリア時） */
function cancelExplorerSearch() {
  if (expSearchTimer !== null) {
    clearTimeout(expSearchTimer);
    expSearchTimer = null;
  }
  expSearchToken++; // 実行中の結果も無効化する
  expSearchDeep = [];
  expSearchTruncated = false;
  expSearchBusy = false;
  expSearchErr = null;
}

/** 入力が落ち着いてから 1 回だけ配下を走査する（打鍵ごとに走らせない） */
function scheduleExplorerSearch() {
  cancelExplorerSearch();
  const root = expCwd;
  const query = expFilter;
  if (!root || !query) return;
  expSearchBusy = true;
  expSearchTimer = window.setTimeout(() => {
    expSearchTimer = null;
    void runExplorerSearch(root, query);
  }, EXP_SEARCH_DEBOUNCE);
}

async function runExplorerSearch(root: string, query: string) {
  const token = ++expSearchToken;
  let res: FsSearchResult | null = null;
  let err: string | null = null;
  try {
    res = await invoke<FsSearchResult>("fs_search", {
      path: root,
      query,
      includeHidden: expShowHidden,
    });
  } catch (e) {
    err = String(e);
  }
  if (token !== expSearchToken) return; // 追い越された古い検索は捨てる
  expSearchBusy = false;
  expSearchErr = err;
  // 直下は取得済みの一覧から出しているので、ここでは配下（depth>=2）だけ使う
  expSearchDeep = (res?.matches ?? []).filter((m) => m.depth >= 2);
  expSearchTruncated = res?.truncated ?? false;
  renderExplorerList();
}

export function renderExplorerList() {
  const restoreMkdirFocus = document.activeElement === expMkdirInput;
  if (expMkdirInput) expMkdirDraft = expMkdirInput.value;
  expMkdirRendering = true;
  expMkdirInput = null;
  expMkdirErrorEl = null;
  expListEl.innerHTML = "";
  if (!expCwd) {
    expMkdirRendering = false;
    return;
  }
  if (expOpError) {
    const e = document.createElement("div");
    e.className = "exp-error exp-op-error";
    e.textContent = expOpError;
    e.setAttribute("role", "alert");
    expListEl.append(e);
  }
  const up = parentPath(expCwd);
  if (up !== null) {
    const row = document.createElement("div");
    row.className = "exp-row is-dir has-path-context";
    row.title = up;
    const name = document.createElement("span");
    name.className = "exp-row-name";
    name.textContent = "▲ ..";
    row.append(name, explorerPathContext(compactExplorerPath(up), up));
    row.onclick = () => explorerNavigate(up);
    row.oncontextmenu = expCtxHandler(up, true, expCwd);
    wireExplorerDropTarget(row, up); // `..` へのドロップ = 1つ上のフォルダへ移動
    expListEl.append(row);
  }
  if (expErr) {
    const e = document.createElement("div");
    e.className = "exp-error";
    e.textContent = t("exp.readError", { error: expErr });
    expListEl.append(e);
    expMkdirRendering = false;
    return;
  }
  if (!expLast) {
    expMkdirRendering = false;
    return;
  }
  if (expMkdirParent === expCwd) renderExplorerMkdirRow(expListEl, 0);
  let shown = 0;
  for (const ent of expLast.entries) {
    if (!expShowHidden && ent.name.startsWith(".")) continue;
    if (expFilter && !ent.name.toLowerCase().includes(expFilter)) continue;
    shown++;
    renderExplorerEntry(expListEl, ent, expCwd, 0);
  }
  const deepShown = expFilter ? renderExplorerDeepMatches() : 0;
  if (expFilter && shown === 0 && deepShown === 0 && !expSearchBusy && !expSearchErr) {
    const n = document.createElement("div");
    n.className = "exp-note";
    n.textContent = t("exp.noMatch");
    expListEl.append(n);
  }
  if (expLast.truncated) {
    const n = document.createElement("div");
    n.className = "exp-note";
    n.textContent = t("exp.truncated");
    expListEl.append(n);
  }
  expMkdirRendering = false;
  const renderedMkdirInput = expListEl.querySelector<HTMLInputElement>(".exp-mkdir-input");
  if (restoreMkdirFocus && renderedMkdirInput) {
    const input = renderedMkdirInput;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    requestAnimationFrame(() => {
      if (input !== expMkdirInput) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function setExplorerDepth(el: HTMLElement, depth: number) {
  el.style.setProperty("--exp-depth", String(depth));
}

function renderExplorerTreeMessage(
  container: HTMLElement,
  text: string,
  depth: number,
  className: string,
) {
  const message = document.createElement("div");
  message.className = `${className} exp-tree-message`;
  message.textContent = text;
  setExplorerDepth(message, depth);
  container.append(message);
}

/** 1エントリと、開いている場合はその子孫を同じ一覧内へ再帰描画する。 */
function renderExplorerEntry(
  container: HTMLElement,
  ent: FsEntry,
  parent: string,
  depth: number,
) {
  const full = joinPath(parent, ent.name);
  const row = document.createElement("div");
  row.className = `exp-row exp-tree-row ${ent.isDir ? "is-dir" : "is-file"}`;
  row.dataset.expPath = full;
  row.dataset.expParent = parent;
  setExplorerDepth(row, depth);

  const marker = document.createElement("span");
  marker.className = "exp-tree-marker";
  marker.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "exp-row-name";
  name.textContent = ent.name;
  row.append(marker, name);

  wireExplorerDragSource(row, full);

  if (ent.isDir) {
    const expanded = expExpandedDirs.has(full);
    marker.textContent = expanded ? "▾" : "▸";
    row.title = full;
    row.setAttribute("aria-expanded", String(expanded));
    row.onclick = () => {
      if (expFilter) void revealExplorerDirectory(full);
      else toggleExplorerDirectory(full);
    };
    row.oncontextmenu = expCtxHandler(full, true, full, true);
    wireExplorerDropTarget(row, full);
    container.append(row);

    // 検索中は通常ツリーを展開せず、下部の検索結果へ一本化する。
    if (!expanded || expFilter) return;
    const children = document.createElement("div");
    children.className = "exp-tree-children";
    children.dataset.expParent = full;
    container.append(children);

    if (expMkdirParent === full) renderExplorerMkdirRow(children, depth + 1);
    if (expTreeLoading.has(full)) {
      renderExplorerTreeMessage(children, "…", depth + 1, "exp-note exp-tree-loading");
      return;
    }
    const err = expTreeErrors.get(full);
    if (err) {
      renderExplorerTreeMessage(children, t("exp.readError", { error: err }), depth + 1, "exp-error");
      return;
    }
    const listing = expTreeListings.get(full);
    if (!listing) return;
    for (const child of listing.entries) {
      if (!expShowHidden && child.name.startsWith(".")) continue;
      renderExplorerEntry(children, child, full, depth + 1);
    }
    if (listing.truncated) {
      renderExplorerTreeMessage(children, t("exp.truncated"), depth + 1, "exp-note");
    }
    return;
  }

  marker.textContent = "";
  row.title = t("file.view", { path: full });
  row.onclick = () => void openFileViewer(full);
  row.oncontextmenu = expCtxHandler(full, false, parent, true);
  container.append(row);
}

/** 新規フォルダの名前入力を、ヘッダではなく通常のフォルダと同じ一覧階層に描画する。 */
function renderExplorerMkdirRow(container: HTMLElement, depth: number): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "exp-row exp-tree-row is-dir exp-mkdir-row";
  row.setAttribute("role", "group");
  setExplorerDepth(row, depth);

  const marker = document.createElement("span");
  marker.className = "exp-mkdir-marker";
  marker.textContent = "▸";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit exp-mkdir-input";
  input.value = expMkdirDraft;
  input.placeholder = t("exp.mkdirPlaceholder");
  input.autocomplete = "off";
  input.disabled = expMkdirBusy;
  input.setAttribute("aria-label", t("exp.mkdirPlaceholder"));
  input.addEventListener("input", () => {
    expMkdirDraft = input.value;
    expMkdirError = null;
    if (expMkdirErrorEl) expMkdirErrorEl.hidden = true;
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 入力中の文字やショートカットをターミナルへ流さない
    if (e.key === "Enter") {
      e.preventDefault();
      expMkdirDraft = input.value;
      void createExplorerFolder();
    } else if (e.key === "Escape" && !expMkdirBusy) {
      e.preventDefault();
      closeExplorerMkdir();
    }
  });
  for (const type of ["mousedown", "click", "dblclick"] as const) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
  input.addEventListener("blur", () => {
    if (expMkdirRendering || expMkdirBusy || input !== expMkdirInput) return;
    expMkdirDraft = input.value;
    if (expMkdirDraft.trim()) void createExplorerFolder();
    else closeExplorerMkdir();
  });

  row.append(marker, input);
  container.append(row);
  expMkdirInput = input;

  if (expMkdirError) {
    const error = document.createElement("div");
    error.className = "exp-error exp-mkdir-error";
    error.textContent = expMkdirError;
    error.setAttribute("role", "alert");
    setExplorerDepth(error, depth);
    container.append(error);
    expMkdirErrorEl = error;
  }
  return input;
}

/** 配下（サブフォルダ）のヒットを見出し付きで追記する。戻り値は描画した件数。 */
function renderExplorerDeepMatches(): number {
  const root = expCwd;
  if (!root) return 0;
  const note = (text: string, cls = "exp-note") => {
    const n = document.createElement("div");
    n.className = cls;
    n.textContent = text;
    expListEl.append(n);
  };
  if (expSearchBusy) {
    note(t("exp.searching"), "exp-note exp-search-head");
    return 0;
  }
  if (expSearchErr) {
    note(t("exp.searchError", { error: expSearchErr }), "exp-error");
    return 0;
  }
  // 隠しファイルの表示切替は取得済み結果にもその場で効かせる
  const deep = expShowHidden
    ? expSearchDeep
    : expSearchDeep.filter((m) => !m.name.startsWith("."));
  if (deep.length === 0) return 0;
  note(t("exp.searchDeep", { count: String(deep.length) }), "exp-note exp-search-head");
  for (const m of deep) {
    const row = document.createElement("div");
    row.className = `exp-row exp-row-deep has-path-context ${m.isDir ? "is-dir" : "is-file"}`;
    const name = document.createElement("span");
    name.className = "exp-row-name";
    name.textContent = (m.isDir ? "▸ " : "  ") + m.name;
    const rel = relativeFromCwd(m.parent, root);
    row.append(name, explorerPathContext(rel, m.parent));
    row.title = m.isDir ? m.path : t("file.view", { path: m.path });
    row.onclick = m.isDir
      ? () => void revealExplorerDirectory(m.path)
      : () => void openFileViewer(m.path);
    row.oncontextmenu = expCtxHandler(m.path, m.isDir, m.isDir ? m.path : m.parent, true);
    expListEl.append(row);
  }
  if (expSearchTruncated) note(t("exp.searchTruncated"));
  return deep.length;
}

/** 手動ナビゲート（次にターミナルが cd / フォーカス移動するまで有効） */
function explorerNavigate(path: string) {
  void explorerShow(path);
}

function closeExplorerMkdir(render = true) {
  expMkdirToken++;
  expMkdirParent = null;
  expMkdirDraft = "";
  expMkdirError = null;
  expMkdirBusy = false;
  expMkdirInput = null;
  expMkdirErrorEl = null;
  if (render) renderExplorerList();
}

export function openExplorerMkdir(parent: string) {
  closeExplorerMkdir(false);
  expMkdirParent = normPath(parent);
  expMkdirDraft = "";
  if (expCwd !== expMkdirParent) {
    expExpandedDirs.add(expMkdirParent);
    if (!expTreeListings.has(expMkdirParent) && !expTreeLoading.has(expMkdirParent)) {
      void loadExplorerDirectory(expMkdirParent);
    }
  }
  renderExplorerList();
  expMkdirInput?.focus();
}

async function createExplorerFolder() {
  const parent = expMkdirParent;
  const name = expMkdirDraft.trim();
  if (!parent || expMkdirBusy) return;
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    expMkdirError = t("exp.mkdirInvalid");
    renderExplorerList();
    expMkdirInput?.focus();
    expMkdirInput?.select();
    return;
  }
  const token = expMkdirToken;
  expMkdirBusy = true;
  expMkdirError = null;
  if (expMkdirInput) expMkdirInput.disabled = true;
  try {
    await invoke("fs_create_dir", { path: joinPath(parent, name) });
    if (token !== expMkdirToken) return;
    closeExplorerMkdir(false);
    if (expCwd === parent) await loadExplorer(parent, false);
    else if (expExpandedDirs.has(parent)) await loadExplorerDirectory(parent);
    else renderExplorerList();
  } catch (e) {
    if (token !== expMkdirToken) return;
    expMkdirBusy = false;
    expMkdirError = t("exp.mkdirError", { error: String(e) });
    renderExplorerList();
    expMkdirInput?.focus();
    expMkdirInput?.select();
  }
}

/** 削除・移動の失敗を一覧の先頭に表示する。null でクリア */
function showExplorerOpError(msg: string | null) {
  expOpError = msg;
  if (expOpErrorTimer !== null) {
    clearTimeout(expOpErrorTimer);
    expOpErrorTimer = null;
  }
  if (msg) {
    expOpErrorTimer = window.setTimeout(() => {
      expOpErrorTimer = null;
      expOpError = null;
      renderExplorerList();
    }, EXP_OP_ERROR_MS);
  }
}

/** ネイティブダイアログで選んだファイルまたはフォルダを、右クリック時のフォルダへコピーする */
export async function openExplorerImport(destDir: string, directory: boolean) {
  if (expImportBusy) return;
  expImportBusy = true;
  let shouldRefresh = false;
  try {
    const dest = normPath(destDir);
    const selected = await open({
      directory,
      multiple: true,
      title: directory ? t("exp.importFolders") : t("exp.importFiles"),
      defaultPath: dest,
    });
    const sources = (Array.isArray(selected) ? selected : selected ? [selected] : []).map(normPath);
    if (!sources.length) return;
    shouldRefresh = true;
    await invoke("fs_import", { destDir: dest, sources });
    showExplorerOpError(null);
  } catch (e) {
    showExplorerOpError(t("exp.importError", { error: String(e) }));
    renderExplorerList();
  } finally {
    expImportBusy = false;
  }
  if (shouldRefresh && expCwd) await loadExplorer(expCwd, false);
}

/** path とその配下の展開状態・取得済み一覧を破棄する（削除・移動で消えた旧パスを
    reloadExpandedDirectories が取り直してエラー行を出さないため） */
function pruneExplorerTreeUnder(path: string) {
  for (const p of [...expExpandedDirs]) if (isBelowExplorerRoot(p, path)) expExpandedDirs.delete(p);
  for (const p of [...expTreeListings.keys()]) if (isBelowExplorerRoot(p, path)) expTreeListings.delete(p);
  for (const p of [...expTreeErrors.keys()]) if (isBelowExplorerRoot(p, path)) expTreeErrors.delete(p);
  for (const p of [...expTreeLoading]) if (isBelowExplorerRoot(p, path)) expTreeLoading.delete(p);
  for (const p of [...expTreeRequests.keys()]) if (isBelowExplorerRoot(p, path)) expTreeRequests.delete(p);
}

/** ファイル / フォルダを OS のゴミ箱へ移す。復元可能なので確認ダイアログは挟まない
    （セッションクローズ = 最近削除から復元、と同じ流儀） */
export async function trashExplorerEntry(path: string) {
  const target = normPath(path);
  try {
    await invoke("fs_trash", { path: target });
  } catch (e) {
    showExplorerOpError(t("exp.trashError", { error: String(e) }));
    renderExplorerList();
    return;
  }
  showExplorerOpError(null);
  pruneExplorerTreeUnder(target);
  // 消えたパスのお気に入り（配下含む）は掃除する
  const favBefore = expFavorites.length;
  expFavorites = expFavorites.filter((p) => !isBelowExplorerRoot(p, target));
  if (expFavorites.length !== favBefore) {
    renderExplorerFavs();
    updateExpFavBtn();
    scheduleSave();
  }
  if (expCwd) await loadExplorer(expCwd, false);
}

/** DnD の移動本体。同名衝突・自分の配下への移動などは Rust 側が拒否して理由を返す */
async function moveExplorerEntry(src: string, destDir: string) {
  try {
    await invoke("fs_move", { src, destDir });
  } catch (e) {
    showExplorerOpError(t("exp.moveError", { error: String(e) }));
    renderExplorerList();
    return;
  }
  showExplorerOpError(null);
  pruneExplorerTreeUnder(src);
  // 移動でパスが変わったお気に入りは新パスへ書き換える
  const dest = joinPath(destDir, pathBasename(src));
  const prefix = `${src}/`;
  let favChanged = false;
  expFavorites = expFavorites.map((p) => {
    if (p === src) {
      favChanged = true;
      return dest;
    }
    if (p.startsWith(prefix)) {
      favChanged = true;
      return `${dest}/${p.slice(prefix.length)}`;
    }
    return p;
  });
  if (favChanged) {
    renderExplorerFavs();
    updateExpFavBtn();
    scheduleSave();
  }
  if (expCwd) await loadExplorer(expCwd, false);
}

/** dest フォルダへ現在のドラッグ元を落とせるか。
    元と同じフォルダ（移動なし）と、自分自身・自分の配下（フォルダが自分の中へ消える）は不可 */
function canDropInto(dest: string): boolean {
  const src = expDragPath;
  if (!src) return false;
  if (parentPath(src) === dest) return false;
  return !isBelowExplorerRoot(dest, src);
}

function clearExplorerDropMarks() {
  expListEl.classList.remove("is-drop-target");
  for (const el of expListEl.querySelectorAll(".exp-row.is-drop-target")) {
    el.classList.remove("is-drop-target");
  }
}

/** フォルダ行（`..` 行含む）をドロップ先にする */
function wireExplorerDropTarget(el: HTMLElement, dirPath: string) {
  el.addEventListener("dragover", (e) => {
    if (!canDropInto(dirPath)) return;
    e.preventDefault();
    e.stopPropagation(); // 一覧余白（expListEl）のドロップ受けと二重反応させない
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    el.classList.add("is-drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("is-drop-target"));
  el.addEventListener("drop", (e) => {
    el.classList.remove("is-drop-target");
    if (!canDropInto(dirPath)) return;
    e.preventDefault();
    e.stopPropagation();
    const src = expDragPath;
    expDragPath = null;
    if (src) void moveExplorerEntry(src, dirPath);
  });
}

/** ファイル / フォルダ行をドラッグ元にする */
function wireExplorerDragSource(row: HTMLElement, path: string) {
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    // WebKit は setData が無いとドラッグ自体を開始しない（サイドバー DnD と同じ）
    e.dataTransfer?.setData("text/plain", path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    expDragPath = path;
    row.classList.add("is-dragging");
  });
  row.addEventListener("dragend", () => {
    expDragPath = null;
    row.classList.remove("is-dragging");
    clearExplorerDropMarks();
  });
}

/** ⌂ の戻り先 = フォーカス中ペインのターミナル起動時のディレクトリ。
    現在の cwd（cd で移動した先）ではない。まだ不明ならファイルシステムのルート */
export function explorerRoot(): string {
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  const p = pane?.initialCwd ?? pane?.spec.cwd;
  return p ? normPath(p) : fsDefaultRoot();
}

function updateExpFavBtn() {
  const on = expCwd !== null && expFavorites.includes(expCwd);
  expFavBtn.textContent = on ? "★" : "☆";
  expFavBtn.classList.toggle("is-on", on);
  expFavBtn.setAttribute("aria-pressed", String(on));
}

export function renderExplorerFavs() {
  expFavsEl.innerHTML = "";
  const cur = focusedCwd();
  expFavsEl.hidden = expFavorites.length === 0 && !cur;
  // 先頭に「セッションの現在地」を常設ピン留め（フォーカス中ペインの cwd に追従。
  // クリックで移動。⌂ の起動時ディレクトリとは別物）
  if (cur) {
    const row = document.createElement("div");
    row.className = "exp-fav-row exp-session-row";
    row.title = t("exp.sessionCwd", { path: cur });
    row.onclick = () => explorerNavigate(cur);
    row.oncontextmenu = expCtxHandler(cur);
    const name = document.createElement("span");
    name.className = "exp-fav-name";
    name.textContent = `➤ ${pathBasename(cur)}`;
    const context = explorerParentContext(cur);
    row.append(name, explorerPathContext(context.text, context.full));
    expFavsEl.append(row);
  }
  for (const path of expFavorites) {
    const row = document.createElement("div");
    row.className = "exp-fav-row";
    row.title = path;
    row.onclick = () => explorerNavigate(path);
    row.oncontextmenu = expCtxHandler(path);
    const name = document.createElement("span");
    name.className = "exp-fav-name";
    name.textContent = `★ ${pathBasename(path)}`;
    const del = document.createElement("button");
    del.className = "exp-fav-del";
    del.textContent = "×";
    del.title = t("exp.favRemove");
    del.onclick = (e) => {
      e.stopPropagation(); // 行クリック（移動）を発火させない
      removeExpFavorite(path);
    };
    const context = explorerParentContext(path);
    row.append(name, explorerPathContext(context.text, context.full), del);
    expFavsEl.append(row);
  }
}

function removeExpFavorite(path: string) {
  expFavorites = expFavorites.filter((p) => p !== path);
  renderExplorerFavs();
  updateExpFavBtn();
  scheduleSave();
}

export function toggleExpFavorite(path: string) {
  if (expFavorites.includes(path)) {
    removeExpFavorite(path);
    return;
  }
  expFavorites.push(path);
  renderExplorerFavs();
  updateExpFavBtn();
  scheduleSave();
}

export function setExplorerOpen(open: boolean, opts: { save?: boolean } = {}) {
  expOpen = open;
  if (!open) closeExplorerMkdir(false);
  explorerEl.hidden = !open;
  expReopenBtn.hidden = open; // 閉じている間だけ右端アイコンを出す
  // パネルの分だけグリッド幅が変わるので即レイアウト（refit で TUI にも resize が飛ぶ）
  layout();
  if (open) {
    // 開いたらフォーカス中ペインの cwd に同期（閉じている間の cd も expFollowed に
    // 記録済み）。まだ cwd 不明で表示も空なら一旦ルートを出し、以降の追従で差し替わる
    const p = expFollowed ?? focusedCwd();
    if (p) {
      expFollowed = p;
      void explorerShow(p);
    } else if (expCwd === null) {
      void explorerShow(fsDefaultRoot());
    }
    updateGitWatch(); // 下部の git セクションも即 populate（3秒ポーリングを待たない）
  }
  if (opts.save !== false) scheduleSave();
}

expCloseBtn.onclick = () => setExplorerOpen(false);
expReopenBtn.onclick = () => setExplorerOpen(true);

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
          const ws = getActiveWs();
          if (!ws?.root) return;
          const r = ws.layer.getBoundingClientRect();
          place(ws, ws.root, { x: 0, y: 0, w: r.width, h: r.height });
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

expFilterEl.oninput = () => {
  expFilter = expFilterEl.value.trim().toLowerCase();
  // 直下は取得済みの一覧を即座に絞り込み、配下はデバウンス後に追記する
  scheduleExplorerSearch();
  renderExplorerList();
};
expFilterEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    expFilterEl.value = "";
    expFilter = "";
    cancelExplorerSearch();
    renderExplorerList();
    expFilterEl.blur();
  }
});

expRefreshBtn.onclick = () => {
  if (expCwd) void loadExplorer(expCwd, false);
};

expRootBtn.onclick = () => explorerNavigate(explorerRoot());

expFavBtn.onclick = () => {
  if (expCwd) toggleExpFavorite(expCwd);
};

// パス表示の右クリックでも表示中フォルダをメニュー操作できる
expPathEl.addEventListener("contextmenu", (e) => {
  if (expCwd) expCtxHandler(expCwd)(e);
});

// 一覧の余白（行の外）を右クリック → 表示中フォルダのメニュー
// （「新規セッションで開く」= ここでセッションを開く、等がそのまま使える）
expListEl.addEventListener("contextmenu", (e) => {
  if (e.target !== expListEl) return; // 行の上は各行のメニューに任せる
  if (expCwd) expCtxHandler(expCwd, true, expCwd)(e);
});

// 一覧の余白へのドロップ = 表示中フォルダへ移動（展開した枝の中から上へ引き上げる用。
// 行の上は各行のドロップ受けが stopPropagation するので target の一致だけ見ればよい）
expListEl.addEventListener("dragover", (e) => {
  if (e.target !== expListEl || !expCwd || !canDropInto(expCwd)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  expListEl.classList.add("is-drop-target");
});
expListEl.addEventListener("dragleave", (e) => {
  if (e.target === expListEl) expListEl.classList.remove("is-drop-target");
});
expListEl.addEventListener("drop", (e) => {
  expListEl.classList.remove("is-drop-target");
  const dest = expCwd;
  if (e.target !== expListEl || !dest || !canDropInto(dest)) return;
  e.preventDefault();
  const src = expDragPath;
  expDragPath = null;
  if (src) void moveExplorerEntry(src, dest);
});

expHiddenBtn.onclick = () => {
  expShowHidden = !expShowHidden;
  expHiddenBtn.classList.toggle("is-on", expShowHidden);
  expHiddenBtn.setAttribute("aria-pressed", String(expShowHidden));
  // 隠しフォルダの中は走査していないので、検索中なら配下を取り直す
  if (expFilter) scheduleExplorerSearch();
  renderExplorerList(); // 取得済みの一覧をフィルタし直すだけ
};

// 表示中のパスを cwd に、フォーカス中ペインを分割して開く
expNewPaneBtn.onclick = () => {
  const ws = getActiveWs();
  const fid = getFocusedId();
  if (!expCwd || !ws || !fid) return;
  splitPane(ws, fid, "row", { title: "shell", cwd: expCwd });
};

// 表示中のパスを cwd にした新規セッション。名前はディレクトリ名を初期値にする
expNewSessionBtn.onclick = () => {
  if (!expCwd) return;
  explorerNewSession(expCwd);
};
// カーソルを当てると場所フライアウト（Issue #192）。クリック（表示中のパスで作成）は
// そのままに、選んだディレクトリで同じ流儀（名前 = ディレクトリ名）のセッションを作る
attachLocationFlyout(expNewSessionBtn, (cwd) => explorerNewSession(cwd));
