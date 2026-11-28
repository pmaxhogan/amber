import { existsSync } from "node:fs";
import { readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { CAP_CEILING_FACTOR } from "../domain/caps.ts";
import { getUser, userCapBytes, userUsageBytes } from "../domain/users.ts";
import { directorySizeBytes } from "./diskUsage.ts";

/**
 * The disk guard that runs WHILE a sync runs (docs/ARCHITECTURE.md "Storage
 * caps"). The twice-the-cap ceiling only decides whether a sync may START, and
 * a size is only known after a clone, so one sync (a tiny repository with
 * huge LFS content, which no forge size includes; an endless packfile from a
 * hostile forge) or several parallel syncs of one owner could still fill the
 * volume. A full volume does not just fail backups: SQLite cannot write its
 * journal and the whole instance crash-loops. So, on a timer:
 *
 * - IN-FLIGHT BUDGET, capped (non-admin) owners only. The owner may grow by
 *   (2 x cap - usage) in total across ALL of their syncs in flight, counted as
 *   each repo directory's growth since its sync started. Past it, the sync
 *   that noticed is aborted (its git process tree killed) with "storage cap
 *   exceeded"; the others notice on their next poll.
 * - FREE-SPACE FLOOR, everyone, the admin included: below the global
 *   `min_free_disk_gb`, the sync is aborted with "disk nearly full".
 *
 * Both abort through an AbortSignal that every git call of the sync carries
 * (sync/gitCli.ts), and the sync then removes the partial pack and LFS files
 * a killed fetch leaves behind (cleanupPartialFetch).
 */

export const DEFAULT_DISK_POLL_MS = 2_000;

export const CAP_EXCEEDED_DURING_SYNC_ERROR =
  "Storage cap exceeded: this sync was stopped because it would take the owner past twice " +
  "their storage cap. The partial download was removed; the existing backup is untouched.";

export const DISK_FLOOR_ERROR =
  "Disk nearly full: the backups volume is below its minimum free space, so this sync was " +
  "stopped (or not started). It will be tried again on its normal schedule.";

export type DiskStopReason = "storage_cap" | "disk_floor";

/** Why the watch aborted a sync. Thrown out of the git call it killed. */
export class DiskBudgetError extends Error {
  override readonly name = "DiskBudgetError";
  readonly reason: DiskStopReason;

  constructor(reason: DiskStopReason) {
    super(reason === "storage_cap" ? CAP_EXCEEDED_DURING_SYNC_ERROR : DISK_FLOOR_ERROR);
    this.reason = reason;
  }
}

/** Free bytes for an unprivileged writer on the volume holding `dir`. */
export type FreeBytesProbe = (dir: string) => Promise<number>;

export const statfsFreeBytes: FreeBytesProbe = async (dir) => {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
};

const BYTES_PER_GB = 1024 ** 3;

export function minFreeBytesFor(gb: number): number {
  return Math.max(0, Math.round(gb * BYTES_PER_GB));
}

/**
 * Whether the volume is below the floor. An unreadable volume (statfs
 * failing) is NOT treated as full: refusing every sync over a probe error
 * would be an outage of its own, and the write itself still fails loudly.
 */
export async function isBelowDiskFloor(
  dir: string,
  minFreeBytes: number,
  probe: FreeBytesProbe = statfsFreeBytes,
): Promise<boolean> {
  if (minFreeBytes <= 0) {
    return false;
  }
  try {
    return (await probe(dir)) < minFreeBytes;
  } catch {
    return false;
  }
}

/** Growth since start of every sync in flight, per owner. Process-wide by design. */
const inFlight = new Map<number, Map<symbol, number>>();

/** Test helper: how many syncs of `ownerId` the registry is tracking. */
export function inFlightSyncCount(ownerId: number): number {
  return inFlight.get(ownerId)?.size ?? 0;
}

export interface DiskWatchOptions {
  db: Db;
  ownerUserId: number | null;
  /** The repo's backup directory (may not exist yet). */
  dir: string;
  /** Where free space is measured: the backups volume. */
  backupsDir: string;
  minFreeBytes: number;
  pollMs?: number;
  freeBytes?: FreeBytesProbe;
  sizeOf?: (dir: string) => Promise<number>;
}

export interface DiskWatch {
  signal: AbortSignal;
  /** Stop polling and forget this sync's growth. Idempotent. */
  stop(): void;
  /** Run one check now (the timer calls this). Exposed for tests. */
  check(): Promise<void>;
}

export async function startDiskWatch(options: DiskWatchOptions): Promise<DiskWatch> {
  const controller = new AbortController();
  const sizeOf = options.sizeOf ?? directorySizeBytes;
  const probe = options.freeBytes ?? statfsFreeBytes;
  const owner = options.ownerUserId === null ? undefined : getUser(options.db, options.ownerUserId);
  const capped = owner !== undefined && userCapBytes(options.db, owner) !== null;
  const startSize = existsSync(options.dir) ? await sizeOf(options.dir).catch(() => 0) : 0;
  const token = Symbol("sync");
  if (capped && owner !== undefined) {
    let syncs = inFlight.get(owner.id);
    if (syncs === undefined) {
      syncs = new Map();
      inFlight.set(owner.id, syncs);
    }
    syncs.set(token, 0);
  }

  let busy = false;
  let stopped = false;
  const abort = (reason: DiskStopReason): void => {
    if (!controller.signal.aborted) {
      controller.abort(new DiskBudgetError(reason));
    }
  };

  const check = async (): Promise<void> => {
    if (busy || stopped || controller.signal.aborted) {
      return;
    }
    busy = true;
    try {
      if (await isBelowDiskFloor(options.backupsDir, options.minFreeBytes, probe)) {
        abort("disk_floor");
        return;
      }
      if (!capped || owner === undefined) {
        return;
      }
      const size = existsSync(options.dir) ? await sizeOf(options.dir).catch(() => startSize) : 0;
      const syncs = inFlight.get(owner.id);
      if (syncs === undefined || !syncs.has(token)) {
        return;
      }
      syncs.set(token, Math.max(0, size - startSize));
      // Re-read every time: the cap can be raised and other syncs can finish
      // (moving their growth into recorded usage) while this one runs.
      const fresh = getUser(options.db, owner.id);
      const capBytes = fresh === undefined ? null : userCapBytes(options.db, fresh);
      if (capBytes === null) {
        return;
      }
      const budget = capBytes * CAP_CEILING_FACTOR - userUsageBytes(options.db, owner.id);
      let growth = 0;
      for (const bytes of syncs.values()) {
        growth += bytes;
      }
      if (growth > budget) {
        abort("storage_cap");
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    void check();
  }, options.pollMs ?? DEFAULT_DISK_POLL_MS);
  timer.unref?.();

  return {
    signal: controller.signal,
    check,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (owner !== undefined) {
        const syncs = inFlight.get(owner.id);
        syncs?.delete(token);
        if (syncs?.size === 0) {
          inFlight.delete(owner.id);
        }
      }
    },
  };
}

/**
 * Remove what a killed fetch leaves behind: git's temporary packs
 * (`objects/pack/tmp_*`, `objects/incoming-*` quarantines) and git-lfs's
 * partial downloads (`lfs/tmp`, `lfs/incomplete`). Complete objects and refs
 * are left alone, so the backup that existed before the sync is untouched.
 * Works for both layouts (bare, and a working tree's `.git`).
 */
export async function cleanupPartialFetch(dir: string): Promise<void> {
  for (const gitDir of [dir, join(dir, ".git")]) {
    const objects = join(gitDir, "objects");
    if (!existsSync(objects)) {
      continue;
    }
    const removals: string[] = [];
    for (const name of await readdir(objects).catch(() => [] as string[])) {
      if (name.startsWith("incoming-")) {
        removals.push(join(objects, name));
      }
    }
    const pack = join(objects, "pack");
    for (const name of await readdir(pack).catch(() => [] as string[])) {
      if (name.startsWith("tmp_")) {
        removals.push(join(pack, name));
      }
    }
    for (const name of ["tmp", "incomplete"]) {
      removals.push(join(gitDir, "lfs", name));
    }
    await Promise.all(removals.map((path) => rm(path, { recursive: true, force: true })));
  }
}
