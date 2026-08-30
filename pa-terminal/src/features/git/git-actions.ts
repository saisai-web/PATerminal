// ============================================================
// ストリップの git 操作（Checkout / Stash / Worktree と Commit / Push / Fetch / Pull）
// 操作バー（#git-actions）のボタン配線と、3つのモーダルが共有する
// showGitMsg / setActionBusy / runGitAction を持つ。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentBranch,
  getGitCount,
  getGitCwd,
  getGitRoot,
  setCurrentBranch,
  updateGitWatch,
} from "./agent-panel";
import { renderCommitBranch, updateCommitDialog } from "./commit-dialog";
import { t } from "../../i18n";
import { layout } from "../../terminal/layout";
import { renderPullBranches, renderPullTarget, updatePullDialog } from "./pull-dialog";
import { updateWorktreeDialog } from "./worktree-dialog";

export type GitBranches = {
  current: string | null;
  upstream: string | null;
  localBranches?: string[];
  branches: string[];
  remotes?: string[];
};

const actionsEl = document.querySelector<HTMLDivElement>("#git-actions")!;
const msgEl = document.querySelector<HTMLSpanElement>("#git-msg")!;
const localBranchSel = document.querySelector<HTMLSelectElement>("#git-local-branch")!;
const switchBranchBtn = document.querySelector<HTMLButtonElement>("#git-switch-branch")!;
const stashBtn = document.querySelector<HTMLButtonElement>("#git-stash")!;
const commitBtn = document.querySelector<HTMLButtonElement>("#git-commit")!;
const worktreeBtn = document.querySelector<HTMLButtonElement>("#git-worktree")!;
const pushBtn = document.querySelector<HTMLButtonElement>("#git-push")!;
const fetchBtn = document.querySelector<HTMLButtonElement>("#git-fetch")!;
const pullBtn = document.querySelector<HTMLButtonElement>("#git-pull")!;
const pullBranchSel = document.querySelector<HTMLSelectElement>("#pull-branch")!;

let branchSig = ""; // 前回描画したブランチ情報のシグネチャ
let branchSelRoot: string | null = null; // セレクトを合わせた時点のリポジトリ
let branchSelCurrent: string | null = null; // セレクトを合わせた時点の現在ブランチ
let actionBusy = false; // Git 操作中（操作ボタンをまとめて disabled）
let canPush = false;
let canFetch = false;
let remoteBranches: string[] = [];
let upstreamBranch: string | null = null;
let msgTimer = 0;
let msgTall = false; // 複数行のエラーを出しているか（帯の高さが変わる）

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

/** Git 配下ではクリーンな状態でも操作バーを固定表示する。 */
export function setGitActionsVisible(repo: boolean): void {
  actionsEl.hidden = !repo;
}

export function renderBranches(br: GitBranches | null): void {
  const sig = JSON.stringify(br);
  if (sig === branchSig) return;
  // ユーザーがドロップダウンを開いている最中は選択肢を引っこ抜かない（次のポーリングで反映）
  if (document.activeElement === pullBranchSel || document.activeElement === localBranchSel) return;
  branchSig = sig;
  setCurrentBranch(br?.current ?? null);
  renderCommitBranch(getCurrentBranch());
  renderPullTarget(getCurrentBranch());
  const localBranches = br?.localBranches ?? (br?.current ? [br.current] : []);
  const previousLocal = localBranchSel.value;
  // 現在ブランチが変わった（ターミナルでの checkout / 別リポジトリや別 worktree の
  // ペインへフォーカス移動）ときは、ユーザーが選びかけていた値より現在ブランチを優先する。
  // 全 worktree はローカルブランチ一覧を共有するので、「一覧に残っているから」だけで
  // 前の選択を維持すると、セレクトが現在ブランチから永久にずれる。
  const followCurrent = branchSelRoot !== getGitRoot() || branchSelCurrent !== (br?.current ?? null);
  branchSelRoot = getGitRoot();
  branchSelCurrent = br?.current ?? null;
  localBranchSel.innerHTML = "";
  for (const branch of localBranches) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = branch;
    localBranchSel.append(opt);
  }
  if (!followCurrent && previousLocal && localBranches.includes(previousLocal)) {
    localBranchSel.value = previousLocal;
  } else if (br?.current && localBranches.includes(br.current)) {
    localBranchSel.value = br.current;
  }
  localBranchSel.hidden = switchBranchBtn.hidden = localBranches.length === 0;
  updateSwitchBranchButton();
  const branches = br?.branches ?? [];
  remoteBranches = branches;
  upstreamBranch = br?.upstream ?? null;
  canPush = Boolean(br?.current && (br.remotes?.length ?? 0) > 0);
  canFetch = (br?.remotes?.length ?? 0) > 0;
  pushBtn.disabled = actionBusy || !canPush;
  fetchBtn.disabled = actionBusy || !canFetch;
  // リモートが無ければプルボタンを隠す。取り込み元の選択は押下後のモーダル内で行う。
  pullBtn.hidden = branches.length === 0;
  pullBtn.disabled = actionBusy || branches.length === 0;
  renderPullBranches();
  updateCommitDialog();
}

