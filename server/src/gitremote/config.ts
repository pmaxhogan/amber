import type { GitRemoteConfig } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { generateGitPassword, hashGitPassword } from "../security/gitPassword.ts";

/**
 * Git remote settings live in the kv table, not the settings registry: they are
 * instance state with a secret attached rather than a per-scope preference.
 *
 * NOTE FOR A LATER MERGE: this is a tiny local kv accessor. If a general kv
 * helper appears next to domain/settings.ts, move these reads onto it.
 */

export const KV_ENABLED = "git_remote.enabled";
export const KV_USERNAME = "git_remote.username";
export const KV_PASSWORD_HASH = "git_remote.password_hash";
export const KV_ROTATED_AT = "git_remote.rotated_at";

export const DEFAULT_GIT_REMOTE_USERNAME = "amber";

export interface GitRemoteState {
  enabled: boolean;
  username: string;
  /** scrypt record. Never leaves the server. */
  passwordHash: string | null;
  rotatedAt: number | null;
}

function readKv(db: Db, key: string): string | undefined {
  const row = db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
  return row?.value;
}

function writeKv(db: Db, key: string, value: string): void {
  const now = Date.now();
  db.run(
    `INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now,
    now,
  );
}

function deleteKv(db: Db, key: string): void {
  db.run("DELETE FROM kv WHERE key = ?", key);
}

/** Defaults: disabled, username "amber", no password yet. */
export function readGitRemoteState(db: Db): GitRemoteState {
  const enabled = readKv(db, KV_ENABLED) === "true";
  const username = readKv(db, KV_USERNAME) ?? DEFAULT_GIT_REMOTE_USERNAME;
  const passwordHash = readKv(db, KV_PASSWORD_HASH) ?? null;
  const rawRotatedAt = readKv(db, KV_ROTATED_AT);
  const rotatedAt = rawRotatedAt === undefined ? null : Number.parseInt(rawRotatedAt, 10);
  return {
    // A remote with no password can never authenticate anyone, so it is not
    // reachable even if the flag somehow says otherwise.
    enabled: enabled && passwordHash !== null,
    username,
    passwordHash,
    rotatedAt: rotatedAt !== null && Number.isSafeInteger(rotatedAt) ? rotatedAt : null,
  };
}

/**
 * The clone URL the UI shows, with placeholders it fills in client side. The
 * real password is only ever sent in the one-time enable/rotate response.
 */
export function buildCloneUrlTemplate(publicOrigin: string, username: string): string {
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    return `${publicOrigin}/git/{slug}.git`;
  }
  return `${origin.protocol}//${encodeURIComponent(username)}:{password}@${origin.host}/git/{slug}.git`;
}

export function toGitRemoteConfig(state: GitRemoteState, publicOrigin: string): GitRemoteConfig {
  return {
    enabled: state.enabled,
    username: state.username,
    cloneUrlTemplate: buildCloneUrlTemplate(publicOrigin, state.username),
    rotatedAt: state.rotatedAt,
  };
}

function mintPassword(db: Db, enabled: boolean): { state: GitRemoteState; password: string } {
  const password = generateGitPassword();
  const hash = hashGitPassword(password);
  db.tx(() => {
    writeKv(db, KV_ENABLED, enabled ? "true" : "false");
    writeKv(db, KV_PASSWORD_HASH, hash);
    writeKv(db, KV_ROTATED_AT, String(Date.now()));
    if (readKv(db, KV_USERNAME) === undefined) {
      writeKv(db, KV_USERNAME, DEFAULT_GIT_REMOTE_USERNAME);
    }
  });
  return { state: readGitRemoteState(db), password };
}

/** Turns the remote on and mints a fresh password, returned exactly once. */
export function enableGitRemote(db: Db): { state: GitRemoteState; password: string } {
  return mintPassword(db, true);
}

export class GitRemoteDisabledError extends Error {
  override readonly name = "GitRemoteDisabledError";
}

/**
 * Mints a fresh password, leaving the remote enabled. Rotating a disabled
 * remote is refused rather than quietly writing a hash nothing can use: that
 * would break the invariant that a disabled remote stores no credential at all.
 * Enabling is the way to get a password back.
 */
export function rotateGitRemotePassword(db: Db): { state: GitRemoteState; password: string } {
  if (!readGitRemoteState(db).enabled) {
    throw new GitRemoteDisabledError("The git remote is disabled. Enable it to get a password.");
  }
  return mintPassword(db, true);
}

/**
 * Turning the remote off also destroys the password hash: a disabled remote
 * holds no live credential, and re-enabling therefore always mints a new one.
 */
export function disableGitRemote(db: Db): GitRemoteState {
  db.tx(() => {
    writeKv(db, KV_ENABLED, "false");
    deleteKv(db, KV_PASSWORD_HASH);
  });
  return readGitRemoteState(db);
}
