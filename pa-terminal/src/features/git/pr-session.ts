// PR 一覧・詳細の「新規セッション」で共有する処理。
//
// 確認画面は挟まず、保存済みの worktree 格納先を使って PR の head ブランチを
// 用意する。同じブランチの worktree があれば Rust 側が再利用する。進行状態と
// エラーもここに集約し、同じ PR を一覧と詳細の両方に表示していても同期させる。

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { getWorktreePrefs, worktreeDirFor } from "./worktree";
import type { WorktreeResult } from "./worktree";

export type PrSessionRequest = {
  root: string;
  number: number;
  title: string;
  headRefName: string | null;
};

type PrSessionDeps = {
  /** worktree の準備後、前面の PR 画面を閉じて通常シェルを開く */
  onReady: (args: { number: number; title: string; cwd: string }) => void;
};

let deps: PrSessionDeps = { onReady: () => {} };
const busy = new Set<string>();
type PrSessionError = { kind: "missingBranch" } | { kind: "failure"; error: string };
const errors = new Map<string, PrSessionError>();
const listeners = new Set<() => void>();

function requestKey(root: string, number: number): string {
  return `${root}\u0000${number}`;
}

export function initPrSession(d: PrSessionDeps): void {
  deps = d;
}

export function subscribePrSessionState(listener: () => void): void {
  listeners.add(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function isPrSessionBusy(root: string | null, number: number | null): boolean {
  return root !== null && number !== null && busy.has(requestKey(root, number));
}

export function getPrSessionError(root: string | null, number: number | null): string {
  if (root === null || number === null) return "";
  const error = errors.get(requestKey(root, number));
  if (!error) return "";
  return error.kind === "missingBranch"
    ? t("pr.sessionMissingBranch")
    : t("pr.sessionFailed", { error: error.error });
}

export async function createPrSessionFromPr(request: PrSessionRequest): Promise<void> {
  const key = requestKey(request.root, request.number);
  if (busy.has(key)) return;
  const branch = request.headRefName?.trim() ?? "";
  if (!branch) {
    errors.set(key, { kind: "missingBranch" });
    notify();
    return;
  }

  busy.add(key);
  errors.delete(key);
  notify();

  let result: WorktreeResult | null = null;
  try {
    const prefs = getWorktreePrefs();
    result = await invoke<WorktreeResult>("git_worktree_from_pr", {
      root: request.root,
      number: request.number,
      branch,
      directory: worktreeDirFor(prefs.location),
      location: prefs.location,
      inherit: prefs.inherit,
    });
  } catch (error) {
    errors.set(key, { kind: "failure", error: String(error) });
  } finally {
    busy.delete(key);
    notify();
  }

  if (result) {
    deps.onReady({
      number: request.number,
      title: request.title,
      cwd: result.path,
    });
  }
}
