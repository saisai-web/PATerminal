// Git ウィンドウの「ファイルステータス」ビュー: コミット前の変更ファイル一覧（コミット対象の
// チェック付き）・選んだファイルの行番号付き差分・コミット欄。
//
// 一覧は git 監視（git-watch.ts の3秒ポーリング）の結果をそのまま描く。差分の取得
// （git_file_diff）はビューが見えている間だけ、選択中のファイルの行数が変わったときに行う。
// コミット対象の選択は「前回の一覧に無かったファイル = 新しい変更」だけ既定でチェックを入れ、
// ユーザーが外したチェックはポーリングをまたいで保つ。

import { invoke } from "@tauri-apps/api/core";
import { getGitCwd, getGitFiles, getGitRoot } from "./git-watch";
import type { GitFile } from "./git-watch";
import { isActionBusy, isPushAvailable, runGitAction, showGitMsg } from "./git-actions";
import { openWorktreeDiffOverlay, renderFileDiffCode } from "./diff-overlay";
import type { CommitDiff } from "./diff-overlay";
import { t } from "../../i18n";
import { isStatusViewVisible, showGitWindowView } from "./git-window";

const filesEl = document.querySelector<HTMLDivElement>("#gw-status-files")!;
const selectAllEl = document.querySelector<HTMLInputElement>("#commit-select-all")!;
const selectionEl = document.querySelector<HTMLSpanElement>("#commit-selection-count")!;
const viewAllBtn = document.querySelector<HTMLButtonElement>("#gw-view-all-diff")!;
const messageEl = document.querySelector<HTMLTextAreaElement>("#commit-message")!;
const pushAfterEl = document.querySelector<HTMLInputElement>("#commit-push-after")!;
const errorEl = document.querySelector<HTMLDivElement>("#commit-error")!;
const submitBtn = document.querySelector<HTMLButtonElement>("#commit-submit")!;
const diffHeadEl = document.querySelector<HTMLDivElement>("#gw-status-diff-head")!;
const diffPathEl = document.querySelector<HTMLSpanElement>("#gw-status-diff-path")!;
const diffStatsEl = document.querySelector<HTMLSpanElement>("#gw-status-diff-stats")!;
const diffBodyEl = document.querySelector<HTMLDivElement>("#gw-status-diff-body")!;

let listSig = ""; // 前回描画した一覧のシグネチャ
let knownPaths = new Set<string>(); // 前回の一覧にあったパス（新しい変更の判定）
let checked = new Set<string>(); // コミット対象
let selectedPath: string | null = null; // 差分を表示中のファイル
let diffSig = ""; // 表示中の差分のシグネチャ（root + path + 行数）
let diffToken = 0;
let draftCwd: string | null = null; // コミットメッセージの下書きがどの cwd のものか
let worktreeDiffBusy = false;

/** git 監視の結果が来るたびに呼ばれる */
export function renderStatusFiles(): void {
  const files = getGitFiles();
  const cwd = getGitCwd();
  // 別のリポジトリ / フォルダーへ移ったら下書きと選択を捨てる
  if (cwd !== draftCwd) {
    draftCwd = cwd;
    messageEl.value = "";
    errorEl.hidden = true;
    knownPaths = new Set();
    checked = new Set();
    selectedPath = null;
  }
  const paths = new Set(files.map((f) => f.path));
  for (const f of files) if (!knownPaths.has(f.path)) checked.add(f.path);
  for (const p of [...checked]) if (!paths.has(p)) checked.delete(p);
  knownPaths = paths;
  if (!selectedPath || !paths.has(selectedPath)) selectedPath = files[0]?.path ?? null;

  const sig = JSON.stringify([getGitRoot(), files, selectedPath]);
  if (sig !== listSig) {
    listSig = sig;
    renderList(files);
  }
  updateCommitBox();
  if (isStatusViewVisible()) void loadDiff();
}

function renderList(files: GitFile[]): void {
  const scrollTop = filesEl.scrollTop;
  filesEl.innerHTML = "";
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gw-status-empty";
    empty.textContent = t("gw.clean");
    filesEl.append(empty);
    return;
  }
  for (const f of files) filesEl.append(buildFileRow(f));
  filesEl.scrollTop = scrollTop;
}

