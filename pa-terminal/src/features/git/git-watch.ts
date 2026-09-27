// フォーカス中ペインの git 監視（変更ファイル・ブランチ）。
//
// 3秒ごと（+ フォーカス移動・cwd 変化などの updateGitWatch 契機）に git_changes と
// git_branches をポーリングし、結果を
//   - ツールバーの Git ボタンの件数バッジ
//   - Git ウィンドウ（ファイルステータス・操作ボタン・履歴 / サイドバーの再取得契機）
// へ配る。監視先の cwd は毎回 resolveWatchCwd で解決する（シェルの実 cwd。cd に確実に追従する）。
// 監視結果はこのファイルが所有し、accessor 経由で読ませる（循環 import の TDZ を避けるため、
// トップレベルの変数を直接見せない）。

import { invoke } from "@tauri-apps/api/core";
import { renderBranches, updateActionButtons } from "./git-actions";
import type { GitBranches } from "./git-actions";
import { gitWindowTick, renderGitOpenBadge } from "./git-window";
import { renderStatusFiles } from "./git-status-view";
import { isLocked } from "../license/license";
import { closePullDialog, getPullDialogRoot, isPullDialogOpen } from "./pull-dialog";
import { setQuickPhraseRepo } from "../quick-phrases/quick-phrases";
import { syncWorktreeDialogWithWatch } from "./worktree-dialog";

type WatchDeps = {
  /** 監視すべき cwd（フォーカス中ペインのシェルの実 cwd）。ポーリングごとに解決する */
  resolveWatchCwd: () => Promise<string | null>;
};

let deps: WatchDeps = { resolveWatchCwd: async () => null };

export function initGitWatch(d: WatchDeps): void {
  deps = d;
  // 監視結果が来るまでは操作ボタンを無効に（モジュール評価中は循環 import で呼べないのでここで）
  renderBranches(null);
}

export type GitFile = { path: string; adds: number; dels: number; status: string };
type GitChanges = { repo: boolean; root: string | null; files: GitFile[] };

let gitRoot: string | null = null;
let gitCwd: string | null = null; // 直近に監視した cwd（コミット・スタッシュのスコープに使う）
let gitFiles: GitFile[] = [];
// 現在ブランチも監視結果の一部（設定は git-actions.ts の renderBranches）
let currentBranch: string | null = null;
let gitBusy = false;
// フォーカス移動や cwd 変更がポーリング中に来ても、その再確認を捨てない。
// true になった時点で進行中の応答は古い監視先のものなので描画せず、直後に取り直す。
let gitPollPending = false;

export function getGitRoot(): string | null {
  return gitRoot;
}

export function getGitCwd(): string | null {
  return gitCwd;
}

export function getGitFiles(): GitFile[] {
  return gitFiles;
}

export function getGitCount(): number {
  return gitFiles.length;
}

export function getCurrentBranch(): string | null {
  return currentBranch;
}

export function setCurrentBranch(branch: string | null): void {
  currentBranch = branch;
}

/** フォーカス移動や cwd 変化の契機で呼ぶ（定期ポーリングを待たず即1回確認する） */
export function updateGitWatch(): void {
  void pollGit(true);
}

async function pollGit(refreshIfBusy: boolean): Promise<void> {
  // ソフトロック対象。interval は止めず毎 tick 冒頭で判定する
  // （購入・キー登録すれば次の tick から自然に復帰する）
  if (isLocked()) {
    renderGitOpenBadge(0);
    return;
  }
  if (gitBusy) {
    // フォーカス移動・cwd 変更などの明示更新だけを予約する。3秒タイマーまで予約すると、
    // 大きなリポジトリで取得に3秒以上かかる場合に応答を捨て続けてしまう。
    if (refreshIfBusy) gitPollPending = true;
    return;
  }
  gitPollPending = true;
  gitBusy = true;
  try {
    while (gitPollPending) {
      gitPollPending = false;
      const cwd = await deps.resolveWatchCwd();
      if (gitPollPending) continue; // await 中に監視先が変わった

      let res: GitChanges | null = null;
      let br: GitBranches | null = null;
      if (cwd) {
        res = await invoke<GitChanges>("git_changes", { cwd }).catch(() => null);
        if (gitPollPending) continue;
        // ブランチ情報もポーリングに相乗り（for-each-ref はローカル処理で軽い）
        if (res?.repo && res.root) {
          br = await invoke<GitBranches>("git_branches", { root: res.root }).catch(() => null);
          if (gitPollPending) continue;
        }
      }

      // cwd・変更一覧・ブランチを同じ監視時点のスナップショットとしてまとめて反映する
      gitCwd = res?.repo && cwd ? cwd : null;
      applyChanges(res);
      renderBranches(br);
      // 操作ボタンは変更件数（Commit / Stash）とブランチ・リモート（Push / Fetch / Pull）の
      // 両方で決まるので、両方を反映し終えてから決め直す。applyChanges の中で呼ぶと
      // 新しいリポジトリに前のリポジトリのリモート情報を組み合わせた状態で一度描いてしまう
      updateActionButtons();
      // Git ウィンドウが開いていれば履歴・サイドバーも同じ cwd で更新する
      gitWindowTick(cwd, Boolean(res?.repo));
    }
  } finally {
    gitBusy = false;
  }
}

function applyChanges(res: GitChanges | null): void {
  const files = res?.repo ? res.files : [];
  const nextRoot = res?.root ?? null;
  gitRoot = nextRoot;
  // 定型文バーは「汎用 + いま見ているリポジトリ専用」だけを出す
  setQuickPhraseRepo(nextRoot);
  gitFiles = files;
  if (isPullDialogOpen() && nextRoot !== getPullDialogRoot()) closePullDialog();
  syncWorktreeDialogWithWatch(nextRoot);
  renderGitOpenBadge(files.length);
  renderStatusFiles();
}

window.setInterval(() => void pollGit(false), 3000);
