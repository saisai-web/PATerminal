import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as signEd25519 } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // 開発者の環境変数に公開鍵があっても、この形状テストは署名検証なしで通す
  const noKey = { TAURI_UPDATER_PUBLIC_KEY: "" };
  assert.equal(run("verify-updater-json.mjs", [manifestPath, "v0.2.2"], noKey).status, 0);
  const wrongVersion = run("verify-updater-json.mjs", [manifestPath, "v0.2.3"], noKey);
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /does not match release tag/);
  delete platforms["darwin-x86_64"];
  writeFileSync(manifestPath, JSON.stringify({ version: "0.2.2", platforms }));
  const rejected = run("verify-updater-json.mjs", [manifestPath], noKey);
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

test("requires the release tag to match every app manifest", (t) => {
  const directory = workspace(t);
  mkdirSync(join(directory, "src-tauri"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({
    version: "1.2.3",
    packages: { "": { version: "1.2.3" } },
  }));
  writeFileSync(join(directory, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(directory, "src-tauri", "Cargo.toml"), '[package]\nname = "pa-terminal"\nversion = "1.2.3"\n');
  writeFileSync(join(directory, "src-tauri", "Cargo.lock"), '[[package]]\nname = "pa-terminal"\nversion = "1.2.3"\n');

  const accepted = run("verify-release-version.mjs", ["v1.2.3", directory]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = run("verify-release-version.mjs", ["v1.2.4", directory]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /package.json: 1.2.3 \(expected 1.2.4\)/);
});

test("prepares the release version in every app manifest", (t) => {
  const directory = workspace(t);
  mkdirSync(join(directory, "src-tauri"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }, null, 2));
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({
    version: "1.2.3",
    packages: { "": { version: "1.2.3" } },
  }, null, 2));
  writeFileSync(join(directory, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }, null, 2));
  writeFileSync(join(directory, "src-tauri", "Cargo.toml"), '[package]\nname = "pa-terminal"\nversion = "1.2.3"\n\n[dependencies]\n');
  writeFileSync(join(directory, "src-tauri", "Cargo.lock"), '[[package]]\nname = "dependency"\nversion = "9.9.9"\n\n[[package]]\nname = "pa-terminal"\nversion = "1.2.3"\n');

  const prepared = run("set-release-version.mjs", ["v1.2.4", directory]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const verified = run("verify-release-version.mjs", ["v1.2.4", directory]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(readFileSync(join(directory, "src-tauri", "Cargo.lock"), "utf8"), /name = "dependency"\nversion = "9.9.9"/);
});

/** minisign 形式の鍵と署名を node:crypto だけで作る（tauri signer と同じ ED = BLAKE2b prehash）。 */
function minisignFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const keyId = randomBytes(8);
  const keyIdHex = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  const publicKeyText = `untrusted comment: minisign public key: ${keyIdHex}\n${Buffer.concat([
    Buffer.from("Ed"),
    keyId,
    rawPublicKey,
  ]).toString("base64")}\n`;
  const sign = (data, fileName) => {
    const signature = signEd25519(null, createHash("blake2b512").update(data).digest(), privateKey);
    const trustedComment = `timestamp:1700000000\tfile:${fileName}`;
    const globalSignature = signEd25519(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment)]),
      privateKey,
    );
    return `untrusted comment: signature from tauri secret key\n${Buffer.concat([
      Buffer.from("ED"),
      keyId,
      signature,
    ]).toString("base64")}\ntrusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`;
  };
  return { keyIdHex, publicKeyBase64: Buffer.from(publicKeyText).toString("base64"), sign };
}

const UPDATER_ASSETS = {
  "darwin-aarch64": "PATerminal_0.2.3_universal.app.tar.gz",
  "darwin-x86_64": "PATerminal_0.2.3_universal.app.tar.gz",
  "windows-x86_64": "PATerminal_0.2.3_x64-setup.exe",
  "windows-x86_64-msi": "PATerminal_0.2.3_x64_en-US.msi",
};

