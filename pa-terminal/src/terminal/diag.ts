// ============================================================
// 入力診断（打鍵取りこぼし調査用の一時計測。解決後に削除してよい）
// key: keydown で見えた印字キー数 / data: xterm onData の文字数 /
// sent,ok,err: pty_write の送信・成功・失敗文字数 / echo: PTY から戻った文字数 /
// rsz,rszOk,rszErr: pty_resize の要求・成功・失敗回数（PTY と xterm のサイズずれ調査用）
// ============================================================

import { invoke } from "@tauri-apps/api/core";

export const diag = {
  key: 0,
  data: 0,
  sent: 0,
  ok: 0,
  err: 0,
  echo: 0,
  rsz: 0,
  rszOk: 0,
  rszErr: 0,
};
let diagEvents: string[] = [];
let diagDirty = false;

export function diagPush(ev: string) {
  diagEvents.push(`${Date.now() % 1000000}:${ev}`);
  if (diagEvents.length > 400) diagEvents.splice(0, diagEvents.length - 400);
  diagDirty = true;
}

window.addEventListener(
  "keydown",
  (e) => {
    // 修飾キーなしの印字キーだけ数える（IME 経由は e.key が "Process" になるので除外される）
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      diag.key++;
      diagPush(`k:${e.key === " " ? "spc" : e.key}`);
    }
  },
  true,
);

window.setInterval(() => {
  if (!diagDirty) return;
  diagDirty = false;
  const line = JSON.stringify({ t: new Date().toISOString(), ...diag, events: diagEvents });
  diagEvents = [];
  void invoke("diag_save", { line }).catch(() => {});
}, 5000);
