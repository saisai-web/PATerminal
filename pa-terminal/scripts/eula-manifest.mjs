#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const outputPath = resolve(repositoryRoot, "legal/eula/manifest.json");
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: node scripts/eula-manifest.mjs [--check]");
}

const VERSION = "1.0";
const EFFECTIVE_DATE = "2026-08-24";
const AUTHORITATIVE_LOCALE = "en";
const CANONICAL_URL = "https://paralellterminal.com/eula";
const CONTACT = "k-saiki@yotsuba-system.co.jp";
const localeFiles = [
  ["en", "LICENSE.md"],
  ["ja", "legal/eula/ja.md"],
  ["zh-Hans", "legal/eula/zh-Hans.md"],
  ["zh-Hant", "legal/eula/zh-Hant.md"],
  ["ko", "legal/eula/ko.md"],
  ["es", "legal/eula/es.md"],
  ["pt-BR", "legal/eula/pt-BR.md"],
  ["fr", "legal/eula/fr.md"],
  ["de", "legal/eula/de.md"],
  ["it", "legal/eula/it.md"],
  ["ru", "legal/eula/ru.md"],
  ["ar", "legal/eula/ar.md"],
  ["hi", "legal/eula/hi.md"],
  ["id", "legal/eula/id.md"],
  ["vi", "legal/eula/vi.md"],
  ["th", "legal/eula/th.md"],
  ["tr", "legal/eula/tr.md"],
];

const requiredMetadata = {
  "eula-version": VERSION,
  "eula-effective-date": EFFECTIVE_DATE,
  "authoritative-locale": AUTHORITATIVE_LOCALE,
  "canonical-eula-url": CANONICAL_URL,
  contact: CONTACT,
  "individual-device-limit": "3",
  "team-device-limit-per-person": "3",
  "liability-lookback-months": "12",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function metadata(content) {
  const block = content.match(/^<!--\n([\s\S]*?)\n-->/)?.[1];
  assert(block, "EULA is missing its machine-readable metadata block");
  return Object.fromEntries(block.split("\n").map((line) => {
    const separator = line.indexOf(":");
    assert(separator > 0, `Invalid EULA metadata line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

const locales = localeFiles.map(([locale, relativePath]) => {
  const absolutePath = resolve(repositoryRoot, relativePath);
  assert(existsSync(absolutePath), `Missing EULA for ${locale}: ${relativePath}`);
  const content = readFileSync(absolutePath, "utf8").replace(/\r\n?/g, "\n");
  assert(content.endsWith("\n"), `${relativePath} must end with a newline`);

  const values = metadata(content);
  assert(values["eula-locale"] === locale, `${relativePath} has locale ${values["eula-locale"]}`);
  for (const [key, expected] of Object.entries(requiredMetadata)) {
    assert(values[key] === expected, `${relativePath} has ${key}=${values[key]}; expected ${expected}`);
  }

  const chapters = [...content.matchAll(/^##\s+(\d+)\.\s+/gm)].map((match) => Number(match[1]));
  assert(chapters.length === 13, `${relativePath} must contain exactly 13 numbered chapters`);
  assert(chapters.every((number, index) => number === index + 1), `${relativePath} chapter numbering is out of sync`);
  assert(content.split(CONTACT).length - 1 >= 2, `${relativePath} must include the contact address in the agreement and contact chapter`);

  const isTranslation = locale !== AUTHORITATIVE_LOCALE;
  if (isTranslation) {
    assert(content.includes("[`LICENSE.md`](../../LICENSE.md)"), `${relativePath} must link to the authoritative English LICENSE.md`);
  } else {
    assert(relativePath === "LICENSE.md", "The authoritative English EULA must be LICENSE.md");
    assert(content.includes("sole authoritative version"), "LICENSE.md must state that English is the sole authoritative version");
  }

  const webPath = locale === "en" ? "/eula" : locale === "ja" ? "/ja/eula" : `/${locale}/eula`;
  return {
    locale,
    path: relativePath,
    webPath,
    role: isTranslation ? "informational-translation" : "authoritative",
    isTranslation,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
});

const manifest = {
  schemaVersion: 1,
  eulaVersion: VERSION,
  effectiveDate: EFFECTIVE_DATE,
  authoritativeLocale: AUTHORITATIVE_LOCALE,
  translationsAreInformational: true,
  canonicalUrl: CANONICAL_URL,
  locales,
};
const generated = `${JSON.stringify(manifest, null, 2)}\n`;

if (checkOnly) {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== generated) {
    console.error("legal/eula/manifest.json is stale. Run npm run generate:eula-manifest.");
    process.exit(1);
  }
  console.log(`EULA manifest is current (${locales.length} locales, authoritative locale ${AUTHORITATIVE_LOCALE}).`);
} else {
  writeFileSync(outputPath, generated);
  console.log(`Wrote ${outputPath} for ${locales.length} locales.`);
}
