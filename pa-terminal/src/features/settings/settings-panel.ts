// ============================================================
// 設定パネル（テーマ / 言語 / 通知 / アップデート確認）
// モーダルオーバーレイなのでレイアウトに影響しない（layout() は呼ばない）
//
// currentTheme / notificationsEnabled / appVersion はこのモジュールが所有し、
// 保存（serializeAll）と復元（boot）は accessor 経由で読み書きする。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_THEME, THEMES, applyThemeCss, xtermThemeFor } from "./themes";
import type { ThemeId } from "./themes";
import { applyStaticTexts, getLang, LANGS, setLang, t } from "../../i18n";
import type { Lang } from "../../i18n";
import { renderAgentPanelTexts } from "../git/agent-panel";
import { ensureNotifPermission } from "../../app/activity";
import { renderExplorerFavs, renderExplorerList } from "../explorer/explorer";
import { renderGitPanelTexts } from "../git/git-panel";
import { renderQuickPhrasesTexts } from "../quick-phrases/quick-phrases";
import { getPairDefaultCmds, renderPairTexts, updatePairDefaultCmds } from "../pair/pair";
import { flushSessionSave, scheduleSave } from "../../app/session";
import { renderSidebar } from "../sidebar/sidebar";
import { getActiveWs, panes, workspaces } from "../../workspace/state";
import { renderSessionTrashTexts } from "../sidebar/session-trash";
import { getWorktreePrefs, updateWorktreePrefs, worktreeDirFor } from "../git/worktree";
import type { WorktreeLocation } from "../git/worktree";
import { renderBroadcastUi } from "../../workspace/workspace";
import { renderBroadcastDialogTexts } from "../broadcast/broadcast-dialog";
import { getLicense, isLocked, requireFeature } from "../license/license";
import { renderLockMarks } from "../license/lock-marks";
import { renderLicenseSection, setLicenseManageOpen } from "../license/license-settings";
import { renderPurchaseModalTexts } from "../license/purchase-modal";
import { openCurrentEula, showThirdPartyNotices } from "../license/eula";
import {
  checkOfficialUpdate,
  installOfficialUpdate,
  type OfficialUpdateInfo,
} from "../update/updater";

const settingsOpenBtn = document.querySelector<HTMLButtonElement>("#settings-open")!;
const settingsOverlay = document.querySelector<HTMLDivElement>("#settings-overlay")!;
const settingsPanel = document.querySelector<HTMLDivElement>("#settings-panel")!;
const settingsCloseBtn = document.querySelector<HTMLButtonElement>("#settings-close")!;
const settingsThemesEl = document.querySelector<HTMLDivElement>("#settings-themes")!;
const settingsLangsEl = document.querySelector<HTMLDivElement>("#settings-langs")!;
const settingsNotifEl = document.querySelector<HTMLInputElement>("#settings-notif")!;
const autoEnterBtn = document.querySelector<HTMLButtonElement>("#auto-enter-toggle")!;
const autoEnterOverlay = document.querySelector<HTMLDivElement>("#auto-enter-overlay")!;
const autoEnterPanel = document.querySelector<HTMLDivElement>("#auto-enter-panel")!;
const autoEnterCloseBtn = document.querySelector<HTMLButtonElement>("#auto-enter-close")!;
const autoEnterAllEl = document.querySelector<HTMLInputElement>("#auto-enter-all")!;
const autoEnterListEl = document.querySelector<HTMLDivElement>("#auto-enter-list")!;
const settingsVersionEl = document.querySelector<HTMLSpanElement>("#settings-version")!;
const settingsCheckBtn = document.querySelector<HTMLButtonElement>("#settings-check-update")!;
const settingsUpdateResultEl = document.querySelector<HTMLDivElement>("#settings-update-result")!;
const settingsPairImplEl = document.querySelector<HTMLInputElement>("#settings-pair-impl")!;
const settingsPairReviewEl = document.querySelector<HTMLInputElement>("#settings-pair-review")!;
const settingsPairSwapBtn = document.querySelector<HTMLButtonElement>("#settings-pair-swap")!;
const settingsWorktreeLocRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>("#settings-worktree-loc input[type=radio]"),
);
const settingsWorktreeDirEl = document.querySelector<HTMLInputElement>("#settings-worktree-dir")!;
const settingsWorktreeInheritRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>("#settings-worktree-inherit input[type=radio]"),
);
const settingsWorktreeDirLabelEl = document.querySelector<HTMLSpanElement>("#settings-worktree-dir-label")!;
const settingsNavItems = Array.from(
  document.querySelectorAll<HTMLButtonElement>("#settings-nav .settings-nav-item"),
);
const settingsSections = Array.from(
  document.querySelectorAll<HTMLElement>("#settings-content section[data-section]"),
);

