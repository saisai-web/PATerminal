import { invoke } from "@tauri-apps/api/core";
import { defaultLang, getLang, isLang, langInfo, setLang, t, type Lang } from "../../i18n";

type EulaStatus = {
  official: boolean;
  version: string;
  effectiveDate: string;
  accepted: boolean;
  url: string;
  text: string;
  resolvedLocale: Lang;
  authoritativeLocale: "en";
  isTranslation: boolean;
};

const overlay = document.querySelector<HTMLDivElement>("#eula-overlay")!;
const title = document.querySelector<HTMLSpanElement>("#eula-title")!;
const meta = document.querySelector<HTMLParagraphElement>("#eula-meta")!;
const intro = document.querySelector<HTMLParagraphElement>("#eula-intro")!;
const text = document.querySelector<HTMLPreElement>("#eula-text")!;
const webButton = document.querySelector<HTMLButtonElement>("#eula-open-web")!;
const closeButton = document.querySelector<HTMLButtonElement>("#eula-close")!;
const check = document.querySelector<HTMLInputElement>("#eula-agree-check")!;
const checkLabel = document.querySelector<HTMLSpanElement>("#eula-agree-label")!;
const acceptButton = document.querySelector<HTMLButtonElement>("#eula-accept")!;
const declineButton = document.querySelector<HTMLButtonElement>("#eula-decline")!;
const error = document.querySelector<HTMLDivElement>("#eula-error")!;

function currentEulaUrl(locale: Lang = getLang()): string {
  return locale === "en"
    ? "https://paralellterminal.com/eula"
    : `https://paralellterminal.com/${locale}/eula`;
}

async function preferredEulaLanguage(): Promise<Lang> {
  try {
    const raw = await invoke<string | null>("session_load");
    if (raw) {
      const language = (JSON.parse(raw) as { settings?: { language?: unknown } }).settings?.language;
      if (isLang(language)) return language;
    }
  } catch {
    // Missing or invalid session data uses the OS language below.
  }
  return defaultLang();
}

function renderCopy(status: EulaStatus): void {
  overlay.dir = langInfo(status.resolvedLocale).dir ?? "ltr";
  overlay.dataset.locale = status.resolvedLocale;
  overlay.dataset.authoritativeLocale = status.authoritativeLocale;
  overlay.dataset.translation = String(status.isTranslation);
  title.textContent = t("eula.title");
  meta.textContent = t("eula.meta", {
    version: status.version,
    date: status.effectiveDate,
  });
  intro.textContent = t(status.isTranslation ? "eula.introTranslation" : "eula.introAuthoritative");
  webButton.textContent = t("eula.openWeb");
  checkLabel.textContent = t("eula.agree", { version: status.version });
  acceptButton.textContent = t("eula.accept");
  declineButton.textContent = t("eula.decline");
  text.textContent = status.text;
  webButton.hidden = false;
  closeButton.hidden = true;
  check.parentElement!.hidden = false;
  declineButton.hidden = false;
  acceptButton.hidden = false;
}

export function openCurrentEula(): void {
  void invoke("open_url", { url: currentEulaUrl() });
}

export async function showThirdPartyNotices(): Promise<void> {
  const notices = await invoke<string>("third_party_notices");
  title.textContent = "Third-Party Notices";
  meta.textContent = "Licenses and notices for components included with PATerminal";
  intro.textContent = "Third-party components remain governed by their own licenses.";
  text.textContent = notices;
  text.scrollTop = 0;
  webButton.hidden = true;
  closeButton.hidden = false;
  check.parentElement!.hidden = true;
  declineButton.hidden = true;
  acceptButton.hidden = true;
  error.hidden = true;
  overlay.hidden = false;
  closeButton.onclick = () => {
    overlay.hidden = true;
  };
}

/** 公式ビルドだけを起動前に止める。成功するまで boot() を呼ばない。 */
export async function ensureEulaAccepted(): Promise<boolean> {
  const locale = await preferredEulaLanguage();
  setLang(locale);
  let status: EulaStatus;
  try {
    status = await invoke<EulaStatus>("eula_status", { locale });
  } catch {
    overlay.hidden = false;
    title.textContent = "PATerminal";
    intro.textContent = t("eula.loadErrorIntro");
    error.textContent = t("eula.loadErrorDetail");
    error.hidden = false;
    acceptButton.disabled = true;
    declineButton.hidden = true;
    return false;
  }
  if (!status.official || status.accepted) return true;

  renderCopy(status);
  overlay.hidden = false;
  check.checked = false;
  acceptButton.disabled = true;
  error.hidden = true;
  text.scrollTop = 0;

  return await new Promise<boolean>((resolve) => {
    check.onchange = () => {
      acceptButton.disabled = !check.checked;
    };
    webButton.onclick = () => void invoke("open_url", { url: status.url });
    acceptButton.onclick = async () => {
      if (!check.checked) return;
      acceptButton.disabled = true;
      declineButton.disabled = true;
      error.hidden = true;
      try {
        await invoke("eula_accept", { version: status.version });
        overlay.hidden = true;
        resolve(true);
      } catch {
        error.textContent = t("eula.saveError");
        error.hidden = false;
        acceptButton.disabled = false;
        declineButton.disabled = false;
      }
    };
    declineButton.onclick = async () => {
      acceptButton.disabled = true;
      declineButton.disabled = true;
      try {
        await invoke("eula_decline");
      } finally {
        resolve(false);
      }
    };
  });
}
