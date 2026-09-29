// ============================================================
// Git ウィンドウ上部の操作ボタン（Commit / Pull / Push / Fetch / Worktree / Stash）と、
// サイドバーのチェックアウト。Pull・Worktree のモーダルとファイルステータスのコミット欄が
// 共有する runGitAction / isActionBusy もここに置く。
// 結果は画面右下のトースト（git-toast）に出す（ターミナルのレイアウトは変えない）。
// ============================================================

import { showGitToast } from "./git-toast";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentBranch, getGitCount, getGitCwd, getGitRoot, setCurrentBranch, updateGitWatch } from "./git-watch";
import { t } from "../../i18n";
import { renderPullBranches, renderPullTarget, updatePullDialog } from "./pull-dialog";
import { updateWorktreeDialog } from "./worktree-dialog";
import { focusCommitMessage, updateCommitBox } from "./git-status-view";
import { renderGitWindowHeader } from "./git-window";

export type GitBranches = {
  current: string | null;
  upstream: string | null;
  localBranches?: string[];
  branches: string[];
  remotes?: string[];
};

const commitBtn = document.querySelector<HTMLButtonElement>("#git-commit")!;
const stashBtn = document.querySelector<HTMLButtonElement>("#git-stash")!;
const worktreeBtn = document.querySelector<HTMLButtonElement>("#git-worktree")!;
const pushBtn = document.querySelector<HTMLButtonElement>("#git-push")!;
const fetchBtn = document.querySelector<HTMLButtonElement>("#git-fetch")!;
const pullBtn = document.querySelector<HTMLButtonElement>("#git-pull")!;

let branchSig = ""; // 前回描画したブランチ情報のシグネチャ
let actionBusy = false; // Git 操作中（操作ボタンをまとめて disabled）
let canPush = false;
let canFetch = false;
let remoteBranches: string[] = [];
let upstreamBranch: string | null = null;

export function isActionBusy(): boolean {
  return actionBusy;
}

export function isPushAvailable(): boolean {
  return canPush;
}

export function getRemoteBranches(): string[] {
  return remoteBranches;
}

export function getUpstreamBranch(): string | null {
  return upstreamBranch;
}

export function renderBranches(br: GitBranches | null): void {
  const sig = JSON.stringify(br);
  if (sig === branchSig) return;
  branchSig = sig;
  setCurrentBranch(br?.current ?? null);
  renderGitWindowHeader();
  renderPullTarget(getCurrentBranch());
  remoteBranches = br?.branches ?? [];
  upstreamBranch = br?.upstream ?? null;
  canPush = Boolean(br?.current && (br.remotes?.length ?? 0) > 0);
  canFetch = (br?.remotes?.length ?? 0) > 0;
  updateActionButtons();
  renderPullBranches();
}

/** 結果の表示（成功・実行中・エラー）。エラーは git の出力を全文そのまま出す */
export function showGitMsg(text: string, kind: "ok" | "err" | "busy"): void {
  showGitToast(text, kind);
}

/** ボタンの有効 / 無効をまとめて決め直す（監視結果・busy の変化のたびに呼ぶ） */
export function updateActionButtons(): void {
  const repo = Boolean(getGitRoot());
  commitBtn.disabled = actionBusy || getGitCount() === 0;
  stashBtn.disabled = actionBusy || getGitCount() === 0;
  worktreeBtn.disabled = actionBusy || !repo;
  pushBtn.disabled = actionBusy || !repo || !canPush;
  fetchBtn.disabled = actionBusy || !repo || !canFetch;
  // リモートブランチが無ければプル不可。取り込み元の選択は押下後のモーダル内で行う
  pullBtn.disabled = actionBusy || !repo || remoteBranches.length === 0;
}

function setActionBusy(busy: boolean): void {
  actionBusy = busy;
  updateActionButtons();
  updateCommitBox();
  updatePullDialog();
  updateWorktreeDialog();
}

export async function runGitAction(
  action: () => Promise<string>,
  onError?: (message: string) => void,
): Promise<boolean> {
  if (actionBusy) return false;
  setActionBusy(true);
  showGitMsg(t("agent.working"), "busy");
  try {
    showGitMsg(await action(), "ok");
    return true;
  } catch (e) {
    const message = String(e);
    showGitMsg(message, "err");
    onError?.(message);
    return false;
  } finally {
    setActionBusy(false);
    updateGitWatch(); // 変更一覧とブランチ表示を即更新
  }
}

/** サイドバーのローカルブランチをチェックアウトする（未コミット変更との競合は Git が拒否する） */
export function switchBranch(branch: string): void {
  const root = getGitRoot();
  if (!root || !branch || branch === getCurrentBranch()) return;
  void runGitAction(async () => {
    const out = await invoke<string>("git_switch_branch", { root, branch });
    return out || t("agent.switchBranchDone", { branch });
  });
}

/** サイドバーのリモートブランチをチェックアウトする（同名ローカルが無ければ追跡ブランチを作る） */
export function checkoutRemoteBranch(branch: string): void {
  const root = getGitRoot();
  if (!root || !branch) return;
  void runGitAction(async () => {
    const out = await invoke<string>("git_checkout_remote", { root, branch });
    return out || t("agent.switchBranchDone", { branch: branch.slice(branch.indexOf("/") + 1) });
  });
}

// Commit はファイルステータスのコミット欄へ移ってメッセージ入力にフォーカスする
commitBtn.onclick = () => {
  if (!commitBtn.disabled) focusCommitMessage();
};

pushBtn.onclick = () => {
  const root = getGitRoot();
  if (!root || !canPush) return;
  void runGitAction(async () => {
    const out = await invoke<string>("git_push", { root });
    return out || t("agent.pushDone");
  });
};

fetchBtn.onclick = () => {
  const root = getGitRoot();
  if (!root || !canFetch) return;
  void runGitAction(async () => {
    const out = await invoke<string>("git_fetch", { root });
    return out || t("agent.fetchDone");
  });
};

// 退避のスコープは表示中の変更と同じ「監視 cwd 配下」（未追跡を含む）
stashBtn.onclick = () => {
  const cwd = getGitCwd();
  if (!cwd || getGitCount() === 0) return;
  void runGitAction(async () => {
    const out = await invoke<string>("git_stash", { cwd });
    return out || t("agent.stashDone");
  });
};
