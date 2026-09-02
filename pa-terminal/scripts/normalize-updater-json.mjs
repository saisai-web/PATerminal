#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const [manifestPath, releasePath, repository, tag] = process.argv.slice(2);
if (!manifestPath || !releasePath || !repository || !tag || process.argv.length !== 6) {
  throw new Error(
    "Usage: node scripts/normalize-updater-json.mjs <latest.json> <release.json> <owner/repository> <tag>",
  );
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("Repository must use the owner/name format");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const release = JSON.parse(readFileSync(releasePath, "utf8"));
if (release.tag_name !== tag) {
  throw new Error(`Release metadata is for ${release.tag_name ?? "an unknown tag"}, not ${tag}`);
}

const apiToDownloadUrl = new Map();
const downloadUrls = new Set();
for (const asset of release.assets ?? []) {
  if (typeof asset?.name !== "string" || typeof asset?.url !== "string") continue;
  const downloadUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
  apiToDownloadUrl.set(asset.url, downloadUrl);
  downloadUrls.add(downloadUrl);
}
if (apiToDownloadUrl.size === 0) throw new Error("Release metadata has no usable assets");

for (const [target, entry] of Object.entries(manifest.platforms ?? {})) {
  if (!entry || typeof entry.url !== "string") {
    throw new Error(`Updater manifest has no URL for ${target}`);
  }
  if (apiToDownloadUrl.has(entry.url)) {
    entry.url = apiToDownloadUrl.get(entry.url);
  } else if (!downloadUrls.has(entry.url)) {
    throw new Error(`Updater URL for ${target} does not match a release asset`);
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Normalized updater URLs for ${repository}@${tag}.`);
