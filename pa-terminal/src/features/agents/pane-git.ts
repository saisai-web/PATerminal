// ============================================================
// ペイン上部のバー（タイトル・cwd の行）の Git 操作
//
// バーには「⎇ ブランチ ↑push ↓pull」「変更数」と Diff / Worktree / Commit / Fetch / Pull（ahead があれば Push）を出し、
// ブランチ名のクリックでブランチ一覧のポップオーバーを開いて切り替え・リモートからの
// チェックアウト・新規作成をその場で行う。Diff はそのペインの未コミットの変更をまとめて
// 差分オーバーレイで開く（Git ウィンドウは開かない）。Worktree はそのペインのリポジトリを対象に
// 作成モーダル（worktree-dialog）を開く。Commit は Git ウィンドウのファイルステータスを開いて
// コミットメッセージ欄へ移る（ペインの mousedown で git 監視がそのペインへ追従済み）。
//
// - 状態はサイドバーのセッション git バッジと同じ5秒スイープ（ws-git の git_summary）から
//   ペインごとに受け取る。このモジュール自身は定期実行しない（CLAUDE.md: 定期サブプロセスを
//   足さない）。操作の直後だけそのペインの git_summary を1回取り直す
// - git_refs はポップオーバーを開いたときに1回だけ呼ぶ
// - 実行・結果トースト・多重実行の抑止は Git ウィンドウと同じ runGitAction に任せる
//   （未コミット変更と競合するチェックアウトは Git 自身が拒否し、その出力をトーストに出す）
// - バーの高さは変えない（refit を起こさない）。狭いペインではボタンの文字を隠す
// - ブランチ一覧はバーの下に開く
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import type { Pane } from "../../terminal/pane";
import { panes } from "../../workspace/state";
import { openWorktreeDiffOverlay } from "../git/diff-overlay";
import type { CommitDiff } from "../git/diff-overlay";
import { isActionBusy, runGitAction, showGitMsg } from "../git/git-actions";
import { focusCommitMessage } from "../git/git-status-view";
import { openWorktreeDialog } from "../git/worktree-dialog";
import { requireFeature } from "../license/license";
import { toPaneGit, updateWsGit } from "../sidebar/ws-git";
import type { GitSummary, PaneGitSummary } from "../sidebar/ws-git";

type GitRef = {
  name: string;
  hash: string;
  upstream: string;
  ahead: number;
  behind: number;
  gone: boolean;
  worktree: string;
};
type GitRefs = { head: string | null; local: GitRef[]; remote: GitRef[]; tags: GitRef[] };

const SVG_NS = "http://www.w3.org/2000/svg";
const CIRCLE = (x: number, y: number) => `M${x + 1.5} ${y}a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0`;
const ICONS = {
  branch: `M5 5v6M11 6.5c0 3-6 2.3-6 4.5${CIRCLE(5, 3.5)}${CIRCLE(5, 12.5)}${CIRCLE(11, 5)}`,
  pull: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3.5 13.5h9",
  push: "M8 13.5v-8M4.5 9 8 5.5 11.5 9M3.5 2.5h9",
  fetch: "M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3",
  check: "M3.5 8.5l3 3 6-7",
  plus: "M8 3.5v9M3.5 8h9",
  cloud: "M4.5 12.5h7a2.5 2.5 0 0 0 .3-5A3.5 3.5 0 0 0 5 6.6a3 3 0 0 0-.5 5.9z",
  caret: "M4.5 10 8 6.5l3.5 3.5",
  commit: "M1.5 8h4M10.5 8h4" + CIRCLE(8, 8),
  diff: "M8 2.5v5M5.5 5h5M5.5 12.5h5",
  worktree: "M2 5V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5zM8 7v4M6 9h4",
} as const;

