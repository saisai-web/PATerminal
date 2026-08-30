// ============================================================
// ライセンス関連の1行バナー（#license-banner、ツールバーの上）。
// - トライアル残 7/3/1 日と Locked 初回の4種は Rust 側の既読管理
//   （banners_shown + license_banner_seen）で「一度だけ」を保証する
// - 自ビルドの新バージョン通知（1日1回・設定でオフ可）もここに出す
// 表示/非表示でグリッドの高さが変わるので必ず layout() を通す。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { getLicense, onLicenseChange, type LicenseStatus } from "./license";

type Deps = {
  layout: () => void;
};

let deps: Deps | null = null;

const bannerEl = document.getElementById("license-banner") as HTMLDivElement;
const textEl = document.getElementById("license-banner-text") as HTMLSpanElement;
const buyBtn = document.getElementById("license-banner-buy") as HTMLButtonElement;
const closeBtn = document.getElementById("license-banner-close") as HTMLButtonElement;

function show(text: string, withBuy: boolean) {
  textEl.textContent = text;
  buyBtn.hidden = !withBuy;
  if (bannerEl.hidden) {
    bannerEl.hidden = false;
    deps?.layout();
  }
}

function hide() {
  if (!bannerEl.hidden) {
    bannerEl.hidden = true;
    deps?.layout();
  }
}

/** license_status の banner フィールド（未読があるときだけ非 null）を表示し既読化する */
function maybeShowLicenseBanner(s: LicenseStatus) {
  if (!s.banner) return;
  const text =
    s.banner === "lockedOnce"
      ? t("license.bannerLocked")
      : t("license.bannerTrial", { days: String(s.daysLeft ?? 0) });
  show(text, true);
  // 表示した時点で既読（毎起動のポップアップ禁止は Rust 側の記録で保証）
  void invoke("license_banner_seen", { id: s.banner }).catch(() => {});
}

/** 自ビルドの新バージョン通知（initSelfBuildNotify から） */
export function showUpdateBanner(version: string) {
  show(t("license.bannerUpdate", { v: version }), false);
}

export function initLicenseBanner(d: Deps) {
  deps = d;
  closeBtn.onclick = hide;
  buyBtn.onclick = () => {
    const url = getLicense().checkoutUrl;
    if (url) void invoke("open_url", { url }).catch(() => {});
  };
  maybeShowLicenseBanner(getLicense());
  onLicenseChange(maybeShowLicenseBanner);
}