function statusLabel(status: string): string {
  if (status === "A") return t("gw.statusAdded");
  if (status === "D") return t("gw.statusDeleted");
  return t("gw.statusModified");
}

function buildFileRow(f: GitFile): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "gw-file-row";
  row.role = "option";
  row.tabIndex = f.path === selectedPath ? 0 : -1;
  row.dataset.path = f.path;
  const selected = f.path === selectedPath;
  row.classList.toggle("is-selected", selected);
  row.setAttribute("aria-selected", String(selected));
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked.has(f.path);
  box.disabled = isActionBusy();
  box.setAttribute("aria-label", t("gw.includeInCommit", { path: f.path }));
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => {
    if (box.checked) checked.add(f.path);
    else checked.delete(f.path);
    updateCommitBox();
  });
  const status = document.createElement("span");
  status.className = `gw-file-status status-${f.status}`;
  status.textContent = f.status;
  status.title = statusLabel(f.status);
  const name = document.createElement("span");
  name.className = "gw-file-name";
  const slash = f.path.lastIndexOf("/");
  const base = document.createElement("span");
  base.className = "gw-file-base";
  base.textContent = f.path.slice(slash + 1);
  name.append(base);
  if (slash > 0) {
    const dir = document.createElement("span");
    dir.className = "gw-file-dir";
    // "/" の後ろで折り返せるようにする（長いパスも省略せず全体を見せる）
    const parts = f.path.slice(0, slash).split("/");
    parts.forEach((part, i) => dir.append(i < parts.length - 1 ? `${part}/` : part, document.createElement("wbr")));
    name.append(dir);
  }
  name.title = f.path;
  const adds = document.createElement("span");
  adds.className = "agent-file-adds";
  adds.textContent = `+${f.adds}`;
  const dels = document.createElement("span");
  dels.className = "agent-file-dels";
  dels.textContent = `-${f.dels}`;
  row.append(box, status, name, adds, dels);
  row.onclick = () => selectFile(f.path);
  row.onkeydown = (e) => {
    if (e.key === " ") {
      e.preventDefault();
      box.click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as
        | HTMLElement
        | null;
      if (next?.dataset.path) {
        selectFile(next.dataset.path);
        filesEl.querySelector<HTMLElement>(".gw-file-row.is-selected")?.focus();
      }
    }
  };
  return row;
}

function selectFile(path: string): void {
  if (path === selectedPath) return;
  selectedPath = path;
  for (const row of filesEl.querySelectorAll<HTMLElement>(".gw-file-row")) {
    const on = row.dataset.path === path;
    row.classList.toggle("is-selected", on);
    row.setAttribute("aria-selected", String(on));
    row.tabIndex = on ? 0 : -1;
  }
  listSig = JSON.stringify([getGitRoot(), getGitFiles(), selectedPath]);
  void loadDiff();
}

/** ビューが表示されたとき（Git ウィンドウを開いた・ビューを切り替えた）に呼ぶ */
export function statusViewShown(): void {
  diffSig = "";
  void loadDiff();
}

async function loadDiff(): Promise<void> {
  const root = getGitRoot();
  const f = getGitFiles().find((x) => x.path === selectedPath);
  const sig = JSON.stringify([root, f ?? null]);
  if (sig === diffSig) return;
  diffSig = sig;
  const token = ++diffToken;
  if (!root || !f) {
    diffHeadEl.hidden = true;
    diffBodyEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "gw-diff-placeholder";
    const mark = document.createElement("div");
    mark.className = "gw-diff-placeholder-mark";
    mark.textContent = root ? "✓" : "";
    const text = document.createElement("div");
    text.textContent = root ? t("gw.clean") : "";
    empty.append(mark, text);
    diffBodyEl.append(empty);
    return;
  }
  diffHeadEl.hidden = false;
  diffPathEl.textContent = f.path;
  diffPathEl.title = f.path;
  diffStatsEl.innerHTML = "";
  const adds = document.createElement("span");
  adds.className = "agent-file-adds";
  adds.textContent = `+${f.adds}`;
  const dels = document.createElement("span");
  dels.className = "agent-file-dels";
  dels.textContent = `-${f.dels}`;
  diffStatsEl.append(adds, dels);
  diffBodyEl.classList.add("is-loading");
  const d = await invoke<{ oldText: string; newText: string }>("git_file_diff", {
    root,
    path: f.path,
  }).catch(() => null);
  if (token !== diffToken) return; // 取得中に別ファイルへ移った
  diffBodyEl.classList.remove("is-loading");
  diffBodyEl.innerHTML = "";
  if (!d) {
    diffSig = ""; // 失敗は次のポーリングで取り直す
    return;
  }
  diffBodyEl.append(renderFileDiffCode({ path: f.path, oldText: d.oldText, newText: d.newText }));
}

