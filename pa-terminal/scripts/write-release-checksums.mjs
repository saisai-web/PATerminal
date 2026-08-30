#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg || process.argv.length !== 4) {
  throw new Error("Usage: node scripts/write-release-checksums.mjs <bundle-root> <output.txt>");
}
const root = resolve(rootArg);
if (!existsSync(root)) throw new Error(`Bundle root does not exist: ${root}`);
const files = [];
const visit = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else if (/\.(dmg|exe|msi|sig)$/.test(name) || name.endsWith(".app.tar.gz")) files.push(path);
  }
};
visit(root);
if (!files.length) throw new Error(`No release bundles found under ${root}`);
const basenames = files.map((path) => basename(path));
if (new Set(basenames).size !== basenames.length) throw new Error("Duplicate release asset file names found");
const lines = files
  .map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${basename(path)}`)
  .sort();
writeFileSync(resolve(outputArg), `${lines.join("\n")}\n`);
console.log(`Wrote ${outputArg} with ${lines.length} SHA-256 entries.`);
