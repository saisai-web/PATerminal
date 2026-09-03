#!/usr/bin/env node
// Verifies the published latest.json before the release is promoted to Latest.
// With TAURI_UPDATER_PUBLIC_KEY and --assets <dir>, every platform entry's signature is
// verified against the downloaded asset exactly as the installed app will do it.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePublicKey, parseSignature, verifySignature } from "./minisign.mjs";

const positional = [];
let assetsDir = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--assets") {
    assetsDir = args[++i];
    if (!assetsDir) throw new Error("--assets requires a directory");
  } else {
    positional.push(args[i]);
  }
}
const [path, expectedTag] = positional;
if (!path || positional.length > 2) {
  throw new Error(
    "Usage: node scripts/verify-updater-json.mjs <latest.json> [expected-tag] [--assets <dir>]",
  );
}
const publicKeyText = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
if (publicKeyText && !assetsDir) {
  throw new Error("--assets <dir> is required to verify signatures with TAURI_UPDATER_PUBLIC_KEY");
}
if (assetsDir && !publicKeyText) {
  throw new Error("TAURI_UPDATER_PUBLIC_KEY is required to verify assets");
}
const publicKey = publicKeyText ? parsePublicKey(publicKeyText) : null;

const manifest = JSON.parse(readFileSync(path, "utf8"));
if (!/^v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version ?? "")) {
  throw new Error("latest.json has no valid semantic version");
}
if (expectedTag && expectedTag !== `v${manifest.version}`) {
  throw new Error(`latest.json version ${manifest.version} does not match release tag ${expectedTag}`);
}
for (const target of ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]) {
  if (!manifest.platforms?.[target]) throw new Error(`latest.json is missing ${target}`);
}
for (const [target, entry] of Object.entries(manifest.platforms ?? {})) {
  const url = new URL(entry.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/saisai-web/PATerminal/releases/")) {
    throw new Error(`latest.json has an unexpected URL for ${target}`);
  }
  if (typeof entry.signature !== "string" || entry.signature.length < 40) {
    throw new Error(`latest.json has no usable signature for ${target}`);
  }
  if (!publicKey) continue;

  const assetName = decodeURIComponent(basename(url.pathname));
  const assetPath = join(assetsDir, assetName);
  if (!existsSync(assetPath)) {
    throw new Error(`Release asset ${assetName} for ${target} was not downloaded to ${assetsDir}`);
  }
  const signature = parseSignature(entry.signature);
  try {
    verifySignature(publicKey, signature, readFileSync(assetPath));
  } catch (error) {
    throw new Error(`latest.json signature for ${target} (${assetName}) is not valid for the updater public key: ${error.message}`);
  }
  // The .sig asset is what a manual verifier uses; it must be the manifest's signature.
  const sidecarPath = `${assetPath}.sig`;
  if (existsSync(sidecarPath)) {
    const sidecar = parseSignature(readFileSync(sidecarPath, "utf8"));
    if (!sidecar.signature.equals(signature.signature) || !sidecar.globalSignature.equals(signature.globalSignature)) {
      throw new Error(`${assetName}.sig does not match the latest.json signature for ${target}`);
    }
  }
  console.log(`Verified ${target}: ${assetName} is signed by updater key ${publicKey.keyId}.`);
}
console.log(
  publicKey
    ? `Verified signed updater manifest for ${manifest.version} against public key ${publicKey.keyId}.`
    : `Verified updater manifest shape for ${manifest.version} (no TAURI_UPDATER_PUBLIC_KEY; signatures not checked).`,
);