type UpdateInfo = { current: string; latest: string | null; url: string | null };

let currentTheme: ThemeId = DEFAULT_THEME;
let notificationsEnabled = true; // settings.notifications（デフォルト ON）
let autoEnterAllEnabled = false; // 全セッションの新規作成分も含む自動Enter

/** 直近のアップデート確認結果。言語切替の再描画でも表示を維持する */
let updateState:
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; info: UpdateInfo }
  | { kind: "error" } = { kind: "idle" };
let appVersion: string | null = null;
let officialUpdate: OfficialUpdateInfo | null = null;
let updateInstallState: "idle" | "confirm" | "installing" | "error" = "idle";
let updateInstallProgress: number | null = null;
/** updater が返した生のエラー。署名不一致か取得失敗かをユーザー報告から判別できるようにする。 */
let updateInstallError = "";

export function getTheme(): ThemeId {
  return currentTheme;
}

/** 保存データからの復元用。CSS 変数を当てるだけで、再描画も保存もしない。
    boot() は restoreTree より前にここを通す（後から当てるとペインの xterm テーマが
    フラッシュする）ので、この順序は変えないこと。 */
export function setTheme(id: ThemeId): void {
  currentTheme = id;
  applyThemeCss(id);
}

export function isNotificationsEnabled(): boolean {
  return notificationsEnabled;
}

export function setNotificationsEnabled(on: boolean): void {
  notificationsEnabled = on;
}

export function isAutoEnterEnabled(): boolean {
  const ws = getActiveWs();
  return !!ws && isAutoEnterEnabledForWorkspace(ws);
}

export function isAutoEnterEnabledForWorkspace(ws: { autoEnter: boolean }): boolean {
  // ソフトロック対象: 判定の実体（pane.ts の実送信）ごと止める
  if (isLocked()) return false;
  return autoEnterAllEnabled || ws.autoEnter;
}

export function isAutoEnterAllEnabled(): boolean {
  return autoEnterAllEnabled;
}

export function setAutoEnterAllEnabled(on: boolean): void {
  autoEnterAllEnabled = on;
  renderAutoEnterButton();
}

export function renderAutoEnterButton() {
  autoEnterBtn.setAttribute("aria-pressed", String(isAutoEnterEnabled()));
  autoEnterBtn.setAttribute("aria-label", t("autoEnter.label"));
  autoEnterBtn.title = t("autoEnter.label");
}

function renderAutoEnterList() {
  autoEnterListEl.textContent = "";
  autoEnterAllEl.checked = autoEnterAllEnabled;
  const activeWs = getActiveWs();
  for (const ws of workspaces) {
    const row = document.createElement("label");
    row.className = "auto-enter-row" + (ws === activeWs ? " is-active" : "");
    row.title = ws.name;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = autoEnterAllEnabled || ws.autoEnter;
    input.disabled = autoEnterAllEnabled;
    input.setAttribute("aria-label", ws.name);
    input.onchange = () => {
      ws.autoEnter = input.checked;
      renderAutoEnterButton();
      scheduleSave();
    };
    const name = document.createElement("span");
    name.textContent = ws.name;
    row.append(input, name);
    autoEnterListEl.append(row);
  }
}

function setAutoEnterOpen(open: boolean) {
  autoEnterOverlay.hidden = !open;
  autoEnterBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    renderAutoEnterList();
    autoEnterCloseBtn.focus();
  } else if (document.activeElement instanceof HTMLElement) {
    autoEnterBtn.focus();
  }
}

export function applyTheme(id: ThemeId) {
  currentTheme = id;
  applyThemeCss(id);
  const xt = xtermThemeFor(id);
  for (const p of panes.values()) p.term.options.theme = xt; // 全セッション横断
  renderSettingsPanel();
  scheduleSave();
}

