import type { AccountSyncRunResult } from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "./db/db.ts";
import type { RepoFileRemover } from "./domain/repos.ts";
import { runDueAccountSyncs, type DiscoveryDeps } from "./providers/discovery.ts";

/**
 * Account sync runs on its own cadence rather than through the repo
 * scheduler's worker pool: it is a handful of API calls a few times a day, and
 * each account_syncs row carries its own next_run_at. A plain interval that
 * asks "anything due?" is enough, and it keeps the sync scheduler's queue
 * about repositories only.
 */

/** How often to look for a due account sync. The rows decide what is due. */
export const ACCOUNT_SYNC_TICK_MS = 60_000;

export interface AccountSyncTimerOptions {
  db: Db;
  log: Logger;
  /** config.secretKey, for accounts with a stored credential. */
  secretKey: Buffer | null;
  /**
   * Deletes a repo's backup directory. Required: a starred sync that confirms
   * an unstar upstream frees the disk, and domain deleteRepo refuses to touch
   * files without it, so omitting it silently retains every removal forever.
   */
  removeFiles: RepoFileRemover;
  intervalMs?: number;
  /** Test seam. */
  run?: (db: Db, deps: DiscoveryDeps) => Promise<AccountSyncRunResult[]>;
}

export interface AccountSyncTimer {
  /** Runs one pass. Exported so a caller (and the tests) can drive it. */
  tick(): Promise<void>;
  stop(): void;
}

export function startAccountSyncTimer(options: AccountSyncTimerOptions): AccountSyncTimer {
  const log = options.log.child({ mod: "accountSync" });
  const run = options.run ?? runDueAccountSyncs;
  const deps: DiscoveryDeps = {
    log,
    secretKey: options.secretKey,
    removeFiles: options.removeFiles,
  };

  // A discovery pass can outlast the interval on a slow forge. Overlapping
  // passes would enumerate the same account twice and race on the same rows,
  // so a pass in flight makes the next tick a no-op rather than queueing up.
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const results = await run(options.db, deps);
      for (const result of results) {
        if (result.error !== null) {
          log.warn(
            { accountSyncId: result.accountSync.id, err: result.error },
            "account sync run failed",
          );
        }
      }
    } catch (error) {
      // One bad pass must never take the process down; the next tick retries.
      log.error({ err: error }, "account sync tick failed");
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs ?? ACCOUNT_SYNC_TICK_MS);
  timer.unref?.();

  return {
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}