function icon(name: keyof typeof ICONS, className = "pathbar-icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(className);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** paneId → 直近の git 状態（リポジトリ外は保持しない） */
const states = new Map<string, PaneGitSummary>();
const sigs = new Map<string, string>();
let closePop: (() => void) | undefined;

/** ws-git のスイープ（と操作直後の取り直し）から呼ぶ */
export function setPaneGit(paneId: string, git: PaneGitSummary | null): void {
  const pane = panes.get(paneId);
  if (!pane) {
    states.delete(paneId);
    sigs.delete(paneId);
    return;
  }
  if (git) states.set(paneId, git);
  else states.delete(paneId);
  renderPaneGit(pane);
}

/** バーの Git 部分（中身は renderPaneGit が状態に合わせて埋める） */
export function buildPaneGit(pane: Pane): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "pane-git";
  el.hidden = true;

  const branch = document.createElement("button");
  branch.type = "button";
  branch.className = "pane-git-branch";
  branch.setAttribute("aria-haspopup", "dialog");
  branch.setAttribute("aria-expanded", "false");
  const name = document.createElement("span");
  name.className = "pane-git-name";
  const sync = document.createElement("span");
  sync.className = "pane-git-sync";
  branch.append(icon("branch"), name, sync, icon("caret", "pathbar-caret"));
  branch.onclick = (e) => {
    e.stopPropagation();
    if (branch.getAttribute("aria-expanded") === "true") closePop?.();
    else openBranchPop(pane, branch);
  };

  const dirty = document.createElement("span");
  dirty.className = "pane-git-dirty";

  const spacer = document.createElement("span");
  spacer.className = "pane-git-spacer";

  const diffBtn = actButton("diff", t("agent.diff"), "is-diff");
  diffBtn.onclick = (e) => {
    e.stopPropagation();
    void openDiff(pane, diffBtn);
  };
  const worktreeBtn = actButton("worktree", t("agent.worktree"), "is-worktree");
  worktreeBtn.onclick = (e) => {
    e.stopPropagation();
    openWorktree(pane, worktreeBtn);
  };
  const commitBtn = actButton("commit", t("agent.commit"), "is-commit");
  commitBtn.onclick = (e) => {
    e.stopPropagation();
    if (!commitBtn.disabled && !isActionBusy()) focusCommitMessage();
  };
  const fetchBtn = actButton("fetch", t("pgit.fetch"), "is-fetch");
  fetchBtn.onclick = (e) => {
    e.stopPropagation();
    runFetch(pane, fetchBtn);
  };
  const pushBtn = actButton("push", t("pgit.push"), "is-push");
  pushBtn.onclick = (e) => {
    e.stopPropagation();
    runPush(pane, pushBtn);
  };
  const pullBtn = actButton("pull", t("pgit.pull"), "is-pull");
  pullBtn.onclick = (e) => {
    e.stopPropagation();
    runPull(pane, pullBtn);
  };
  el.append(branch, dirty, spacer, diffBtn, worktreeBtn, commitBtn, fetchBtn, pushBtn, pullBtn);
  return el;
}

function actButton(name: keyof typeof ICONS, label: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `pane-git-act ${cls}`;
  const text = document.createElement("span");
  text.className = "pane-git-act-label";
  text.textContent = label;
  const count = document.createElement("span");
  count.className = "pane-git-count";
  b.append(icon(name), text, count);
  return b;
}