export function applyLanguage(l: Lang) {
  setLang(l);
  applyStaticTexts();
  renderSidebar();
  renderExplorerFavs();
  renderExplorerList();
  renderAgentPanelTexts();
  renderGitPanelTexts();
  renderQuickPhrasesTexts();
  renderPairTexts();
  renderSessionTrashTexts();
  const activeWs = getActiveWs();
  // ブロードキャストボタンとヒントの文言は状態依存なので個別に貼り直す
  if (activeWs) renderBroadcastUi(activeWs);
  renderBroadcastDialogTexts();
  renderAutoEnterButton();
  if (!autoEnterOverlay.hidden) renderAutoEnterList();
  renderSettingsPanel();
  // applyStaticTexts が textContent を置換するので 🔒 クラスと動的文言を貼り直す
  renderLockMarks();
  renderLicenseSection();
  renderPurchaseModalTexts();
  scheduleSave();
}

/** 「v1.2.3」形式を数値セグメントで比較。latest の方が新しければ true
    （自ビルドの新バージョン通知 self-build-notify.ts も同じ比較を使う） */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (s: string) =>
    s.trim().replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function renderUpdateResult() {
  settingsUpdateResultEl.textContent = "";
  if (updateState.kind === "checking") {
    settingsUpdateResultEl.textContent = t("settings.checking");
  } else if (updateState.kind === "error") {
    settingsUpdateResultEl.textContent = t("settings.checkFailed");
  } else if (updateState.kind === "ok") {
    const { current, latest, url } = updateState.info;
    if (latest && isNewerVersion(latest, current)) {
      const msg = document.createElement("div");
      msg.className = "update-new";
      msg.textContent = t("settings.newVersion", { v: latest });
      settingsUpdateResultEl.append(msg);
      if (officialUpdate) {
        if (officialUpdate.body) {
          const notes = document.createElement("p");
          notes.className = "update-notes";
          notes.textContent = officialUpdate.body;
          settingsUpdateResultEl.append(notes);
        }
        if (updateInstallState === "confirm") {
          const warning = document.createElement("p");
          warning.className = "update-warning";
          warning.textContent = t("settings.restartConfirm");
          const install = document.createElement("button");
          install.id = "settings-confirm-install";
          install.textContent = t("settings.installConfirm");
          install.onclick = () => void installUpdate();
          const cancel = document.createElement("button");
          cancel.id = "settings-cancel-install";
          cancel.textContent = t("agent.commitCancel");
          cancel.onclick = () => {
            updateInstallState = "idle";
            renderSettingsPanel();
          };
          settingsUpdateResultEl.append(warning, install, cancel);
        } else if (updateInstallState === "installing") {
          const percent = updateInstallProgress === null ? "…" : `${Math.round(updateInstallProgress * 100)}%`;
          const progress = document.createElement("div");
          progress.id = "settings-update-progress";
          progress.textContent = t("settings.installing", { p: percent });
          settingsUpdateResultEl.append(progress);
        } else {
          const install = document.createElement("button");
          install.id = "settings-install-update";
          install.textContent = t("settings.downloadInstall");
          install.onclick = () => {
            updateInstallState = "confirm";
            renderSettingsPanel();
          };
          settingsUpdateResultEl.append(install);
          if (updateInstallState === "error") {
            const failure = document.createElement("div");
            failure.className = "update-error";
            failure.textContent = t("settings.installFailed");
            settingsUpdateResultEl.append(failure);
            if (updateInstallError) {
              const detail = document.createElement("div");
              detail.className = "update-error-detail";
              detail.textContent = updateInstallError;
              settingsUpdateResultEl.append(detail);
            }
          }
        }
        const fallback = document.createElement("button");
        fallback.id = "settings-open-release";
        fallback.textContent = t("settings.openRelease");
        fallback.onclick = () => void invoke("open_url", {
          url: "https://github.com/saisai-web/PATerminal/releases/latest",
        });
        settingsUpdateResultEl.append(fallback);
      } else if (url) {
        const open = document.createElement("button");
        open.id = "settings-open-release";
        open.textContent = t("settings.openRelease");
        open.onclick = () => void invoke("open_url", { url });
        settingsUpdateResultEl.append(open);
      }
    } else {
      settingsUpdateResultEl.textContent = t("settings.upToDate", { v: current });
    }
  }
}

async function checkUpdate() {
  updateState = { kind: "checking" };
  settingsCheckBtn.disabled = true;
  renderUpdateResult();
  try {
    let info: UpdateInfo;
    if (getLicense().official) {
      officialUpdate = await checkOfficialUpdate();
      const current = officialUpdate?.currentVersion ?? await invoke<string>("app_version");
      info = {
        current,
        latest: officialUpdate?.version ?? null,
        url: null,
      };
    } else {
      officialUpdate = null;
      info = await invoke<UpdateInfo>("update_check");
    }
    appVersion = info.current;
    updateInstallState = "idle";
    updateState = { kind: "ok", info };
  } catch {
    updateState = { kind: "error" };
  } finally {
    settingsCheckBtn.disabled = false;
    renderSettingsPanel();
  }
}

