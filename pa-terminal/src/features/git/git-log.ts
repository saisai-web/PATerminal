// Git ウィンドウの「履歴」ビュー: git_log の取得と、コミットグラフ・ref チップつきの行の描画、
// 検索、選んだコミットの詳細（変更ファイルと差分）、コミット行の右クリックメニュー
// （差分表示 / 巻き戻し）。サイドバーのブランチ・タグからは revealCommit で該当行へ飛ぶ。
//
// コミット履歴（git_log）は Git ウィンドウが開いている間だけ git 監視の3秒ポーリングに相乗りする。
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。

import { invoke } from "@tauri-apps/api/core";
import { openCommitDiffOverlay, renderCommitDiffBody } from "./diff-overlay";
import type { CommitDiff } from "./diff-overlay";
import { getLang, t } from "../../i18n";
import { showGitWindowView } from "./git-window";
import { showGitMsg } from "./git-actions";
import { updateIssueTarget } from "./issues-tab";
import { updatePrTarget } from "./pr-overlay";
import type { GitCommit, GitLog } from "./git-panel-types";
import { graphLanes, layoutGraph, renderGraphCell } from "./commit-graph";

const searchEl = document.querySelector<HTMLInputElement>("#gw-search")!;
const logEl = document.querySelector<HTMLDivElement>("#gw-log")!;
const detailEl = document.querySelector<HTMLDivElement>("#gw-commit-detail")!;

/** 行の高さ（px）。グラフの線が行をまたいでつながるよう、CSS の .git-commit-row と揃える */
const ROW_H = 40;

let logBusy = false;
let logToken = 0; // 遅れて返った古い応答を捨てる
let logSig = ""; // 前回描画のシグネチャ（無駄な再描画を避ける）
let lastCwd: string | null = null;
let rerun = false; // 取得中に再要求が来たら、終わった直後にもう一度取る
let lastLog: GitLog | null = null;
let query = "";
/** 詳細を表示中のコミット（完全ハッシュ。古い応答では短縮ハッシュ） */
let selectedId: string | null = null;
let detailToken = 0;
/** 履歴を開いたとき、まだ何も選んでいなければ HEAD を選ぶ */
let autoSelectHead = true;

const commitKey = (c: GitCommit): string => c.id ?? c.hash;

/** 言語切替時: 次の描画を強制する（シグネチャを捨てる） */
export function renderGitLogTexts(): void {
  closeCommitMenu();
  logSig = "";
  if (lastLog) renderGitSection(lastLog);
  const c = lastLog?.commits.find((x) => commitKey(x) === selectedId);
  if (c && lastLog?.root) void showCommitDetail(lastLog.root, c);
  else renderDetailPlaceholder();
}

export async function pollLog(cwd: string): Promise<void> {
  lastCwd = cwd;
  if (logBusy) {
    rerun = true;
    return;
  }
  logBusy = true;
  rerun = false;
  const token = ++logToken;
  try {
    const res = await invoke<GitLog>("git_log", { cwd }).catch(() => null);
    if (token !== logToken) return; // 追い越された古い応答
    renderGitSection(res);
    updateIssueTarget(res);
    updatePrTarget(res);
  } finally {
    logBusy = false;
    if (rerun && lastCwd) void pollLog(lastCwd);
  }
}

export function renderGitSection(res: GitLog | null): void {
  if (!res?.repo) {
    logSig = "";
    if (lastLog) {
      lastLog = null;
      selectedId = null;
      autoSelectHead = true;
      logEl.innerHTML = "";
      renderDetailPlaceholder();
    }
    updateIssueTarget(null);
    return;
  }
  if (lastLog?.root !== res.root) {
    // 別のリポジトリへ移った: 選択を捨てて HEAD から見せ直す
    selectedId = null;
    autoSelectHead = true;
    renderDetailPlaceholder();
  }
  lastLog = res;
  // root も含める。別リポジトリに同じ履歴があってもクリック時の差分取得先を取り違えない。
  const sig = JSON.stringify([res.root, res.branch, res.commits, query]);
  if (sig !== logSig) {
    closeCommitMenu();
    logSig = sig;
    renderRows(res);
  }
  maybeSelectHead();
}

