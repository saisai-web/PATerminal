// ============================================================
// 履歴の引き継ぎ（共通履歴ダイアログの会話履歴タブ）
//
// 別のセッション・別のターミナル・過去の起動で動いていた claude / codex の
// 会話を、新しいセッションとして再開するためのモーダル。一覧は1つだけで、
// agent_session_list が CLI の保存ファイルから読んだ履歴を新しい順に表示する。
//
// - このアプリ内で実行中の会話（pty_agents の検知 = PaneSpec.agent と
//   sessionId で一致）には「実行中」バッジと、そのペインへ移動する「表示」を出す
// - 由来が分かる行には、やりとりしていたセッション名と所属グループも表示する
//   （稼働中のセッション + 最近削除したセッションの保存データと sessionId で照合）
//
// 「新規セッションで開く」は即作成せず、行の下に作成先パスの入力
// （初期値 = 会話の元ディレクトリ。「参照…」で OS のフォルダ選択ダイアログも
// 使える）と「開く / キャンセル」を展開してから作る。実行中の会話は
// 二重プロセスになるため、展開内に警告文を出して確認を兼ねる
// （window.confirm は WKWebView で使わない方針）。
//
// 走査（agent_session_list）はモーダルを開いた時だけ実行する（ポーリングには
// 使わない・ルール3/5）。セッション ID は Rust 側の valid_session_id と
// フロントの isValidSessionId の両方を通ったものしかコマンドに載せない。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { getLang, t } from "../../i18n";
import { requireFeature } from "../license/license";
import type { Pane } from "../../terminal/pane";
import { workspaces } from "../../workspace/state";
import type { DeletedWorkspace, SerializedNode, Workspace } from "../../workspace/types";
import { isKnownAgent, isValidSessionId, resumeCommandFor } from "./agents";
import {
  closeHistoryDialog,
  type HistoryDialogTabController,
} from "../history/history-dialog";

/** agent_session_list の1件。Rust 側 AgentSessionEntry と対 */
type AgentSessionEntry = {
  kind: string;
  id: string;
  cwd: string;
  summary: string | null;
  updatedMs: number;
};

type RunningRow = { ws: Workspace; pane: Pane; kind: string; sessionId?: string };

/** sessionId から引いた「その会話をやりとりしていたセッション」の情報 */
type Origin = { name: string; group: string | null; deleted?: boolean };

type TakeoverOptions = {
  /** cwd に新規セッションを開き、run を初回コマンドとして自動入力する */
  openSession: (opts: { name: string; cwd?: string; run: string }) => void;
  /** 実行中の会話が動いているペインへ移動する */
  showPane: (ws: Workspace, paneId: string) => void;
  /** WorkspaceGroup.id → 親階層込みの表示パス（未所属・不明は null） */
  groupPathOf: (groupId: string | undefined) => string | null;
  /** 最近削除したセッション（由来表示の照合用） */
  deletedWorkspaces: () => DeletedWorkspace[];
};

/** 会話の要約から付ける新規セッション名の上限 */
const SESSION_NAME_MAX = 24;

const historyListEl = document.querySelector<HTMLDivElement>("#takeover-history")!;
const historyStatusEl = document.querySelector<HTMLDivElement>("#takeover-history-status")!;

let options: TakeoverOptions | null = null;
/** 開いている間の履歴読み込み世代。閉じる・開き直すたびに進め、古い応答を捨てる */
let loadGen = 0;
/** 同じダイアログを開いている間は、タブを往復しても走査を繰り返さない。 */
let loadedThisOpen = false;
/** 開いている作成先確認（同時に1つ）。別の行を開く・再描画する前に閉じる */
let closeConfirm: (() => void) | null = null;

/** epoch ミリ秒 → 相対表記（"3分前"）。表示言語に追従する */
function relTime(epochMs: number): string {
  if (!epochMs) return "";
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });
  const diff = epochMs - Date.now();
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, "minute"],
    [3_600_000, "hour"],
    [86_400_000, "day"],
    [2_592_000_000, "month"],
    [31_536_000_000, "year"],
  ];
  if (Math.abs(diff) < 60_000) return rtf.format(0, "minute");
  let unitMs = 60_000;
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  for (const [ms, u] of steps) {
    if (Math.abs(diff) >= ms) {
      unitMs = ms;
      unit = u;
    }
  }
  return rtf.format(Math.trunc(diff / unitMs), unit);
}

/** サイドバーの cwd 表示と同じ「末尾2階層 + 全文 title」の詰め方 */
function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `.../${parts.slice(-2).join("/")}`;
}

/** このアプリ内で実行中（または復元直後で実行予定）の会話 */
function runningRows(): RunningRow[] {
  const rows: RunningRow[] = [];
  for (const ws of workspaces) {
    for (const pane of ws.panes.values()) {
      const agent = pane.spec.agent;
      if (!pane.alive || !agent || !isKnownAgent(agent.kind)) continue;
      rows.push({
        ws,
        pane,
        kind: agent.kind,
        sessionId: isValidSessionId(agent.sessionId) ? agent.sessionId : undefined,
      });
    }
  }
  return rows;
}

