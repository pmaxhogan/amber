import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM for account credentials under AMBER_SECRET_KEY.
 * Wire format: 12 byte IV || 16 byte tag || ciphertext.
 *
 * Nothing in this module ever puts key material, ciphertext, or plaintext into
 * an error message: a thrown error is frequently logged or surfaced to a
 * client, and a credential must never ride along.
 */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

const ALGORITHM = "aes-256-gcm";

export class SecretError extends Error {
  override readonly name = "SecretError";
}

/**
 * Fail fast on a key that is not exactly 32 bytes. The message names the
 * problem and the expected size, never the bytes we were handed.
 */
export function assertSecretKey(key: Buffer | null | undefined): Buffer {
  if (key === null || key === undefined) {
    throw new SecretError(
      "AMBER_SECRET_KEY is not configured, so stored credentials cannot be read or written. " +
        "Set it to 64 hex characters.",
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretError(
      `AMBER_SECRET_KEY must decode to ${String(KEY_BYTES)} bytes (64 hex characters), ` +
        `got ${String(key.length)} bytes.`,
    );
  }
  return key;
}

/** True when the key is present and usable, without throwing. */
export function isUsableSecretKey(key: Buffer | null | undefined): key is Buffer {
  return key !== null && key !== undefined && key.length === KEY_BYTES;
}

export function encryptSecret(key: Buffer, plaintext: string): Buffer {
  assertSecretKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptSecret(key: Buffer, blob: Buffer): string {
  assertSecretKey(key);
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new SecretError("Stored credential is malformed: the blob is shorter than its header.");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The underlying error carries no plaintext, but it is replaced anyway so
    // a tampered blob and a wrong key fail identically and say nothing useful
    // to an attacker who can read logs.
    throw new SecretError(
      "Stored credential could not be decrypted. The encryption key may have changed, " +
        "or the stored value was modified.",
    );
  }
}

/**
 * Constant time equality for two secrets. Length is compared first, which
 * leaks only the length, never the content.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
