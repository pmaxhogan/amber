import type { Db } from "../db/db.ts";

/**
 * The git remote's one piece of instance state: the kill switch. Credentials
 * are per user and live on the users row (gitremote/credentials.ts); the
 * instance-wide credential that used to sit next to this flag was deleted by
 * migration 010.
 *
 * NOTE FOR A LATER MERGE: this is a tiny local kv accessor. If a general kv
 * helper appears next to domain/settings.ts, move these reads onto it.
 */

export const KV_ENABLED = "git_remote.enabled";

function readKv(db: Db, key: string): string | undefined {
  const row = db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
  return row?.value;
}

function writeKv(db: Db, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now,
    now,
  );
}

/**
 * Off unless the flag reads exactly "true": a missing, garbled or legacy value
 * keeps the one surface outside Cloudflare Access closed.
 */
export function isGitRemoteEnabled(db: Db): boolean {
  return readKv(db, KV_ENABLED) === "true";
}

/**
 * Flip the kill switch. Turning it off does NOT delete anyone's credential:
 * it is an emergency stop for the whole surface, and destroying every user's
 * password on the way would turn a brief "off, then on" into everyone
 * re-minting and re-configuring their clones. While it is off every /git path
 * answers 404 before a credential is even looked at.
 */
export function setGitRemoteEnabled(db: Db, enabled: boolean, now: number = Date.now()): void {
  writeKv(db, KV_ENABLED, enabled ? "true" : "false", now);
}

/**
 * The clone URL the UI shows, with `{password}` and `{slug}` placeholders it
 * fills in client side. The real password is only ever sent in the one-time
 * rotate response.
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
