#!/usr/bin/env node
// Release preflight: prove that TAURI_SIGNING_PRIVATE_KEY (+ password) and
// TAURI_UPDATER_PUBLIC_KEY are one key pair before anything is built or uploaded.
// Installed apps embed the public key, so artifacts signed with any other private key
// are rejected at install time ("the signed update could not be installed").
// The private key only ever reaches `tauri signer sign` through the environment.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublicKey, parseSignature, verifySignature } from "./minisign.mjs";

if (process.argv.length !== 2) {
  throw new Error("Usage: node scripts/check-updater-keypair.mjs (reads TAURI_* from the environment)");
}
const publicKeyText = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
if (!publicKeyText) throw new Error("TAURI_UPDATER_PUBLIC_KEY is required");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY is required");
}
const publicKey = parsePublicKey(publicKeyText);
const tauriCli =
  process.env.PATERMINAL_TAURI_CLI ?? fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));

const directory = mkdtempSync(join(tmpdir(), "paterminal-updater-keypair-"));
try {
  const sample = join(directory, "sample.bin");
  writeFileSync(sample, `PATerminal updater key pair check ${new Date().toISOString()}\n`);
  const signed = spawnSync(process.execPath, [tauriCli, "signer", "sign", sample], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (signed.status !== 0) {
    throw new Error(`tauri signer sign failed (is TAURI_SIGNING_PRIVATE_KEY_PASSWORD correct?): ${signed.stderr.trim()}`);
  }
  const signature = parseSignature(readFileSync(`${sample}.sig`, "utf8"));
  verifySignature(publicKey, signature, readFileSync(sample));
  console.log(`Updater signing key and public key ${publicKey.keyId} are a matching pair.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
