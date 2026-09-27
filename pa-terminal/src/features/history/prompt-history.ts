// ============================================================
// 入力履歴（セッションごとに claude / codex へ送った入力を振り返る）
//
// 左 = サイドバーと同じグループ階層のセッション一覧（アーカイブは除く）、
// 右 = 選んだセッション（またはグループ配下の全セッション）の会話ごとのタイムライン。
// 索引は Workspace.agentHistory（features/agents/watch.ts が会話 ID を解決するたびに
// 追記）で、本文は CLI 自身の保存ファイルから agent_session_prompts が
// 1回の IPC でまとめて読む。セッションを選んだ時だけ読み、開いている間は
// 会話単位でキャッシュする（ポーリングしない・並列 invoke を作らない）。
//
// 各入力は「コピー」と「ターミナルへ入力」（Enter は送らない）で再利用できる。
// 改行を含む入力は相手の TUI が bracketed paste を有効にしていればマーカーで包む
// （features/pair/pair.ts の pasteToPane と同じ変換）。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { getLang, t } from "../../i18n";
import { copyText } from "../../shared/clipboard";
import { requireFeature } from "../license/license";
import type { Pane } from "../../terminal/pane";
import { getActiveWs, workspaces } from "../../workspace/state";
import type { AgentConversationRef, Workspace, WorkspaceGroup } from "../../workspace/types";

/** agent_session_prompts の1件。Rust 側 AgentConversationPrompts と対 */
type ConversationPrompts = {
  kind: string;
  id: string;
  found: boolean;
  omitted: number;
  prompts: AgentPrompt[];
};
type AgentPrompt = { text: string; timestamp: string | null; images: number; command: boolean };

type AgentFilter = "all" | "claude" | "codex";

type PromptHistoryOptions = {
  /** セッションを表示し、入力先のペイン（フォーカス中 or 先頭）を返す */
  targetPane: (ws: Workspace) => Pane | null;
  /** 実行中の会話が動いているペインへ移動する */
  showPane: (ws: Workspace, paneId: string) => void;
  /** サイドバーと同じ表示順の、同じ親階層のセッションとグループ */
  sidebarEntries: (parentId?: string) => Array<Workspace | WorkspaceGroup>;
  focusTerminal: () => void;
};

const COPIED_MS = 1400;

const openBtn = document.querySelector<HTMLButtonElement>("#prompt-history-open")!;
const overlay = document.querySelector<HTMLDivElement>("#prompt-history-overlay")!;
const panel = document.querySelector<HTMLDivElement>("#prompt-history-panel")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#prompt-history-close")!;
const refreshBtn = document.querySelector<HTMLButtonElement>("#prompt-history-refresh")!;
const searchEl = document.querySelector<HTMLInputElement>("#prompt-history-search")!;
const sessionsEl = document.querySelector<HTMLDivElement>("#prompt-history-sessions")!;
const summaryEl = document.querySelector<HTMLDivElement>("#prompt-history-summary")!;
const statusEl = document.querySelector<HTMLDivElement>("#prompt-history-status")!;
const timelineEl = document.querySelector<HTMLDivElement>("#prompt-history-timeline")!;

let options: PromptHistoryOptions | null = null;
/** 右ペインの対象。グループは配下（サブグループ含む）の全セッションをまとめて表示する */
type Selection = { kind: "ws"; id: string } | { kind: "group"; id: string };
let selection: Selection | null = null;
/** 一覧でたたんだグループ（開いている間だけ保持） */
const collapsedNav = new Set<string>();
/** 記録のないセッションも一覧に出すか */
let showEmptySessions = false;
let agentFilter: AgentFilter = "all";
/** "kind:id" → 読み込んだ会話。開いている間だけ保持する */
const cache = new Map<string, ConversationPrompts>();
/** 読み込み世代。閉じる・選び直すたびに進め、古い応答を捨てる */
let loadGen = 0;

const refKey = (kind: string, id: string) => `${kind}:${id}`;

const isWs = (entry: Workspace | WorkspaceGroup): entry is Workspace => "panes" in entry;

/** 「すべて」フィルターに出るセッション = アーカイブ以外 */
function listed(ws: Workspace): boolean {
  return ws.archived !== true;
}