/** 操作結果の表示。成功・実行中は1行だけ（8秒で消える）、
    **エラーだけは git の出力を全文そのまま折り返して出す**（省略記号で切ると
    原因が読めない。Rust 側の git_headline が1行目に要約を足している）。
    エラーは読んで対処するものなので寿命も長い。全文はホバーの title でも読める */
export function showGitMsg(text: string, kind: "ok" | "err" | "busy"): void {
  window.clearTimeout(msgTimer);
  msgEl.hidden = false;
  msgEl.className = kind;
  msgEl.textContent = kind === "err" ? text : text.split("\n")[0];
  msgEl.title = text;
  setMsgTall(kind === "err" && text.includes("\n"));
  if (kind !== "busy") {
    msgTimer = window.setTimeout(() => {
      msgEl.hidden = true;
      setMsgTall(false);
    }, kind === "err" ? 60000 : 8000);
  }
}

/** 複数行エラーの出し入れは帯の高さを変えるので、グリッドを refit する */
function setMsgTall(tall: boolean): void {
  if (tall === msgTall) return;
  msgTall = tall;
  layout();
}

function setActionBusy(busy: boolean): void {
  actionBusy = busy;
  updateStashButton();
  updateCommitButton();
  updateCommitDialog();
  pushBtn.disabled = busy || !canPush;
  fetchBtn.disabled = busy || !canFetch;
  updateWorktreeButton();
  pullBtn.disabled = busy || remoteBranches.length === 0;
  updatePullDialog();
  updateWorktreeDialog();
  localBranchSel.disabled = busy;
  updateSwitchBranchButton();
}

function updateSwitchBranchButton(): void {
  const selected = localBranchSel.value;
  switchBranchBtn.disabled =
    actionBusy || !getGitRoot() || !selected || selected === getCurrentBranch();
}

export function updateCommitButton(): void {
  commitBtn.disabled = actionBusy || getGitCount() === 0;
}

export function updateStashButton(): void {
  stashBtn.disabled = actionBusy || getGitCount() === 0;
}

export function updateWorktreeButton(): void {
  worktreeBtn.disabled = actionBusy || !getGitRoot();
}

export async function runGitAction(action: () => Promise<string>, onError?: (message: string) => void): Promise<boolean> {
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
    updateGitWatch(); // チップとブランチ表示を即更新
  }
}

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

localBranchSel.addEventListener("change", updateSwitchBranchButton);
switchBranchBtn.onclick = () => {
  const root = getGitRoot();
  const branch = localBranchSel.value;
  if (!root || !branch || branch === getCurrentBranch()) return;
  void runGitAction(async () => {
    const out = await invoke<string>("git_switch_branch", { root, branch });
    return out || t("agent.switchBranchDone", { branch });
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

// ボタン操作をターミナルやグローバルショートカットに流さない（インライン編集と同じ流儀）
actionsEl.addEventListener("keydown", (e) => e.stopPropagation());
