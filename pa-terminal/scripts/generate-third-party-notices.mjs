#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const outputPath = resolve(repositoryRoot, "THIRD_PARTY_NOTICES.md");
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: node scripts/generate-third-party-notices.mjs [--check]");
}

function commandJson(command, args) {
  return JSON.parse(execFileSync(command, args, { cwd: packageRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }));
}

function noticeFiles(directory, explicitFile) {
  const paths = [];
  if (explicitFile && existsSync(explicitFile)) paths.push(explicitFile);
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).sort()) {
      if (/^(licen[cs]e|copying|notice)(\.|-|$)/i.test(name)) paths.push(resolve(directory, name));
    }
  }
  return [...new Set(paths)];
}

function readNotice(path) {
  try {
    const value = readFileSync(path, "utf8")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .trim();
    return value.includes("\0") ? null : value;
  } catch {
    return null;
  }
}

function npmComponents() {
  const npmArgs = ["ls", "--all", "--omit=dev", "--json", "--long"];
  const tree = process.env.npm_execpath
    ? commandJson(process.execPath, [process.env.npm_execpath, ...npmArgs])
    : commandJson(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs);
  const components = new Map();
  const visit = (node, fallbackName) => {
    if (node.path && node.version && node.path !== packageRoot) {
      const manifest = JSON.parse(readFileSync(resolve(node.path, "package.json"), "utf8"));
      const key = `${manifest.name ?? fallbackName}@${manifest.version ?? node.version}`;
      components.set(key, {
        ecosystem: "npm",
        name: manifest.name ?? fallbackName,
        version: manifest.version ?? node.version,
        license: typeof manifest.license === "string" ? manifest.license : "See package notice",
        paths: noticeFiles(node.path),
      });
    }
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) visit(dependency, name);
  };
  visit(tree, tree.name);
  return [...components.values()];
}

function cargoComponents() {
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];
  const components = new Map();
  for (const target of targets) {
    const cargoMetadata = commandJson("cargo", [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      target,
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ]);
    const root = cargoMetadata.resolve.root;
    const nodes = new Map(cargoMetadata.resolve.nodes.map((node) => [node.id, node]));
    const used = new Set();
    const visit = (id) => {
      if (used.has(id)) return;
      used.add(id);
      for (const dependency of nodes.get(id)?.dependencies ?? []) visit(dependency);
    };
    visit(root);
    for (const pkg of cargoMetadata.packages) {
      if (!used.has(pkg.id) || pkg.id === root) continue;
      const directory = dirname(pkg.manifest_path);
      const explicit = pkg.license_file
        ? (pkg.license_file.startsWith("/") ? pkg.license_file : resolve(directory, pkg.license_file))
        : null;
      components.set(`${pkg.name}@${pkg.version}`, {
        ecosystem: "Cargo",
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "See crate notice",
        paths: noticeFiles(directory, explicit),
      });
    }
  }
  return [...components.values()];
}

const components = [...npmComponents(), ...cargoComponents()].sort((a, b) =>
  a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

const texts = new Map();
for (const component of components) {
  for (const path of component.paths) {
    const value = readNotice(path);
    if (!value) continue;
    const hash = createHash("sha256").update(value).digest("hex");
    const existing = texts.get(hash) ?? { value, components: [] };
    existing.components.push(`${component.name} ${component.version}`);
    texts.set(hash, existing);
  }
}

const lines = [
  "# PATerminal Third-Party Notices",
  "",
  "This file lists third-party components used by the official macOS universal and Windows x64 builds. Those components remain governed by their own licenses. The PATerminal EULA does not replace or restrict those licenses.",
  "",
  "This file is generated from `pa-terminal/package-lock.json`, `pa-terminal/Cargo.lock`, and the license files shipped in the installed packages. Do not edit it by hand; run `npm run generate:third-party-notices` from `pa-terminal`.",
  "",
  `Components: ${components.length}. Distinct bundled license or notice texts: ${texts.size}.`,
  "",
  "## Component inventory",
  "",
  "| Ecosystem | Component | Version | Declared license |",
  "| --- | --- | --- | --- |",
];
for (const component of components) {
  const clean = (value) => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  lines.push(`| ${component.ecosystem} | ${clean(component.name)} | ${clean(component.version)} | ${clean(component.license)} |`);
}
lines.push("", "## License and notice texts", "");
for (const [hash, notice] of [...texts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const owners = [...new Set(notice.components)].sort();
  lines.push(
    `### ${hash.slice(0, 16)}`,
    "",
    `Applies to: ${owners.join(", ")}`,
    "",
    "```text",
    notice.value.replace(/```/g, "` ` `"),
    "```",
    "",
  );
}
const generated = `${lines.join("\n").trim()}\n`;

if (checkOnly) {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== generated) {
    console.error("THIRD_PARTY_NOTICES.md is stale. Run npm run generate:third-party-notices.");
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is current (${components.length} components, ${texts.size} texts).`);
} else {
  writeFileSync(outputPath, generated);
  console.log(`Wrote ${outputPath} (${components.length} components, ${texts.size} texts).`);
}
