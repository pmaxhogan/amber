import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSecretKey,
  decryptSecret,
  encryptSecret,
  IV_BYTES,
  isUsableSecretKey,
  KEY_BYTES,
  SecretError,
  secretsEqual,
  TAG_BYTES,
} from "../src/security/secrets.ts";

const KEY = Buffer.from("a".repeat(64), "hex");
const OTHER_KEY = Buffer.from("b".repeat(64), "hex");

/** A distinctive value so a leak into a message is unmistakable. */
const SENTINEL = "SENTINEL-github_pat_11ABCDEFG-do-not-leak";

describe("encryptSecret / decryptSecret", () => {
  it("round trips a credential", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    expect(decryptSecret(KEY, blob)).toBe(SENTINEL);
  });

  it("round trips an empty string and multibyte text", () => {
    expect(decryptSecret(KEY, encryptSecret(KEY, ""))).toBe("");
    const unicode = "pa55w0rd-éü中文";
    expect(decryptSecret(KEY, encryptSecret(KEY, unicode))).toBe(unicode);
  });

  it("uses the documented blob layout: 12 byte IV, 16 byte tag, then ciphertext", () => {
    const plaintext = "0123456789";
    const blob = encryptSecret(KEY, plaintext);
    expect(IV_BYTES).toBe(12);
    expect(TAG_BYTES).toBe(16);
    expect(blob.length).toBe(IV_BYTES + TAG_BYTES + Buffer.byteLength(plaintext, "utf8"));
  });

  it("never stores the plaintext in the blob", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    expect(blob.toString("utf8")).not.toContain(SENTINEL);
    expect(blob.toString("latin1")).not.toContain("SENTINEL");
  });

  it("uses a fresh IV per call, so the same input never produces the same blob", () => {
    const first = encryptSecret(KEY, SENTINEL);
    const second = encryptSecret(KEY, SENTINEL);
    expect(first.equals(second)).toBe(false);
    expect(first.subarray(0, IV_BYTES).equals(second.subarray(0, IV_BYTES))).toBe(false);
    expect(decryptSecret(KEY, first)).toBe(SENTINEL);
    expect(decryptSecret(KEY, second)).toBe(SENTINEL);
  });
});

describe("tamper detection", () => {
  it("throws when a ciphertext byte is flipped", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    const tampered = Buffer.from(blob);
    const target = IV_BYTES + TAG_BYTES;
    tampered[target] = (tampered[target] ?? 0) ^ 0x01;
    expect(() => decryptSecret(KEY, tampered)).toThrow(SecretError);
  });

  it("throws when a tag byte is flipped", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    const tampered = Buffer.from(blob);
    tampered[IV_BYTES] = (tampered[IV_BYTES] ?? 0) ^ 0xff;
    expect(() => decryptSecret(KEY, tampered)).toThrow(SecretError);
  });

  it("throws when an IV byte is flipped", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    const tampered = Buffer.from(blob);
    tampered[0] = (tampered[0] ?? 0) ^ 0x80;
    expect(() => decryptSecret(KEY, tampered)).toThrow(SecretError);
  });

  it("flips every single byte in turn and never decrypts successfully", () => {
    const blob = encryptSecret(KEY, "short-secret");
    for (let i = 0; i < blob.length; i += 1) {
      const tampered = Buffer.from(blob);
      tampered[i] = (tampered[i] ?? 0) ^ 0x01;
      expect(() => decryptSecret(KEY, tampered)).toThrow(SecretError);
    }
  });

  it("rejects a blob too short to hold the header", () => {
    expect(() => decryptSecret(KEY, Buffer.alloc(IV_BYTES + TAG_BYTES - 1))).toThrow(SecretError);
    expect(() => decryptSecret(KEY, Buffer.alloc(0))).toThrow(SecretError);
  });
});

describe("wrong key", () => {
  it("refuses to decrypt a blob written under a different key", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    expect(() => decryptSecret(OTHER_KEY, blob)).toThrow(SecretError);
  });

  it("fails identically for a wrong key and a tampered blob", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;

    let wrongKeyMessage = "";
    let tamperMessage = "";
    try {
      decryptSecret(OTHER_KEY, blob);
    } catch (error) {
      wrongKeyMessage = (error as Error).message;
    }
    try {
      decryptSecret(KEY, tampered);
    } catch (error) {
      tamperMessage = (error as Error).message;
    }
    expect(wrongKeyMessage).not.toBe("");
    expect(wrongKeyMessage).toBe(tamperMessage);
  });
});

describe("error messages carry no secret material", () => {
  const collect = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      const err = error as Error;
      return `${err.message}\n${err.stack ?? ""}`;
    }
    throw new Error("expected the call to throw");
  };

  it("says nothing about the plaintext, ciphertext, or key on a decrypt failure", () => {
    const blob = encryptSecret(KEY, SENTINEL);
    const message = collect(() => decryptSecret(OTHER_KEY, blob));

    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain("SENTINEL");
    expect(message).not.toContain(blob.toString("hex"));
    expect(message).not.toContain(blob.toString("base64"));
    expect(message).not.toContain(KEY.toString("hex"));
    expect(message).not.toContain(OTHER_KEY.toString("hex"));
  });

  it("says nothing about the key bytes when the key is the wrong size", () => {
    const short = randomBytes(KEY_BYTES - 1);
    const long = randomBytes(KEY_BYTES + 1);

    const shortMessage = collect(() => encryptSecret(short, SENTINEL));
    expect(shortMessage).toContain("64 hex characters");
    expect(shortMessage).toContain("31 bytes");
    expect(shortMessage).not.toContain(short.toString("hex"));
    expect(shortMessage).not.toContain(SENTINEL);

    const longMessage = collect(() => encryptSecret(long, SENTINEL));
    expect(longMessage).toContain("33 bytes");
    expect(longMessage).not.toContain(long.toString("hex"));
  });
});

describe("assertSecretKey", () => {
  it("returns the key when it is exactly 32 bytes", () => {
    expect(assertSecretKey(KEY)).toBe(KEY);
  });

  it("throws a SecretError for null and undefined", () => {
    expect(() => assertSecretKey(null)).toThrow(SecretError);
    expect(() => assertSecretKey(undefined)).toThrow(SecretError);
    expect(() => assertSecretKey(null)).toThrow(/AMBER_SECRET_KEY is not configured/);
  });

  it("throws for a key of the wrong length in either direction", () => {
    expect(() => assertSecretKey(Buffer.alloc(0))).toThrow(SecretError);
    expect(() => assertSecretKey(Buffer.alloc(16))).toThrow(SecretError);
    expect(() => assertSecretKey(Buffer.alloc(64))).toThrow(SecretError);
  });

  it("fails fast on both encrypt and decrypt with a bad key", () => {
    const bad = Buffer.alloc(16);
    expect(() => encryptSecret(bad, "x")).toThrow(SecretError);
    expect(() => decryptSecret(bad, encryptSecret(KEY, "x"))).toThrow(SecretError);
  });
});

describe("isUsableSecretKey", () => {
  it("recognizes a well formed key and rejects everything else", () => {
    expect(isUsableSecretKey(KEY)).toBe(true);
    expect(isUsableSecretKey(null)).toBe(false);
    expect(isUsableSecretKey(undefined)).toBe(false);
    expect(isUsableSecretKey(Buffer.alloc(31))).toBe(false);
  });
});

describe("secretsEqual", () => {
  it("compares equal and unequal values", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });
});
