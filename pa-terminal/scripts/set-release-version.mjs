#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const requestedVersion = process.argv[2];
const projectRoot = process.argv[3] ?? ".";
if (!requestedVersion || process.argv.length > 4) {
  throw new Error("Usage: node scripts/set-release-version.mjs <VERSION> [project-root]");
}

const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(requestedVersion);
if (!match) throw new Error(`Version must be semantic version, optionally prefixed with v: ${requestedVersion}`);
const version = match[1];

function path(relativePath) {
  return join(projectRoot, relativePath);
}

function read(relativePath) {
  return readFileSync(path(relativePath), "utf8");
}

function write(relativePath, contents) {
  writeFileSync(path(relativePath), contents);
}

function replaceFirst(relativePath, pattern, replacement) {
  const contents = read(relativePath);
  if (!pattern.test(contents)) throw new Error(`Version field was not found in ${relativePath}`);
  write(relativePath, contents.replace(pattern, replacement));
}

function replaceSectionVersion(relativePath, header, name) {
  const contents = read(relativePath);
  const sections = contents.split(new RegExp(`(?=^${header.replace(/[\[\]]/g, "\\$&")}$)`, "m"));
  const index = sections.findIndex((section) => section.startsWith(header)
    && (!name || new RegExp(`^name\\s*=\\s*"${name}"\\s*$`, "m").test(section)));
  if (index < 0) throw new Error(`Package section was not found in ${relativePath}`);
  if (!/^version\s*=\s*"[^"]+"\s*$/m.test(sections[index])) {
    throw new Error(`Version field was not found in ${relativePath}`);
  }
  sections[index] = sections[index].replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`);
  write(relativePath, sections.join(""));
}

replaceFirst("package.json", /^(\s*"version"\s*:\s*")[^"]+("\s*,?)$/m, `$1${version}$2`);

const packageLock = JSON.parse(read("package-lock.json"));
packageLock.version = version;
if (!packageLock.packages?.[""]) throw new Error("Root package was not found in package-lock.json");
packageLock.packages[""].version = version;
write("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);

replaceFirst("src-tauri/tauri.conf.json", /^(\s*"version"\s*:\s*")[^"]+("\s*,?)$/m, `$1${version}$2`);
replaceSectionVersion("src-tauri/Cargo.toml", "[package]");
replaceSectionVersion("src-tauri/Cargo.lock", "[[package]]", "pa-terminal");

console.log(`Set PATerminal release version to ${version}.`);
