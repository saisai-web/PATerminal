#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/write-updater-config.mjs <output.json>");
}
const pubkey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
if (!pubkey) throw new Error("TAURI_UPDATER_PUBLIC_KEY is required");
const decodedPubkey = /^[A-Za-z0-9+/]+={0,2}$/.test(pubkey)
  ? Buffer.from(pubkey, "base64").toString("utf8").trim().split(/\r?\n/)
  : [];
if (
  pubkey.length > 4096 ||
  decodedPubkey.length !== 2 ||
  !/^untrusted comment: minisign public key: [A-Fa-f0-9]{16}$/.test(decodedPubkey[0]) ||
  !/^RW[A-Za-z0-9+/=]{40,}$/.test(decodedPubkey[1])
) {
  throw new Error("TAURI_UPDATER_PUBLIC_KEY is not a Tauri minisign public key");
}

const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey,
      endpoints: ["https://github.com/saisai-web/PATerminal/releases/latest/download/latest.json"],
      windows: { installMode: "passive" },
    },
  },
};
writeFileSync(resolve(output), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote updater build configuration to ${output} (public key value not printed).`);