function renderRows(res: GitLog): void {
  const scrollTop = logEl.scrollTop;
  logEl.innerHTML = "";
  if (res.commits.length === 0) {
    logEl.append(emptyRow(t("git.noCommits")));
    return;
  }
  const q = query.trim().toLowerCase();
  if (q) {
    // 検索中は間引いた行でグラフの線がつながらないので、グラフ列なしで並べる
    logEl.classList.add("is-flat");
    const hits = res.commits.filter((c) =>
      [c.hash, c.id ?? "", c.subject, c.author, c.refs].some((v) => v.toLowerCase().includes(q)),
    );
    if (hits.length === 0) logEl.append(emptyRow(t("git.noMatches")));
    for (const c of hits) logEl.append(buildCommitRow(res.root!, c, null));
  } else {
    logEl.classList.remove("is-flat");
    const graph = layoutGraph(res.commits.map((c) => ({ id: commitKey(c), parents: c.parents ?? [] })));
    const lanes = graphLanes(graph);
    const frag = document.createDocumentFragment();
    res.commits.forEach((c, i) => {
      const cell = renderGraphCell(graph[i], lanes, ROW_H, {
        head: isHeadCommit(c),
        merge: (c.parents?.length ?? 0) > 1,
      });
      frag.append(buildCommitRow(res.root!, c, cell));
    });
    logEl.append(frag);
  }
  logEl.scrollTop = scrollTop; // 3秒ごとの再描画で読んでいる位置を飛ばさない
}

function emptyRow(text: string): HTMLDivElement {
  const empty = document.createElement("div");
  empty.className = "git-commit-empty";
  empty.textContent = text;
  return empty;
}

/** 履歴ビューが表示されたとき */
export function historyViewShown(): void {
  maybeSelectHead();
}

function maybeSelectHead(): void {
  if (!autoSelectHead || !lastLog?.root || VIEW_HIDDEN()) return;
  const head = lastLog.commits.find(isHeadCommit) ?? lastLog.commits[0];
  if (!head) return;
  autoSelectHead = false;
  selectCommit(lastLog.root, head, false);
}

const VIEW_HIDDEN = (): boolean => logEl.closest<HTMLElement>(".gw-view")?.hidden ?? true;

function selectCommit(root: string, c: GitCommit, scroll: boolean): void {
  selectedId = commitKey(c);
  autoSelectHead = false;
  for (const row of logEl.querySelectorAll<HTMLElement>(".git-commit-row")) {
    const on = row.dataset.id === selectedId;
    row.classList.toggle("is-selected", on);
    row.setAttribute("aria-selected", String(on));
    if (on && scroll) row.scrollIntoView({ block: "center" });
  }
  void showCommitDetail(root, c);
}

/** サイドバーのブランチ・タグ: 先端コミットを履歴で選んで表示する */
export function revealCommit(hash: string): void {
  showGitWindowView("history");
  const c = lastLog?.commits.find((x) => x.hash.startsWith(hash) || (x.id ?? "").startsWith(hash));
  if (!c || !lastLog?.root) {
    showGitMsg(t("gw.notInHistory"), "err");
    return;
  }
  if (query) {
    query = "";
    searchEl.value = "";
    renderRows(lastLog);
    logSig = JSON.stringify([lastLog.root, lastLog.branch, lastLog.commits, query]);
  }
  selectCommit(lastLog.root, c, true);
}

function renderDetailPlaceholder(): void {
  ++detailToken;
  detailEl.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "gw-diff-placeholder";
  empty.textContent = t("gw.selectCommit");
  detailEl.append(empty);
}

async function showCommitDetail(root: string, c: GitCommit): Promise<void> {
  const token = ++detailToken;
  detailEl.innerHTML = "";
  detailEl.append(buildDetailHead(c));
  const body = document.createElement("div");
  body.className = "gw-commit-detail-body is-loading";
  detailEl.append(body);
  const d = await invoke<CommitDiff>("git_commit_diff", { root, hash: c.hash }).catch(() => null);
  if (token !== detailToken) return; // 取得中に別のコミットを選んだ
  body.classList.remove("is-loading");
  if (!d) {
    body.append(emptyRow(t("git.commitNoDiff")));
    return;
  }
  body.append(renderCommitDiffBody(d));
}

