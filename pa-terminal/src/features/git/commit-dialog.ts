// ============================================================
// コミットモーダル（ファイル単位の対象選択 + 複数行メッセージ）
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { getCurrentBranch, getGitCwd, getGitFiles, getGitRoot } from "./agent-panel";
import type { GitFile } from "./agent-panel";
import { isActionBusy, isPushAvailable, runGitAction } from "./git-actions";
import { t } from "../../i18n";

const commitBtn = document.querySelector<HTMLButtonElement>("#git-commit")!;
const commitOverlay = document.querySelector<HTMLDivElement>("#commit-overlay")!;
const commitPanel = document.querySelector<HTMLDivElement>("#commit-panel")!;
const commitBranchEl = document.querySelector<HTMLSpanElement>("#commit-branch")!;
const commitCloseBtn = document.querySelector<HTMLButtonElement>("#commit-close")!;
const commitSelectAllEl = document.querySelector<HTMLInputElement>("#commit-select-all")!;
const commitSelectionEl = document.querySelector<HTMLSpanElement>("#commit-selection-count")!;
const commitFileListEl = document.querySelector<HTMLDivElement>("#commit-file-list")!;
const commitMessageEl = document.querySelector<HTMLTextAreaElement>("#commit-message")!;
const commitPushAfterEl = document.querySelector<HTMLInputElement>("#commit-push-after")!;
const commitErrorEl = document.querySelector<HTMLDivElement>("#commit-error")!;
const commitCancelBtn = document.querySelector<HTMLButtonElement>("#commit-cancel")!;
const commitSubmitBtn = document.querySelector<HTMLButtonElement>("#commit-submit")!;

let commitDialogCwd: string | null = null;
let commitDraftCwd: string | null = null;
let commitModalFiles: GitFile[] = [];
let selectedCommitPaths = new Set<string>();

export function isCommitDialogOpen(): boolean {
  return !commitOverlay.hidden;
}

export function getCommitDialogCwd(): string | null {
  return commitDialogCwd;
}

/** ブランチ情報の更新をモーダル表示中のヘッダへ反映する */
export function renderCommitBranch(branch: string | null): void {
  if (!commitOverlay.hidden) commitBranchEl.textContent = branch ? `⎇ ${branch}` : "";
}

export function renderCommitFiles(preserveSelection: boolean): void {
  const oldFiles = new Set(commitModalFiles.map((f) => f.path));
  const oldSelection = selectedCommitPaths;
  commitModalFiles = [...getGitFiles()];
  selectedCommitPaths = new Set(
    commitModalFiles
      .filter((f) => !preserveSelection || oldSelection.has(f.path) || !oldFiles.has(f.path))
      .map((f) => f.path),
  );
  commitFileListEl.innerHTML = "";
  for (const f of commitModalFiles) {
    const row = document.createElement("label");
    row.className = "commit-file-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedCommitPaths.has(f.path);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedCommitPaths.add(f.path);
      else selectedCommitPaths.delete(f.path);
      updateCommitDialog();
    });
    const status = document.createElement("span");
    status.className = `commit-file-status status-${f.status}`;
    status.textContent = f.status;
    const path = document.createElement("span");
    path.className = "commit-file-choice-path";
    path.textContent = f.path;
    const stats = document.createElement("span");
    stats.className = "commit-file-choice-stats";
    const adds = document.createElement("span");
    adds.className = "agent-file-adds";
    adds.textContent = `+${f.adds}`;
    const dels = document.createElement("span");
    dels.className = "agent-file-dels";
    dels.textContent = `-${f.dels}`;
    stats.append(adds, dels);
    row.append(checkbox, status, path, stats);
    commitFileListEl.append(row);
  }
  updateCommitDialog();
}

export function updateCommitDialog(): void {
  const actionBusy = isActionBusy();
  const available = new Set(commitModalFiles.map((f) => f.path));
  const selected = [...selectedCommitPaths].filter((path) => available.has(path)).length;
  const total = commitModalFiles.length;
  commitSelectAllEl.checked = total > 0 && selected === total;
  commitSelectAllEl.indeterminate = selected > 0 && selected < total;
  commitSelectAllEl.disabled = actionBusy || total === 0;
  commitSelectionEl.textContent = t("agent.commitSelection", {
    selected: String(selected),
    total: String(total),
  });
  commitFileListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.disabled = actionBusy;
  });
  commitMessageEl.disabled = actionBusy;
  const pushAvailable = isPushAvailable();
  commitPushAfterEl.disabled = actionBusy || !pushAvailable;
  if (!pushAvailable) commitPushAfterEl.checked = false;
  commitCloseBtn.disabled = actionBusy;
  commitCancelBtn.disabled = actionBusy;
  commitSubmitBtn.disabled = actionBusy || selected === 0 || commitMessageEl.value.trim() === "";
}

function openCommitDialog(): void {
  const cwd = getGitCwd();
  if (!cwd || getGitFiles().length === 0 || isActionBusy()) return;
  commitDialogCwd = cwd;
  if (commitDraftCwd !== cwd) {
    commitMessageEl.value = "";
    commitDraftCwd = cwd;
  }
  const currentBranch = getCurrentBranch();
  commitBranchEl.textContent = currentBranch ? `⎇ ${currentBranch}` : "";
  commitPushAfterEl.checked = false;
  commitErrorEl.hidden = true;
  renderCommitFiles(false);
  commitOverlay.hidden = false;
  requestAnimationFrame(() => commitMessageEl.focus());
}

export function closeCommitDialog(): void {
  if (isActionBusy()) return;
  commitOverlay.hidden = true;
  commitDialogCwd = null;
  commitBtn.focus();
}

commitBtn.onclick = openCommitDialog;
commitCloseBtn.onclick = closeCommitDialog;
commitCancelBtn.onclick = closeCommitDialog;
commitOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === commitOverlay) closeCommitDialog();
});
commitPanel.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    commitSubmitBtn.click();
  }
});
window.addEventListener(
  "keydown",
  (e) => {
    if (!commitOverlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      closeCommitDialog();
    }
  },
  true,
);
commitSelectAllEl.addEventListener("change", () => {
  selectedCommitPaths = commitSelectAllEl.checked
    ? new Set(commitModalFiles.map((f) => f.path))
    : new Set();
  for (const input of commitFileListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    input.checked = commitSelectAllEl.checked;
  }
  updateCommitDialog();
});
commitMessageEl.addEventListener("input", updateCommitDialog);
commitPushAfterEl.addEventListener("change", updateCommitDialog);
commitSubmitBtn.onclick = () => {
  const cwd = commitDialogCwd;
  const message = commitMessageEl.value.trim();
  const paths = commitModalFiles.map((f) => f.path).filter((path) => selectedCommitPaths.has(path));
  const pushAfterCommit = commitPushAfterEl.checked && isPushAvailable();
  const root = getGitRoot();
  if (!cwd || !message || paths.length === 0 || (pushAfterCommit && !root)) return;
  commitErrorEl.hidden = true;
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
        commitErrorEl.textContent = error;
        commitErrorEl.hidden = false;
      },
    );
    if (ok) {
      commitMessageEl.value = "";
      commitPushAfterEl.checked = false;
      commitDraftCwd = null;
      closeCommitDialog();
    }
  })();
};
