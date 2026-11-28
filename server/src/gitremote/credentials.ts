import { randomBytes } from "node:crypto";
import type { GitRemoteMe } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { DomainError, isUniqueViolation } from "../domain/errors.ts";
import { requireUser, type User } from "../domain/users.ts";
import { generateGitPassword, hashGitPassword } from "../security/gitPassword.ts";
import { buildCloneUrlTemplate, isGitRemoteEnabled } from "./config.ts";

/**
 * Per-user git credentials. Each user with the `git` permission mints their
 * own: a random username that is theirs for good, and a password that is shown
 * once and stored only as a scrypt hash on their users row.
 *
 * The username is random rather than derived from the email or the row id, so
 * a clone URL seen over someone's shoulder says nothing about who they are and
 * cannot be enumerated. It is assigned on the first mint and never changes,
 * so rotating the password keeps every configured remote URL valid apart from
 * the secret.
 */

export const GIT_USERNAME_LENGTH = 10;
const GIT_USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const GIT_USERNAME_PATTERN = /^[a-z0-9]{10}$/;

/** Attempts at a free username before giving up. 36^10 makes even two a fluke. */
const USERNAME_ATTEMPTS = 8;

/** 10 lower-case alphanumerics from crypto.randomBytes, without modulo bias. */
export function generateGitUsername(): string {
  const alphabet = GIT_USERNAME_ALPHABET;
  // 256 is not a multiple of 36, so bytes past the last whole multiple are
  // thrown away rather than folded back onto the first few characters.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < GIT_USERNAME_LENGTH) {
    for (const byte of randomBytes(GIT_USERNAME_LENGTH * 2)) {
      if (byte >= limit) {
        continue;
      }
      out += alphabet[byte % alphabet.length];
      if (out.length === GIT_USERNAME_LENGTH) {
        break;
      }
    }
  }
  return out;
}

/**
 * Only names the generator could have produced are looked up at all. The
 * caller still pays the dummy derivation for anything else, so a malformed
 * name is indistinguishable from an unknown one.
 */
export function isWellFormedGitUsername(value: string): boolean {
  return GIT_USERNAME_PATTERN.test(value);
}

export interface MintedGitCredential {
  username: string;
  /** Plaintext, for the one response that carries it. Never stored or logged. */
  password: string;
  rotatedAt: number;
}

export interface MintOptions {
  now?: number;
  /** Test seam, so a username collision can be forced. */
  generateUsername?: () => string;
}

/**
 * Mint the user's first credential, or rotate it. Rotation replaces the hash,
 * so the previous password stops working on the very next request; the
 * username is kept.
 */
export function mintGitCredential(
  db: Db,
  userId: number,
  options: MintOptions = {},
): MintedGitCredential {
  const now = options.now ?? Date.now();
  const generate = options.generateUsername ?? generateGitUsername;
  const password = generateGitPassword();
  // scrypt is deliberately slow; derive before opening the transaction so the
  // write lock is held only for the row update.
  const hash = hashGitPassword(password);

  const username = db.tx(() => {
    const user = requireUser(db, userId);
    if (user.removedAt !== null) {
      // The API already refuses removed users; this keeps the domain call
      // from ever handing one a live credential on its own.
      throw new DomainError("forbidden", "A removed user cannot hold a git credential.");
    }
    if (user.gitUsername !== null) {
      db.run(
        `UPDATE users SET git_password_hash = ?, git_rotated_at = ?, updated_at = ?
          WHERE id = ?`,
        hash,
        now,
        now,
        userId,
      );
      return user.gitUsername;
    }
    for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
      const candidate = generate();
      if (!isWellFormedGitUsername(candidate)) {
        throw new Error("The git username generator produced a malformed name");
      }
      const taken = db.get<{ id: number }>(
        "SELECT id FROM users WHERE git_username = ?",
        candidate,
      );
      if (taken !== undefined) {
        continue;
      }
      try {
        db.run(
          `UPDATE users
              SET git_username = ?, git_password_hash = ?, git_rotated_at = ?, updated_at = ?
            WHERE id = ? AND git_username IS NULL`,
          candidate,
          hash,
          now,
          now,
          userId,
        );
      } catch (error) {
        // The UNIQUE index is the real guarantee; the SELECT above only
        // avoids relying on an exception for the common case.
        if (isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
      return candidate;
    }
    throw new Error("Could not find a free git username");
  });

  return { username, password, rotatedAt: now };
}

/** What git authentication needs about a credential. The hash never leaves the server. */
export interface StoredGitCredential {
  userId: number;
  passwordHash: string;
}

/** The live credential for a username, or undefined when there is none. */
export function findGitCredential(db: Db, username: string): StoredGitCredential | undefined {
  const row = db.get<{ id: number; git_password_hash: string }>(
    `SELECT id, git_password_hash FROM users
      WHERE git_username = ? AND git_password_hash IS NOT NULL`,
    username,
  );
  return row === undefined ? undefined : { userId: row.id, passwordHash: row.git_password_hash };
}

/** The user's current hash, re-read after an await to catch a rotation or a revoke. */
export function readGitPasswordHash(db: Db, userId: number): string | null {
  const row = db.get<{ git_password_hash: string | null }>(
    "SELECT git_password_hash FROM users WHERE id = ?",
    userId,
  );
  return row?.git_password_hash ?? null;
}

/** GET /api/git-remote: the caller's own credential state, never a secret. */
export function toGitRemoteMe(db: Db, user: User, publicOrigin: string): GitRemoteMe {
  return {
    enabled: isGitRemoteEnabled(db),
    username: user.gitUsername,
    hasPassword: user.hasGitPassword,
    rotatedAt: user.hasGitPassword ? user.gitRotatedAt : null,
    cloneUrlTemplate:
      user.gitUsername === null ? null : buildCloneUrlTemplate(publicOrigin, user.gitUsername),
  };
}
