#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tag = process.argv[2];
const projectRoot = process.argv[3] ?? ".";
if (!tag || process.argv.length > 4) {
  throw new Error("Usage: node scripts/verify-release-version.mjs <vVERSION> [project-root]");
}

const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) throw new Error(`Release tag must be v-prefixed semantic version: ${tag}`);
const expected = match[1];

function read(path) {
  return readFileSync(join(projectRoot, path), "utf8");
}

function packageVersionFromToml(contents) {
  const section = contents.split(/(?=^\[)/m).find((part) => /^\[package\]\s*$/m.test(part));
  return section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

function packageVersionFromCargoLock(contents) {
  const section = contents
    .split(/\n(?=\[\[package\]\])/)
    .find((part) => /^name\s*=\s*"pa-terminal"\s*$/m.test(part));
  return section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const versions = [
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", packageVersionFromToml(read("src-tauri/Cargo.toml"))],
  ["src-tauri/Cargo.lock", packageVersionFromCargoLock(read("src-tauri/Cargo.lock"))],
];

const mismatches = versions.filter(([, version]) => version !== expected);
if (mismatches.length) {
  throw new Error([
    `Release tag ${tag} does not match the app version:`,
    ...mismatches.map(([file, version]) => `- ${file}: ${version ?? "missing"} (expected ${expected})`),
  ].join("\n"));
}

console.log(`Verified release version ${expected} in all manifests and lockfiles.`);