/** 状態が変わったときだけバーの Git 部分を書き換える */
export function renderPaneGit(pane: Pane): void {
  const el = pane.el.querySelector<HTMLDivElement>(":scope > .pane-bar .pane-git");
  if (!el) return;
  const s = states.get(pane.id);
  const busy = el.classList.contains("is-busy");
  const sig = s
    ? [s.root, s.branch, s.detached, s.upstream, s.ahead, s.behind, s.fileCount, busy].join("\0")
    : "";
  if (sigs.get(pane.id) === sig && el.dataset.rendered === "true") return;
  sigs.set(pane.id, sig);
  el.dataset.rendered = "true";
  if (!s) {
    el.hidden = true;
    delete el.dataset.branch;
    closePopFor(pane);
    return;
  }
  el.hidden = false;
  el.dataset.branch = s.branch ?? "";
  el.classList.toggle("is-detached", s.detached);

  const branch = el.querySelector<HTMLButtonElement>(".pane-git-branch")!;
  el.querySelector(".pane-git-name")!.textContent = s.branch ?? "HEAD";
  const sync = el.querySelector<HTMLSpanElement>(".pane-git-sync")!;
  sync.textContent = "";
  if (s.ahead > 0) sync.append(syncChip("↑", s.ahead, "is-ahead"));
  if (s.behind > 0) sync.append(syncChip("↓", s.behind, "is-behind"));
  sync.hidden = !sync.childElementCount;
  branch.title = [
    s.detached ? t("pgit.detached", { hash: s.branch ?? "" }) : t("pgit.branchTitle", { branch: s.branch ?? "" }),
    syncText(s),
    s.root,
  ].join("\n");

  const dirty = el.querySelector<HTMLSpanElement>(".pane-git-dirty")!;
  dirty.hidden = s.fileCount === 0;
  dirty.textContent = String(s.fileCount);
  dirty.title = t("pgit.dirty", { n: String(s.fileCount) });

  const pull = el.querySelector<HTMLButtonElement>(".pane-git-act.is-pull")!;
  pull.disabled = busy || !s.upstream;
  pull.classList.toggle("is-attn", s.behind > 0);
  pull.querySelector(".pane-git-count")!.textContent = s.behind > 0 ? String(s.behind) : "";
  pull.title = s.upstream ? t("pgit.pullTitle", { upstream: s.upstream }) : t("pgit.noUpstream");

  const push = el.querySelector<HTMLButtonElement>(".pane-git-act.is-push")!;
  push.hidden = !(s.upstream && s.ahead > 0);
  push.disabled = busy;
  push.querySelector(".pane-git-count")!.textContent = s.ahead > 0 ? String(s.ahead) : "";
  push.title = s.upstream ? t("pgit.pushTitle", { n: String(s.ahead), upstream: s.upstream }) : "";

  const fetch = el.querySelector<HTMLButtonElement>(".pane-git-act.is-fetch")!;
  fetch.disabled = busy;
  fetch.title = t("pgit.fetchTitle");

  const commit = el.querySelector<HTMLButtonElement>(".pane-git-act.is-commit")!;
  commit.disabled = busy || s.fileCount === 0;
  commit.title = t("agent.commitTitle");

  const diff = el.querySelector<HTMLButtonElement>(".pane-git-act.is-diff")!;
  diff.disabled = s.fileCount === 0;
  diff.title = t("agent.allChangesTitle");

  const worktree = el.querySelector<HTMLButtonElement>(".pane-git-act.is-worktree")!;
  worktree.disabled = busy;
  worktree.title = t("agent.worktreeTitle");
}

function syncChip(arrow: string, n: number, cls: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = `pane-git-chip ${cls}`;
  chip.textContent = `${arrow}${n}`;
  return chip;
}

function syncText(s: PaneGitSummary): string {
  if (!s.upstream) return t("pgit.noUpstream");
  const parts: string[] = [];
  if (s.behind > 0) parts.push(t("gw.behind", { n: String(s.behind) }));
  if (s.ahead > 0) parts.push(t("gw.ahead", { n: String(s.ahead) }));
  return parts.length ? `${s.upstream} · ${parts.join(" · ")}` : t("pgit.synced", { upstream: s.upstream });
}

// ============================================================
// 操作
// ============================================================

function live(pane: Pane): boolean {
  return pane.alive && panes.get(pane.id) === pane;
}

/** 操作の直後だけ、そのペインの git_summary を取り直してバーへ反映する */
async function refreshPane(pane: Pane): Promise<void> {
  const s = states.get(pane.id);
  if (!s) return;
  const res = await invoke<GitSummary>("git_summary", { cwd: s.cwd }).catch(() => null);
  if (panes.get(pane.id) !== pane) return;
  setPaneGit(pane.id, toPaneGit(s.cwd, res));
  // 同じリポジトリを開いている他ペインとサイドバーのバッジも追従させる
  updateWsGit();
}

/** Git ウィンドウと共有の runGitAction で実行し、押したボタンを実行中表示にする */
function run(pane: Pane, button: HTMLElement | null, action: () => Promise<string>): Promise<boolean> {
  const el = pane.el.querySelector<HTMLDivElement>(":scope > .pane-bar .pane-git");
  if (isActionBusy()) return Promise.resolve(false);
  el?.classList.add("is-busy");
  button?.classList.add("is-running");
  renderPaneGit(pane);
  return runGitAction(action).finally(() => {
    el?.classList.remove("is-busy");
    button?.classList.remove("is-running");
    renderPaneGit(pane);
    if (live(pane)) void refreshPane(pane);
  });
}

function runPull(pane: Pane, button: HTMLElement | null): void {
  const s = states.get(pane.id);
  if (!s?.upstream) return;
  const { root, upstream } = s;
  void run(pane, button, () => invoke<string>("git_pull", { root, branch: upstream }));
}

function runPush(pane: Pane, button: HTMLElement | null): void {
  const s = states.get(pane.id);
  if (!s) return;
  const { root } = s;
  void run(pane, button, async () => (await invoke<string>("git_push", { root })) || t("agent.pushDone"));
}

