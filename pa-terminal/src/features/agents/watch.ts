// ============================================================
// 実行中エージェントの検知スイープ + ペイン内の再開バナー
//
// 全ペインの「いま claude / codex が動いているか」を 5 秒ごとに確認する。
// 確認は 1 回の IPC（pty_agents。Rust 側が ps / Toolhelp を1度だけ叩く）に
// まとめ、並列 invoke のバーストを作らない（CLAUDE.md 再発防止ルール3/5）。
//
// - 実行中: PaneSpec.agent に記録して session.json へ保存する。アプリ再起動・
//   最近削除からの復元では、この記録から再開コマンド（claude --resume <id> 等）を
//   自動入力して会話を引き継ぐ（terminal/pane.ts の start）
// - セッション ID: 検知直後から agent_session_id で解決する。エージェントの
//   保存ファイルは初回メッセージまで作られないことがあるため、解決できるまで
//   スイープごとに再試行し、一度解決したら固定する（mtime の新しさで選ぶと
//   同じリポジトリで並走する別ペインの会話を掴むため、Rust 側は「検知時刻以後に
//   作成されたファイル」だけを見る）
// - 終了: シェルは生きたままエージェントだけが消えたら、ペイン右上に
//   「再開」バナーを出す（クリックで再開コマンド + Enter を入力）。
//   自動では実行しない（勝手にキー入力を送らない方針）
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { isLocked } from "../license/license";
import { scheduleSave } from "../../app/session";
import { panes } from "../../workspace/state";
import type { Pane } from "../../terminal/pane";
import type { PaneAgentInfo } from "../../workspace/types";
import { resumeCommandFor } from "./agents";

const SWEEP_MS = 5000;
/** これ未満しか観測していないエージェントの終了にはバナーを出さない
    （`claude --help` のような一瞬の実行や誤検知の保険） */
const MIN_OBSERVED_MS = 3000;
/** ペインを見始めてからこの時間エージェントが一度も観測されなければ、保存済みの
    再開情報を消す（復元時に自動入力した再開コマンドをユーザーが消したケース。
    残したままだと次回の起動でも再開コマンドが入力されてしまう） */
const CLEAR_GRACE_MS = 30_000;
/** セッション ID 解決の下限時刻に持たせる余裕。検知はスイープ間隔ぶん遅れるため、
    「エージェントの実際の起動 → 検知」の間に作られたセッションを取りこぼさない */
const SINCE_SLACK_MS = 15_000;

type WatchState = {
  kind: string;
  /** 観測を始めた時刻（終了バナーを出すかの基準） */
  firstSeen: number;
  /** セッション ID 解決の下限（これ以後に作成されたセッションだけが候補） */
  since: number;
  /** 解決済みなら再試行しない（後から出来た別セッションへ乗り換えない） */
  resolved: boolean;
  resolving: boolean;
};

/** paneId → 実行中エージェントの観測状態 */
const running = new Map<string, WatchState>();
/** paneId → そのペインを初めて見た時刻（CLEAR_GRACE_MS の基準） */
const firstSweepAt = new Map<string, number>();
let sweeping = false;
let lastSweepAt = 0;

export function initAgentWatch(): void {
  window.setInterval(() => void sweep(), SWEEP_MS);
  void sweep();
}

/** pty:act の idle 遷移などの契機で呼ぶ（定期スイープを待たず即確認する）。
    エージェントの終了は「出力が流れて静止する」のと同時に起きるので、
    バナーが最大5秒遅れるのを防ぐ。連打はスイープ間隔の下限で間引く */
export function updateAgentWatch(): void {
  if (Date.now() - lastSweepAt < 1000) return;
  void sweep();
}

async function sweep(): Promise<void> {
  // ソフトロック対象（エージェント検知・再開バナー）。interval は止めず tick 冒頭で判定
  if (isLocked()) return;
  if (sweeping) return; // 前回のスイープが終わっていなければスキップ
  sweeping = true;
  lastSweepAt = Date.now();
  try {
    // 閉じたペインの観測状態を回収（spec.agent は保存データ側に残る =
    // シェルごと落ちたペインの復元では引き続き再開できる）
    for (const id of [...running.keys()]) {
      if (!panes.get(id)?.alive) running.delete(id);
    }
    for (const id of [...firstSweepAt.keys()]) {
      if (!panes.has(id)) firstSweepAt.delete(id);
    }
    const alive = [...panes.values()].filter((pane) => pane.alive);
    if (alive.length === 0) return;
    let result: Record<string, string | null>;
    try {
      result = await invoke<Record<string, string | null>>("pty_agents", {
        ids: alive.map((pane) => pane.id),
      });
    } catch {
      return; // 旧バイナリ等。検知なしのまま何もしない
    }
    const now = Date.now();
    for (const pane of alive) {
      if (!pane.alive || !panes.has(pane.id)) continue; // await 中に閉じられた
      apply(pane, result[pane.id] ?? null, now);
    }
  } finally {
    sweeping = false;
  }
}

