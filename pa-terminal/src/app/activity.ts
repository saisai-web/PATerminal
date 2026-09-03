// ============================================================
// 稼働インジケータ + デスクトップ通知
// （検知は Rust 側: 非表示ペインの出力は JS に届かないため。ここは遷移イベント
//   pty:act / pty:bell を受けて状態ラベルとドットを更新し、必要なら通知するだけ）
//
// 通知は tauri-plugin-notification 経由（WKWebView に Web Notification API が無い）。
// sendNotification はプラグイン注入の window.Notification を new する実装なので、
// dev-mock.ts がクラスごと差し替えて記録している。
// ============================================================

import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { t } from "../i18n";
import { updateAgentWatch } from "../features/agents/watch";
import { notifyPairActivity, notifyPairExit, notifyPairSignal } from "../features/pair/pair";
import { isNotificationsEnabled } from "../features/settings/settings-panel";
import { getActiveWs, isAppFocused, panes } from "../workspace/state";
import type { Pane } from "../terminal/pane";
import type { ActivityState, Workspace } from "../workspace/types";

const wsList = document.querySelector<HTMLDivElement>("#ws-list")!;

const activityWatchers = new Set<(workspace: Workspace) => void>();

/** 状態で一覧を絞る機能など、activity の表示上の派生状態だけを追従させる逆向きフック。 */
export function onWorkspaceActivityChange(watcher: (workspace: Workspace) => void): () => void {
  activityWatchers.add(watcher);
  return () => activityWatchers.delete(watcher);
}

/** 左サイドバーに常設する稼働状態。PTY が静止したら基本的に完了として扱うが、
    静止した画面が承認ダイアログ等（Rust の pty:act の waiting）なら入力待ちにする。 */
export function wsActivityState(
  ws: Workspace,
  busy = [...ws.panes.values()].some((p) => p.busy),
): ActivityState {
  if (busy) return "running";
  if ([...ws.panes.values()].some((p) => p.waiting)) return "waiting";
  return ws.activity;
}

export function wsActivityText(state: ActivityState): string {
  if (state === "running") return t("ws.statusRunning");
  if (state === "waiting") return t("ws.statusWaiting");
  return t("ws.statusDone");
}

/** 出力が静止した状態がこの時間続いたときだけ通知する。 */
const NOTIFY_IDLE_MS = 60_000;
/** 同一セッションへの連続通知の間引き。 */
const NOTIFY_COOLDOWN_MS = 5000;
const lastNotified = new Map<string, number>(); // wsId → epoch ms
const idleNotifyTimers = new Map<string, number>(); // wsId → window.setTimeout の ID

/** UI テストでは1分待たずに通知の経路だけ検証する。製品では常に NOTIFY_IDLE_MS。 */
function notificationIdleMs(): number {
  const tuning = (window as Window & { __activityTuning?: { notificationIdleMs?: unknown } })
    .__activityTuning?.notificationIdleMs;
  return typeof tuning === "number" && tuning >= 0 ? tuning : NOTIFY_IDLE_MS;
}

/**
 * 打鍵を伴わない PTY 出力を「実行中」と見なすまでの連続出力時間。
 * Rust の busy は1バイトの出力でも立つが、TUI はセッション切替（フォーカス通知・
 * リサイズ）や起動時の問い合わせだけでも再描画する。その burst は数百 ms で終わり、
 * 2 秒の静止判定を足しても 2.x 秒で idle になる。一方、claude / codex の実作業は
 * スピナー等で出力が途切れないので、これを超えて続いたときだけ実行中に切り替える。
 * ユーザーの打鍵（Pane.write）は従来どおり即座に実行中になる。
 */
const OUTPUT_BUSY_MS = 3000;
const outputBusyTimers = new Map<string, number>(); // paneId → window.setTimeout の ID

/** UI テストでは3秒待たずに遷移だけ検証する。製品では常に OUTPUT_BUSY_MS。 */
function outputBusyMs(): number {
  const tuning = (window as Window & { __activityTuning?: { outputBusyMs?: unknown } })
    .__activityTuning?.outputBusyMs;
  return typeof tuning === "number" && tuning >= 0 ? tuning : OUTPUT_BUSY_MS;
}

function cancelOutputBusy(pane: Pane): void {
  const timer = outputBusyTimers.get(pane.id);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  outputBusyTimers.delete(pane.id);
}

