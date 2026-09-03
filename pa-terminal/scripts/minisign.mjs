// Dependency-free minisign verification for the Tauri updater.
// Mirrors what tauri-plugin-updater checks at install time (minisign-verify crate):
// the key ID must match the public key, the ed25519 signature must cover the file
// (BLAKE2b-512 prehash for "ED" signatures), and the global signature must cover the
// signature plus the trusted comment. Verifying with this module in CI catches a
// public/private key mismatch before users see "the signed update could not be installed".
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";

/** Tauri stores keys and signatures as base64 of the multi-line minisign text. Accept both. */
function minisignLines(text) {
  const trimmed = text.trim();
  if (!trimmed.includes("\n") && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded.startsWith("untrusted comment:")) return decoded.split(/\r?\n/);
  }
  return trimmed.split(/\r?\n/);
}

/** minisign prints key IDs as the little-endian 8 bytes in uppercase hex. */
export function keyIdHex(bytes) {
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

export function parsePublicKey(text) {
  const lines = minisignLines(text);
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment:")) {
    throw new Error("not a minisign public key");
  }
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") {
    throw new Error("not an ed25519 minisign public key");
  }
  return { keyId: keyIdHex(raw.subarray(2, 10)), key: raw.subarray(10, 42) };
}

export function parseSignature(text) {
  const lines = minisignLines(text);
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:")) {
    throw new Error("not a minisign signature");
  }
  const raw = Buffer.from(lines[1], "base64");
  const algorithm = raw.toString("latin1", 0, 2);
  if (raw.length !== 74 || (algorithm !== "ED" && algorithm !== "Ed")) {
    throw new Error("not an ed25519 minisign signature");
  }
  if (!lines[2].startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error("minisign signature has no trusted comment");
  }
  const globalSignature = Buffer.from(lines[3], "base64");
  if (globalSignature.length !== 64) {
    throw new Error("minisign signature has no global signature");
  }
  return {
    prehashed: algorithm === "ED",
    keyId: keyIdHex(raw.subarray(2, 10)),
    signature: raw.subarray(10, 74),
    trustedComment: lines[2].slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature,
  };
}

/** Throws with a reason when `signature` was not made for `data` by the key behind `publicKey`. */
export function verifySignature(publicKey, signature, data) {
  if (publicKey.keyId !== signature.keyId) {
    throw new Error(
      `signature was made with key ${signature.keyId}, but the updater public key is ${publicKey.keyId}`,
    );
  }
  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]),
    format: "der",
    type: "spki",
  });
  const message = signature.prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!verifyEd25519(null, message, keyObject, signature.signature)) {
    throw new Error(`signature from key ${signature.keyId} does not match the file`);
  }
  const global = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]);
  if (!verifyEd25519(null, global, keyObject, signature.globalSignature)) {
    throw new Error("trusted comment signature is invalid");
  }
}
