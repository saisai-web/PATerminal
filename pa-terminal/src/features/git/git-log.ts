// git セクションのコミット履歴（Branch タブ）: git_log の取得と描画、コミット行の
// 右クリックメニュー（差分表示 / 巻き戻し）。
//
// コミット履歴（git_log）は変更ストリップの3秒ポーリング（pollGit）に相乗りする。
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。

import { invoke } from "@tauri-apps/api/core";
import { openCommitDiffOverlay } from "./diff-overlay";
import type { CommitDiff } from "./diff-overlay";
import { getLang, t } from "../../i18n";
import { getActiveTab } from "./git-panel";
import { updateIssueTarget } from "./issues-tab";
import { updatePrTarget } from "./pr-overlay";
import type { GitCommit, GitLog } from "./git-panel-types";

const sectionEl = document.querySelector<HTMLDivElement>("#exp-git")!;
const resizeEl = document.querySelector<HTMLDivElement>("#exp-git-resize")!;
const branchEl = document.querySelector<HTMLButtonElement>("#exp-git-branch")!;
const branchNameEl = document.querySelector<HTMLDivElement>("#exp-git-branch-name")!;
const logEl = document.querySelector<HTMLDivElement>("#exp-git-log")!;

let logBusy = false;
let logToken = 0; // 遅れて返った古い応答を捨てる（expListToken と同じ流儀）
let logSig = ""; // 前回描画のシグネチャ（無駄な再描画を避ける。gitSig と同じ流儀）
// タブ見出しは固定ラベルなので、現在のブランチ名はタブ行の下の1行に出す。
// タブ切替でも出し入れするので、最後に取れた表示文字列を持っておく
let branchLine = "";

/** 言語切替時: 次の描画を強制する（シグネチャを捨てる） */
export function renderGitLogTexts(): void {
  closeCommitMenu();
  logSig = "";
}

export async function pollLog(cwd: string): Promise<void> {
  if (logBusy) return; // 前回の呼び出しが終わっていなければスキップ
  logBusy = true;
  const token = ++logToken;
  try {
    const res = await invoke<GitLog>("git_log", { cwd }).catch(() => null);
    if (token !== logToken) return; // 追い越された古い応答
    renderGitSection(res);
    updateIssueTarget(res);
    updatePrTarget(res);
  } finally {
    logBusy = false;
  }
}

export function renderGitSection(res: GitLog | null): void {
  const show = !!res?.repo;
  sectionEl.hidden = !show;
  resizeEl.hidden = !show;
  if (!show) {
    logSig = "";
    branchLine = "";
    renderBranchLine();
    updateIssueTarget(null);
    return;
  }
  // root も含める。別リポジトリに同じ履歴があってもクリック時の差分取得先を取り違えない。
  const sig = JSON.stringify([res.root, res.branch, res.commits]);
  if (sig === logSig) return;
  closeCommitMenu();
  logSig = sig;
  // タブの見出しは他のタブと同じ固定ラベル（"Branch"）。ブランチ名は長いと
  // タブ列が右へ伸びて Issue / PR / Worktree を押し出すので、title だけに持たせる
  branchEl.title = res.branch ?? t("git.branchTitle");
  // 代わりにタブ行の直下・コミット行の上に現在のブランチ名を1行で出す
  branchLine = res.branch ? (res.detached ? res.branch : `⎇ ${res.branch}`) : "";
  renderBranchLine();
  logEl.innerHTML = "";
  if (res.commits.length === 0) {
    const empty = document.createElement("div");
    empty.className = "git-commit-empty";
    empty.textContent = t("git.noCommits");
    logEl.append(empty);
    return;
  }
  for (const c of res.commits) {
    logEl.append(buildCommitRow(res.root!, c));
  }
}

/** ブランチ名の行は Branch タブのときだけ（Issue/PR/Worktree では出さない） */
export function renderBranchLine(): void {
  const show = getActiveTab() === "branch" && !!branchLine;
  branchNameEl.hidden = !show;
  branchNameEl.textContent = show ? branchLine : "";
  branchNameEl.title = show ? branchLine : "";
}

function buildCommitRow(root: string, c: GitCommit): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "git-commit-row";
  row.title = t("git.viewCommitDiff", { subject: c.subject });
  row.role = "button";
  row.tabIndex = 0;
  row.setAttribute("aria-label", row.title);
  const line1 = document.createElement("div");
  const hash = document.createElement("span");
  hash.className = "git-commit-hash";
  hash.textContent = c.hash;
  const subject = document.createElement("span");
  subject.className = "git-commit-subject";
  subject.textContent = c.subject;
  line1.append(hash, subject);
  const line2 = document.createElement("div");
  if (c.refs) {
    const refs = document.createElement("span");
    refs.className = "git-commit-refs";
    refs.textContent = c.refs;
    line2.append(refs);
  }
  const meta = document.createElement("span");
  meta.className = "git-commit-meta";
  meta.textContent = `${c.author} · ${relTime(c.time)}`;
  line2.append(meta);
  row.append(line1, line2);
  row.onclick = () => void openCommitDiff(root, c, row);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    openCommitMenu(root, c, row, e.clientX, e.clientY);
  };
  row.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
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
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCommitMenu();
});
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