/** サイドバーと同じ順（ピン留めしたセッションを先頭）の子要素 */
function childEntries(parentId?: string): Array<Workspace | WorkspaceGroup> {
  const entries = (options?.sidebarEntries(parentId) ?? []).filter((e) => !isWs(e) || listed(e));
  return [
    ...entries.filter((e) => isWs(e) && e.pinned),
    ...entries.filter((e) => !isWs(e) || !e.pinned),
  ];
}

/** グループ配下（サブグループ含む）のセッションを表示順で */
function groupSessions(groupId: string): Workspace[] {
  const out: Workspace[] = [];
  for (const entry of childEntries(groupId)) {
    if (isWs(entry)) out.push(entry);
    else out.push(...groupSessions(entry.id));
  }
  return out;
}

function groupOf(id: string): WorkspaceGroup | null {
  const find = (parentId?: string): WorkspaceGroup | null => {
    for (const entry of childEntries(parentId)) {
      if (isWs(entry)) continue;
      if (entry.id === id) return entry;
      const hit = find(entry.id);
      if (hit) return hit;
    }
    return null;
  };
  return find();
}

/** 右ペインに並べるセッション */
function selectedSessions(): Workspace[] {
  if (!selection) return [];
  if (selection.kind === "group") return groupSessions(selection.id);
  const ws = workspaces.find((w) => w.id === selection!.id);
  return ws && listed(ws) ? [ws] : [];
}

function selectionKey(sel: Selection | null): string {
  return sel ? `${sel.kind}:${sel.id}` : "";
}

function historyOf(ws: Workspace): AgentConversationRef[] {
  return ws.agentHistory ?? [];
}

/** 実行中の会話 → そのペイン */
function runningPanes(ws: Workspace): Map<string, Pane> {
  const map = new Map<string, Pane>();
  for (const pane of ws.panes.values()) {
    const agent = pane.spec.agent;
    if (pane.alive && agent?.sessionId) map.set(refKey(agent.kind, agent.sessionId), pane);
  }
  return map;
}

function parseTime(ts: string | null): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 今日なら時刻だけ、それ以外は日付つき */
function formatTime(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = sameDay(date, new Date())
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat(getLang(), opts).format(date);
}

