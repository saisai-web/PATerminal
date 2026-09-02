#!/usr/bin/env node
import { readFileSync } from "node:fs";

const path = process.argv[2];
const expectedTag = process.argv[3];
if (!path || process.argv.length > 4) {
  throw new Error("Usage: node scripts/verify-updater-json.mjs <latest.json> [expected-tag]");
}
const manifest = JSON.parse(readFileSync(path, "utf8"));
if (!/^v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version ?? "")) {
  throw new Error("latest.json has no valid semantic version");
}
if (expectedTag && expectedTag !== `v${manifest.version}`) {
  throw new Error(`latest.json version ${manifest.version} does not match release tag ${expectedTag}`);
}
for (const target of ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]) {
  const entry = manifest.platforms?.[target];
  if (!entry) throw new Error(`latest.json is missing ${target}`);
  const url = new URL(entry.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/saisai-web/PATerminal/releases/")) {
    throw new Error(`latest.json has an unexpected URL for ${target}`);
  }
  if (typeof entry.signature !== "string" || entry.signature.length < 40) {
    throw new Error(`latest.json has no usable signature for ${target}`);
  }
}
console.log(`Verified signed updater manifest for ${manifest.version}.`);
