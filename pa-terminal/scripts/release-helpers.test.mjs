import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scripts = new URL("./", import.meta.url);

function workspace(testContext) {
  const directory = mkdtempSync(join(tmpdir(), "paterminal-release-helpers-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(name, args, env = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(name, scripts)), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("writes updater config without printing the public key", (t) => {
  const directory = workspace(t);
  const output = join(directory, "tauri.json");
  const publicKey = Buffer.from(
    `untrusted comment: minisign public key: ${"A".repeat(16)}\nRW${"A".repeat(50)}\n`,
  ).toString("base64");
  const result = run("write-updater-config.mjs", [output], { TAURI_UPDATER_PUBLIC_KEY: publicKey });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(publicKey));
  const config = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.pubkey, publicKey);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/saisai-web/PATerminal/releases/latest/download/latest.json",
  ]);
});

test("rejects a malformed updater public key", (t) => {
  const result = run("write-updater-config.mjs", [join(workspace(t), "tauri.json")], {
    TAURI_UPDATER_PUBLIC_KEY: "not-a-minisign-key",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a Tauri minisign public key/);
});

test("writes deterministic checksums for all release artifact types", (t) => {
  const directory = workspace(t);
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  for (const name of ["PATerminal.dmg", "PATerminal.exe", "PATerminal.exe.sig", "PATerminal.app.tar.gz"]) {
    writeFileSync(join(bundle, name), `fixture:${name}`);
  }
  const output = join(directory, "SHA256SUMS.txt");
  const result = run("write-release-checksums.mjs", [bundle, output]);
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(output, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.deepEqual(lines, lines.toSorted());
  assert.ok(lines.every((line) => /^[a-f0-9]{64}  [A-Za-z0-9._+-]+$/.test(line)));
});

test("uses tauri-action asset names for tagged macOS updater bundles", (t) => {
  const directory = workspace(t);
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  for (const name of [
    "PATerminal.app.tar.gz",
    "PATerminal.app.tar.gz.sig",
    "PATerminal_0.2.2_universal.dmg",
  ]) {
    writeFileSync(join(bundle, name), `fixture:${name}`);
  }
  const output = join(directory, "SHA256SUMS.txt");
  const result = run("write-release-checksums.mjs", [bundle, output, "0.2.2"]);
  assert.equal(result.status, 0, result.stderr);
  const names = readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("  ")[1]);
  assert.deepEqual(names.toSorted(), [
    "PATerminal_0.2.2_universal.app.tar.gz",
    "PATerminal_0.2.2_universal.app.tar.gz.sig",
    "PATerminal_0.2.2_universal.dmg",
  ]);
});

test("requires every supported updater platform in latest.json", (t) => {
  const directory = workspace(t);
  const manifestPath = join(directory, "latest.json");
  const signature = "S".repeat(80);
  const platforms = Object.fromEntries(
    ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"].map((target) => [
      target,
      {
        url: `https://github.com/saisai-web/PATerminal/releases/download/v0.2.2/${target}`,
        signature,
      },
    ]),
  );
  writeFileSync(manifestPath, JSON.stringify({ version: "0.2.2", platforms }));
  assert.equal(run("verify-updater-json.mjs", [manifestPath]).status, 0);
  delete platforms["darwin-x86_64"];
  writeFileSync(manifestPath, JSON.stringify({ version: "0.2.2", platforms }));
  const rejected = run("verify-updater-json.mjs", [manifestPath]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /missing darwin-x86_64/);
});

test("normalizes updater API asset URLs to stable public download URLs", (t) => {
  const directory = workspace(t);
  const manifestPath = join(directory, "latest.json");
  const releasePath = join(directory, "release.json");
  const apiUrl = "https://api.github.com/repos/saisai-web/PATerminal/releases/assets/123";
  const signature = "S".repeat(80);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "0.2.2",
      platforms: {
        "darwin-aarch64": { url: apiUrl, signature },
        "darwin-x86_64": { url: apiUrl, signature },
      },
    }),
  );
  writeFileSync(
    releasePath,
    JSON.stringify({
      tag_name: "v0.2.2",
      assets: [{ name: "PATerminal_0.2.2_universal.app.tar.gz", url: apiUrl }],
    }),
  );

  const normalized = run("normalize-updater-json.mjs", [
    manifestPath,
    releasePath,
    "saisai-web/PATerminal",
    "v0.2.2",
  ]);
  assert.equal(normalized.status, 0, normalized.stderr);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected =
    "https://github.com/saisai-web/PATerminal/releases/download/v0.2.2/PATerminal_0.2.2_universal.app.tar.gz";
  assert.equal(manifest.platforms["darwin-aarch64"].url, expected);
  assert.equal(manifest.platforms["darwin-x86_64"].url, expected);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, signature);
});

test("rejects updater URLs that do not match a release asset", (t) => {
  const directory = workspace(t);
  const manifestPath = join(directory, "latest.json");
  const releasePath = join(directory, "release.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "0.2.2",
      platforms: {
        "windows-x86_64": {
          url: "https://example.com/PATerminal.exe",
          signature: "S".repeat(80),
        },
      },
    }),
  );
  writeFileSync(
    releasePath,
    JSON.stringify({
      tag_name: "v0.2.2",
      assets: [
        {
          name: "PATerminal_0.2.2_x64-setup.exe",
          url: "https://api.github.com/repos/saisai-web/PATerminal/releases/assets/456",
        },
      ],
    }),
  );

  const rejected = run("normalize-updater-json.mjs", [
    manifestPath,
    releasePath,
    "saisai-web/PATerminal",
    "v0.2.2",
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match a release asset/);
});