function formatFullTime(ms: number | null): string {
  if (ms === null) return "";
  return new Intl.DateTimeFormat(getLang(), { dateStyle: "full", timeStyle: "medium" }).format(
    new Date(ms),
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** 1本の stroke アイコン（ツールバーと同じ線の太さ） */
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ph-icon");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
const ICON_COPY = ["M9 9h11v11H9z", "M5 15H4V4h11v1"];
const ICON_CHECK = ["M5 12.5l4.5 4.5L19 7"];
const ICON_INSERT = ["M4 7l4 5-4 5", "M11 17h9"];
const ICON_CHEVRON = ["M6 9l6 6 6-6"];
const ICON_IMAGE = ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15 9h.01"];
const ICON_FOLDER = ["M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"];
const ICON_EMPTY = ["M4 7l4 5-4 5", "M11 7h9", "M11 12h9", "M11 17h6"];

function iconButton(
  className: string,
  label: string,
  paths: string[],
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = el("button", `ph-icon-btn ${className}`);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(paths));
  button.onclick = (event) => {
    event.stopPropagation();
    onClick(button);
  };
  return button;
}

function kindBadge(kind: string): HTMLSpanElement {
  const badge = el("span", "ph-kind", kind); // エージェント名は固有名詞（翻訳しない）
  badge.dataset.kind = kind;
  return badge;
}

/** 検索語を <mark> で強調したテキストを node へ入れる（innerHTML は使わない） */
function appendHighlighted(node: HTMLElement, text: string, query: string): void {
  if (!query) {
    node.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(query, from);
    if (at < 0) break;
    if (at > from) node.append(text.slice(from, at));
    node.append(el("mark", undefined, text.slice(at, at + query.length)));
    from = at + query.length;
  }
  if (from < text.length) node.append(text.slice(from));
}

// ---------------- セッション一覧（グループ階層） ----------------

/** 一覧に出すか。記録のないセッションは既定で隠す（表示中のセッションと選択中は常に出す） */
function shownInNav(ws: Workspace): boolean {
  return (
    showEmptySessions ||
    historyOf(ws).length > 0 ||
    ws === getActiveWs() ||
    (selection?.kind === "ws" && selection.id === ws.id)
  );
}

function navItem(className: string, sel: Selection, depth: number): HTMLButtonElement {
  const row = el("button", `ph-nav-item ${className}`);
  row.type = "button";
  row.setAttribute("role", "treeitem");
  row.dataset.sel = selectionKey(sel);
  row.style.setProperty("--ph-depth", String(depth));
  const selected = selectionKey(selection) === selectionKey(sel);
  row.setAttribute("aria-selected", String(selected));
  row.tabIndex = selected ? 0 : -1;
  row.onclick = () => select(sel);
  row.onkeydown = (event) => moveNavFocus(event, row);
  return row;
}

function renderSessionRow(ws: Workspace, depth: number): HTMLButtonElement {
  const count = historyOf(ws).length;
  const row = navItem("ph-session", { kind: "ws", id: ws.id }, depth);
  row.dataset.wsId = ws.id;
  if (count === 0) row.classList.add("is-empty");
  if (ws.backgroundColor) row.style.setProperty("--ph-ws-color", `var(--ws-color-${ws.backgroundColor})`);
  const text = el("span", "ph-session-text");
  const name = el("span", "ph-session-name", ws.name);
  name.title = ws.name;
  text.append(name);
  const kinds = [...new Set(historyOf(ws).map((r) => r.kind))];
  if (kinds.length) text.append(el("span", "ph-session-meta", kinds.join(" · ")));
  row.append(el("span", "ph-session-swatch"), text);
  if (ws === getActiveWs()) row.append(el("span", "ph-session-current", t("prompts.current")));
  if (count > 0) {
    const badge = el("span", "ph-session-count", String(count));
    badge.title = t("prompts.conversationCount", { n: String(count) });
    row.append(badge);
  }
  return row;
}

/** 1階層ぶんを描画する。表示するセッションが1つも無いグループは出さない */
function renderNavLevel(parent: HTMLElement, parentId: string | undefined, depth: number): number {
  let shown = 0;
  for (const entry of childEntries(parentId)) {
    if (isWs(entry)) {
      if (!shownInNav(entry)) continue;
      parent.append(renderSessionRow(entry, depth));
      shown++;
      continue;
    }
    const box = el("div", "ph-group");
    box.setAttribute("role", "group");
    const body = el("div", "ph-group-body");
    const inner = renderNavLevel(body, entry.id, depth + 1);
    if (inner === 0) continue;
    const collapsed = collapsedNav.has(entry.id);
    box.classList.toggle("is-collapsed", collapsed);

    const head = navItem("ph-group-head", { kind: "group", id: entry.id }, depth);
    head.dataset.groupId = entry.id;
    head.setAttribute("aria-expanded", String(!collapsed));
    const chevron = el("span", "ph-group-chevron");
    chevron.append(icon(ICON_CHEVRON));
    chevron.title = t("prompts.collapse");
    chevron.onclick = (event) => {
      event.stopPropagation();
      if (collapsedNav.has(entry.id)) collapsedNav.delete(entry.id);
      else collapsedNav.add(entry.id);
      renderNav();
    };
    const folder = el("span", "ph-group-icon");
    folder.append(icon(ICON_FOLDER));
    const name = el("span", "ph-group-name", entry.name);
    name.title = entry.name;
    const convs = groupSessions(entry.id).reduce((n, ws) => n + historyOf(ws).length, 0);
    head.append(chevron, folder, name);
    if (convs > 0) {
      const badge = el("span", "ph-session-count", String(convs));
      badge.title = t("prompts.conversationCount", { n: String(convs) });
      head.append(badge);
    }
    box.append(head, body);
    parent.append(box);
    shown += inner;
  }
  return shown;
}

function renderNav(): void {
  sessionsEl.textContent = "";
  const shown = renderNavLevel(sessionsEl, undefined, 0);
  if (shown === 0) sessionsEl.append(el("div", "ph-nav-empty", t("prompts.noRecordSessions")));
  const hidden = workspaces.filter((w) => listed(w) && !shownInNav(w)).length;
  if (hidden > 0 || showEmptySessions) {
    const toggle = el(
      "button",
      "ph-nav-toggle",
      showEmptySessions ? t("prompts.hideEmpty") : t("prompts.showEmpty", { n: String(hidden) }),
    );
    toggle.type = "button";
    toggle.onclick = () => {
      showEmptySessions = !showEmptySessions;
      renderNav();
    };
    sessionsEl.append(toggle);
  }
}

function moveNavFocus(event: KeyboardEvent, row: HTMLButtonElement): void {
  const rows = [...sessionsEl.querySelectorAll<HTMLButtonElement>(".ph-nav-item")].filter(
    (item) => item.offsetParent !== null,
  );
  const index = rows.indexOf(row);
  let next: HTMLButtonElement | undefined;
  if (event.key === "ArrowDown") next = rows[index + 1];
  else if (event.key === "ArrowUp") next = rows[index - 1];
  else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows[rows.length - 1];
  else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && row.dataset.groupId) {
    const id = row.dataset.groupId;
    if (event.key === "ArrowLeft") collapsedNav.add(id);
    else collapsedNav.delete(id);
    event.preventDefault();
    renderNav();
    focusSelectedNav();
    return;
  }
  if (!next) return;
  event.preventDefault();
  const [kind, id] = next.dataset.sel!.split(/:(.*)/s);
  select({ kind: kind as Selection["kind"], id });
  focusSelectedNav();
}