function buildDetailHead(c: GitCommit): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "gw-commit-detail-head";
  const subject = document.createElement("div");
  subject.className = "gw-commit-detail-subject";
  subject.textContent = c.subject;
  const meta = document.createElement("div");
  meta.className = "gw-commit-detail-meta";
  const hash = document.createElement("code");
  hash.textContent = c.id ?? c.hash;
  const who = document.createElement("span");
  who.textContent = c.author;
  const when = document.createElement("span");
  when.textContent = c.time
    ? `${new Date(c.time * 1000).toLocaleString(getLang())} (${relTime(c.time)})`
    : "";
  meta.append(hash, who, when);
  if ((c.parents?.length ?? 0) > 0) {
    const parents = document.createElement("span");
    parents.textContent = `${t("gw.parents")}: ${c.parents!.map((p) => p.slice(0, 7)).join(", ")}`;
    meta.append(parents);
  }
  head.append(subject);
  const refs = buildRefChips(c.refs);
  if (refs) head.append(refs);
  head.append(meta);
  return head;
}

searchEl.addEventListener("input", () => {
  query = searchEl.value;
  if (lastLog) renderGitSection(lastLog);
});
// 入力済みの検索欄の Escape は文字だけ消す（ウィンドウは閉じない）
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchEl.value) {
    e.preventDefault();
    searchEl.value = "";
    searchEl.dispatchEvent(new Event("input"));
  }
});

// ============================================================
// ref チップ（%D を --decorate=full で受け取り、ローカル / リモート / タグを見分ける）
// ============================================================

type RefChip = {
  kind: "branch" | "remote" | "tag" | "detached";
  name: string;
  /** HEAD が指しているローカルブランチ */
  current: boolean;
  /** 同じコミットに同名のリモート追跡ブランチもある（ローカルとリモートが揃っている） */
  remote: string | null;
};

const REMOTE_GUESS = /^(origin|upstream)\//;