function signedRelease(directory, signer) {
  const assets = join(directory, "assets");
  mkdirSync(assets);
  const platforms = {};
  for (const [target, name] of Object.entries(UPDATER_ASSETS)) {
    const path = join(assets, name);
    if (!existsSync(path)) {
      writeFileSync(path, `fixture:${name}`);
      writeFileSync(`${path}.sig`, signer.sign(readFileSync(path), name));
    }
    platforms[target] = {
      url: `https://github.com/saisai-web/PATerminal/releases/download/v0.2.3/${name}`,
      signature: Buffer.from(readFileSync(`${path}.sig`, "utf8")).toString("base64"),
    };
  }
  const manifestPath = join(directory, "latest.json");
  writeFileSync(manifestPath, JSON.stringify({ version: "0.2.3", platforms }));
  return { assets, manifestPath };
}

test("verifies latest.json signatures against the updater public key", (t) => {
  const signer = minisignFixture();
  const { assets, manifestPath } = signedRelease(workspace(t), signer);
  const result = run("verify-updater-json.mjs", [manifestPath, "v0.2.3", "--assets", assets], {
    TAURI_UPDATER_PUBLIC_KEY: signer.publicKeyBase64,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`windows-x86_64-msi: .* key ${signer.keyIdHex}`));
  assert.match(result.stdout, new RegExp(`against public key ${signer.keyIdHex}`));
});

test("rejects latest.json signed by a key other than the embedded updater public key", (t) => {
  const signer = minisignFixture();
  const embedded = minisignFixture();
  const { assets, manifestPath } = signedRelease(workspace(t), signer);
  const result = run("verify-updater-json.mjs", [manifestPath, "v0.2.3", "--assets", assets], {
    TAURI_UPDATER_PUBLIC_KEY: embedded.publicKeyBase64,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`signature was made with key ${signer.keyIdHex}, but the updater public key is ${embedded.keyIdHex}`),
  );
});

test("rejects an updater asset that no longer matches its signature", (t) => {
  const signer = minisignFixture();
  const { assets, manifestPath } = signedRelease(workspace(t), signer);
  writeFileSync(join(assets, UPDATER_ASSETS["windows-x86_64"]), "tampered");
  const result = run("verify-updater-json.mjs", [manifestPath, "v0.2.3", "--assets", assets], {
    TAURI_UPDATER_PUBLIC_KEY: signer.publicKeyBase64,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /windows-x86_64 .*does not match the file/);
});

test("requires downloaded assets whenever a public key is given", (t) => {
  const signer = minisignFixture();
  const { manifestPath } = signedRelease(workspace(t), signer);
  const result = run("verify-updater-json.mjs", [manifestPath, "v0.2.3"], {
    TAURI_UPDATER_PUBLIC_KEY: signer.publicKeyBase64,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--assets <dir> is required/);
});

const tauriCli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));

function generateTauriKey(directory, name) {
  const path = join(directory, name);
  const result = spawnSync(process.execPath, [tauriCli, "signer", "generate", "-w", path, "-p", "", "--ci"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return { privateKey: readFileSync(path, "utf8"), publicKey: readFileSync(`${path}.pub`, "utf8") };
}

test("release preflight accepts a matching updater key pair and rejects a rotated one", { skip: !existsSync(tauriCli) && "tauri CLI is not installed" }, (t) => {
  const directory = workspace(t);
  const current = generateTauriKey(directory, "current.key");
  const rotated = generateTauriKey(directory, "rotated.key");
  const matching = run("check-updater-keypair.mjs", [], {
    TAURI_SIGNING_PRIVATE_KEY: current.privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    TAURI_UPDATER_PUBLIC_KEY: current.publicKey,
  });
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stdout, /matching pair/);
  assert.doesNotMatch(matching.stdout + matching.stderr, new RegExp(current.privateKey.trim().slice(-24)));

  const mismatched = run("check-updater-keypair.mjs", [], {
    TAURI_SIGNING_PRIVATE_KEY: current.privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    TAURI_UPDATER_PUBLIC_KEY: rotated.publicKey,
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /signature was made with key .*, but the updater public key is/);
});
