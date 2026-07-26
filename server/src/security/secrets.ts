import { notImplemented } from "../notImplemented.ts";

/**
 * AES-256-GCM for account credentials under AMBER_SECRET_KEY.
 * Wire format: 12 byte IV || 16 byte tag || ciphertext.
 */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export function encryptSecret(_key: Buffer, _plaintext: string): Buffer {
  return notImplemented("encryptSecret");
}

export function decryptSecret(_key: Buffer, _blob: Buffer): string {
  return notImplemented("decryptSecret");
}