/** 出力が OUTPUT_BUSY_MS 続いたら実行中へ。途中で idle / exit が来れば取り消される。 */
function scheduleOutputBusy(pane: Pane): void {
  cancelOutputBusy(pane);
  const timer = window.setTimeout(() => {
    outputBusyTimers.delete(pane.id);
    if (panes.get(pane.id) !== pane || !pane.alive || pane.busy) return;
    // 起動完了後に出力を続けている既知の agent だけは、打鍵なしでも作業中と見なす
    // （cron / loop など agent 自身が起こしたターン）。通常のシェルの出力は操作を待つ。
    if (!pane.activityEngaged) {
      if (!pane.activityReady || !pane.spec.agent) return;
      pane.activityEngaged = true;
    }
    pane.busy = true;
    pane.waiting = false;
    cancelIdleNotification(pane.ws);
    updateWsActivity(pane.ws);
  }, outputBusyMs());
  outputBusyTimers.set(pane.id, timer);
}

function cancelIdleNotification(ws: Workspace): void {
  const timer = idleNotifyTimers.get(ws.id);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  idleNotifyTimers.delete(ws.id);
}

/**
 * 2秒の Rust 側静止判定はステータス更新・ペアモードにも使うため維持し、OS 通知だけは
 * ワークスペース内の全ペインが連続して1分静止した後に送る。次の実作業が始まれば取消す。
 */
function scheduleIdleNotification(ws: Workspace): void {
  cancelIdleNotification(ws);
  // 完了時に見ていたセッションは、あとで別のセッションへ移っただけで通知しない。
  if (!shouldAlert(ws)) return;
  if (![...ws.panes.values()].some((pane) => pane.activityEngaged)) return;
  if ([...ws.panes.values()].some((pane) => pane.busy)) return;
  const timer = window.setTimeout(() => {
    idleNotifyTimers.delete(ws.id);
    // タイマー待ちの間にセッションを閉じた・再開した場合は何もしない。
    if (![...ws.panes.values()].some((pane) => pane.activityEngaged)) return;
    if ([...ws.panes.values()].some((pane) => pane.busy)) return;
    const waiting = [...ws.panes.values()].some((pane) => pane.waiting);
    if (waiting) {
      void notifyWs(ws, t("notif.waitTitle"), t("notif.waitBody", { ws: ws.name }));
    } else {
      void notifyWs(ws, t("notif.doneTitle"), t("notif.doneBody", { ws: ws.name }));
    }
  }, notificationIdleMs());
  idleNotifyTimers.set(ws.id, timer);
}

/** 該当セッション項目のドットと文字ラベルだけを外科的に更新（renderSidebar は呼ばない。
    inline-edit ガード・DnD と衝突させないため。全再構築時は buildWsItem が再導出する） */
export function updateWsActivity(ws: Workspace) {
  const item = wsList.querySelector<HTMLDivElement>(`.ws-item[data-ws-id="${ws.id}"]`);
  const busy = [...ws.panes.values()].some((p) => p.busy);
  // 検索・状態フィルターで非表示なら DOM 更新は不要。watcher が必要に応じて全体を再描画する。
  if (item) {
    item.classList.toggle("is-busy", busy);
    item.classList.toggle("is-wait", !busy && [...ws.panes.values()].some((p) => p.waiting));
    item.classList.toggle("is-attn", Boolean(ws.attention));
    const status = item.querySelector<HTMLElement>(".ws-status");
    if (status) {
      const activity = wsActivityState(ws, busy);
      status.dataset.status = activity;
      status.textContent = wsActivityText(activity);
      status.hidden = false;
    }
  }
  for (const watcher of activityWatchers) watcher(ws);
}

/** 「ユーザーが今それを見ていない」= 通知・注意ドットに値する状況か */
function shouldAlert(ws: Workspace): boolean {
  return !isAppFocused() || ws !== getActiveWs();
}

let notifGranted: boolean | null = null;
export async function ensureNotifPermission(): Promise<boolean> {
  if (notifGranted !== null) return notifGranted;
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    notifGranted = ok === true;
  } catch {
    notifGranted = false; // プラグイン不在（古いバイナリ等）でも壊さない
  }
  return notifGranted;
}

async function notifyWs(ws: Workspace, title: string, body: string) {
  if (!isNotificationsEnabled() || !shouldAlert(ws)) return;
  const now = Date.now();
  if (now - (lastNotified.get(ws.id) ?? 0) < NOTIFY_COOLDOWN_MS) return;
  lastNotified.set(ws.id, now);
  try {
    if (await ensureNotifPermission()) sendNotification({ title, body });
  } catch {
    /* 通知失敗でアプリは壊さない */
  }
}

