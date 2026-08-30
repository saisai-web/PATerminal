// サイドバーのセッション git バッジ: 各セッション項目に
// 「リポジトリ名 · 変更ファイル数 +追加 -削除」、「⎇ ブランチ」の順で常時表示する。
//
// 全セッションを5秒間隔で直列にポーリング（git_summary = 集計済みサマリのみ。
// macOS では IPC 配送がメインスレッド消費なので、ファイル一覧は流さず並列バーストも
// しない。CLAUDE.md 再発防止ルール3/5）。各セッションの全ペインについて pty_cwd
// （シェルの実 cwd）を優先し、取れなければ OSC 7 / spec.cwd へフォールバック。
// 前回から変更量が動いた worktree をそのセッションの表示対象にし、
// 動きが無い間は直前の対象を保つ（複数の dirty worktree 間で往復させない）。
//
// 更新は renderSidebar() を呼ばず、既存の .ws-git 要素だけを外科的に差し替える
// （inline-edit ガードで握り潰されず、DnD 中の DOM 破壊も起きない）。
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。

import { invoke } from "@tauri-apps/api/core";
import { isLocked } from "../license/license";
import { t } from "../../i18n";

export type WsGitPaneTarget = {
  paneId: string;
  paneAlive: boolean;
  /** OSC 7 / spec.cwd による cwd（pty_cwd が取れない環境のフォールバック） */
  fallbackCwd: string | null;
  /** 複数 worktree が同時に動いたときの優先順位 */
  busy: boolean;
  focused: boolean;
};

/** ポーリング1回分の対象。毎スイープ deps.getTargets() で取り直す（閉じた ws を掴まない） */
export type WsGitTarget = {
  wsId: string;
  /** セッション内で開いている全ペイン */
  panes: WsGitPaneTarget[];
};

type WsGitDeps = { getTargets: () => WsGitTarget[] };

type GitSummary = {
  repo: boolean;
  root: string | null;
  branch: string | null;
  fileCount: number;
  adds: number;
  dels: number;
};

type WsGitInfo = {
  root: string;
  repoName: string;
  branch: string | null;
  fileCount: number;
  adds: number;
  dels: number;
};

type Candidate = {
  cwd: string;
  info: WsGitInfo;
  busy: boolean;
  focused: boolean;
};

let deps: WsGitDeps = { getTargets: () => [] };

/** wsId → 直近のサマリ（非リポジトリ・未取得は null）。buildWsGitEl が同期で読む */
const cache = new Map<string, WsGitInfo | null>();
/** wsId → 前回描画したシグネチャ（無変化なら DOM に触らない） */
const sigs = new Map<string, string>();
/** wsId → 現在追従中の worktree root。clean になっても保持する */
const selectedRoots = new Map<string, string>();
/** wsId → root → 前回の変更量。新しく動いた worktree の検出用 */
const observed = new Map<string, Map<string, string>>();
let busy = false;

export function initWsGit(d: WsGitDeps): void {
  deps = d;
  window.setInterval(() => void sweep(), 5000);
  void sweep();
}

/** cwd 変化などの契機で呼ぶ（定期ポーリングを待たず即1回確認する） */
export function updateWsGit(): void {
  void sweep();
}

/** buildWsItem から呼ぶ: キャッシュの内容で .ws-git 行を作る（未取得なら非表示のまま） */
export function buildWsGitEl(wsId: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ws-git";
  fillBadge(el, cache.get(wsId) ?? null);
  return el;
}

async function sweep(): Promise<void> {
  // ソフトロック対象（セッション git バッジ）。interval は止めず tick 冒頭で判定し、
  // 表示済みのバッジはキャッシュごと外す
  if (isLocked()) {
    if (cache.size) {
      for (const id of [...cache.keys()]) {
        cache.delete(id);
        patchBadge(id, null);
      }
    }
    return;
  }
  if (busy) return; // 前回のスイープが終わっていなければスキップ
  busy = true;
  try {
    // 閉じられたセッションのキャッシュを回収
    const liveIds = new Set(deps.getTargets().map((x) => x.wsId));
    for (const id of [...cache.keys()]) {
      if (!liveIds.has(id)) {
        cache.delete(id);
        sigs.delete(id);
        selectedRoots.delete(id);
        observed.delete(id);
      }
    }
    // 直列に1セッションずつ（並列 IPC バーストでメインスレッドを圧迫しない）
    for (const tg of deps.getTargets()) {
      // await の間にセッションが閉じられていたら飛ばす
      if (!deps.getTargets().some((x) => x.wsId === tg.wsId)) continue;
      const candidates = await resolveCandidates(tg);
      const info = selectCandidate(tg.wsId, candidates)?.info ?? null;
      cache.set(tg.wsId, info);
      patchBadge(tg.wsId, info);
    }
  } finally {
    busy = false;
  }
}

async function resolveCwd(tg: WsGitPaneTarget): Promise<string | null> {
  let live: string | null = null;
  if (tg.paneAlive) {
    try {
      live = await invoke<string | null>("pty_cwd", { id: tg.paneId });
    } catch {
      /* フォールバックへ */
    }
  }
  return live ?? tg.fallbackCwd;
}