/** そのペインの未コミットの変更（Git ウィンドウの「すべての差分」と同じ内容）を差分オーバーレイで開く */
async function openDiff(pane: Pane, button: HTMLElement): Promise<void> {
  const s = states.get(pane.id);
  if (!s || s.fileCount === 0 || button.classList.contains("is-running")) return;
  const { cwd } = s;
  button.classList.add("is-running");
  try {
    const d = await invoke<CommitDiff>("git_worktree_diff", { cwd });
    // 取得中にペインが閉じたり cwd が変わったら古い差分は開かない
    if (live(pane) && states.get(pane.id)?.cwd === cwd) openWorktreeDiffOverlay(d);
  } catch (e) {
    showGitMsg(String(e), "err");
  } finally {
    button.classList.remove("is-running");
  }
}

/** そのペインのリポジトリで Worktree の作成モーダルを開く（Git ウィンドウは開かない） */
function openWorktree(pane: Pane, opener: HTMLElement): void {
  const s = states.get(pane.id);
  if (!s || isActionBusy()) return;
  if (!requireFeature()) return; // ソフトロック中は購入案内（Git ウィンドウと同じ扱い）
  void openWorktreeDialog({ root: s.root, opener });
}

function runFetch(pane: Pane, button: HTMLElement | null): void {
  const s = states.get(pane.id);
  if (!s) return;
  const { root } = s;
  void run(pane, button, async () => (await invoke<string>("git_fetch", { root })) || t("agent.fetchDone"));
}

// ============================================================
// ブランチ一覧のポップオーバー
// ============================================================

type Row =
  | { kind: "local"; ref: GitRef; current: boolean; blocked: string | null }
  | { kind: "remote"; ref: GitRef }
  | { kind: "create"; name: string };

function closePopFor(pane: Pane): void {
  const expanded = pane.el.querySelector('.pane-git-branch[aria-expanded="true"]');
  if (expanded) closePop?.();
}

