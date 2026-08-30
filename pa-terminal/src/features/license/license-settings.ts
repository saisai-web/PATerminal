// ============================================================
// ライセンス管理モーダル（#license-manage-overlay）。設定パネルとは独立の
// 専用モーダルで、サイドバーの 🔑 / 設定内の入口 / 購入モーダルの
// 「ライセンスキーを入力」から開く。
// 状態表示（Trial残 / Licensed / Grace残 / Locked / Supporter / 自ビルド）、
// キーの登録・解除、デバイス一覧と解除、DeviceLimit 時の「解除して続行」、
// 購入リンク、Win-back、自ビルドの新バージョン通知トグルを持つ。
// 要素 ID は設定パネル時代の #settings-license-* のまま（UIテストとの互換のため）。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { getLicense, refreshLicenseStatus, type LicenseStatus } from "./license";

type Device = { id: string; label: string; createdAt: string | null };
type ActivateOutcome =
  | { kind: "activated"; status: LicenseStatus }
  | { kind: "deviceLimit"; devices: Device[] };

const overlay = document.getElementById("license-manage-overlay") as HTMLDivElement;
const modalPanel = document.getElementById("license-manage-panel") as HTMLDivElement;
const modalCloseBtn = document.getElementById("license-manage-close") as HTMLButtonElement;
const sidebarOpenBtn = document.getElementById("license-open") as HTMLButtonElement;
const statusEl = document.getElementById("settings-license-status") as HTMLDivElement;
const stateEl = document.getElementById("settings-license-state") as HTMLDivElement;
const keyInput = document.getElementById("settings-license-key") as HTMLInputElement;
const registerBtn = document.getElementById("settings-license-register") as HTMLButtonElement;
const removeBtn = document.getElementById("settings-license-remove") as HTMLButtonElement;
const msgEl = document.getElementById("settings-license-msg") as HTMLDivElement;
const devicesEl = document.getElementById("settings-license-devices") as HTMLDivElement;
const deviceListEl = document.getElementById("settings-license-device-list") as HTMLDivElement;
const buyBtn = document.getElementById("settings-license-buy") as HTMLButtonElement;
const retrialBtn = document.getElementById("settings-license-retrial") as HTMLButtonElement;
const notifyRow = document.getElementById("settings-update-notify-row") as HTMLLabelElement;
const notifyCheck = document.getElementById("settings-update-notify") as HTMLInputElement;

/** DeviceLimit で登録が保留になっているキー（「解除して続行」の再試行に使う） */
let pendingKey: string | null = null;

function stateText(s: LicenseStatus): string {
  if (!s.official) {
    return s.supporter ? t("license.stateSupporter") : t("license.stateSelfbuild");
  }
  const days = String(s.daysLeft ?? 0);
  switch (s.state) {
    case "trial":
      return t("license.stateTrial", { days });
    case "retrial":
      return t("license.stateRetrial", { days });
    case "licensed":
      return t("license.stateLicensed");
    case "grace":
      return t("license.stateGrace", { days });
    default:
      return t("license.stateLocked");
  }
}

function errorText(raw: string): string {
  switch (raw) {
    case "malformed":
      return t("license.errMalformed");
    case "bad-signature":
      return t("license.errBadSignature");
    case "expired":
      return t("license.errExpired");
    case "revoked":
      return t("license.errRevoked");
    default:
      return raw;
  }
}

function showMsg(text: string, isError: boolean) {
  msgEl.textContent = text;
  msgEl.classList.toggle("is-error", isError);
  msgEl.hidden = !text;
}

function renderDevices(devices: Device[], limitMode: boolean) {
  deviceListEl.textContent = "";
  devicesEl.hidden = devices.length === 0;
  for (const d of devices) {
    const row = document.createElement("div");
    row.className = "settings-license-device";
    const label = document.createElement("span");
    label.textContent = d.createdAt ? `${d.label} — ${d.createdAt.slice(0, 10)}` : d.label;
    const remove = document.createElement("button");
    remove.textContent = limitMode ? t("license.deviceRemoveContinue") : t("license.deviceRemove");
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await invoke("license_device_remove", { activationId: d.id });
        if (limitMode && pendingKey) {
          // 上限で保留していた登録をその場で再試行する（買い替えで詰まない導線）
          await activate(pendingKey);
        } else {
          await loadDevices();
        }
      } catch (e) {
        showMsg(String(e), true);
        remove.disabled = false;
      }
    };
    row.append(label, remove);
    deviceListEl.append(row);
  }
}

async function loadDevices() {
  const s = getLicense();
  if (s.keyKind !== "paid") {
    renderDevices([], false);
    return;
  }
  try {
    const devices = await invoke<Device[]>("license_devices");
    renderDevices(devices, false);
  } catch {
    renderDevices([], false); // 取得できないだけならセクションを隠す（エラーで脅さない）
  }
}

