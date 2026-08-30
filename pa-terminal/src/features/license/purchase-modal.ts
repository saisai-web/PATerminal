// ============================================================
// 購入案内モーダル（#license-overlay）。ロック中の機能入口に触れた瞬間に開く。
// 脅さないトーンで、自ビルドの選択肢を隠さず明記する（指示書 §UI文言のトーン）。
// 開閉作法は他モーダル（broadcast-dialog 等）と同一。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { getLicense, refreshLicenseStatus, setPurchaseOpener } from "./license";

type Deps = {
  focusTerminal: () => void;
  /** 「ライセンスキーを入力」→ ライセンス管理モーダルを開く */
  openLicense: () => void;
};

let deps: Deps | null = null;

const overlay = document.getElementById("license-overlay") as HTMLDivElement;
const panel = document.getElementById("license-panel") as HTMLDivElement;
const closeBtn = document.getElementById("license-close") as HTMLButtonElement;
const buyBtn = document.getElementById("license-buy") as HTMLButtonElement;
const enterKeyBtn = document.getElementById("license-enter-key") as HTMLButtonElement;
const retrialBtn = document.getElementById("license-retrial") as HTMLButtonElement;
const errorEl = document.getElementById("license-modal-error") as HTMLDivElement;

function setOpen(open: boolean) {
  overlay.hidden = !open;
  if (open) {
    errorEl.hidden = true;
    retrialBtn.hidden = !getLicense().retrialAvailable;
  } else if (overlay.contains(document.activeElement)) {
    deps?.focusTerminal();
  }
}

export function openPurchaseModal() {
  setOpen(true);
}

export function initPurchaseModal(d: Deps) {
  deps = d;
  // requireFeature() がここへ届く（license.ts → モーダルの import 循環を避ける登録式）
  setPurchaseOpener(() => setOpen(true));
  closeBtn.onclick = () => setOpen(false);
  buyBtn.onclick = () => {
    const url = getLicense().checkoutUrl;
    if (url) void invoke("open_url", { url }).catch(() => {});
  };
  enterKeyBtn.onclick = () => {
    setOpen(false);
    deps?.openLicense();
  };
  retrialBtn.onclick = async () => {
    retrialBtn.disabled = true;
    try {
      await invoke("license_retrial");
      await refreshLicenseStatus();
      setOpen(false);
    } catch (e) {
      errorEl.textContent = String(e);
      errorEl.hidden = false;
    } finally {
      retrialBtn.disabled = false;
    }
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) setOpen(false);
  });
  panel.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    e.stopPropagation();
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || overlay.hidden) return;
      e.stopPropagation();
      setOpen(false);
    },
    true,
  );
}

/** 言語切替後の貼り直し（静的文言は applyStaticTexts が刻印するのでボタンだけ） */
export function renderPurchaseModalTexts() {
  retrialBtn.textContent = t("license.retrialStart");
}