/** 保存ツリーの leaf から検知済み sessionId を集める（削除済みセッションの照合用） */
function leafSessionIds(node: SerializedNode, out: string[] = []): string[] {
  if (node.kind === "leaf") {
    const id = node.agent?.sessionId;
    if (isValidSessionId(id)) out.push(id);
  } else {
    leafSessionIds(node.a, out);
    leafSessionIds(node.b, out);
  }
  return out;
}

/** sessionId → やりとりしていたセッションの照合表。
    稼働中を優先し、無ければ最近削除したセッションの保存データから引く */
function originMap(): Map<string, Origin> {
  const map = new Map<string, Origin>();
  for (const saved of options?.deletedWorkspaces() ?? []) {
    for (const id of leafSessionIds(saved.root)) {
      if (!map.has(id)) {
        map.set(id, {
          name: saved.name,
          group: options?.groupPathOf(saved.group) ?? null,
          deleted: true,
        });
      }
    }
  }
  for (const ws of workspaces) {
    for (const pane of ws.panes.values()) {
      const id = pane.spec.agent?.sessionId;
      if (isValidSessionId(id)) {
        map.set(id, { name: ws.name, group: options?.groupPathOf(ws.group) ?? null });
      }
    }
  }
  return map;
}

function kindBadge(kind: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "takeover-kind";
  badge.textContent = kind; // エージェント名は固有名詞（翻訳しない）
  return badge;
}

function cwdEl(cwd: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "takeover-cwd";
  el.textContent = compactPath(cwd);
  el.title = cwd;
  return el;
}

/** 由来（セッション名 + グループ + 削除済み印）のメタ行。不明なら null */
function originEl(origin: Origin | undefined): HTMLDivElement | null {
  if (!origin) return null;
  const line = document.createElement("div");
  line.className = "takeover-origin";
  const name = document.createElement("span");
  name.className = "takeover-origin-name";
  name.textContent =
    t("takeover.origin", { name: origin.name }) +
    (origin.deleted ? ` ${t("takeover.originDeleted")}` : "");
  name.title = origin.name;
  line.append(name);
  if (origin.group) {
    const group = document.createElement("span");
    group.className = "takeover-origin-group";
    group.textContent = t("takeover.originGroup", { group: origin.group });
    group.title = origin.group;
    line.append(group);
  }
  return line;
}

/** 新規セッションを開いて再開コマンドを自動入力する。名前は要約の先頭を使う */
function openConversation(
  kind: string,
  sessionId: string | undefined,
  cwd: string | undefined,
  summary?: string | null,
): void {
  const cmd = resumeCommandFor({ kind, sessionId });
  if (!cmd) return;
  const trimmed = (summary ?? "").trim();
  const name = trimmed
    ? trimmed.length > SESSION_NAME_MAX
      ? `${trimmed.slice(0, SESSION_NAME_MAX)}…`
      : trimmed
    : kind;
  options?.openSession({ name, cwd: cwd || undefined, run: cmd });
  closeHistoryDialog();
}

/** 行の下に作成先パスの確認 UI を展開する。開けるのは同時に1つだけ。
    実行中の会話には二重プロセスの警告文を出して確認を兼ねる */
function expandConfirm(
  row: HTMLDivElement,
  opts: { cwd?: string; running: boolean; onOpen: (cwd: string | undefined) => void },
): void {
  if (row.classList.contains("is-expanded")) return; // 同じ行の再クリックは何もしない
  closeConfirm?.();
  const box = document.createElement("div");
  box.className = "takeover-confirm";
  const close = () => {
    box.remove();
    row.classList.remove("is-expanded");
    if (closeConfirm === doClose) closeConfirm = null;
  };
  const doClose = close;

  if (opts.running) {
    const warn = document.createElement("p");
    warn.className = "takeover-warning";
    warn.textContent = t("takeover.runningWarning");
    box.append(warn);
  }

  const field = document.createElement("div");
  field.className = "takeover-dest";
  const caption = document.createElement("span");
  caption.className = "takeover-dest-label";
  caption.textContent = t("takeover.destination");
  const destRow = document.createElement("div");
  destRow.className = "takeover-dest-row";
  const input = document.createElement("input");
  input.type = "text";
  input.value = opts.cwd ?? "";
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.setAttribute("autocomplete", "off");
  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "takeover-browse";
  browse.textContent = t("takeover.browse");
  browse.onclick = async () => {
    // OS のフォルダ選択（Finder / エクスプローラー）。キャンセルは何もしない
    browse.disabled = true;
    try {
      const picked = await openFolderDialog({
        directory: true,
        multiple: false,
        title: t("takeover.destination"),
        defaultPath: input.value.trim() || opts.cwd,
      });
      if (typeof picked === "string" && picked) input.value = picked;
    } catch (e) {
      console.error("folder picker failed:", e);
    } finally {
      browse.disabled = false;
      input.focus();
    }
  };
  destRow.append(input, browse);
  field.append(caption, destRow);
  box.append(field);

  const submit = () => {
    const path = input.value.trim() || opts.cwd;
    opts.onOpen(path || undefined);
  };
  // panel の keydown（Escape = モーダルを閉じる）より先に受けて、展開だけを閉じる
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") submit();
    else if (event.key === "Escape") close();
  });

  const actions = document.createElement("div");
  actions.className = "takeover-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("takeover.cancel");
  cancel.onclick = close;
  const openConfirmBtn = document.createElement("button");
  openConfirmBtn.type = "button";
  openConfirmBtn.className = "is-primary";
  openConfirmBtn.textContent = t("takeover.openConfirm");
  openConfirmBtn.onclick = submit;
  actions.append(cancel, openConfirmBtn);
  box.append(actions);

  row.append(box);
  row.classList.add("is-expanded");
  closeConfirm = doClose;
  input.focus();
}