/** ペイン順に直列取得。同じ cwd のペインは git を1回だけ呼ぶ */
async function resolveCandidates(tg: WsGitTarget): Promise<Candidate[]> {
  const byCwd = new Map<string, { busy: boolean; focused: boolean }>();
  for (const pane of tg.panes) {
    // await 中にペインが閉じられたらその結果は使わない
    const current = deps
      .getTargets()
      .find((x) => x.wsId === tg.wsId)
      ?.panes.some((x) => x.paneId === pane.paneId);
    if (!current) continue;
    const cwd = await resolveCwd(pane);
    if (!cwd) continue;
    const existing = byCwd.get(cwd);
    if (existing) {
      existing.busy ||= pane.busy;
      existing.focused ||= pane.focused;
    } else {
      byCwd.set(cwd, { busy: pane.busy, focused: pane.focused });
    }
  }

  const byRoot = new Map<string, Candidate>();
  for (const [cwd, state] of byCwd) {
    const res = await invoke<GitSummary>("git_summary", { cwd }).catch(() => null);
    if (!res?.repo || !res.root) continue;
    const candidate: Candidate = {
      cwd,
      busy: state.busy,
      focused: state.focused,
      info: {
        root: res.root,
        repoName: pathBase(res.root),
        branch: res.branch,
        fileCount: res.fileCount,
        adds: res.adds,
        dels: res.dels,
      },
    };
    const existing = byRoot.get(res.root);
    if (!existing) {
      byRoot.set(res.root, candidate);
    } else {
      existing.busy ||= candidate.busy;
      existing.focused ||= candidate.focused;
      // 同じ worktree の別サブディレクトリを開いている場合は、
      // より広い変更が見えているサマリを表示に使う。
      if (candidate.info.fileCount > existing.info.fileCount) {
        existing.cwd = candidate.cwd;
        existing.info = candidate.info;
      }
    }
  }
  return [...byRoot.values()];
}

function summarySig(info: WsGitInfo): string {
  return `${info.branch ?? ""}\0${info.fileCount}\0${info.adds}\0${info.dels}`;
}

function preferred(list: Candidate[]): Candidate | undefined {
  return list.find((x) => x.busy) ?? list.find((x) => x.focused) ?? list[0];
}

/**
 * 実際に変更量が動いた worktree を優先する。複数が dirty でも、
 * 新しい動きが無い間は前回選んだ root を維持するので表示がぶれない。
 */
function selectCandidate(wsId: string, candidates: Candidate[]): Candidate | undefined {
  const previous = observed.get(wsId);
  const next = new Map(candidates.map((x) => [x.info.root, summarySig(x.info)]));
  const movedDirty = candidates.filter(
    (x) => x.info.fileCount > 0 && previous?.get(x.info.root) !== next.get(x.info.root),
  );
  const currentRoot = selectedRoots.get(wsId);
  const selected =
    preferred(movedDirty) ??
    candidates.find((x) => x.info.root === currentRoot) ??
    preferred(candidates.filter((x) => x.info.fileCount > 0)) ??
    preferred(candidates);

  observed.set(wsId, next);
  if (selected) selectedRoots.set(wsId, selected.info.root);
  else selectedRoots.delete(wsId);
  return selected;
}

/** サイドバー上の既存バッジをその場で差し替える。無変化なら何もしない */
function patchBadge(wsId: string, info: WsGitInfo | null): void {
  const sig = info
    ? `${info.root}\0${info.branch ?? ""}\0${info.fileCount}\0${info.adds}\0${info.dels}`
    : "";
  if (sigs.get(wsId) === sig) return;
  sigs.set(wsId, sig);
  const el = document.querySelector<HTMLDivElement>(`#ws-list .ws-item[data-ws-id="${wsId}"] .ws-git`);
  if (el) fillBadge(el, info);
}

function fillBadge(el: HTMLDivElement, info: WsGitInfo | null): void {
  el.textContent = "";
  if (!info) {
    el.hidden = true;
    el.removeAttribute("title");
    return;
  }
  el.hidden = false;
  const repo = document.createElement("span");
  repo.className = "ws-git-repo";
  repo.textContent = info.repoName;
  el.append(repo);
  if (info.fileCount > 0) {
    const files = document.createElement("span");
    files.className = "ws-git-files";
    files.textContent = `· ${info.fileCount}`;
    const add = document.createElement("span");
    add.className = "ws-git-add";
    add.textContent = `+${info.adds}`;
    const del = document.createElement("span");
    del.className = "ws-git-del";
    del.textContent = `-${info.dels}`;
    el.append(files, add, del);
  }
  if (info.branch) {
    const branch = document.createElement("span");
    branch.className = "ws-git-branch";
    branch.textContent = `⎇ ${info.branch}`;
    el.append(branch);
  }
  el.title = t("ws.gitTooltip", {
    root: info.root,
    branch: info.branch ?? "-",
    n: String(info.fileCount),
    adds: String(info.adds),
    dels: String(info.dels),
  });
}

function pathBase(p: string): string {
  const c = p.replace(/[\\/]+$/, "");
  const i = Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\"));
  return i >= 0 ? c.slice(i + 1) || p : c || p;
}
