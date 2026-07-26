import { describe, expect, it } from "vitest";
import {
  GIT_PASSWORD_LENGTH,
  generateGitPassword,
  hashGitPassword,
  safeEqualString,
  SCRYPT_PARAMS,
  verifyGitPassword,
} from "../src/security/gitPassword.ts";

const BASE58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

describe("generateGitPassword", () => {
  it("returns 32 base58 characters", () => {
    for (let i = 0; i < 20; i += 1) {
      const password = generateGitPassword();
      expect(password).toHaveLength(GIT_PASSWORD_LENGTH);
      expect(password).toMatch(BASE58);
    }
  });

  it("never emits the ambiguous base58 exclusions", () => {
    const joined = Array.from({ length: 50 }, () => generateGitPassword()).join("");
    for (const excluded of ["0", "O", "I", "l"]) {
      expect(joined).not.toContain(excluded);
    }
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateGitPassword()));
    expect(seen.size).toBe(200);
  });

  it("covers most of the alphabet across many draws, so no range is dead", () => {
    const joined = Array.from({ length: 300 }, () => generateGitPassword()).join("");
    const distinct = new Set(joined).size;
    expect(distinct).toBe(58);
  });
});

describe("hashGitPassword and verifyGitPassword", () => {
  it("round trips", () => {
    const password = generateGitPassword();
    const stored = hashGitPassword(password);
    expect(verifyGitPassword(password, stored)).toBe(true);
  });

  it("never contains the plaintext", () => {
    const password = generateGitPassword();
    const stored = hashGitPassword(password);
    expect(stored).not.toContain(password);
  });

  it("records the parameters it used", () => {
    const stored = hashGitPassword("hunter2");
    const [scheme, n, r, p] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBe(SCRYPT_PARAMS.N);
    expect(Number(r)).toBe(SCRYPT_PARAMS.r);
    expect(Number(p)).toBe(SCRYPT_PARAMS.p);
  });

  it("salts, so the same password hashes differently every time", () => {
    const password = generateGitPassword();
    expect(hashGitPassword(password)).not.toBe(hashGitPassword(password));
  });

  it("rejects the wrong password", () => {
    const stored = hashGitPassword("correct horse battery staple");
    expect(verifyGitPassword("correct horse battery stapler", stored)).toBe(false);
    expect(verifyGitPassword("", stored)).toBe(false);
    expect(verifyGitPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("refuses to hash an empty password", () => {
    expect(() => hashGitPassword("")).toThrow(/empty/i);
  });

  it("returns false rather than throwing on a tampered or malformed record", () => {
    const password = generateGitPassword();
    const stored = hashGitPassword(password);
    const parts = stored.split("$");

    const flippedHash = [...parts];
    flippedHash[5] = Buffer.from("nope-not-the-hash").toString("base64");
    expect(verifyGitPassword(password, flippedHash.join("$"))).toBe(false);

    const flippedSalt = [...parts];
    flippedSalt[4] = Buffer.from("different-salt00").toString("base64");
    expect(verifyGitPassword(password, flippedSalt.join("$"))).toBe(false);

    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$32768$8$1$onlyfive",
      "bcrypt$32768$8$1$c2FsdA==$aGFzaA==",
      "scrypt$notanumber$8$1$c2FsdA==$aGFzaA==",
      "scrypt$32768$8$1$$aGFzaA==",
      "scrypt$32768$8$1$c2FsdA==$",
      stored.slice(0, -4),
    ]) {
      expect(() => verifyGitPassword(password, bad)).not.toThrow();
      expect(verifyGitPassword(password, bad)).toBe(false);
    }
  });

  it("refuses an absurd work factor instead of allocating gigabytes", () => {
    const stored = `scrypt$${String(2 ** 30)}$8$1$c2FsdA==$aGFzaA==`;
    const started = Date.now();
    expect(verifyGitPassword("anything", stored)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rejects a hash truncated to a shorter but still valid derivation", () => {
    // scrypt ends in a single PBKDF2 pass, so the first 32 bytes of a 64 byte
    // derivation are exactly the 32 byte derivation. Without a pinned length
    // a truncated record would verify.
    const stored = hashGitPassword("portable");
    expect(verifyGitPassword("portable", stored)).toBe(true);
    const parts = stored.split("$");
    parts[5] = Buffer.from(parts[5] as string, "base64")
      .subarray(0, 32)
      .toString("base64");
    expect(verifyGitPassword("portable", parts.join("$"))).toBe(false);
  });

  it("rejects a record with a resized salt", () => {
    const stored = hashGitPassword("portable");
    const parts = stored.split("$");
    parts[4] = Buffer.from(parts[4] as string, "base64")
      .subarray(0, 8)
      .toString("base64");
    expect(verifyGitPassword("portable", parts.join("$"))).toBe(false);
  });
});

describe("safeEqualString", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(safeEqualString("amber", "amber")).toBe(true);
    expect(safeEqualString("amber", "ambeR")).toBe(false);
    expect(safeEqualString("amber", "amber2")).toBe(false);
    expect(safeEqualString("", "")).toBe(true);
  });

  it("does not throw on a length mismatch, which timingSafeEqual would", () => {
    expect(() => safeEqualString("a", "abcdefghijklmnop")).not.toThrow();
  });
});