// ============================================================
// コミット欄（ファイル単位の対象選択 + 複数行メッセージ + コミット後に Push）
// ============================================================

/** 監視結果・busy の変化のたびに有効 / 無効を決め直す */
export function updateCommitBox(): void {
  const busy = isActionBusy();
  const files = getGitFiles();
  const selected = files.filter((f) => checked.has(f.path)).length;
  const total = files.length;
  selectAllEl.checked = total > 0 && selected === total;
  selectAllEl.indeterminate = selected > 0 && selected < total;
  selectAllEl.disabled = busy || total === 0;
  selectionEl.textContent = total
    ? t("agent.commitSelection", { selected: String(selected), total: String(total) })
    : "";
  for (const box of filesEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.disabled = busy;
  }
  viewAllBtn.disabled = worktreeDiffBusy || total === 0;
  messageEl.disabled = busy || total === 0;
  const pushAvailable = isPushAvailable();
  pushAfterEl.disabled = busy || !pushAvailable || total === 0;
  if (!pushAvailable) pushAfterEl.checked = false;
  submitBtn.disabled = busy || selected === 0 || messageEl.value.trim() === "";
}

/** 上部の Commit ボタン: ファイルステータスへ移ってメッセージ欄にフォーカス */
export function focusCommitMessage(): void {
  showGitWindowView("status");
  requestAnimationFrame(() => messageEl.focus());
}

selectAllEl.addEventListener("change", () => {
  checked = selectAllEl.checked ? new Set(getGitFiles().map((f) => f.path)) : new Set();
  for (const box of filesEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.checked = selectAllEl.checked;
  }
  updateCommitBox();
});
messageEl.addEventListener("input", updateCommitBox);
messageEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    submitBtn.click();
  }
});
pushAfterEl.addEventListener("change", updateCommitBox);

submitBtn.onclick = () => {
  const cwd = getGitCwd();
  const root = getGitRoot();
  const message = messageEl.value.trim();
  const paths = getGitFiles().map((f) => f.path).filter((p) => checked.has(p));
  const pushAfterCommit = pushAfterEl.checked && isPushAvailable();
  if (!cwd || !message || paths.length === 0 || (pushAfterCommit && !root)) return;
  errorEl.hidden = true;
  void (async () => {
    const ok = await runGitAction(
      async () => {
        const out = await invoke<string>("git_commit", { cwd, message, paths });
        const commitResult = out || t("agent.commitDone");
        if (!pushAfterCommit || !root) return commitResult;
        const pushOut = await invoke<string>("git_push", { root });
        return [commitResult, pushOut || t("agent.pushDone")].join("\n");
      },
      (error) => {
        errorEl.textContent = error;
        errorEl.hidden = false;
      },
    );
    if (ok) {
      messageEl.value = "";
      pushAfterEl.checked = false;
      updateCommitBox();
    }
  })();
};

/** 「すべての差分」: 作業ツリーの全変更をコミット差分と同じ一覧 UI で開く */
viewAllBtn.onclick = async () => {
  const cwd = getGitCwd();
  if (!cwd || getGitFiles().length === 0 || worktreeDiffBusy) return;
  worktreeDiffBusy = true;
  updateCommitBox();
  try {
    const d = await invoke<CommitDiff>("git_worktree_diff", { cwd });
    // 取得中にフォーカス中ペインの cwd が変わったら古い差分は開かない
    if (getGitCwd() === cwd) openWorktreeDiffOverlay(d);
  } catch (e) {
    showGitMsg(String(e), "err");
  } finally {
    worktreeDiffBusy = false;
    updateCommitBox();
  }
};

/** 言語切替時: 動的に作った文言を作り直す */
export function renderStatusViewTexts(): void {
  listSig = "";
  diffSig = "";
  renderStatusFiles();
}
