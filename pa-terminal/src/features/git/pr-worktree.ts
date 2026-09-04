// PR 一覧・詳細の「新規セッション」で共有する処理。
//
// 変更ストリップの Worktree モーダルを PR モードで開く。置き場所ラジオ・作成中の
// 無効化・既存 worktree 一覧を Worktree ボタンと同じ画面で出し、作成後は PR 画面と
// 拡大モーダルを閉じて通常シェルのセッション（「#番号 タイトル」）を開く。

import { closeGitPanelModal } from "./git-panel";
import { getIssueRoot } from "./issues-tab";
import { closePrOverlay } from "./pr-overlay";
import { getPrListPrs } from "./pr-tab";
import { openWorktreeDialog } from "./worktree-dialog";
import type { PrSummary } from "./git-panel-types";

/** 詳細画面しか持っていない PR の最低限の情報。一覧に無いときの候補にする */
export type PrWorktreeFallback = Pick<PrSummary, "number" | "title" | "headRefName" | "state">;

export async function openWorktreeDialogForPr(
  number: number,
  fallback?: PrWorktreeFallback,
): Promise<void> {
  const root = getIssueRoot();
  if (!root) return;
  const listed = getPrListPrs() ?? [];
  const prs =
    listed.some((pr) => pr.number === number) || !fallback
      ? listed
      : [
          {
            url: "",
            author: "",
            baseRefName: "",
            isDraft: false,
            updatedAt: "",
            ...fallback,
          },
          ...listed,
        ];
  await openWorktreeDialog({
    root,
    pr: { prs, number },
    beforeOpenSession: () => {
      // 詳細と拡大一覧を閉じても以前のボタンへ focus を戻さない。直後に作る
      // セッションのターミナルへ createWorkspace が focus を移すため。
      closePrOverlay(false);
      closeGitPanelModal(false);
    },
  });
}
