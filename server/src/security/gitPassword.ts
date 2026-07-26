import { notImplemented } from "../notImplemented.ts";

/** scrypt parameters for the read-only git remote password. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;

/** 32 characters of base58 from crypto.randomBytes. Shown to the user once. */
export function generateGitPassword(): string {
  return notImplemented("generateGitPassword");
}

export function hashGitPassword(_password: string): string {
  return notImplemented("hashGitPassword");
}

/** Constant time comparison via timingSafeEqual. */
export function verifyGitPassword(_password: string, _stored: string): boolean {
  return notImplemented("verifyGitPassword");
}
