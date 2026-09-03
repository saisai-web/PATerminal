// ============================================================
// ワークスペース CRUD と切替
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { setFocused } from "../terminal/focus";
import { appendSidebarEntry, groupById, placeSidebarEntryAfter, placeSidebarEntryAt } from "./groups";
import { t } from "../i18n";
import { dividerEls, layout, splitRects, syncPaneNotes } from "../terminal/layout";
import { makePane } from "../terminal/pane";
import { flushResizes } from "../terminal/resize";
import type { Pane } from "../terminal/pane";
import { normPath } from "../features/explorer/paths";
import { archiveWorkspace, scheduleSave } from "../app/session";
import { requireFeature } from "../features/license/license";
import { recordRecentDir } from "../features/sidebar/recent-dirs";
import { clearWsSelection } from "../features/sidebar/sidebar-selection";
import { refreshBroadcastMarks, renderSidebar, scrollWsIntoView } from "../features/sidebar/sidebar";
import {
  collapsedGroups,
  getActiveWs,
  getFocusedId,
  getSelectionAnchor,
  panes,
  selectedWsIds,
  setActiveWs,
  setSelectionAnchor,
  workspaces,
} from "./state";
import { firstLeaf } from "../terminal/tree";
import { normalizeWorkspaceNote } from "./note";
import type { PaneSpec, ShellKind, Workspace, WorkspaceBackgroundColor } from "./types";

const grid = document.querySelector<HTMLDivElement>("#grid")!;
const broadcastBtn = document.querySelector<HTMLButtonElement>("#broadcast")!;
const broadcastLabelEl = document.querySelector<HTMLSpanElement>("#broadcast-label")!;
const bcHintEl = document.querySelector<HTMLSpanElement>("#bc-hint")!;

