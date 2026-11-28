import type { Db } from "../db/db.ts";
import { getUser, userCapBytes, userUsageBytes, type User } from "./users.ts";

/**
 * Storage caps beyond "refuse a new repository at or over the cap" (which
 * the importer and account syncs check themselves):
 *
 * - the under -> at-or-over TRANSITION, recorded in `cap_notified_at` so the
 *   user is told once (web push, and the banner GET /api/me shows), and
 *   cleared again when they drop back under;
 * - the FIRST-CLONE gate: a size is only known after a clone, so a batch of
 *   imports would all pass the import-time check. The scheduler re-checks
 *   the cap right before a never-synced repo's first clone, refuses one the
 *   forge says would not fit, and runs a capped owner's first clones one at a
 *   time (sync/scheduler.ts).
 */

export type CapTransition = "reached" | "cleared" | null;

/**
 * Bring `cap_notified_at` in line with the user's usage now. Returns
 * "reached" exactly once per crossing (the conditional UPDATE makes two
 * concurrent syncs agree on who saw it), "cleared" when they are back under,
 * and null when nothing changed. The admin is uncapped and never "reached".
 */
export function refreshCapState(db: Db, userId: number, now: number = Date.now()): CapTransition {
  const user = getUser(db, userId);
  if (user === undefined) {
    return null;
  }
  const capBytes = userCapBytes(db, user);
  const over = capBytes !== null && userUsageBytes(db, userId) >= capBytes;
  if (over) {
    const set = db.run(
      "UPDATE users SET cap_notified_at = ? WHERE id = ? AND cap_notified_at IS NULL",
      now,
      userId,
    );
    return set.changes > 0 ? "reached" : null;
  }
  const cleared = db.run(
    "UPDATE users SET cap_notified_at = NULL WHERE id = ? AND cap_notified_at IS NOT NULL",
    userId,
  );
  return cleared.changes > 0 ? "cleared" : null;
}

export const CAP_REACHED_ERROR =
  "Storage cap reached: this repository's first backup has not started. It will be tried " +
  "again on its normal schedule.";

export const CAP_WOULD_NOT_FIT_ERROR =
  "Storage cap reached: the forge reports this repository is larger than the owner's " +
  "remaining allowance, so its first backup has not started. It will be tried again on its " +
  "normal schedule.";

export interface FirstCloneFacts {
  /** The repo has never synced successfully: the next run is its first clone. */
  firstClone: boolean;
  /** The owner, when they are capped (not the admin). Null otherwise. */
  cappedOwner: User | null;
}

/** Whether the next sync of this repo is a capped owner's first clone. */
export function firstCloneFacts(db: Db, repoId: number): FirstCloneFacts {
  const row = db.get<{ owner_user_id: number | null; last_success_at: number | null }>(
    "SELECT owner_user_id, last_success_at FROM repos WHERE id = ?",
    repoId,
  );
  if (row === undefined) {
    return { firstClone: false, cappedOwner: null };
  }
  const owner = row.owner_user_id === null ? undefined : getUser(db, row.owner_user_id);
  return {
    firstClone: row.last_success_at === null,
    cappedOwner: owner === undefined || owner.isAdmin ? null : owner,
  };
}

/** Bytes the owner may still use, or null when uncapped. Never negative. */
export function remainingAllowanceBytes(db: Db, owner: User): number | null {
  const capBytes = userCapBytes(db, owner);
  if (capBytes === null) {
    return null;
  }
  return Math.max(0, capBytes - userUsageBytes(db, owner.id));
}

/**
 * Record a refused first clone on the repo row, without a sync run: nothing
 * was fetched, and a failure row would feed backoff and the network breaker.
 * The repo shows the reason and is retried at `retryAt`, its normal schedule.
 */
export function markFirstCloneRefused(
  db: Db,
  repoId: number,
  message: string,
  retryAt: number,
  now: number,
): void {
  db.run(
    "UPDATE repos SET last_error = ?, next_sync_at = ?, updated_at = ? WHERE id = ?",
    message,
    retryAt,
    now,
    repoId,
  );
}
