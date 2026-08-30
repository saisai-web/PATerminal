// ============================================================
// ライセンス状態のキャッシュとソフトロックのゲート
// フロントのロック判定は LicenseStatus.locked だけを見る（状態の内訳は表示専用）。
// 初期値は unlocked（fail-open）: license_status が未実装の古いバイナリや
// invoke 失敗でも機能を奪わない（迷ったらユーザー有利の大原則）。
// 期限の再評価は起動時 + 1時間ごと（initLicense のタイマー）。既存のポーリング系は
// interval を止めず、各 tick の冒頭で isLocked() を見る流儀にする。
// ============================================================

import { invoke } from "@tauri-apps/api/core";

export type LicenseStatus = {
  official: boolean;
  state: "selfbuild" | "trial" | "retrial" | "licensed" | "grace" | "locked";
  locked: boolean;
  daysLeft: number | null;
  supporter: boolean;
  keyMasked: string | null;
  keyKind: "paid" | "dev" | null;
  retrialAvailable: boolean;
  banner: string | null;
  guidePending: boolean;
  checkoutUrl: string;
};

/** 無料枠のペイン上限。3枚目以降の分割が課金機能（指示書 §ソフトロックの定義） */
export const FREE_PANE_LIMIT = 2;

const SELF_BUILD_DEFAULT: LicenseStatus = {
  official: false,
  state: "selfbuild",
  locked: false,
  daysLeft: null,
  supporter: false,
  keyMasked: null,
  keyKind: null,
  retrialAvailable: false,
  banner: null,
  guidePending: false,
  checkoutUrl: "",
};

let current: LicenseStatus = SELF_BUILD_DEFAULT;
const listeners: Array<(s: LicenseStatus) => void> = [];
let purchaseOpener: (() => void) | null = null;

export function getLicense(): LicenseStatus {
  return current;
}

export function isLocked(): boolean {
  return current.locked;
}

/** ロック中の機能入口に置くゲート。Locked なら購入案内を開いて false を返す */
export function requireFeature(): boolean {
  if (!current.locked) return true;
  purchaseOpener?.();
  return false;
}

/** purchase-modal.ts が登録する（license.ts → modal の import 循環を作らないため） */
export function setPurchaseOpener(fn: () => void) {
  purchaseOpener = fn;
}

/** 動的に構築されるメニュー項目へ 🔒 クラスを付けるヘルパ */
export function lockClass(el: HTMLElement) {
  if (current.locked) el.classList.add("is-locked");
}

export function onLicenseChange(fn: (s: LicenseStatus) => void) {
  listeners.push(fn);
}

export async function refreshLicenseStatus(): Promise<void> {
  let next: LicenseStatus;
  try {
    next = await invoke<LicenseStatus>("license_status");
  } catch {
    return; // 取得できない間は前回の状態を維持（初期値は unlocked）
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  if (changed) {
    for (const fn of listeners) fn(next);
  }
}

/** boot() から呼ぶ。1時間ごとに期限を再評価する（日付跨ぎで起動しっぱなしのケース） */
export function initLicense() {
  window.setInterval(() => void refreshLicenseStatus(), 3600_000);
}