/** createWorkspace から初期ペイン生成と activate を除いた版（復元用） */
export function createEmptyWorkspace(
  id: string | undefined,
  name: string,
  shellKind: ShellKind,
  broadcast: boolean,
  autoEnter = false,
): Workspace {
  const layer = document.createElement("div");
  layer.className = "workspace-layer";
  layer.hidden = true;
  grid.append(layer);

  const ws: Workspace = {
    id: id ?? `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    shellKind,
    broadcast,
    autoEnter,
    broadcastTargets: new Set(),
    root: null,
    layer,
    panes: new Map(),
    activity: "done",
    attention: null,
  };
  workspaces.push(ws);
  return ws;
}

export function createWorkspace(
  name: string,
  shellKind: ShellKind,
  opts?: { activate?: boolean; group?: string; cwd?: string; autoEnter?: boolean; pane?: PaneSpec },
): Workspace {
  const ws = createEmptyWorkspace(undefined, name, shellKind, false, opts?.autoEnter === true);
  ws.group = opts?.group;
  appendSidebarEntry(ws, ws.group);
  ws.root = {
    kind: "leaf",
    pane: makePane(ws, { title: name, cwd: opts?.cwd, ...opts?.pane }),
  };
  // 場所フライアウトの「最近使った場所」へ記録（保存はこの後の scheduleSave に相乗り）
  if (opts?.cwd) recordRecentDir(opts.cwd);
  if (opts?.activate !== false) setActive(ws);
  else renderSidebar();
  scheduleSave();
  return ws;
}

/** 表示中セッションと同じ階層・直後に新規セッションを作る。
    エクスプローラーや Issue など、作成先グループを明示しない入口で共通利用する。 */
export function createWorkspaceBesideActive(
  name: string,
  shellKind: ShellKind,
  opts?: { activate?: boolean; cwd?: string; pane?: PaneSpec },
): Workspace {
  const ref = getActiveWs();
  const ws = createWorkspace(name, shellKind, { ...opts, group: ref?.group });
  if (ref) placeAfter(ws, ref);
  return ws;
}

/** 新規セッション作成で使う、自動採番されたデフォルトセッション名。
    セッションを閉じても既存名と重複しないよう、現在の最大番号の次を返す。 */
export function nextSessionName(): string {
  let max = 0;
  for (const ws of workspaces) {
    const match = /^Session (\d+)$/.exec(ws.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Session ${max + 1}`;
}

export function renameWorkspace(w: Workspace, v: string) {
  w.name = v;
  renderSidebar(); // アバターの頭文字にも即反映
  scheduleSave();
}

export function updateWorkspaceNote(w: Workspace, value: unknown) {
  const note = normalizeWorkspaceNote(value);
  if (w.note === note) return;
  w.note = note;
  // サイドバーは再描画せず（入力フォーカスを維持）、ペインバーだけを同期する。
  // 空↔非空や行数変更で本文領域の高さが変わるため、表示中なら即座に再フィットする。
  if (w === getActiveWs()) layout(w);
  else syncPaneNotes(w);
  scheduleSave();
}

/** ピン済みセッションは所属を変えず、サイドバーの同じ階層内で先頭に表示する。 */
export function toggleWorkspacePinned(w: Workspace) {
  // ソフトロック対象（メニューと行内 📌 の両経路がここを通る）。
  // ピン済みの解除は Locked でも許す（状態から抜けられなくしない）
  if (!w.pinned && !requireFeature()) return;
  w.pinned = w.pinned ? undefined : true;
  renderSidebar();
  scheduleSave();
}

/** セッションのプロセスやペインを維持したまま、通常一覧とアーカイブを行き来させる。
    表示中セッションを退避したときは、次に近い通常セッションへ表示を移す。 */
export function toggleWorkspaceArchived(w: Workspace) {
  if (!workspaces.includes(w)) return;
  const archived = w.archived !== true;
  w.archived = archived ? true : undefined;

  if (archived && getActiveWs() === w) {
    const index = workspaces.indexOf(w);
    const next =
      workspaces.slice(index + 1).find((workspace) => !workspace.archived) ??
      workspaces.slice(0, index).reverse().find((workspace) => !workspace.archived);
    if (next) {
      setActive(next);
      return;
    }
  }
  renderSidebar();
  scheduleSave();
}

/** 右クリックメニューから、単独または複数選択中のセッションへ背景色を付ける。 */
export function setWorkspaceBackgroundColor(
  targets: readonly Workspace[],
  color: WorkspaceBackgroundColor | undefined,
) {
  let changed = false;
  for (const workspace of targets) {
    if (workspace.backgroundColor === color) continue;
    workspace.backgroundColor = color;
    changed = true;
  }
  if (!changed) return;
  renderSidebar();
  scheduleSave();
}

/** セッションの代表ディレクトリ = フォーカス中ペイン（非アクティブなセッション
    なら先頭ペイン）の cwd。まだ分からなければ null */
export function workspacePane(w: Workspace): Pane | undefined {
  const fid = getFocusedId();
  return (fid && w.panes.get(fid)) || firstLeaf(w.root)?.pane;
}

export function workspaceCwd(w: Workspace): string | null {
  const pane = workspacePane(w);
  const p = pane?.cwd ?? pane?.spec.cwd;
  return p ? normPath(p) : null;
}

/** シェル統合（OSC 7）が無い環境でも複製元の現在地を引き継げるよう、Rust から
    プロセスの実 cwd を取得する。終了済みプロセス・未対応 OS では既知値へ退避する。 */
export async function resolveWorkspaceCwd(w: Workspace): Promise<string | null> {
  const pane = workspacePane(w);
  if (!pane) return null;
  let live: string | null = null;
  if (pane.alive) {
    try {
      live = await invoke<string | null>("pty_cwd", { id: pane.id });
    } catch {
      /* OSC 7 / spec.cwd へフォールバック */
    }
  }
  const p = live || pane.cwd || pane.spec.cwd;
  return p ? normPath(p) : null;
}

/** 新規セッションの既定ディレクトリ = 表示中（フォーカス中）ペインのシェルの実 cwd。
    resolveWatchCwd / resolveWorkspaceCwd と同じ順序で pty_cwd を優先し、取れない環境
    （終了済みプロセス・未対応 OS）だけ OSC 7 / spec.cwd に退避する。cd 済みのディレクトリを
    引き継ぐのが目的なので、シェル統合の有無で結果が変わらないようにする */
export async function newSessionCwd(): Promise<string | undefined> {
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  if (!pane) return undefined;
  let live: string | null = null;
  if (pane.alive) {
    try {
      live = await invoke<string | null>("pty_cwd", { id: pane.id });
    } catch {
      /* OSC 7 / spec.cwd へフォールバック */
    }
  }
  const p = live || pane.cwd || pane.spec.cwd;
  return p ? normPath(p) : undefined;
}

/** フォームを出さない新規セッション作成（macOS / Linux の左上 + と右クリックメニュー）。
    名前は自動採番、ディレクトリ・階層・挿入位置は表示中セッションと同じ場所。
    group を明示した場合だけ、そのグループを作成先として優先する。
    cwd を明示した場合（場所フライアウトからの作成）は既定の cwd 解決を行わない。 */
export async function quickCreateWorkspace(
  opts: { group?: string; after?: Workspace | null; at?: number; cwd?: string } = {},
) {
  // 作成先を明示しない入口（サイドバー余白を含む）は、クイック作成と同じく
  // 表示中セッションを基準にする。await 中に activeWs が変わっても配置がぶれないよう先に捕捉する。
  const ref = opts.after === undefined ? getActiveWs() : opts.after;
  const group = opts.group ?? ref?.group;
  const cwd = opts.cwd !== undefined ? opts.cwd : await newSessionCwd();
  const ws = createWorkspace(nextSessionName(), "default", { group, cwd });
  if (opts.at !== undefined) {
    placeSidebarEntryAt(ws, group, opts.at);
    renderSidebar();
  } else if (ref && ref.group === group) {
    placeAfter(ws, ref); // 待っている間に閉じられていても placeAfter が吸収する
  }
  return ws;
}

/** 一覧（workspaces 配列 = 表示順）で ws を ref の直後へ差し替える。
    グループは配列順では決まらないので、呼び出し側で ref に合わせておくこと */
export function placeAfter(ws: Workspace, ref: Workspace) {
  if (ws === ref) return;
  const from = workspaces.indexOf(ws);
  if (from < 0) return;
  workspaces.splice(from, 1);
  const at = workspaces.indexOf(ref);
  if (at < 0) workspaces.splice(from, 0, ws); // ref が消えていたら元の位置へ戻す
  else {
    workspaces.splice(at + 1, 0, ws);
    if (ws.group === ref.group) placeSidebarEntryAfter(ws, ref);
  }
  renderSidebar();
  // 新規作成直後の並び替えでも、最終位置の表示中セッションへサイドバーを合わせる。
  if (getActiveWs() === ws) scrollWsIntoView(ws);
  scheduleSave();
}

/** 「{name}のコピー」テンプレートから照合用の正規表現を作る。言語ごとに埋め込み
    位置が違う（前置き・後置き）ので、生テンプレートを {name} / {n} で割って組み立てる */
export function copyNameRe(tpl: string): RegExp {
  const esc = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = tpl
    .split("{name}")
    .map((part) => part.split("{n}").map(esc).join("\\d+"))
    .join("(.+)");
  return new RegExp("^" + body + "$");
}

/** 複製名。すでにコピー名なら元名を取り出して連番だけ増やす（「のコピーのコピー」を
    作らない）。1つ目は「元名のコピー」、以降は「元名のコピー 2」「… 3」 */
export function copyWorkspaceName(srcName: string): string {
  // 現在の言語のテンプレート（パラメータ無しの t() は生テンプレートを返す）から元名を
  // 復元する。ws.copyOfN は {name} の直後にリテラルを置く必要がある（前置き語順の
  // 言語では "(2)" のように囲む）。言語を切り替えた後に付いた名前は一致しないので
  // srcName をそのまま使う
  const base =
    copyNameRe(t("ws.copyOfN")).exec(srcName)?.[1] ??
    copyNameRe(t("ws.copyOf")).exec(srcName)?.[1] ??
    srcName;
  const used = new Set(workspaces.map((w) => w.name));
  for (let n = 1; ; n++) {
    const name =
      n === 1 ? t("ws.copyOf", { name: base }) : t("ws.copyOfN", { name: base, n: String(n) });
    if (!used.has(name)) return name; // 名前は有限個なので必ず抜ける
  }
}

/** 右クリックメニューの数量指定で一度に作れるコピーの上限。
    1回の操作で PTY をいくつも起こすので、事故で数十個作られない程度に抑える */
export const MAX_DUPLICATE_COUNT = 20;

/** セッションの複製。ペインは1つだけ作り、元セッションのフォーカス中ペイン
    （非アクティブなセッションなら先頭ペイン）と同じディレクトリで開く。
    count を渡すと同じコピーを一度にその数だけ作る（元の直後に作った順で並ぶ） */
export async function duplicateWorkspace(src: Workspace, count = 1) {
  const n = Math.max(1, Math.min(MAX_DUPLICATE_COUNT, Math.floor(count) || 1));
  // cwd の解決は元セッション1つぶんで足りる（コピーは全部同じディレクトリ）
  const cwd = await resolveWorkspaceCwd(src);
  // cwd 解決待ちの間に元セッションが閉じられた場合は複製しない。
  if (!workspaces.includes(src)) return;
  // 一覧では元セッションの直後に、作った順で並べる（workspaces 配列 = 表示順）。
  // 途中のコピーを activate すると表示切替と pty_set_visible を人数分往復するので、
  // 表示するのは最後の1つだけにする
  let ref = src;
  let last: Workspace | null = null;
  for (let i = 0; i < n; i++) {
    // 名前は既存名の空き番号から採るので、1つ作るごとに次の番号へ進む
    const ws = createWorkspace(copyWorkspaceName(src.name), src.shellKind, {
      group: src.group,
      cwd: cwd ?? undefined,
      autoEnter: src.autoEnter,
      activate: false,
    });
    ws.note = src.note;
    ws.backgroundColor = src.backgroundColor;
    placeAfter(ws, ref);
    ref = ws;
    last = ws;
  }
  if (!last) return;
  setActive(last);
  // 複製直後はそのまま打てるようターミナルへフォーカスを戻す（以前はここで名前の
  // インライン編集を開いていたが、続けてコマンドを打つ方が多いためユーザー要望で撤去。
  // リネームは右クリックメニューの「名前を変更」から）。
  // setActive でも focus するが、その後の renderSidebar を挟むため最後にもう一度当てる
  const pane = firstLeaf(last.root)?.pane;
  if (pane) setFocused(pane.id);
}

/** ツールバーのボタン・ヒント・ペイン枠・サイドバーの送信先マークを一斉入力の状態に
    合わせる。表示反映はここに一元化し、setActive と言語切替の両方から呼ぶ。
    送信先が空（従来どおりセッション内で閉じる）ときは文言も従来のままにする。 */
export function renderBroadcastUi(ws: Workspace) {
  const n = ws.broadcast ? ws.broadcastTargets.size : 0;
  document.body.classList.toggle("broadcasting", ws.broadcast);
  broadcastLabelEl.textContent = !ws.broadcast
    ? t("toolbar.broadcast")
    : n
      ? t("toolbar.broadcastOnN", { n: String(n + 1) })
      : t("toolbar.broadcastOn");
  broadcastBtn.title = ws.broadcast ? t("toolbar.broadcastOffTitle") : t("toolbar.broadcastTitle");
  broadcastBtn.setAttribute("aria-pressed", String(ws.broadcast));
  bcHintEl.hidden = !ws.broadcast;
  bcHintEl.textContent = n
    ? t("toolbar.broadcastHintN", { n: String(n + 1) })
    : t("toolbar.broadcastHint");
  refreshBroadcastMarks();
}

export function setActive(ws: Workspace) {
  // 同一セッションへの状態再適用（broadcast 切替など）では、ユーザーが遡って見ている
  // スクロール位置を壊さない。非表示から開き直すときだけ末尾へ戻す。
  const reopening = ws.layer.hidden;
  // 表示中セッションが変わる経路は、サイドバークリック以外にも新規作成・履歴・
  // 数字ショートカットなど多数ある。操作対象の選択をここで新しい1件へ揃えないと、
  // 以前の選択と新しい active の両方に選択マークが残る。同じ active への再適用
  // （broadcast の表示更新など）では、ユーザーが明示した複数選択を維持する。
  if (getActiveWs() !== ws) {
    selectedWsIds.clear();
    selectedWsIds.add(ws.id);
    setSelectionAnchor(ws.id);
    // 「最近操作した順」の並べ替えはこの時刻だけを見る。同じ active への再適用や
    // キー入力では動かさない（入力できるのはアクティブセッションだけなので足りる）
    ws.lastOpAt = Date.now();
    scheduleSave();
  }
  setActiveWs(ws);
  ws.attention = null; // 見に来たので注意表示は消す

  // 折りたたみ中グループのセッションがアクティブになったら祖先まで自動展開する
  let expanded = false;
  let group = groupById(ws.group);
  const seenGroups = new Set<string>();
  while (group && !seenGroups.has(group.id)) {
    seenGroups.add(group.id);
    if (collapsedGroups.delete(group.id)) expanded = true;
    group = groupById(group.parentId);
  }
  if (expanded) scheduleSave();
  for (const w of workspaces) w.layer.hidden = w !== ws;
  // 可視状態を Rust に伝える。非表示ペインの出力は Rust 側で堰き止められる
  const shownIds: string[] = [];
  const hiddenIds: string[] = [];
  for (const w of workspaces) {
    for (const id of w.panes.keys()) (w === ws ? shownIds : hiddenIds).push(id);
  }
  if (hiddenIds.length) void invoke("pty_set_visible", { ids: hiddenIds, visible: false });
  // ブロードキャスト表示はアクティブセッションの状態を反映
  renderBroadcastUi(ws);
  // 表示してから layout（非表示中は寸法ゼロで fit が失敗する）
  layout(ws);
  // xterm の viewport は hidden 中や再表示時のリフローで先頭位置が残ることがある。
  // layout/refit 後に末尾へ送っておけば、このあと Rust から解禁される保留出力も
  // 「末尾を見ている」状態のまま追従する。
  if (reopening) {
    for (const pane of ws.panes.values()) pane.scrollToBottom();
  }
  // **サイズを確定させてから溜まった出力を解禁する。** 非表示中にペイン幅が変わって
  // いると、pty_set_visible が先だと旧サイズで描かれた出力（最大2MB）が新しい
  // グリッドへ流し込まれる。pty_resize と pty_set_visible は別々の非同期コマンドで
  // 順序保証が無いので、ここで明示的に待つ。保留が無ければマイクロタスクで解決する
  if (shownIds.length) {
    void flushResizes(shownIds)
      .catch(() => {})
      .then(() => invoke("pty_set_visible", { ids: shownIds, visible: true }));
  }
  // 同一セッション内での再適用（broadcast トグル等）ではフォーカスを維持する
  const fid = getFocusedId();
  const keep = fid && ws.panes.has(fid) ? fid : firstLeaf(ws.root)?.pane.id;
  if (keep) setFocused(keep);
  renderSidebar();
  // グループ階層・作成経路を問わず、表示中セッションがサイドバーでも見える位置に来る。
  scrollWsIntoView(ws);
  for (const cb of activeWatchers) cb();
}

/** setActive の後処理。機能側の追従（ペアストリップ等）を main.ts が登録する。
    workspace.ts から features/ を import して新しい循環を作らないための逆向きフック */
const activeWatchers: Array<() => void> = [];
export function onActiveWorkspaceChange(cb: () => void): void {
  activeWatchers.push(cb);
}

const closingWorkspaces = new WeakSet<Workspace>();

export async function closeWorkspace(ws: Workspace) {
  const idx = workspaces.indexOf(ws);
  if (idx < 0 || closingWorkspaces.has(ws)) return;
  closingWorkspaces.add(ws);
  try {
    // 一覧・画面からは先に外す。スクロールバックの退避（アーカイブ）はアイドル
    // スライス待ちで数百msかかることがあり、先に待つと × が効いていないように
    // 見えるうえ、待機中に workspaces が変わると取得済み idx がずれて別の
    // セッションを消してしまう。採取は Pane.destroy 前ならよく、非表示ペインでも
    // SerializeAddon はバッファから読めるので（通常保存と同じ）、表示上の
    // クローズを済ませてから退避する
    workspaces.splice(idx, 1);
    selectedWsIds.delete(ws.id); // 閉じたセッションを選択に残さない
    if (getSelectionAnchor() === ws.id) setSelectionAnchor(null);
    ws.layer.hidden = true;
    if (workspaces.length === 0) {
      createWorkspace("Session 1", "default");
    } else if (getActiveWs() === ws) {
      setActive(workspaces[Math.max(0, idx - 1)]);
    }
    renderSidebar();
    // destroy 前でなければ xterm の表示履歴を取得できない。退避が完了してから破棄する
    await archiveWorkspace(ws, idx);
    await Promise.all([...ws.panes.values()].map((p) => p.destroy()));
    // このレイヤーに属するディバイダの参照を回収
    for (const [split, el] of [...dividerEls]) {
      if (el.parentElement === ws.layer) {
        dividerEls.delete(split);
        splitRects.delete(split);
      }
    }
    ws.layer.remove();
    scheduleSave();
  } finally {
    closingWorkspaces.delete(ws);
  }
}
/** 選択中のセッションをまとめて閉じる。closeWorkspace が workspaces を書き換えるので
    対象を先に確定してから順に閉じる（グループ一括クローズと同じ手順） */
export async function closeWorkspaces(list: Workspace[]) {
  const targets = [...list];
  for (const w of targets) {
    if (workspaces.includes(w)) await closeWorkspace(w);
  }
  clearWsSelection();
  renderSidebar();
  scheduleSave();
}
// ============================================================
// サイドバー
// ============================================================

export function wsSubtitle(ws: Workspace): string {
  // 先頭ペインの cwd をサブタイトルとして出す
  const first = firstLeaf(ws.root);
  return first?.pane.cwd ?? "";
}

/** サイドバーでは cwd の末尾2階層だけを表示する。
    省略前の全文は title に残すので、パス操作には影響しない。 */
export function compactWsPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `.../${parts.slice(-2).join("/")}`;
}
