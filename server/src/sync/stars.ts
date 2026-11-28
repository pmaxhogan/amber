import type { ForgeKind } from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { STARS_ANONYMOUS_RESERVE } from "../providers/forks.ts";
import { DEFAULT_TIMEOUT_MS } from "../providers/http.ts";
import type { RepoInfo } from "../providers/types.ts";

/**
 * Star counts (docs/ARCHITECTURE.md "Star counts"). After a SUCCESSFUL sync of
 * a GitHub repo, the repo is looked up once through providers/forks.ts
 * lookupRepoInfo, the same single-repository GET the visibility pass and the
 * first-clone gate use, so the admin-only rule for unrestricted forges, the
 * egress guard, the per-credential cooldowns, the anonymous budget and the
 * credential rule all apply unchanged. That lookup also writes the visibility
 * answer, so it doubles as a visibility refresh.
 *
 * Purely additive: a lookup that answers nothing (rate limited, cooling down,
 * budget spent, forge error, timeout) records nothing, never overwrites a
 * known count with null, and never changes the outcome of the sync.
 */

/**
 * Asks the forge about one repo, only while it still has `options.path`, and
 * anonymously only while more than `options.anonymousReserve` of the hour's
 * anonymous lookups are unspent.
 * Injectable like the scheduler's first-clone lookup so tests never reach a
 * forge; null means nothing could be learned.
 */
export type RepoInfoLookup = (
  db: Db,
  repoId: number,
  options?: { path?: string; anonymousReserve?: number },
) => Promise<RepoInfo | null>;

export interface RecordStarsInput {
  db: Db;
  repoId: number;
  runId: number;
  /** The path the sync fetched: both writes are guarded on it. */
  fetchedPath: string;
  forgeKind: ForgeKind;
  lookup: RepoInfoLookup;
  now: () => number;
  log: Logger;
  /** How long the sync waits for the answer. Defaults to the provider's own timeout. */
  timeoutMs?: number;
}

/** Resolves null once `ms` pass, so a slow forge cannot hold a worker slot past it. */
function withCeiling<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
    timer.unref();
  });
  return Promise.race([work, ceiling]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Look the repo up and record its star count on the repo row and on the run.
 * Returns the count written, or null when nothing was. Never throws.
 */
export async function recordStars(input: RecordStarsInput): Promise<number | null> {
  // GitHub only, per the feature: no other provider maps a star count, and a
  // lookup that cannot yield one would spend rate limit for nothing.
  if (input.forgeKind !== "github") {
    return null;
  }
  let info: RepoInfo | null;
  try {
    info = await withCeiling(
      // Stars are a nicety: they never take the anonymous budget below half,
      // which stays for the visibility pass and the first-clone gate.
      input.lookup(input.db, input.repoId, {
        path: input.fetchedPath,
        anonymousReserve: STARS_ANONYMOUS_RESERVE,
      }),
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch (cause) {
    // A missing secret key or a corrupt stored credential: not an answer.
    input.log.debug(
      { repoId: input.repoId, err: cause instanceof Error ? cause.message : String(cause) },
      "could not look up the star count",
    );
    return null;
  }
  const stars = info?.stars ?? null;
  if (stars === null) {
    return null;
  }
  const at = input.now();
  return input.db.tx(() => {
    // Guarded on the fetched path like every other post-fetch writer: a rename
    // that landed during the lookup names a different upstream, which must not
    // inherit this count, and the run then records none either.
    const written = input.db.run(
      "UPDATE repos SET stars = ?, stars_checked_at = ? WHERE id = ? AND path = ?",
      stars,
      at,
      input.repoId,
      input.fetchedPath,
    );
    if (written.changes === 0) {
      return null;
    }
    input.db.run(
      "UPDATE sync_runs SET stars = ? WHERE id = ? AND repo_id = ?",
      stars,
      input.runId,
      input.repoId,
    );
    return stars;
  });
}
