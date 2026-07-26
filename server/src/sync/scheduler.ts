import { notImplemented } from "../notImplemented.ts";

export interface SchedulerStatus {
  queueDepth: number;
  activeSyncs: number;
  breakerOpen: boolean;
}

/**
 * Persistent schedule driven by repos.next_sync_at, an in-memory min-heap, a
 * worker pool capped by max_concurrent_syncs, a per-forge cap, exponential
 * backoff with full jitter, and a cross-forge network circuit breaker.
 */
export class Scheduler {
  start(): Promise<void> {
    return notImplemented("Scheduler.start");
  }

  stop(): Promise<void> {
    return notImplemented("Scheduler.stop");
  }

  /** Manual sync: jumps the queue. */
  enqueueNow(_repoId: number): void {
    notImplemented("Scheduler.enqueueNow");
  }

  status(): SchedulerStatus {
    return notImplemented("Scheduler.status");
  }
}

/** delay = min(interval, 60s * 2^failures) * rand(0.5..1.5) */
export function backoffDelayMs(_consecutiveFailures: number, _intervalMs: number): number {
  return notImplemented("backoffDelayMs");
}
