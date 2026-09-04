// ============================================================
// worktree 作成中のローディング（worktree add → 環境ファイルのコピー）。
//
// Worktree モーダルと Issue 画面が同じ見た目で出す。Rust からの進捗イベント
// （worktree:inherit）は root で宛先を判定し、作成を頼んだ画面だけに反映する。
// マークアップはここで組み立て、各画面のパネル（position: relative）へ重ねる。
// ============================================================

import { listen } from "@tauri-apps/api/event";
import { t } from "../../i18n";
import type { WorktreeResult } from "./worktree";

export type WorktreeInheritProgress = {
  root: string;
  target: string;
  done: number;
  total: number;
  entry: string;
};

export type WorktreeProgressView = {
  /** ローディングを出し、その root 宛の進捗イベントを受け取り始める */
  start: (root: string) => void;
  /** ローディングを消し、進捗イベントの受け取りをやめる */
  stop: () => void;
};

type ActiveView = { root: string; show: (progress: WorktreeInheritProgress) => void };
const activeViews = new Set<ActiveView>();

/** 作成結果の文言。引き継いだ件数を添え、一部失敗があれば警告を続ける。 */
export function worktreeResultMessage(result: WorktreeResult): string {
  const path = result.path;
  let message = result.reused
    ? t("agent.worktreeReused", { path })
    : result.inherited > 0
      ? t("agent.worktreeCreatedInherited", { path, count: String(result.inherited) })
      : t("agent.worktreeCreated", { path });
  const warning = result.inheritWarning?.trim();
  if (warning) message += `\n${t("agent.worktreeInheritWarning", { error: warning })}`;
  return message;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  id?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (id) node.id = id;
  return node;
}

/**
 * `panel` の上に重ねるローディングを作る。要素の id は `${idPrefix}-progress` 系
 * （UI テストが参照する）。`progress` が無い間は件数不明の流れる帯にする。
 */
export function createWorktreeProgress(panel: HTMLElement, idPrefix: string): WorktreeProgressView {
  const overlay = el("div", "wt-progress", `${idPrefix}-progress`);
  overlay.role = "status";
  overlay.setAttribute("aria-live", "polite");
  overlay.hidden = true;
  const card = el("div", "wt-progress-card");
  const spinner = el("div", "wt-progress-spinner");
  spinner.setAttribute("aria-hidden", "true");
  const text = el("div", "wt-progress-text");
  const titleEl = el("span", "wt-progress-title", `${idPrefix}-progress-title`);
  const detailEl = el("span", "wt-progress-detail", `${idPrefix}-progress-detail`);
  text.append(titleEl, detailEl);
  const barEl = el("div", "wt-progress-bar is-indeterminate");
  const fillEl = el("div", "wt-progress-fill", `${idPrefix}-progress-fill`);
  barEl.append(fillEl);
  const countEl = el("span", "wt-progress-count", `${idPrefix}-progress-count`);
  card.append(spinner, text, barEl, countEl);
  overlay.append(card);
  panel.append(overlay);

  const show = (progress: WorktreeInheritProgress | null): void => {
    overlay.hidden = false;
    if (!progress) {
      titleEl.textContent = t("agent.worktreeProgressCreating");
      detailEl.textContent = "";
      countEl.textContent = "";
      barEl.classList.add("is-indeterminate");
      fillEl.style.width = "0";
      return;
    }
    const finished = progress.total > 0 && progress.done >= progress.total;
    titleEl.textContent = t(
      finished ? "agent.worktreeProgressFinishing" : "agent.worktreeProgressCopying",
    );
    detailEl.textContent = progress.entry;
    countEl.textContent = progress.total > 0 ? `${progress.done} / ${progress.total}` : "";
    barEl.classList.remove("is-indeterminate");
    const ratio = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
    fillEl.style.width = `${Math.round(ratio * 100)}%`;
  };
  const active: ActiveView = { root: "", show };
  return {
    start(repoRoot) {
      active.root = repoRoot;
      activeViews.add(active);
      show(null);
    },
    stop() {
      activeViews.delete(active);
      overlay.hidden = true;
      barEl.classList.add("is-indeterminate");
      fillEl.style.width = "0";
    },
  };
}

// Rust からの引き継ぎ進捗。root が一致する（= その画面が頼んだ）ものだけ表示に反映する
void listen<WorktreeInheritProgress>("worktree:inherit", (e) => {
  for (const view of activeViews) {
    if (view.root === e.payload.root) view.show(e.payload);
  }
});
