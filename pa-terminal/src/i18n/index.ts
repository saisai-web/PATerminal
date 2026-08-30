// UI 文言の多言語辞書。en を基準辞書（as const）とし、他言語は Dict = Record<MsgKey, string>
// なのでキー欠落・打ち間違いはコンパイルエラーになる。t() の {name} はパラメータ補間。
//
// 言語を1つ足す手順:
//   1. src/i18n/<code>.ts に `export const xx: Dict = { ... }` を作る（en.ts をコピーして訳す）
//   2. この下の import と Lang / LANGS / DICTS に1行ずつ足す
// UI（設定パネルの言語ボタン）と保存値の検証は LANGS から自動で決まるので他の変更は不要。

import { en } from "./en";
import type { Dict } from "./en";
import { ar } from "./ar";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { hi } from "./hi";
import { id } from "./id";
import { it } from "./it";
import { ja } from "./ja";
import { ko } from "./ko";
import { ptBR } from "./pt-BR";
import { ru } from "./ru";
import { th } from "./th";
import { tr } from "./tr";
import { vi } from "./vi";
import { zhHans } from "./zh-Hans";
import { zhHant } from "./zh-Hant";

export type { MsgKey, Dict } from "./en";
import type { MsgKey } from "./en";

export type Lang =
  | "en"
  | "ja"
  | "zh-Hans"
  | "zh-Hant"
  | "ko"
  | "es"
  | "pt-BR"
  | "fr"
  | "de"
  | "it"
  | "ru"
  | "ar"
  | "hi"
  | "id"
  | "vi"
  | "th"
  | "tr";

export type LangInfo = {
  code: Lang;
  /** 言語名は自言語表記（探しやすさ優先で翻訳しない） */
  label: string;
  /** 書字方向。省略は ltr */
  dir?: "rtl";
  /** navigator.language から拾う BCP47 タグ（小文字）。長いものから優先的に一致させる */
  match: string[];
};

/** 設定パネルの言語ボタンはこの順・この表記で出る */
export const LANGS: readonly LangInfo[] = [
  { code: "en", label: "English", match: ["en"] },
  { code: "ja", label: "日本語", match: ["ja"] },
  { code: "zh-Hans", label: "简体中文", match: ["zh", "zh-hans", "zh-cn", "zh-sg", "zh-my"] },
  { code: "zh-Hant", label: "繁體中文", match: ["zh-hant", "zh-tw", "zh-hk", "zh-mo"] },
  { code: "ko", label: "한국어", match: ["ko"] },
  { code: "es", label: "Español", match: ["es"] },
  { code: "pt-BR", label: "Português", match: ["pt"] },
  { code: "fr", label: "Français", match: ["fr"] },
  { code: "de", label: "Deutsch", match: ["de"] },
  { code: "it", label: "Italiano", match: ["it"] },
  { code: "ru", label: "Русский", match: ["ru"] },
  { code: "ar", label: "العربية", dir: "rtl", match: ["ar"] },
  { code: "hi", label: "हिन्दी", match: ["hi"] },
  { code: "id", label: "Bahasa Indonesia", match: ["id", "in"] },
  { code: "vi", label: "Tiếng Việt", match: ["vi"] },
  { code: "th", label: "ไทย", match: ["th"] },
  { code: "tr", label: "Türkçe", match: ["tr"] },
];

const DICTS: Record<Lang, Dict> = {
  en,
  ja,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ko,
  es,
  "pt-BR": ptBR,
  fr,
  de,
  it,
  ru,
  ar,
  hi,
  id,
  vi,
  th,
  tr,
};

/** "zh" より "zh-tw" を先に見るため、タグの長い順に並べた検索表 */
const MATCHES: Array<{ tag: string; code: Lang }> = LANGS.flatMap((l) =>
  l.match.map((tag) => ({ tag, code: l.code })),
).sort((a, b) => b.tag.length - a.tag.length);

let lang: Lang = "en";

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
}

/** 保存値・外部入力が対応言語かどうか（session.json の設定検証用） */
export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DICTS, v);
}

export function langInfo(l: Lang = lang): LangInfo {
  return LANGS.find((x) => x.code === l) ?? LANGS[0];
}

/** OS の言語設定から初期言語を決める。未対応言語は英語 */
export function defaultLang(): Lang {
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  for (const raw of prefs) {
    const tag = (raw ?? "").toLowerCase();
    if (!tag) continue;
    const hit = MATCHES.find((m) => tag === m.tag || tag.startsWith(m.tag + "-"));
    if (hit) return hit.code;
  }
  return "en";
}

export function t(key: MsgKey, params?: Record<string, string>): string {
  let s: string = DICTS[lang][key] ?? en[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  }
  return s;
}

/** index.html の data-i18n / data-i18n-title / data-i18n-placeholder を現在言語で刻印する。
    言語切替時にも呼ぶ（動的生成分は各 render が t() で作り直す） */
export function applyStaticTexts(): void {
  document.documentElement.lang = lang;
  // RTL 言語では UI 全体を反転する。ターミナル・差分・コードは styles.css 側で ltr に固定
  document.documentElement.dir = langInfo().dir === "rtl" ? "rtl" : "ltr";
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n as MsgKey);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle as MsgKey);
  }
  for (const el of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder as MsgKey);
  }
}
