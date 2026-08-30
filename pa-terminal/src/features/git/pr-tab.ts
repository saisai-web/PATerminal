// git セクションの PR タブ（gh CLI）: open な PR の一覧だけを出す。
//
// 取得はタブを開いた時と60秒間隔と手動 ⟳ のみ（ネットワークを3秒ごとに叩かない）。
// 取得に失敗しても直前に取れた一覧は消さず、失敗理由（gh の生メッセージ）だけを足す。
// 行クリックは pr-overlay.ts の openPrFromList へ渡す一方向。

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { formatDate, statusEl } from "./git-log";
import { getIssueRoot } from "./issues-tab";
import { openPrFromList, prStateClass, prStateLabel } from "./pr-overlay";
import type { PrList, PrSummary } from "./git-panel-types";

const prsEl = document.querySelector<HTMLDivElement>("#exp-git-prs")!;

// PR 一覧は「直近に取れた一覧」と「直近の失敗理由」を別に持つ。取得に失敗しても
// 表示中の一覧を消さない（60秒ごとの自動更新が一瞬の gh 失敗で一覧を潰さないように）
let prListPrs: PrSummary[] | null = null;
let prListFailed = false;
let prListError = ""; // gh の生メッセージ。言語に依存しないので翻訳せずそのまま持つ
let prListLoading = false;
let prListFetchedAt = 0;
let prListToken = 0;
let prListBusyFor: string | null = null;
const PR_LIST_REFRESH_MS = 60_000;

/** PR オーバーレイが「一覧の行から開いたかどうか」を引き当てるのに使う */
export function getPrListPrs(): PrSummary[] | null {
  return prListPrs;
}

/** 監視先リポジトリが変わったとき: 一覧と失敗理由を捨て、走っている取得を無効化する */
export function resetPrList(): void {
  prListPrs = null;
  prListFailed = false;
  prListError = "";
  prListLoading = false;
  prListFetchedAt = 0;
  prListToken++;
}

/** PR タブを表示した時: 一覧が無い / 古ければ取り直す */
export function prsTabShown(): void {
  renderPrList();
  const root = getIssueRoot();
  if (root && (prListPrs === null || Date.now() - prListFetchedAt > PR_LIST_REFRESH_MS)) {
    void fetchPrList(root);
  }
}

/** 同じリポジトリを見続けている間の定期更新（60秒間隔） */
export function fetchPrListIfStale(root: string): void {
  if (Date.now() - prListFetchedAt > PR_LIST_REFRESH_MS) {
    void fetchPrList(root);
  }
}

export async function fetchPrList(root: string): Promise<void> {
  if (prListBusyFor === root) return;
  prListBusyFor = root;
  const token = ++prListToken;
  prListLoading = true;
  renderPrList();
  try {
    // invoke 自体の失敗（コマンド未登録など）も理由として見せる
    const res = await invoke<PrList>("pr_list", { root }).catch(
      (e): PrList => ({ available: false, prs: [], error: String(e) }),
    );
    if (token !== prListToken || root !== getIssueRoot()) return; // 追い越された古い応答
    prListFetchedAt = Date.now();
    if (res.available) {
      // open な PR だけ出す（MERGED / CLOSED は出さない）。Rust 側でも絞っているが、
      // 一覧の見た目を決めるのはこちらなので保険として同じ条件で絞る
      prListPrs = res.prs.filter((pr) => (pr.state ?? "").toUpperCase() === "OPEN");
      prListFailed = false;
      prListError = "";
    } else {
      // 失敗しても prListPrs（前回の成功分）は残す。理由だけ差し替える
      prListFailed = true;
      prListError = res.error?.trim() ?? "";
    }
  } finally {
    if (prListBusyFor === root) prListBusyFor = null;
    if (token === prListToken) {
      prListLoading = false;
      renderPrList();
    }
  }
}

/**
 * エクスプローラー下部（画面右下）の PR 一覧だけで使うブランチ表示。
 * 長いブランチ名で行が右へ膨らむのを防ぐため、上限超えは一律 "branch" と書く。
 * PR オーバーレイ側は実名のまま。
 */
const PR_LIST_BRANCH_MAX = 18;

function prListBranchLabel(name: string): string {
  return name.length > PR_LIST_BRANCH_MAX ? "branch" : name;
}

function buildPrRow(pr: PrSummary): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "pr-list-row";
  row.role = "button";
  row.tabIndex = 0;
  row.title = pr.title;

  const number = document.createElement("span");
  number.className = "pr-list-number";
  number.textContent = `#${pr.number}`;
  const title = document.createElement("span");
  title.className = "pr-list-title";
  title.textContent = pr.title;
  const state = document.createElement("span");
  state.className = `pr-list-state ${prStateClass(pr.state)}`;
  state.textContent = pr.isDraft ? t("git.prDraft") : prStateLabel(pr.state);
  const branches = document.createElement("span");
  branches.className = "pr-list-branches";
  branches.textContent = `${prListBranchLabel(pr.headRefName)} → ${prListBranchLabel(pr.baseRefName)}`;
  branches.title = `${pr.headRefName} → ${pr.baseRefName}`;
  const meta = document.createElement("span");
  meta.className = "pr-list-meta";
  meta.textContent = `${pr.author} · ${formatDate(pr.updatedAt)}`;
  row.append(number, title, state, branches, meta);
  row.onclick = () => void openPrFromList(pr);
  row.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    }
  };
  return row;
}

/** 失敗の見出し + gh の生メッセージ + 再試行。理由を出さないと gh 不在・未認証・
 *  リポジトリ違いのどれなのかユーザーが切り分けられない */
function buildPrListError(detail: string): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "issue-status is-error pr-list-error";
  const head = document.createElement("div");
  head.textContent = t("pr.loadFailed");
  box.append(head);
  const reason = document.createElement("div");
  reason.className = "pr-list-error-detail";
  const text = detail || t("pr.loadFailedUnknown");
  reason.textContent = text; // gh の出力そのまま（textContent でプレーン表示）
  reason.title = text;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "pr-list-retry";
  retry.textContent = t("pr.retry");
  retry.onclick = () => {
    const root = getIssueRoot();
    if (root) void fetchPrList(root);
  };
  box.append(reason, retry);
  return box;
}

export function renderPrList(): void {
  prsEl.replaceChildren();
  if (!getIssueRoot()) {
    // リポジトリ未解決を「PR はありません」と同じ文言にすると取りこぼしに見える
    prsEl.append(statusEl(t("pr.noRepo")));
    return;
  }
  // ⟳ を押したことが分かるように、一覧を消さずに読み込み中の行だけ足す
  if (prListLoading) prsEl.append(statusEl(t("pr.loading")));
  if (prListFailed) prsEl.append(buildPrListError(prListError));
  if (prListPrs === null) {
    if (!prListLoading && !prListFailed) prsEl.append(statusEl(t("pr.loading")));
    return;
  }
  if (prListPrs.length === 0) {
    if (!prListLoading && !prListFailed) prsEl.append(statusEl(t("pr.empty")));
    return;
  }
  for (const pr of prListPrs) prsEl.append(buildPrRow(pr));
}