async function installUpdate() {
  updateInstallState = "installing";
  updateInstallProgress = null;
  updateInstallError = "";
  renderSettingsPanel();
  if (!(await flushSessionSave())) {
    updateInstallState = "error";
    updateInstallError = t("save.failed");
    renderSettingsPanel();
    return;
  }
  try {
    await installOfficialUpdate((progress) => {
      updateInstallProgress = progress;
      if (!settingsOverlay.hidden) renderUpdateResult();
    });
  } catch (err) {
    updateInstallState = "error";
    updateInstallError = err instanceof Error ? err.message : String(err);
    renderSettingsPanel();
  }
}

export function renderSettingsPanel() {
  // テーマ（ラベルは固有名詞なので翻訳しない）
  settingsThemesEl.textContent = "";
  for (const p of THEMES) {
    const b = document.createElement("button");
    b.className = "settings-choice" + (p.id === currentTheme ? " is-selected" : "");
    b.setAttribute("aria-pressed", String(p.id === currentTheme));
    b.dataset.themeId = p.id;
    const sw = document.createElement("span");
    sw.className = "settings-swatch";
    sw.style.background = p.ui["pane-bg"];
    const dot = document.createElement("span");
    dot.className = "settings-swatch-accent";
    dot.style.background = p.ui.accent;
    const name = document.createElement("span");
    name.textContent = p.label;
    b.append(sw, dot, name);
    b.onclick = () => applyTheme(p.id);
    settingsThemesEl.append(b);
  }
  // 言語（各言語名は自言語表記のまま。一覧・順序は i18n の LANGS が持つ）
  settingsLangsEl.textContent = "";
  for (const info of LANGS) {
    const b = document.createElement("button");
    b.className = "settings-choice" + (info.code === getLang() ? " is-selected" : "");
    b.setAttribute("aria-pressed", String(info.code === getLang()));
    b.dataset.lang = info.code;
    b.textContent = info.label;
    // 言語名はその言語の文字なので、RTL 言語のボタンだけ書字方向を合わせる
    if (info.dir) b.dir = info.dir;
    b.onclick = () => applyLanguage(info.code);
    settingsLangsEl.append(b);
  }
  // 通知
  settingsNotifEl.checked = notificationsEnabled;
  // アップデート
  settingsVersionEl.textContent = appVersion ? t("settings.currentVersion", { v: appVersion }) : "";
  settingsCheckBtn.textContent = updateState.kind === "checking" ? t("settings.checking") : t("settings.checkUpdate");
  renderUpdateResult();
  // ペアモードの既定コマンド。編集中のフィールドは打鍵の途中で上書きしない
  const pairCmds = getPairDefaultCmds();
  if (document.activeElement !== settingsPairImplEl) settingsPairImplEl.value = pairCmds.implCmd;
  if (document.activeElement !== settingsPairReviewEl) settingsPairReviewEl.value = pairCmds.reviewCmd;
  // Worktree の既定の置き場所
  const wtPrefs = getWorktreePrefs();
  for (const r of settingsWorktreeLocRadios) r.checked = r.value === wtPrefs.location;
  settingsWorktreeDirLabelEl.textContent = t(
    wtPrefs.location === "outside" ? "agent.worktreeDirectoryExternal" : "agent.worktreeDirectory",
  );
  if (document.activeElement !== settingsWorktreeDirEl) {
    settingsWorktreeDirEl.value = worktreeDirFor(wtPrefs.location);
  }
  for (const r of settingsWorktreeInheritRadios) r.checked = (r.value === "yes") === wtPrefs.inherit;
}