void listen<{ id: string }>("pty:exit", (e) => {
  const pane = panes.get(e.payload.id);
  if (!pane) return;
  cancelOutputBusy(pane);
  cancelIdleNotification(pane.ws);
  pane.busy = false;
  pane.waiting = false; // 終了したペインは誰の応答も待っていない
  updateWsActivity(pane.ws);
  notifyPairExit(pane); // ペアの片方が死んだらペアモードを終了状態にする
  // 終了した表示だけを残すと、見た目はターミナルなのに入力先の PTY が無い状態になる。
  // 同じペインで対話シェルを自動再起動し、exit / 異常終了後も必ず打鍵可能に戻す。
  pane.recoverFromExit();
});

void listen<{ id: string; busy: boolean; busyMs: number; waiting: boolean }>("pty:act", (e) => {
  const pane = panes.get(e.payload.id);
  if (!pane) return;
  cancelOutputBusy(pane);
  if (e.payload.busy) {
    // 出力が流れ始めた。打鍵で既に実行中ならそのまま。そうでなければ、シェル起動・
    // セッション可視化・フォーカス通知・リサイズによる TUI の再描画かもしれないので、
    // 出力が OUTPUT_BUSY_MS 続いたときだけ実行中にする（scheduleOutputBusy）。
    // それまでは表示（実行中 / 入力待ち / 完了）も注意ドットも変えない。
    if (pane.busy) cancelIdleNotification(pane.ws);
    else scheduleOutputBusy(pane);
    // ペアモード: busy/idle 遷移が自動ハンドオフの合図。生の遷移をそのまま渡す
    notifyPairActivity(pane, true, e.payload.busyMs, false);
    return;
  }
  // 静止した。実際に実行中だった（打鍵、または OUTPUT_BUSY_MS 続いた出力）ときだけ
  // 「完了」への遷移として扱う。再描画の burst が静止しただけなら、状態・注意ドット・
  // 通知の予約はいずれも触らない（開いただけのセッションから通知が量産されていた）。
  // 出力中に鳴った BEL は完了の合図なので、短いターンでも遷移に数える。
  const completed = pane.busy || pane.bellPending;
  pane.busy = false;
  pane.activityReady = true;
  pane.bellPending = false;
  // claude / codex の承認ダイアログのように「応答しないと進まない」画面で止まった時だけ
  // 入力待ちにする。それ以外は出力から完了と区別できないので、既定値は完了のまま。
  // BEL は完了時にも鳴るので、状態分類には使わない。
  const waiting = e.payload.waiting && pane.activityEngaged;
  pane.waiting = waiting;
  pane.ws.activity = "done";
  if (completed && shouldAlert(pane.ws)) {
    // 実際の活動が静止した = 完了 / 入力待ち。デスクトップ通知は下の遅延タイマーが送る。
    pane.ws.attention = waiting ? "waiting" : "done";
  }
  if (completed) scheduleIdleNotification(pane.ws);
  updateWsActivity(pane.ws);
  notifyPairActivity(pane, false, e.payload.busyMs, waiting);
  // エージェントの終了は「出力が流れて静止」と同時に起きることが多い。
  // 静止の瞬間に検知スイープを1回前倒しし、再開バナーの遅れを抑える
  updateAgentWatch();
});

void listen<{ id: string; bracketedPaste: boolean }>("pty:mode", (e) => {
  const pane = panes.get(e.payload.id);
  if (!pane) return;
  // 非表示ペインは PTY 出力が xterm に届かず term.modes が古いままになるため、
  // bracketed paste の状態は Rust 側の追跡（このイベント）を正とする
  pane.bracketedPaste = e.payload.bracketedPaste;
});

// ペアモードのターン完了シグナル（agents/signal.rs の監視スレッドが、注入した
// エージェント完了フックの作るファイルを拾って emit する）。token → ペインの
// 解決とフェーズ遷移はペア側が持つ
void listen<{ token: string }>("agent:turn", (e) => {
  notifyPairSignal(e.payload.token);
});

void listen<{ id: string }>("pty:bell", (e) => {
  const pane = panes.get(e.payload.id);
  if (!pane) return;
  // シェル初期化中の BEL はプロンプト準備音であって、完了通知にも使わない。
  // 最初の pty:act idle を受け取るまでは初期状態の「完了」を保つ。
  if (!pane.activityReady || !pane.activityEngaged) return;
  // BEL は「質問した時」にも「終わった時」にも鳴る。出力の途中（実行中への切替待ちを
  // 含む）なら静止まで判断を待ち、pty:act の waiting を見てから入力待ち / 完了の
  // どちらかで通知する
  if (pane.busy || outputBusyTimers.has(pane.id)) {
    pane.bellPending = true;
    return;
  }
  // 静止後に鳴ったベルは種別が分からないので、従来どおり完了として扱う
  pane.ws.activity = "done";
  if (shouldAlert(pane.ws)) {
    pane.ws.attention = "done";
  }
  scheduleIdleNotification(pane.ws);
  updateWsActivity(pane.ws);
});