function focusSelectedNav(): void {
  const row = sessionsEl.querySelector<HTMLButtonElement>(`.ph-nav-item[aria-selected="true"]`);
  row?.focus();
  row?.scrollIntoView({ block: "nearest" });
}

function select(sel: Selection): void {
  if (selectionKey(selection) !== selectionKey(sel)) agentFilter = "all";
  selection = sel;
  renderNav();
  timelineEl.scrollTop = 0;
  void loadSelected();
}

// ---------------- 読み込み ----------------

/** Rust 側 MAX_REFS と揃えた1回の上限。グループ表示で超える分は順に読む */
const REFS_PER_CALL = 64;

async function loadSelected(force = false): Promise<void> {
  const gen = ++loadGen;
  timelineEl.textContent = "";
  summaryEl.textContent = "";
  const sessions = selectedSessions();
  if (!selection || (selection.kind === "ws" && sessions.length === 0)) {
    showStatus(t("prompts.pickSession"));
    return;
  }
  statusEl.hidden = true;
  const refs = sessions.flatMap(historyOf);
  renderSummary([]);
  if (refs.length === 0) {
    renderEmpty();
    return;
  }
  const seen = new Set<string>();
  const missing = refs.filter((r) => {
    const key = refKey(r.kind, r.sessionId);
    if (seen.has(key) || (!force && cache.has(key))) return false;
    seen.add(key);
    return true;
  });
  if (missing.length > 0) {
    showStatus(t("prompts.loading"));
    try {
      for (let i = 0; i < missing.length; i += REFS_PER_CALL) {
        const got = await invoke<ConversationPrompts[]>("agent_session_prompts", {
          refs: missing.slice(i, i + REFS_PER_CALL).map((r) => ({ kind: r.kind, id: r.sessionId })),
        });
        if (gen !== loadGen) return;
        for (const conv of Array.isArray(got) ? got : []) {
          if (conv && typeof conv.kind === "string" && typeof conv.id === "string") {
            cache.set(refKey(conv.kind, conv.id), {
              ...conv,
              prompts: Array.isArray(conv.prompts) ? conv.prompts : [],
            });
          }
        }
      }
    } catch {
      if (gen !== loadGen) return;
      showStatus(t("prompts.loadFailed"), true);
      return;
    }
  }
  if (gen !== loadGen) return;
  statusEl.hidden = true;
  renderTimeline();
}

function showStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", error);
  statusEl.hidden = false;
}

type ConversationItem = { ref: AgentConversationRef; conv: ConversationPrompts | null };

function conversationsOf(ws: Workspace): ConversationItem[] {
  return historyOf(ws)
    .map((ref) => ({ ref, conv: cache.get(refKey(ref.kind, ref.sessionId)) ?? null }))
    .reverse(); // 新しい会話を上に
}

// ---------------- 右ペイン ----------------