/** 左ナビで選んだセクションだけを右側に表示する（diff オーバーレイと同じ流儀） */
function showSettingsSection(id: string) {
  for (const b of settingsNavItems) {
    const on = b.dataset.section === id;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
  for (const s of settingsSections) s.hidden = s.dataset.section !== id;
}

export function setSettingsOpen(open: boolean) {
  settingsOverlay.hidden = !open;
  if (open) {
    showSettingsSection("theme"); // 開くたびに先頭セクションへ戻す
    renderSettingsPanel();
    if (appVersion === null) {
      // 現バージョン表示（ネットワーク不要）。未実装の古いバイナリでも無害に続行
      void invoke<string>("app_version")
        .then((v) => {
          if (typeof v === "string" && v) {
            appVersion = v;
            if (!settingsOverlay.hidden) renderSettingsPanel();
          }
        })
        .catch(() => {});
    }
  }
}

settingsOpenBtn.onclick = () => setSettingsOpen(true);
settingsCloseBtn.onclick = () => setSettingsOpen(false);
for (const b of settingsNavItems) {
  b.onclick = () => showSettingsSection(b.dataset.section ?? "theme");
}
// ライセンスの実体は専用モーダル。設定は閉じてから重ならないように開く
document.querySelector<HTMLButtonElement>("#settings-license-manage")!.onclick = () => {
  setSettingsOpen(false);
  setLicenseManageOpen(true);
};
document.querySelector<HTMLButtonElement>("#settings-eula-open")!.onclick = openCurrentEula;
document.querySelector<HTMLButtonElement>("#settings-third-party-open")!.onclick = () => {
  setSettingsOpen(false);
  void showThirdPartyNotices();
};
autoEnterBtn.onclick = () => {
  if (requireFeature()) setAutoEnterOpen(true); // 自動 Enter はソフトロック対象
};
autoEnterCloseBtn.onclick = () => setAutoEnterOpen(false);
autoEnterAllEl.onchange = () => {
  autoEnterAllEnabled = autoEnterAllEl.checked;
  renderAutoEnterList();
  renderAutoEnterButton();
  scheduleSave();
};
autoEnterOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === autoEnterOverlay) setAutoEnterOpen(false);
});
settingsOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === settingsOverlay) setSettingsOpen(false); // バックドロップクリックで閉じる
});
// パネル内の打鍵をターミナルやアプリのショートカットに流さない（startInlineEdit と同じ流儀）
settingsPanel.addEventListener("keydown", (e) => e.stopPropagation());
autoEnterPanel.addEventListener("keydown", (e) => e.stopPropagation());
window.addEventListener(
  "keydown",
  (e) => {
    if (!settingsOverlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      setSettingsOpen(false);
    }
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (!autoEnterOverlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      setAutoEnterOpen(false);
    }
  },
  true,
);
settingsCheckBtn.onclick = () => void checkUpdate();
settingsNotifEl.onchange = () => {
  notificationsEnabled = settingsNotifEl.checked;
  // ON にした瞬間 = ユーザーが意図したタイミングで OS の許可ダイアログを出す
  if (notificationsEnabled) void ensureNotifPermission();
  scheduleSave();
};

// ペアモードの既定コマンド。blur/Enter（change）で確定・保存し、無効値は直前の値へ戻す
settingsPairImplEl.addEventListener("change", () => {
  updatePairDefaultCmds({ implCmd: settingsPairImplEl.value });
  renderSettingsPanel();
  scheduleSave();
});
settingsPairReviewEl.addEventListener("change", () => {
  updatePairDefaultCmds({ reviewCmd: settingsPairReviewEl.value });
  renderSettingsPanel();
  scheduleSave();
});
settingsPairSwapBtn.onclick = () => {
  const cur = getPairDefaultCmds();
  updatePairDefaultCmds({ implCmd: cur.reviewCmd, reviewCmd: cur.implCmd });
  renderSettingsPanel();
  scheduleSave();
};

// Worktree の既定の置き場所
for (const radio of settingsWorktreeLocRadios) {
  radio.onchange = () => {
    const location: WorktreeLocation = radio.value === "outside" ? "outside" : "inside";
    updateWorktreePrefs({ location });
    renderSettingsPanel();
  };
}
settingsWorktreeDirEl.addEventListener("change", () => {
  const location: WorktreeLocation =
    settingsWorktreeLocRadios.find((r) => r.checked)?.value === "outside" ? "outside" : "inside";
  const dir = settingsWorktreeDirEl.value.trim();
  if (dir && dir.length <= 512) {
    updateWorktreePrefs(location === "outside" ? { outsideDir: dir } : { insideDir: dir });
  }
  renderSettingsPanel(); // 無効値は直前の値へ戻す
});
// Worktree 作成時に作成元の環境ファイル（gitignore 対象）を引き継ぐか
for (const radio of settingsWorktreeInheritRadios) {
  radio.onchange = () => {
    updateWorktreePrefs({ inherit: radio.value === "yes" });
    renderSettingsPanel();
  };
}