export function parseRefs(raw: string): RefChip[] {
  const chips: RefChip[] = [];
  const remotes: string[] = [];
  for (let part of raw.split(",")) {
    part = part.trim();
    if (!part) continue;
    if (part === "HEAD") {
      chips.push({ kind: "detached", name: "HEAD", current: true, remote: null });
      continue;
    }
    let current = false;
    if (part.startsWith("HEAD -> ")) {
      current = true;
      part = part.slice("HEAD -> ".length);
    }
    if (part.startsWith("tag: ")) {
      chips.push({ kind: "tag", name: part.slice(5).replace(/^refs\/tags\//, ""), current: false, remote: null });
    } else if (part.startsWith("refs/remotes/")) {
      const name = part.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) remotes.push(name); // origin/HEAD は既定ブランチの別名なので出さない
    } else if (part.startsWith("refs/heads/")) {
      chips.push({ kind: "branch", name: part.slice("refs/heads/".length), current, remote: null });
    } else if (!current && REMOTE_GUESS.test(part)) {
      // 短縮名で届いた場合（古い応答）はよくあるリモート名から推測する
      if (!part.endsWith("/HEAD")) remotes.push(part);
    } else {
      chips.push({ kind: "branch", name: part, current, remote: null });
    }
  }
  // 同名のローカルとリモートは1つのチップにまとめる（狭いパネルで行を埋めないため）
  for (const r of remotes) {
    const local = chips.find(
      (c) => c.kind === "branch" && !c.remote && r.slice(r.indexOf("/") + 1) === c.name,
    );
    if (local) local.remote = r;
    else chips.push({ kind: "remote", name: r, current: false, remote: null });
  }
  const order = { detached: 0, branch: 1, remote: 2, tag: 3 };
  return chips.sort((a, b) => Number(b.current) - Number(a.current) || order[a.kind] - order[b.kind]);
}

function isHeadCommit(c: GitCommit): boolean {
  return /(^|,\s*)HEAD(\s|,|$)/.test(c.refs);
}

const ICONS: Record<RefChip["kind"] | "cloud", string> = {
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2.5-7 4.5"/>',
  remote: '<path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7 1A2.5 2.5 0 0 0 4.5 12.5z"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  detached: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v3.5M8 11v3.5"/>',
  cloud: '<path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7 1A2.5 2.5 0 0 0 4.5 12.5z"/>',
};

function refIcon(kind: keyof typeof ICONS, cls = "git-ref-icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[kind];
  return svg;
}

function buildRefChips(raw: string): HTMLSpanElement | null {
  const chips = parseRefs(raw);
  if (chips.length === 0) return null;
  const wrap = document.createElement("span");
  wrap.className = "git-commit-refs";
  for (const c of chips) {
    const chip = document.createElement("span");
    chip.className = `git-ref git-ref-${c.kind}${c.current ? " is-current" : ""}`;
    chip.append(refIcon(c.kind));
    const label = document.createElement("span");
    label.className = "git-ref-name";
    label.textContent = c.name;
    chip.append(label);
    if (c.remote) {
      chip.append(refIcon("cloud", "git-ref-synced"));
      chip.dataset.remote = c.remote;
    }
    chip.title = [c.current ? `HEAD → ${c.name}` : c.name, c.remote].filter(Boolean).join(" · ");
    wrap.append(chip);
  }
  wrap.title = chips.map((c) => [c.name, c.remote].filter(Boolean).join(" · ")).join(", ");
  return wrap;
}

function buildCommitRow(root: string, c: GitCommit, graph: SVGSVGElement | null): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "git-commit-row";
  row.dataset.id = commitKey(c);
  const selected = commitKey(c) === selectedId;
  row.classList.toggle("is-selected", selected);
  row.setAttribute("aria-selected", String(selected));
  if (isHeadCommit(c)) row.classList.add("is-head");
  if ((c.parents?.length ?? 0) > 1) row.classList.add("is-merge");
  row.title = t("git.viewCommitDiff", { subject: c.subject });
  row.role = "listitem";
  row.tabIndex = 0;
  row.setAttribute("aria-label", row.title);
  if (graph) {
    // 狭いパネルではグラフ列をパネル幅の一定割合で切り詰める（本文を残す）
    const cell = document.createElement("span");
    cell.className = "git-graph-cell";
    cell.append(graph);
    row.append(cell);
  }
  // 行の中身は refs / subject / info の3つ。並べ方（件名の前にチップか、2行目にチップか）は
  // パネル幅に応じて CSS（container query）が決める
  const body = document.createElement("div");
  body.className = "git-commit-body";
  const refs = buildRefChips(c.refs);
  if (refs) body.append(refs);
  else body.classList.add("no-refs");
  const subject = document.createElement("span");
  subject.className = "git-commit-subject";
  subject.textContent = c.subject;
  const info = document.createElement("span");
  info.className = "git-commit-info";
  const hash = document.createElement("span");
  hash.className = "git-commit-hash";
  hash.textContent = c.hash;
  const meta = document.createElement("span");
  meta.className = "git-commit-meta";
  meta.textContent = `${c.author} · ${relTime(c.time)}`;
  info.append(hash, meta);
  body.append(subject, info);
  row.append(body);
  row.onclick = () => selectCommit(root, c, false);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    openCommitMenu(root, c, row, e.clientX, e.clientY);
  };
  row.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as
        | HTMLElement
        | null;
      if (next?.classList.contains("git-commit-row")) {
        next.focus();
        next.click();
      }
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const box = row.getBoundingClientRect();
      openCommitMenu(root, c, row, box.left + 16, box.top + 16);
    }
  };
  return row;
}

let commitMenuEl: HTMLDivElement | null = null;

function closeCommitMenu(): void {
  commitMenuEl?.remove();
  commitMenuEl = null;
}

function placeCommitMenu(menu: HTMLDivElement, x: number, y: number): void {
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
}

function commitMenuTitle(c: GitCommit): HTMLDivElement {
  const title = document.createElement("div");
  title.className = "git-commit-ctx-title";
  title.textContent = `${c.hash} ${c.subject}`;
  title.title = title.textContent;
  return title;
}

function commitMenuButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "menuitem";
  button.textContent = label;
  button.onclick = onClick;
  return button;
}

function openCommitMenu(
  root: string,
  c: GitCommit,
  row: HTMLElement,
  x: number,
  y: number,
): void {
  closeCommitMenu();
  const menu = document.createElement("div");
  menu.id = "git-commit-ctx";
  menu.className = "git-ctx-menu";
  menu.role = "menu";
  menu.append(commitMenuTitle(c));

  const show = commitMenuButton(t("git.ctxShowFiles"), () => {
    closeCommitMenu();
    void openCommitDiff(root, c, row);
  });
  const reset = commitMenuButton(t("git.ctxReset"), () => {
    renderResetConfirm(menu, root, c, row, x, y);
  });
  reset.className = "is-danger";
  menu.append(show, reset);
  document.body.append(menu);
  commitMenuEl = menu;
  placeCommitMenu(menu, x, y);
}

function renderResetConfirm(
  menu: HTMLDivElement,
  root: string,
  c: GitCommit,
  row: HTMLElement,
  x: number,
  y: number,
): void {
  menu.replaceChildren(commitMenuTitle(c));
  const warning = document.createElement("div");
  warning.className = "git-commit-reset-warning";
  warning.textContent = t("git.resetWarning");
  const status = document.createElement("div");
  status.className = "git-commit-reset-status";
  status.hidden = true;
  const confirm = commitMenuButton(t("git.resetConfirm"), () => {
    void resetToCommit(menu, root, c, row, confirm, cancel, status);
  });
  confirm.className = "is-danger";
  const cancel = commitMenuButton(t("git.resetCancel"), closeCommitMenu);
  menu.append(warning, status, confirm, cancel);
  placeCommitMenu(menu, x, y);
  confirm.focus();
}

async function resetToCommit(
  menu: HTMLDivElement,
  root: string,
  c: GitCommit,
  row: HTMLElement,
  confirm: HTMLButtonElement,
  cancel: HTMLButtonElement,
  status: HTMLDivElement,
): Promise<void> {
  if (row.classList.contains("is-loading")) return;
  row.classList.add("is-loading");
  confirm.disabled = true;
  cancel.disabled = true;
  confirm.textContent = t("git.resetWorking");
  status.hidden = true;
  try {
    await invoke<string>("git_reset_to_commit", { root, hash: c.hash });
    closeCommitMenu();
    logSig = "";
    void pollLog(root);
  } catch (e) {
    if (commitMenuEl !== menu) return;
    status.textContent = t("git.resetFailed", { error: String(e) });
    status.hidden = false;
    confirm.disabled = false;
    cancel.disabled = false;
    confirm.textContent = t("git.resetConfirm");
  } finally {
    row.classList.remove("is-loading");
  }
}

window.addEventListener(
  "mousedown",
  (e) => {
    if (commitMenuEl && !commitMenuEl.contains(e.target as Node)) closeCommitMenu();
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (commitMenuEl && e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault(); // Git ウィンドウは閉じない
      closeCommitMenu();
    }
  },
  true,
);
window.addEventListener("blur", closeCommitMenu);
window.addEventListener("resize", closeCommitMenu);

async function openCommitDiff(root: string, c: GitCommit, row: HTMLElement): Promise<void> {
  if (row.classList.contains("is-loading")) return;
  row.classList.add("is-loading");
  try {
    const d = await invoke<CommitDiff>("git_commit_diff", { root, hash: c.hash }).catch(() => null);
    if (d) openCommitDiffOverlay(`${c.hash} ${c.subject}`, d);
  } finally {
    row.classList.remove("is-loading");
  }
}

/** epoch 秒 → 相対表記（"3分前" / "3 minutes ago"）。表示言語に追従する */
function relTime(epochSec: number): string {
  if (!epochSec) return "";
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });
  const diff = epochSec * 1000 - Date.now();
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

export function statusEl(text: string, error = false): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `issue-status${error ? " is-error" : ""}`;
  el.textContent = text;
  return el;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getLang());
}