function renderSummary(list: ConversationItem[]): void {
  summaryEl.textContent = "";
  const head = el("div", "ph-summary-head");
  if (selection?.kind === "group") {
    const group = groupOf(selection.id);
    const folder = el("span", "ph-summary-icon");
    folder.append(icon(ICON_FOLDER));
    const title = el("div", "ph-summary-title", group?.name ?? "");
    title.title = group?.name ?? "";
    head.append(folder, title);
    const n = groupSessions(selection.id).filter((w) => historyOf(w).length > 0).length;
    head.append(el("span", "ph-summary-group", t("prompts.sessionCount", { n: String(n) })));
  } else {
    const ws = selectedSessions()[0];
    if (!ws) return;
    const title = el("div", "ph-summary-title", ws.name);
    title.title = ws.name;
    head.append(title);
    const path = ws.group ? groupPathOf(ws.group) : "";
    if (path) head.append(el("span", "ph-summary-group", path));
  }
  summaryEl.append(head);

  if (list.length === 0) return;
  const stats = el("div", "ph-summary-stats");
  const prompts = list.reduce((n, { conv }) => n + (conv?.prompts.length ?? 0), 0);
  stats.append(
    el("span", "ph-stat", t("prompts.promptCount", { n: String(prompts) })),
    el("span", "ph-stat", t("prompts.conversationCount", { n: String(list.length) })),
  );
  const kinds = [...new Set(list.map(({ ref }) => ref.kind))];
  if (kinds.length > 1) {
    const seg = el("div", "ph-filter");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", t("prompts.filter"));
    for (const value of ["all", ...kinds] as AgentFilter[]) {
      const button = el("button", "ph-filter-btn", value === "all" ? t("prompts.filterAll") : value);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(agentFilter === value));
      if (value !== "all") button.dataset.kind = value;
      button.onclick = () => {
        agentFilter = value;
        renderTimeline();
      };
      seg.append(button);
    }
    stats.append(seg);
  }
  summaryEl.append(stats);
}

/** グループの表示パス（サイドバーの親子関係から） */
function groupPathOf(groupId: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let group = groupOf(groupId);
  while (group && !seen.has(group.id)) {
    seen.add(group.id);
    names.unshift(group.name);
    group = group.parentId ? groupOf(group.parentId) : null;
  }
  return names.join(" / ");
}

function renderEmpty(): void {
  const box = el("div", "ph-empty");
  const art = el("div", "ph-empty-art");
  art.append(icon(ICON_EMPTY));
  box.append(
    art,
    el("div", "ph-empty-title", t("prompts.emptyTitle")),
    el("div", "ph-empty-hint", t("prompts.emptyHint")),
  );
  timelineEl.append(box);
}

/** グループ表示でのセッション見出し。クリックでそのセッション単体の表示へ */
function sessionDivider(ws: Workspace, groupId: string, shown: number): HTMLElement {
  const head = el("button", "ph-session-divider");
  head.type = "button";
  head.dataset.wsId = ws.id;
  if (ws.backgroundColor) head.style.setProperty("--ph-ws-color", `var(--ws-color-${ws.backgroundColor})`);
  head.append(el("span", "ph-session-swatch"), el("span", "ph-divider-name", ws.name));
  // サブグループ所属なら、選択中グループからの相対パスを添える
  if (ws.group && ws.group !== groupId) {
    const full = groupPathOf(ws.group);
    const base = groupPathOf(groupId);
    head.append(el("span", "ph-divider-path", full.startsWith(`${base} / `) ? full.slice(base.length + 3) : full));
  }
  head.append(el("span", "ph-divider-count", t("prompts.conversationCount", { n: String(shown) })));
  head.title = t("prompts.openSession");
  head.onclick = () => select({ kind: "ws", id: ws.id });
  return head;
}

function renderTimeline(): void {
  const sessions = selectedSessions();
  if (!selection) return;
  const scroll = timelineEl.scrollTop;
  timelineEl.textContent = "";
  const all = sessions.flatMap(conversationsOf);
  renderSummary(all);
  const query = searchEl.value.trim().toLowerCase();
  const grouped = selection.kind === "group";
  let shownPrompts = 0;
  for (const ws of sessions) {
    const running = runningPanes(ws);
    const cards: HTMLElement[] = [];
    for (const { ref, conv } of conversationsOf(ws)) {
      if (agentFilter !== "all" && ref.kind !== agentFilter) continue;
      const prompts = (conv?.prompts ?? [])
        .map((prompt, index) => ({ prompt, index }))
        .filter(({ prompt }) => !query || prompt.text.toLowerCase().includes(query));
      if (query && prompts.length === 0) continue;
      shownPrompts += prompts.length;
      cards.push(
        renderConversation(ws, ref, conv, prompts, query, running.get(refKey(ref.kind, ref.sessionId))),
      );
    }
    if (cards.length === 0) continue;
    if (grouped) {
      const section = el("div", "ph-session-section");
      section.append(sessionDivider(ws, selection.id, cards.length), ...cards);
      timelineEl.append(section);
    } else {
      timelineEl.append(...cards);
    }
  }
  if (!timelineEl.firstChild) {
    if (all.length === 0) renderEmpty();
    else {
      const box = el("div", "ph-empty is-compact");
      box.append(el("div", "ph-empty-title", query ? t("prompts.noMatch") : t("prompts.noPrompts")));
      timelineEl.append(box);
    }
  } else if (query) {
    const hits = el("div", "ph-hits", t("prompts.matches", { n: String(shownPrompts) }));
    timelineEl.prepend(hits);
  }
  timelineEl.scrollTop = scroll;
  requestAnimationFrame(markClamped);
}