async function loadHistory(): Promise<void> {
  const gen = loadGen;
  historyListEl.textContent = "";
  historyStatusEl.textContent = t("takeover.loading");
  historyStatusEl.classList.remove("is-error");
  historyStatusEl.hidden = false;
  let entries: AgentSessionEntry[];
  try {
    const raw = await invoke<AgentSessionEntry[]>("agent_session_list");
    // ID・種別はフロント側でも検証を通す（シェルへ入力する文字列になるため）
    entries = (Array.isArray(raw) ? raw : []).filter(
      (entry) =>
        isKnownAgent(entry.kind) &&
        isValidSessionId(entry.id) &&
        typeof entry.cwd === "string" &&
        entry.cwd.length > 0,
    );
  } catch {
    if (gen !== loadGen) return; // 旧バイナリ等。await 中に閉じていれば何もしない
    historyStatusEl.textContent = t("takeover.loadFailed");
    historyStatusEl.classList.add("is-error");
    return;
  }
  if (gen !== loadGen) return; // await 中に閉じた・開き直した
  if (entries.length === 0) {
    historyStatusEl.textContent = t("takeover.historyEmpty");
    return;
  }
  historyStatusEl.hidden = true;
  renderHistory(entries);
}

function renderHistory(entries: AgentSessionEntry[]): void {
  historyListEl.textContent = "";
  // 実行中の会話は同じ一覧の中でバッジ + 「表示」ボタンとして表す（専用セクションは持たない）
  const runningBySession = new Map<string, RunningRow>();
  for (const row of runningRows()) {
    if (row.sessionId) runningBySession.set(row.sessionId, row);
  }
  const origins = originMap();
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "takeover-row";
    item.setAttribute("role", "listitem");
    const line = document.createElement("div");
    line.className = "takeover-row-main";

    const info = document.createElement("div");
    info.className = "takeover-info";
    const main = document.createElement("div");
    main.className = "takeover-main";
    main.append(kindBadge(entry.kind));
    const name = document.createElement("span");
    name.className = "takeover-name";
    name.textContent = entry.summary ?? t("takeover.noSummary");
    name.title = entry.summary ?? "";
    main.append(name);
    const running = runningBySession.get(entry.id);
    if (running) {
      const badge = document.createElement("span");
      badge.className = "takeover-running-badge";
      badge.textContent = t("takeover.runningBadge");
      main.append(badge);
    }
    const meta = document.createElement("div");
    meta.className = "takeover-meta";
    meta.append(cwdEl(entry.cwd));
    const time = document.createElement("span");
    time.className = "takeover-time";
    time.textContent = relTime(entry.updatedMs);
    meta.append(time);
    info.append(main, meta);
    const origin = originEl(origins.get(entry.id));
    if (origin) info.append(origin);
    line.append(info);

    if (running) {
      const show = document.createElement("button");
      show.type = "button";
      show.className = "takeover-show";
      show.textContent = t("takeover.show");
      show.title = t("takeover.showTitle");
      show.onclick = () => {
        options?.showPane(running.ws, running.pane.id);
        closeHistoryDialog();
      };
      line.append(show);
    }

    const open = document.createElement("button");
    open.type = "button";
    open.className = "takeover-open-btn";
    open.textContent = t("takeover.open");
    open.title = t("takeover.openTitle");
    open.onclick = () =>
      expandConfirm(item, {
        cwd: entry.cwd,
        running: !!running,
        onOpen: (path) => openConversation(entry.kind, entry.id, path, entry.summary),
      });
    line.append(open);

    item.append(line);
    historyListEl.append(item);
  }
}

export function initTakeover(deps: TakeoverOptions): HistoryDialogTabController {
  options = deps;
  return {
    activate: () => {
      // 会話履歴はソフトロック対象。拒否されたときは共通ダイアログ側が
      // 現在のタブ（または閉じた状態）を維持する。
      if (!requireFeature()) return false;
      if (!loadedThisOpen) {
        loadedThisOpen = true;
        void loadHistory();
      }
      return true;
    },
    deactivate: () => {
      // 作成先入力へ残ったフォーカスや展開状態を別タブへ持ち越さない。
      closeConfirm?.();
    },
    reset: () => {
      loadGen++;
      loadedThisOpen = false;
      closeConfirm?.();
      closeConfirm = null;
    },
  };
}
