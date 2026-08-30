// ============================================================
// プルモーダル（押下後に取り込み元を選択。現在ブランチは切り替えない）
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { getCurrentBranch, getGitRoot } from "./agent-panel";
import { getRemoteBranches, getUpstreamBranch, isActionBusy, runGitAction } from "./git-actions";

const pullBtn = document.querySelector<HTMLButtonElement>("#git-pull")!;
const pullOverlay = document.querySelector<HTMLDivElement>("#pull-overlay")!;
const pullPanel = document.querySelector<HTMLDivElement>("#pull-panel")!;
const pullTargetEl = document.querySelector<HTMLSpanElement>("#pull-target")!;
const pullCloseBtn = document.querySelector<HTMLButtonElement>("#pull-close")!;
const pullBranchSel = document.querySelector<HTMLSelectElement>("#pull-branch")!;
const pullErrorEl = document.querySelector<HTMLDivElement>("#pull-error")!;
const pullCancelBtn = document.querySelector<HTMLButtonElement>("#pull-cancel")!;
const pullSubmitBtn = document.querySelector<HTMLButtonElement>("#pull-submit")!;

let pullDialogRoot: string | null = null;

export function isPullDialogOpen(): boolean {
  return !pullOverlay.hidden;
}

export function getPullDialogRoot(): string | null {
  return pullDialogRoot;
}

/** ブランチ情報の更新をモーダル表示中のヘッダへ反映する */
export function renderPullTarget(branch: string | null): void {
  if (!pullOverlay.hidden) pullTargetEl.textContent = branch ? `→ ⎇ ${branch}` : "";
}

export function renderPullBranches(): void {
  const remoteBranches = getRemoteBranches();
  const upstreamBranch = getUpstreamBranch();
  const prev = pullBranchSel.value;
  pullBranchSel.innerHTML = "";
  for (const branch of remoteBranches) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = branch;
    pullBranchSel.append(opt);
  }
  if (prev && remoteBranches.includes(prev)) pullBranchSel.value = prev;
  else if (upstreamBranch && remoteBranches.includes(upstreamBranch)) pullBranchSel.value = upstreamBranch;
  updatePullDialog();
}

export function updatePullDialog(): void {
  const actionBusy = isActionBusy();
  pullBranchSel.disabled = actionBusy || getRemoteBranches().length === 0;
  pullCloseBtn.disabled = actionBusy;
  pullCancelBtn.disabled = actionBusy;
  pullSubmitBtn.disabled = actionBusy || !pullDialogRoot || !pullBranchSel.value;
}

function openPullDialog(): void {
  const root = getGitRoot();
  if (!root || getRemoteBranches().length === 0 || isActionBusy()) return;
  pullDialogRoot = root;
  const currentBranch = getCurrentBranch();
  pullTargetEl.textContent = currentBranch ? `→ ⎇ ${currentBranch}` : "";
  pullErrorEl.hidden = true;
  renderPullBranches();
  pullOverlay.hidden = false;
  requestAnimationFrame(() => pullBranchSel.focus());
}

export function closePullDialog(): void {
  if (isActionBusy()) return;
  pullOverlay.hidden = true;
  pullDialogRoot = null;
  if (!pullBtn.hidden) pullBtn.focus();
}

pullBtn.onclick = openPullDialog;
pullCloseBtn.onclick = closePullDialog;
pullCancelBtn.onclick = closePullDialog;
pullOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === pullOverlay) closePullDialog();
});
pullPanel.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    pullSubmitBtn.click();
  }
});
pullSubmitBtn.onclick = () => {
  const root = pullDialogRoot;
  const branch = pullBranchSel.value;
  if (!root || !branch) return;
  pullErrorEl.hidden = true;
  void (async () => {
    const ok = await runGitAction(
      () => invoke<string>("git_pull", { root, branch }),
      (error) => {
        pullErrorEl.textContent = error;
        pullErrorEl.hidden = false;
      },
    );
    if (ok) closePullDialog();
  })();
};

// Escape でモーダルを閉じる（元は worktree モーダルと1つの listener に相乗りしていた）
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    if (!pullOverlay.hidden) {
      e.stopPropagation();
      closePullDialog();
    }
  },
  true,
);