function renderConversation(
  ws: Workspace,
  ref: AgentConversationRef,
  conv: ConversationPrompts | null,
  prompts: { prompt: AgentPrompt; index: number }[],
  query: string,
  running: Pane | undefined,
): HTMLElement {
  const card = el("section", "ph-conv");
  card.dataset.kind = ref.kind;
  card.dataset.sessionId = ref.sessionId;

  const head = el("header", "ph-conv-head");
  const toggle = iconButton("ph-conv-toggle", t("prompts.collapse"), ICON_CHEVRON, () => {
    const collapsed = card.classList.toggle("is-collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });
  toggle.setAttribute("aria-expanded", "true");
  head.append(toggle, kindBadge(ref.kind));

  const titleBox = el("div", "ph-conv-titlebox");
  const first = conv?.prompts.find((p) => !p.command) ?? conv?.prompts[0];
  const title = el(
    "div",
    "ph-conv-title",
    first ? first.text.replace(/\s+/g, " ") : t("prompts.untitled"),
  );
  title.title = title.textContent ?? "";
  const times = (conv?.prompts ?? []).map((p) => parseTime(p.timestamp)).filter((v): v is number => v !== null);
  const start = times[0] ?? ref.seenAt;
  const end = times.length ? times[times.length - 1] : null;
  const meta = el("div", "ph-conv-meta");
  const range = formatTime(start) + (end !== null && end - start > 60_000 ? ` – ${formatTime(end)}` : "");
  meta.append(el("span", undefined, range));
  if (conv?.found) meta.append(el("span", undefined, t("prompts.promptCount", { n: String(conv.prompts.length) })));
  const idEl = el("span", "ph-conv-id", ref.sessionId.slice(0, 8));
  idEl.title = ref.sessionId;
  meta.append(idEl);
  titleBox.append(title, meta);
  head.append(titleBox);

  if (running) {
    const live = el("button", "ph-live");
    live.type = "button";
    live.append(el("span", "ph-live-dot"), t("prompts.running"));
    live.title = t("prompts.showPane");
    live.onclick = () => {
      options?.showPane(ws, running.id);
      closePromptHistory(false);
    };
    head.append(live);
  }
  head.onclick = (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    toggle.click();
  };
  card.append(head);

  const body = el("ol", "ph-prompts");
  if (!conv || !conv.found) {
    body.append(el("li", "ph-note", t("prompts.fileMissing")));
  } else if (conv.prompts.length === 0) {
    body.append(el("li", "ph-note", t("prompts.noPrompts")));
  } else {
    if (conv.omitted > 0 && !query) {
      body.append(el("li", "ph-note", t("prompts.omitted", { n: String(conv.omitted) })));
    }
    let prevDay: Date | null = null;
    for (const { prompt, index } of prompts) {
      const ms = parseTime(prompt.timestamp);
      if (ms !== null) {
        const day = new Date(ms);
        if (prevDay && !sameDay(prevDay, day)) {
          const sep = el("li", "ph-day");
          sep.textContent = new Intl.DateTimeFormat(getLang(), { dateStyle: "medium" }).format(day);
          body.append(sep);
        }
        prevDay = day;
      }
      body.append(renderPrompt(ws, prompt, index + 1 + conv.omitted, query));
    }
  }
  card.append(body);
  return card;
}

function renderPrompt(ws: Workspace, prompt: AgentPrompt, number: number, query: string): HTMLLIElement {
  const item = el("li", "ph-prompt");
  if (prompt.command) item.classList.add("is-command");
  const rail = el("div", "ph-rail");
  rail.append(el("span", "ph-num", String(number)));
  const content = el("div", "ph-content");

  const meta = el("div", "ph-prompt-meta");
  const ms = parseTime(prompt.timestamp);
  if (ms !== null) {
    const time = el("time", "ph-time", formatTime(ms));
    time.dateTime = prompt.timestamp!;
    time.title = formatFullTime(ms);
    meta.append(time);
  }
  if (prompt.command) meta.append(el("span", "ph-tag", t("prompts.command")));
  if (prompt.images > 0) {
    const images = el("span", "ph-tag ph-images");
    images.append(icon(ICON_IMAGE), String(prompt.images));
    images.title = t("prompts.images", { n: String(prompt.images) });
    meta.append(images);
  }
  const actions = el("div", "ph-actions");
  actions.append(
    iconButton("ph-copy", t("prompts.copy"), ICON_COPY, (button) => {
      void copyText(prompt.text);
      button.classList.add("is-done");
      button.replaceChildren(icon(ICON_CHECK));
      button.title = t("prompts.copied");
      window.setTimeout(() => {
        button.classList.remove("is-done");
        button.replaceChildren(icon(ICON_COPY));
        button.title = t("prompts.copy");
      }, COPIED_MS);
    }),
    iconButton("ph-insert", t("prompts.insert"), ICON_INSERT, () => insertPrompt(ws, prompt.text)),
  );
  meta.append(actions);

  const text = el("div", "ph-text");
  appendHighlighted(text, prompt.text, query);
  content.append(meta, text);
  item.append(rail, content);
  return item;
}

/** 長い入力を畳み、「全文を表示」を付ける。描画後に実寸で判定する */
function markClamped(): void {
  for (const text of timelineEl.querySelectorAll<HTMLDivElement>(".ph-text:not(.is-measured)")) {
    text.classList.add("is-measured");
    if (text.scrollHeight <= text.clientHeight + 2) continue;
    text.classList.add("is-clamped");
    const more = el("button", "ph-more", t("prompts.showMore"));
    more.type = "button";
    more.onclick = () => {
      const expanded = text.classList.toggle("is-expanded");
      more.textContent = t(expanded ? "prompts.showLess" : "prompts.showMore");
    };
    text.after(more);
  }
}

function insertPrompt(ws: Workspace, text: string): void {
  const pane = options?.targetPane(ws);
  if (!pane) return;
  const normalized = text.replace(/\r?\n/g, "\r");
  const bracketed = pane.bracketedPaste ?? pane.term.modes.bracketedPasteMode;
  pane.write(bracketed && normalized.includes("\r") ? `\x1b[200~${normalized}\x1b[201~` : normalized);
  closePromptHistory(false);
  pane.focus();
}

// ---------------- 開閉 ----------------

/** ws を省略するとアクティブなセッションを選んで開く */
/** ws を省略するとアクティブなセッションを選んで開く。アーカイブ済みは対象外 */
export function openPromptHistory(ws?: Workspace): void {
  if (!requireFeature()) return;
  const candidate = ws ?? getActiveWs();
  const fallback = workspaces.find((w) => listed(w) && historyOf(w).length > 0);
  const target = candidate && listed(candidate) ? candidate : fallback;
  selection = target ? { kind: "ws", id: target.id } : null;
  // 選んだセッションが見えるよう、祖先グループのたたみは解除する
  let parentId = target?.group;
  while (parentId) {
    collapsedNav.delete(parentId);
    parentId = groupOf(parentId)?.parentId;
  }
  agentFilter = "all";
  searchEl.value = "";
  overlay.hidden = false;
  openBtn.setAttribute("aria-expanded", "true");
  renderNav();
  void loadSelected();
  sessionsEl.querySelector<HTMLButtonElement>(`.ph-nav-item[aria-selected="true"]`)?.scrollIntoView({
    block: "nearest",
  });
  searchEl.focus();
}

export function closePromptHistory(restoreFocus = true): void {
  if (overlay.hidden) return;
  overlay.hidden = true;
  openBtn.setAttribute("aria-expanded", "false");
  loadGen++;
  cache.clear();
  timelineEl.textContent = "";
  if (restoreFocus) options?.focusTerminal();
}

export function initPromptHistory(deps: PromptHistoryOptions): void {
  options = deps;
  openBtn.onclick = () => openPromptHistory();
  closeBtn.onclick = () => closePromptHistory();
  refreshBtn.onclick = () => void loadSelected(true);
  searchEl.addEventListener("input", () => {
    if (selection && statusEl.hidden) renderTimeline();
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closePromptHistory();
  });
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      if (event.target === searchEl && searchEl.value) {
        searchEl.value = "";
        renderTimeline();
        return;
      }
      closePromptHistory();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });
}
