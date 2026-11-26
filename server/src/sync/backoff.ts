/**
 * Scheduling arithmetic shared by syncRepo (which persists the next attempt)
 * and the scheduler (which consumes it). Lives apart from both so neither has
 * to import the other.
 */

export const BACKOFF_BASE_MS = 60_000;
/** Rate limited forges get twice the delay of an ordinary failure. */
export const RATE_LIMIT_BACKOFF_FACTOR = 2;
/** Scheduled syncs are spread by +-10% so a fleet never syncs in lockstep. */
export const JITTER_FRACTION = 0.1;

function clampExponent(consecutiveFailures: number): number {
  // 2^30 * 60s already dwarfs any interval; keep the shift out of Infinity.
  return Math.min(Math.max(Math.trunc(consecutiveFailures), 0), 30);
}

/**
 * delay = min(interval, 60s * 2^failures) * rand(0.5..1.5)
 *
 * Persisted via repos.next_sync_at, so backoff state survives a restart.
 */
export function backoffDelayMs(
  consecutiveFailures: number,
  intervalMs: number,
  random: () => number = Math.random,
): number {
  const exponential = BACKOFF_BASE_MS * 2 ** clampExponent(consecutiveFailures);
  const capped = Math.min(Math.max(intervalMs, 0), exponential);
  return Math.max(1, Math.round(capped * (0.5 + random())));
}

/** interval +-10%, the ordinary success path. */
export function jitteredIntervalMs(intervalMs: number, random: () => number = Math.random): number {
  const spread = intervalMs * JITTER_FRACTION;
  return Math.max(1, Math.round(intervalMs - spread + random() * spread * 2));
}

/** A freshly gone repository is looked at again at least this often. */
export const GONE_RECHECK_MS = 60 * 60_000;
/** How long after going gone a repository keeps that closer watch. */
export const GONE_RECHECK_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * The ceiling a failing repository's backoff is capped at.
 *
 * Normally that is its own sync interval. A repository that went gone in the
 * last week is checked at least hourly instead: forges bring repositories
 * back, and one that is reachable again must not sit on the Removed page until
 * a three hour interval comes round. After a week it is as gone as it will
 * get, and it returns to its interval.
 */
export function goneRecheckCapMs(intervalMs: number, goneAt: number | null, now: number): number {
  if (goneAt === null || now - goneAt >= GONE_RECHECK_WINDOW_MS) {
    return intervalMs;
  }
  return Math.min(intervalMs, GONE_RECHECK_MS);
}