function normRoot(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Git が受け付けないことが明らかな名前は作成行を出さない（最終判定は Rust の check-ref-format） */
function plausibleBranchName(name: string): boolean {
  return (
    !!name &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !/[\s~^:?*[\\]/.test(name)
  );
}

function openBranchPop(pane: Pane, anchor: HTMLButtonElement): void {
  closePop?.();
  const s = states.get(pane.id);
  if (!s) return;
  const root = s.root;
  const rect = anchor.getBoundingClientRect();
  let refs: GitRefs | null = null;
  let error: string | null = null;
  let rows: Row[] = [];
  let selected = 0;
  let closed = false;

  const pop = document.createElement("div");
  pop.className = "pgit-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", t("pgit.branches"));

  // ---- 見出し: 現在のブランチとリポジトリ、upstream との同期状態
  const head = document.createElement("div");
  head.className = "pgit-head";
  const headTop = document.createElement("div");
  headTop.className = "pgit-head-top";
  const headBranch = document.createElement("strong");
  headBranch.textContent = s.branch ?? "HEAD";
  const headRepo = document.createElement("span");
  headRepo.className = "pgit-head-repo";
  headRepo.textContent = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;
  headRepo.title = root;
  headTop.append(icon("branch"), headBranch, headRepo);
  const headSync = document.createElement("div");
  headSync.className = "pgit-head-sync";
  headSync.textContent = syncText(s);
  head.append(headTop, headSync);

  // ---- 絞り込み（一致が無ければその名前で作成できる）
  const filterWrap = document.createElement("div");
  filterWrap.className = "pgit-filter";
  const filter = document.createElement("input");
  filter.type = "text";
  filter.placeholder = t("pgit.filter");
  filter.spellcheck = false;
  filter.autocomplete = "off";
  filter.setAttribute("aria-label", t("pgit.filter"));
  filterWrap.append(filter);

  const list = document.createElement("div");
  list.className = "pgit-list";
  list.setAttribute("role", "listbox");

  // ---- 下部: Fetch / Pull / Push（バーのボタンと同じ操作）
  const actions = document.createElement("div");
  actions.className = "pgit-actions";
  const fetchBtn = popAction("fetch", t("pgit.fetch"), () => {
    close();
    runFetch(pane, pane.el.querySelector(".pane-git-act.is-fetch"));
  });
  fetchBtn.title = t("pgit.fetchTitle");
  const pullBtn = popAction("pull", s.behind > 0 ? `${t("pgit.pull")} ${s.behind}` : t("pgit.pull"), () => {
    close();
    runPull(pane, pane.el.querySelector(".pane-git-act.is-pull"));
  });
  pullBtn.disabled = !s.upstream || isActionBusy();
  pullBtn.title = s.upstream ? t("pgit.pullTitle", { upstream: s.upstream }) : t("pgit.noUpstream");
  pullBtn.classList.toggle("is-primary", s.behind > 0);
  const worktreeBtn = popAction("worktree", t("agent.worktree"), () => {
    close(false);
    const bar = pane.el.querySelector<HTMLElement>(":scope > .pane-bar .pane-git-act.is-worktree");
    openWorktree(pane, bar ?? anchor);
  });
  worktreeBtn.title = t("agent.worktreeTitle");
  worktreeBtn.disabled = isActionBusy();
  actions.append(worktreeBtn, fetchBtn, pullBtn);
  if (s.upstream && s.ahead > 0) {
    const pushBtn = popAction("push", `${t("pgit.push")} ${s.ahead}`, () => {
      close();
      runPush(pane, pane.el.querySelector(".pane-git-act.is-push"));
    });
    pushBtn.title = t("pgit.pushTitle", { n: String(s.ahead), upstream: s.upstream });
    actions.append(pushBtn);
  }
  fetchBtn.disabled = isActionBusy();

  pop.append(head, filterWrap, list, actions);
  document.body.append(pop);

  // バーの下に開く（左端はブランチボタンに揃え、画面内に収める）
  const vw = window.innerWidth;
  const w = Math.min(380, vw - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.left - 4, vw - w - 8))}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.maxHeight = `${Math.max(220, Math.min(480, window.innerHeight - rect.bottom - 12))}px`;

  anchor.setAttribute("aria-expanded", "true");

  function computeRows(): void {
    rows = [];
    if (!refs) return;
    const q = filter.value.trim();
    const ql = q.toLowerCase();
    const match = (name: string) => !ql || name.toLowerCase().includes(ql);
    const here = normRoot(root);
    const locals = [...refs.local].sort((a, b) =>
      a.name === refs!.head ? -1 : b.name === refs!.head ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    const localNames = new Set(refs.local.map((r) => r.name));
    for (const ref of locals) {
      if (!match(ref.name)) continue;
      const current = ref.name === refs.head;
      const wt = ref.worktree ? normRoot(ref.worktree) : "";
      rows.push({ kind: "local", ref, current, blocked: !current && wt && wt !== here ? ref.worktree : null });
    }
    // リモートは同名のローカルが無いものだけ（あればローカル行で切り替えられる）
    for (const ref of refs.remote) {
      const short = ref.name.slice(ref.name.indexOf("/") + 1);
      if (localNames.has(short) || !match(ref.name)) continue;
      rows.push({ kind: "remote", ref });
    }
    const exists = localNames.has(q) || refs.remote.some((r) => r.name.slice(r.name.indexOf("/") + 1) === q);
    if (q && !exists && plausibleBranchName(q)) rows.push({ kind: "create", name: q });
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    // 現在のブランチの上に選択を置かない（Enter で何も起きない行を避ける）
    if (!ql && rows[selected]?.kind === "local" && (rows[selected] as { current: boolean }).current && rows.length > 1) {
      selected = 1;
    }
  }

  function renderList(): void {
    list.textContent = "";
    if (error) {
      list.append(note(error, "is-error"));
      return;
    }
    if (!refs) {
      list.append(note(t("pathbar.loading")));
      return;
    }
    if (!rows.length) {
      list.append(note(t("pgit.noMatch")));
      return;
    }
    let section: Row["kind"] | null = null;
    rows.forEach((row, i) => {
      if (row.kind !== section && row.kind !== "create") {
        const h = document.createElement("div");
        h.className = "pgit-section";
        h.textContent = row.kind === "local" ? t("pgit.local") : t("pgit.remote");
        list.append(h);
      }
      section = row.kind;
      list.append(buildRow(row, i));
    });
  }

  function buildRow(row: Row, index: number): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `pgit-row is-${row.kind}`;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(index === selected));
    const name = document.createElement("span");
    name.className = "pgit-row-name";
    const meta = document.createElement("span");
    meta.className = "pgit-row-meta";
    if (row.kind === "create") {
      el.append(icon("plus"));
      name.textContent = t("pgit.create", { name: row.name });
    } else {
      const full = row.ref.name;
      const slash = full.lastIndexOf("/");
      if (slash > 0) {
        const dir = document.createElement("span");
        dir.className = "pgit-row-dir";
        dir.textContent = full.slice(0, slash + 1);
        name.append(dir);
      }
      name.append(full.slice(slash + 1));
      name.title = full;
      if (row.kind === "local") {
        el.append(icon(row.current ? "check" : "branch"));
        if (row.current) {
          el.classList.add("is-current");
          el.setAttribute("aria-current", "true");
          const tag = document.createElement("span");
          tag.className = "pgit-tag is-current";
          tag.textContent = t("pgit.current");
          meta.append(tag);
        }
        if (row.ref.ahead > 0) meta.append(syncChip("↑", row.ref.ahead, "is-ahead"));
        if (row.ref.behind > 0) meta.append(syncChip("↓", row.ref.behind, "is-behind"));
        if (row.blocked) {
          el.classList.add("is-blocked");
          el.setAttribute("aria-disabled", "true");
          el.title = t("gw.inWorktree", { path: row.blocked });
          const tag = document.createElement("span");
          tag.className = "pgit-tag";
          tag.textContent = "worktree";
          meta.append(tag);
        }
      } else {
        el.append(icon("cloud"));
      }
    }
    el.append(name, meta);
    el.onmouseenter = () => {
      if (selected === index) return;
      selected = index;
      updateSelection(false);
    };
    el.onclick = () => activate(row);
    return el;
  }

  function note(text: string, cls = ""): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `pgit-note ${cls}`.trim();
    el.textContent = text;
    return el;
  }

  function updateSelection(scroll: boolean): void {
    const els = list.querySelectorAll<HTMLElement>(".pgit-row");
    els.forEach((el, i) => el.setAttribute("aria-selected", String(i === selected)));
    if (scroll) els[selected]?.scrollIntoView({ block: "nearest" });
  }

  function activate(row: Row): void {
    if (isActionBusy()) return;
    if (row.kind === "local") {
      if (row.current) {
        close();
        return;
      }
      if (row.blocked) return;
      const branch = row.ref.name;
      close();
      void run(pane, null, async () =>
        (await invoke<string>("git_switch_branch", { root, branch })) || t("agent.switchBranchDone", { branch }),
      );
    } else if (row.kind === "remote") {
      const branch = row.ref.name;
      close();
      void run(pane, null, async () =>
        (await invoke<string>("git_checkout_remote", { root, branch })) ||
        t("agent.switchBranchDone", { branch: branch.slice(branch.indexOf("/") + 1) }),
      );
    } else {
      const branch = row.name;
      close();
      void run(pane, null, async () => {
        await invoke<string>("git_create_branch", { root, branch });
        return t("pgit.createDone", { branch });
      });
    }
  }

  function close(refocus = true): void {
    if (closed) return;
    closed = true;
    pop.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("resize", dismissQuietly);
    window.removeEventListener("blur", dismissQuietly);
    if (closePop === dismissQuietly) closePop = undefined;
    if (refocus && live(pane)) pane.focus();
  }
  function dismissQuietly(): void {
    close(false);
  }
  function onOutside(e: MouseEvent): void {
    if (e.target instanceof Node && (pop.contains(e.target) || anchor.contains(e.target))) return;
    close(false);
  }
  closePop = dismissQuietly;
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("resize", dismissQuietly);
  window.addEventListener("blur", dismissQuietly);

  filter.oninput = () => {
    selected = 0;
    computeRows();
    renderList();
  };
  pop.addEventListener("keydown", (e) => {
    // グローバルショートカットやターミナルへキーを流さない
    e.stopPropagation();
    if (e.isComposing) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "ArrowDown":
      case "ArrowUp":
        if (!rows.length) return;
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        updateSelection(true);
        return;
      case "Enter":
        if (e.target !== filter || !rows[selected]) return;
        e.preventDefault();
        activate(rows[selected]);
        return;
    }
  });

  renderList();
  filter.focus();
  void invoke<GitRefs>("git_refs", { root }).then(
    (res) => {
      if (closed) return;
      refs = res;
      computeRows();
      renderList();
    },
    (e) => {
      if (closed) return;
      error = String(e);
      renderList();
    },
  );
}

function popAction(name: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pgit-action";
  const text = document.createElement("span");
  text.textContent = label;
  b.append(icon(name), text);
  b.onclick = onClick;
  return b;
}