function apply(pane: Pane, kind: string | null, now: number): void {
  if (!firstSweepAt.has(pane.id)) firstSweepAt.set(pane.id, now);
  const state = running.get(pane.id);
  if (kind) {
    // ユーザーが手で再開した場合もバナーは畳む
    hideResumeBanner(pane);
    if (!state || state.kind !== kind) {
      running.set(pane.id, {
        kind,
        firstSeen: now,
        since: now - SINCE_SLACK_MS,
        resolved: false,
        resolving: false,
      });
      // 実行中エージェントとして記録。復元直後の再検知では保存済みの sessionId を
      // 残す（新しい ID が解決できるまでのフォールバック）
      if (pane.spec.agent?.kind !== kind) {
        pane.spec.agent = { kind };
        scheduleSave();
      }
      void resolveSessionId(pane);
    } else if (!state.resolved) {
      // 保存ファイルは初回メッセージまで作られないことがある。解決まで再試行
      void resolveSessionId(pane);
    }
    return;
  }
  if (state) {
    // 実行中 → 消えた = エージェントの終了。記録を消し（次回の復元で
    // 勝手に再開しない）、ワンクリック再開のバナーだけを残す
    running.delete(pane.id);
    const info = pane.spec.agent;
    pane.spec.agent = undefined;
    scheduleSave();
    if (info && now - state.firstSeen >= MIN_OBSERVED_MS) {
      showResumeBanner(pane, info);
    }
    return;
  }
  if (
    pane.spec.agent &&
    now - (firstSweepAt.get(pane.id) ?? now) > CLEAR_GRACE_MS
  ) {
    // 復元された再開情報が残ったまま、エージェントが一度も観測されない
    // （自動入力された再開コマンドをユーザーが消した等）。次回の起動で
    // また再開コマンドを注入しないよう記録を消す
    pane.spec.agent = undefined;
    scheduleSave();
  }
}

/** 検知時点の cwd からエージェントのセッション ID を解決して spec.agent に足す。
    解決できるまで各スイープから再試行され、成功したら固定される */
async function resolveSessionId(pane: Pane): Promise<void> {
  const state = running.get(pane.id);
  if (!state || state.resolving || state.resolved) return;
  state.resolving = true;
  try {
    let live: string | null = null;
    try {
      live = await invoke<string | null>("pty_cwd", { id: pane.id });
    } catch {
      /* フォールバックへ */
    }
    const cwd = live ?? pane.cwd ?? pane.spec.cwd;
    if (!cwd) return;
    const id = await invoke<string | null>("agent_session_id", {
      kind: state.kind,
      cwd,
      sinceMs: state.since,
    });
    // await 中に終了・別エージェント化していたら反映しない
    if (running.get(pane.id) !== state || !pane.alive) return;
    if (id && pane.spec.agent?.kind === state.kind) {
      state.resolved = true;
      if (pane.spec.agent.sessionId !== id) {
        pane.spec.agent = { kind: state.kind, sessionId: id };
        scheduleSave();
      }
    }
  } catch {
    /* 旧バイナリ等。ID 無し（--continue へ退化）のまま */
  } finally {
    state.resolving = false;
  }
}

/** シェルは生きたままエージェントだけが終了したペインに出すワンクリック再開バナー。
    クリックで再開コマンド + Enter を入力する（明示操作なので Enter まで送る）。
    自動実行はしない */
function showResumeBanner(pane: Pane, info: PaneAgentInfo): void {
  const cmd = resumeCommandFor(info);
  if (!cmd) return;
  hideResumeBanner(pane);
  const banner = document.createElement("div");
  banner.className = "pane-resume";
  const label = document.createElement("span");
  label.className = "pane-resume-label";
  label.textContent = t("agents.exited", { agent: info.kind });
  const resume = document.createElement("button");
  resume.className = "pane-resume-btn";
  resume.textContent = t("agents.resume");
  resume.title = cmd;
  resume.onclick = (e) => {
    e.stopPropagation();
    hideResumeBanner(pane);
    pane.write(`${cmd}\r`);
    pane.focus();
  };
  const close = document.createElement("button");
  close.className = "pane-resume-close";
  close.textContent = "×";
  close.title = t("agents.dismiss");
  close.onclick = (e) => {
    e.stopPropagation();
    hideResumeBanner(pane);
  };
  banner.append(label, resume, close);
  pane.el.append(banner);
}

function hideResumeBanner(pane: Pane): void {
  pane.el.querySelector(".pane-resume")?.remove();
}