async function activate(key: string) {
  registerBtn.disabled = true;
  showMsg("", false);
  try {
    const outcome = await invoke<ActivateOutcome>("license_activate", { key });
    if (outcome.kind === "deviceLimit") {
      pendingKey = key;
      // Polar の現行 API は認証なしでデバイス一覧を返さないため通常 devices は空。
      // 空のときは「他の端末で解除してから再試行」の案内に切り替える
      // （一覧が取れた場合は従来どおり「解除して続行」を出す）
      showMsg(
        t(outcome.devices.length > 0 ? "license.deviceLimit" : "license.deviceLimitNoList"),
        true,
      );
      renderDevices(outcome.devices, true);
      return;
    }
    pendingKey = null;
    keyInput.value = "";
    await refreshLicenseStatus();
    showMsg(t("license.activateOk"), false);
    renderLicenseSection();
    void loadDevices();
  } catch (e) {
    showMsg(errorText(String(e)), true);
  } finally {
    registerBtn.disabled = false;
  }
}

/** 状態カードの色分け用クラス（license.css の #settings-license-status.is-*） */
function statusClass(s: LicenseStatus): string {
  if (!s.official) return "is-neutral";
  switch (s.state) {
    case "licensed":
      return "is-good";
    case "grace":
    case "locked":
      return "is-warn";
    default:
      return "is-info"; // trial / retrial
  }
}

/** モーダルを開いたとき・言語切替時の表示の貼り直し */
export function renderLicenseSection() {
  const s = getLicense();
  stateEl.textContent = stateText(s);
  statusEl.className = statusClass(s);
  const hasKey = s.keyMasked !== null;
  removeBtn.hidden = !hasKey;
  keyInput.placeholder = hasKey
    ? t("license.registeredKey", { key: s.keyMasked ?? "" })
    : t("license.keyPlaceholder");
  // 購入リンクは公式ビルドの未購入状態でだけ出す（Supporter へ二重に売り込まない）
  buyBtn.hidden = !s.official || s.state === "licensed" || !s.checkoutUrl;
  retrialBtn.hidden = !s.retrialAvailable;
  // 新バージョン通知のトグルは自ビルドのみ（公式は自動更新があるため不要）
  notifyRow.hidden = s.official;
}

/** モーダルを開いたときの遅延ロード（デバイス一覧・通知トグルの現在値） */
function onLicenseModalOpen() {
  showMsg("", false);
  renderLicenseSection();
  void loadDevices();
  if (!getLicense().official) {
    void invoke<{ off: boolean; due: boolean }>("license_update_notify", { off: null })
      .then((info) => {
        notifyCheck.checked = !info.off;
      })
      .catch(() => {});
  }
}

/** ライセンス管理モーダルの開閉（設定パネル・購入モーダルからも呼ばれる） */
export function setLicenseManageOpen(open: boolean) {
  overlay.hidden = !open;
  if (open) {
    onLicenseModalOpen();
    keyInput.focus();
  }
}

export function initLicenseSettings() {
  sidebarOpenBtn.onclick = () => setLicenseManageOpen(true);
  modalCloseBtn.onclick = () => setLicenseManageOpen(false);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) setLicenseManageOpen(false); // バックドロップクリックで閉じる
  });
  // モーダル内の打鍵をターミナルやショートカットへ流さない（他モーダルと同じ流儀）
  modalPanel.addEventListener("keydown", (e) => e.stopPropagation());
  window.addEventListener(
    "keydown",
    (e) => {
      if (!overlay.hidden && e.key === "Escape") {
        e.stopPropagation();
        setLicenseManageOpen(false);
      }
    },
    true,
  );
  registerBtn.onclick = () => {
    const key = keyInput.value.trim();
    if (key) void activate(key);
  };
  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") registerBtn.click();
  });
  removeBtn.onclick = async () => {
    removeBtn.disabled = true;
    try {
      await invoke("license_deactivate");
      await refreshLicenseStatus();
      renderLicenseSection();
      renderDevices([], false);
    } catch (e) {
      showMsg(String(e), true);
    } finally {
      removeBtn.disabled = false;
    }
  };
  buyBtn.onclick = () => {
    const url = getLicense().checkoutUrl;
    if (url) void invoke("open_url", { url }).catch(() => {});
  };
  retrialBtn.onclick = async () => {
    retrialBtn.disabled = true;
    try {
      await invoke("license_retrial");
      await refreshLicenseStatus();
      renderLicenseSection();
    } catch (e) {
      showMsg(String(e), true);
    } finally {
      retrialBtn.disabled = false;
    }
  };
  notifyCheck.onchange = () => {
    void invoke("license_update_notify", { off: !notifyCheck.checked }).catch(() => {});
  };
}
