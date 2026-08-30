// ============================================================
// PTY サイズの配信（pty_resize の唯一の窓口）
//
// xterm の cols/rows と PTY のサイズがずれると、TUI（claude / codex）は
// 実際と違う幅で描き続ける。狭いペインで PTY が広いままだと、TUI が出した
// 長い行を xterm 側が折り返すため TUI のカーソル計算が崩れ、
// **アプリを再起動するまで直らない**レイアウト崩れになる。
//
// ここが担うのは4つ:
// 1. **spawn ゲート**: pty_spawn の完了前に決まったサイズを保持し、完了後に送る
//    （ペインは DOM 挿入前に spawn されるので、最初の fit は必ず spawn より先に来る）
// 2. **束ね**: ウィンドウのドラッグリサイズで SIGWINCH を連射しない。
//    TUI が欲しいのは「落ち着いた1回」であって、途中経過ではない
// 3. **重複排除**: 同じサイズを送らない（no-op の SIGWINCH でも Ink は再描画する）
// 4. **リトライ**: IPC が落ちてもサイズを取りこぼさない
//
// 送信は**単一の promise チェーン**で直列化する。pty_resize は個別の
// async コマンドなので、並行に投げると順序が保証されない（CLAUDE.md ルール3/5）。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { diag, diagPush } from "./diag";

type Size = { cols: number; rows: number };

type Entry = {
  /** 最後に refit が決めたサイズ */
  desired: Size | null;
  /** Rust が受け取ったサイズ */
  sent: Size | null;
  /** pty_spawn が完了したか。未完了の間は送らずに保持する */
  ready: boolean;
  attempts: number;
  dead: boolean;
};

/** 打鍵が止まってから送るまで。TUI に渡すのは「落ち着いた1回」だけにする */
const SETTLE_MS = 120;
/** 連続変化が続いても、最初の変化からこれ以上は待たない */
const MAX_WAIT_MS = 400;
const MAX_ATTEMPTS = 5;

const entries = new Map<string, Entry>();
let settleTimer = 0;
let settleDeadline = 0;
/** 送信の直列化。reject させないので then で繋ぎ続けてよい */
let chain: Promise<void> = Promise.resolve();

const same = (a: Size | null, b: Size | null) =>
  !!a && !!b && a.cols === b.cols && a.rows === b.rows;

export function registerPane(id: string) {
  entries.set(id, { desired: null, sent: null, ready: false, attempts: 0, dead: false });
}

export function unregisterPane(id: string) {
  const e = entries.get(id);
  if (e) e.dead = true;
  entries.delete(id);
}

/** pty_spawn の完了。保持していたサイズがあればここで送りに行く */
export function markSpawned(id: string) {
  const e = entries.get(id);
  if (!e) return;
  e.ready = true;
  if (e.desired && !same(e.desired, e.sent)) scheduleSettle();
}

/** refit が決めたサイズを記録する（実際の送信は束ねてから） */
export function requestResize(id: string, cols: number, rows: number) {
  const e = entries.get(id);
  if (!e || e.dead) return;
  if (same(e.desired, { cols, rows })) return;
  e.desired = { cols, rows };
  e.attempts = 0;
  diag.rsz++;
  if (!same(e.desired, e.sent)) scheduleSettle();
}

/** 束ねを待たずに今すぐ送り、届き切るまで待つ（セッション切替で使う）。
    保留が無ければマイクロタスクで解決するので、通常の切替は遅くならない */
export function flushResizes(ids?: string[]): Promise<void> {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = 0;
    settleDeadline = 0;
  }
  chain = chain.then(() => sendPending(ids));
  return chain;
}

function scheduleSettle() {
  const now = Date.now();
  if (!settleDeadline) settleDeadline = now + MAX_WAIT_MS;
  const at = Math.min(now + SETTLE_MS, settleDeadline);
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    settleDeadline = 0;
    chain = chain.then(() => sendPending());
  }, Math.max(0, at - now));
}

/** 送信対象: spawn 済み・生存・desired が sent と違うもの */
function pendingIds(ids?: string[]): string[] {
  const target = ids ?? [...entries.keys()];
  return target.filter((id) => {
    const e = entries.get(id);
    return !!e && e.ready && !e.dead && !!e.desired && !same(e.desired, e.sent);
  });
}

async function sendPending(ids?: string[]): Promise<void> {
  for (const id of pendingIds(ids)) {
    const e = entries.get(id);
    // ループ中に閉じられている可能性がある
    if (!e || e.dead || !e.ready) continue;
    const want = e.desired;
    if (!want || same(want, e.sent)) continue;
    try {
      await invoke("pty_resize", { id, cols: want.cols, rows: want.rows });
      e.sent = want;
      e.attempts = 0;
      diag.rszOk++;
    } catch (err) {
      diag.rszErr++;
      e.attempts++;
      if (e.attempts >= MAX_ATTEMPTS) {
        // これ以上叩いても直らない。次に本当にサイズが変わったら再挑戦する
        console.error("pty_resize failed:", err);
        diagPush(`rszgiveup:${id}`);
        e.sent = want;
        e.attempts = 0;
        continue;
      }
      diagPush(`rszerr:${id}`);
      window.setTimeout(scheduleSettle, 100 * 2 ** (e.attempts - 1));
    }
  }
}

/** テスト用: 送信待ちが無くなるまで待つ */
export function resizeSettled(): Promise<void> {
  return chain;
}
