import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedSettings, SyncErrorKind, SyncRun } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { backoffDelayMs, BACKOFF_BASE_MS, jitteredIntervalMs } from "../src/sync/backoff.ts";
import { setNextSyncAt } from "../src/sync/repoStore.ts";
import {
  BREAKER_BASE_PAUSE_MS,
  BREAKER_FAILURE_THRESHOLD,
  Scheduler,
  type SchedulerOptions,
} from "../src/sync/scheduler.ts";
import { syncRepo, type SyncRepoDeps } from "../src/sync/syncRepo.ts";
import {
  createOrigin,
  createTestDb,
  fixedSettings,
  insertForge,
  insertRepo,
  silentLog,
  tempDir,
} from "./helpers/gitFixtures.ts";

let root: string;
let db: Db;
let clock: number;
let started: number[];
let schedulers: Scheduler[];

/** Deterministic "random" so jitter never makes an assertion flaky. */
const noJitter = (): number => 0.5;

function makeRun(repoId: number, errorKind: SyncErrorKind | null = null): SyncRun {
  return {
    id: 1,
    repoId,
    startedAt: clock,
    finishedAt: clock,
    outcome: errorKind === null ? "success" : "error",
    error: errorKind === null ? null : "boom",
    errorKind,
    bytesFetched: null,
    durationMs: 0,
    refsChanged: null,
    paranoidArchived: null,
  };
}

interface FakeSyncOptions {
  outcomeFor?: (repoId: number, attempt: number) => SyncErrorKind | null;
  hold?: Map<number, () => void>;
  intervalMs?: number;
}

/**
 * A stand-in for syncRepo that records dispatches and advances next_sync_at the
 * way a real run would, so the scheduler's own logic is what is under test.
 */
function fakeSync(options: FakeSyncOptions = {}): (deps: SyncRepoDeps) => Promise<SyncRun> {
  const attempts = new Map<number, number>();
  return async (deps) => {
    const attempt = (attempts.get(deps.repoId) ?? 0) + 1;
    attempts.set(deps.repoId, attempt);
    started.push(deps.repoId);
    if (options.hold !== undefined) {
      await new Promise<void>((release) => {
        options.hold?.set(deps.repoId, release);
      });
    }
    setNextSyncAt(db, deps.repoId, clock + (options.intervalMs ?? 3_600_000), clock);
    return makeRun(deps.repoId, options.outcomeFor?.(deps.repoId, attempt) ?? null);
  };
}

function makeScheduler(overrides: Partial<SchedulerOptions> = {}): Scheduler {
  const scheduler = new Scheduler({
    db,
    backupsDir: join(root, "backups"),
    stateDir: join(root, "state"),
    logger: silentLog,
    now: () => clock,
    random: noJitter,
    staggerStepMs: 0,
    refreshIntervalMs: 3_600_000,
    settings: fixedSettings(),
    globalSettings: () => fixedSettings()(db, 0),
    runSync: fakeSync(),
    shutdownGraceMs: 50,
    ...overrides,
  });
  schedulers.push(scheduler);
  return scheduler;
}

function globals(overrides: Partial<ResolvedSettings>): (database: Db) => ResolvedSettings {
  const resolver = fixedSettings(overrides);
  return (database) => resolver(database, 0);
}

beforeEach(() => {
  root = tempDir("scheduler");
  db = createTestDb(root);
  // Ahead of the wall clock the fixtures stamp rows with, so a freshly
  // inserted repo is already due.
  clock = Date.now() + 60_000;
  started = [];
  schedulers = [];
});

afterEach(async () => {
  for (const scheduler of schedulers) {
    await scheduler.stop();
  }
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("backoff", () => {
  it("grows exponentially and is capped by the sync interval", () => {
    const interval = 180 * 60_000;
    expect(backoffDelayMs(0, interval, () => 0.5)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(1, interval, () => 0.5)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(4, interval, () => 0.5)).toBe(BACKOFF_BASE_MS * 16);
    // 60s * 2^10 is far past the interval, so the interval wins.
    expect(backoffDelayMs(10, interval, () => 0.5)).toBe(interval);
    expect(backoffDelayMs(64, interval, () => 0.5)).toBe(interval);
  });

  it("applies full jitter between half and one and a half of the delay", () => {
    const interval = 180 * 60_000;
    expect(backoffDelayMs(3, interval, () => 0)).toBe(BACKOFF_BASE_MS * 8 * 0.5);
    expect(backoffDelayMs(3, interval, () => 1)).toBe(BACKOFF_BASE_MS * 8 * 1.5);
    for (let i = 0; i < 50; i += 1) {
      const delay = backoffDelayMs(2, interval);
      expect(delay).toBeGreaterThanOrEqual(BACKOFF_BASE_MS * 4 * 0.5);
      expect(delay).toBeLessThanOrEqual(BACKOFF_BASE_MS * 4 * 1.5);
    }
  });

  it("jitters the ordinary interval by ten percent", () => {
    const interval = 100_000;
    expect(jitteredIntervalMs(interval, () => 0)).toBe(90_000);
    expect(jitteredIntervalMs(interval, () => 0.5)).toBe(100_000);
    expect(jitteredIntervalMs(interval, () => 1)).toBe(110_000);
  });
});

describe("startup catch-up", () => {
  it("queues every overdue repo exactly once", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const ids = [1, 2, 3].map((n) => insertRepo(db, { forgeId, path: `acme/repo-${String(n)}` }));
    for (const id of ids) {
      // Two days overdue: the outage produces one catch-up fetch, not one per
      // missed interval.
      setNextSyncAt(db, id, clock - 2 * 24 * 60 * 60 * 1000, clock);
    }

    const scheduler = makeScheduler();
    await scheduler.start();
    await Promise.resolve();
    scheduler.tick();
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 10));

    expect([...started].sort()).toEqual([...ids].sort());
    expect(scheduler.status().queueDepth).toBe(0);
  });

  it("never dispatches a repo that is already running", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const repoId = insertRepo(db, { forgeId, path: "acme/slow" });
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({ runSync: fakeSync({ hold }) });

    await scheduler.start();
    await Promise.resolve();
    expect(scheduler.status().activeSyncs).toBe(1);

    scheduler.tick();
    scheduler.tick();
    expect(started).toEqual([repoId]);

    hold.get(repoId)?.();
    await new Promise((done) => setTimeout(done, 10));
    expect(started).toEqual([repoId]);
  });

  it("staggers the first syncs of a large batch", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    for (let i = 0; i < 3; i += 1) {
      insertRepo(db, { forgeId, path: `acme/batch-${String(i)}` });
    }

    const scheduler = makeScheduler({ staggerStepMs: 1000, staggerWindowMs: 60_000 });
    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toHaveLength(1);

    clock += 1000;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toHaveLength(2);

    clock += 1000;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toHaveLength(3);
  });

  it("leaves repos that are not due yet alone", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const repoId = insertRepo(db, { forgeId, path: "acme/later" });
    setNextSyncAt(db, repoId, clock + 60_000, clock);

    const scheduler = makeScheduler();
    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toEqual([]);

    clock += 60_000;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toEqual([repoId]);
  });

  it("skips paused repos entirely", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    insertRepo(db, { forgeId, path: "acme/paused", state: "paused" });
    const scheduler = makeScheduler();
    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toEqual([]);
  });

  it("pushes a repo forward instead of spinning when syncing is disabled", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const repoId = insertRepo(db, { forgeId, path: "acme/disabled" });
    const scheduler = makeScheduler({ settings: fixedSettings({ sync_enabled: false }) });

    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));

    expect(started).toEqual([]);
    const next = db.get<{ next_sync_at: number }>(
      "SELECT next_sync_at FROM repos WHERE id = ?",
      repoId,
    );
    expect(next?.next_sync_at).toBeGreaterThan(clock);
  });
});

describe("concurrency caps", () => {
  it("never exceeds max_concurrent_syncs", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    for (let i = 0; i < 6; i += 1) {
      insertRepo(db, { forgeId, path: `acme/wide-${String(i)}` });
    }
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      runSync: fakeSync({ hold }),
      globalSettings: globals({ max_concurrent_syncs: 2, max_concurrent_per_forge: 10 }),
    });

    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(scheduler.status().activeSyncs).toBe(2);
    expect(started).toHaveLength(2);

    for (const release of [...hold.values()]) {
      release();
    }
    await new Promise((done) => setTimeout(done, 20));
    expect(started.length).toBeGreaterThan(2);
  });

  it("never exceeds max_concurrent_per_forge while other forges keep moving", async () => {
    const busy = insertForge(db, { host: "busy.test" });
    const calm = insertForge(db, { host: "calm.test" });
    for (let i = 0; i < 4; i += 1) {
      insertRepo(db, { forgeId: busy, path: `busy/repo-${String(i)}` });
    }
    const calmRepo = insertRepo(db, { forgeId: calm, path: "calm/repo" });

    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      runSync: fakeSync({ hold }),
      globalSettings: globals({ max_concurrent_syncs: 8, max_concurrent_per_forge: 2 }),
    });

    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));

    expect(started).toHaveLength(3);
    expect(started).toContain(calmRepo);
    expect(scheduler.status().queueDepth).toBe(2);
  });
});

describe("sync now", () => {
  it("jumps the queue ahead of everything else", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const queued = [1, 2, 3].map((n) => insertRepo(db, { forgeId, path: `acme/q-${String(n)}` }));
    const urgent = insertRepo(db, { forgeId, path: "acme/urgent" });
    setNextSyncAt(db, urgent, clock + 60 * 60_000, clock);

    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      runSync: fakeSync({ hold }),
      globalSettings: globals({ max_concurrent_syncs: 1, max_concurrent_per_forge: 1 }),
    });
    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toHaveLength(1);

    scheduler.enqueueNow(urgent);
    const first = started[0];
    hold.get(first ?? 0)?.();
    await new Promise((done) => setTimeout(done, 10));

    expect(started[1]).toBe(urgent);
    expect(queued).toContain(first);
  });

  it("promotes a repo that is already waiting in the queue", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const first = insertRepo(db, { forgeId, path: "acme/first" });
    insertRepo(db, { forgeId, path: "acme/second" });
    const last = insertRepo(db, { forgeId, path: "acme/last" });

    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      runSync: fakeSync({ hold }),
      globalSettings: globals({ max_concurrent_syncs: 1, max_concurrent_per_forge: 1 }),
    });
    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toEqual([first]);
    expect(scheduler.status().queueDepth).toBe(2);

    // Already queued, but behind another repo. Sync now must still mean now.
    scheduler.enqueueNow(last);
    hold.get(first)?.();
    await new Promise((done) => setTimeout(done, 10));

    expect(started[1]).toBe(last);
  });

  it("ignores a manual sync for a repo that is already running or gone", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const repoId = insertRepo(db, { forgeId, path: "acme/one" });
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      runSync: fakeSync({ hold }),
      globalSettings: globals({ max_concurrent_syncs: 1, max_concurrent_per_forge: 1 }),
    });
    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));

    scheduler.enqueueNow(repoId);
    scheduler.enqueueNow(999);
    expect(scheduler.status().queueDepth).toBe(0);
    expect(started).toEqual([repoId]);
  });

  it("runs a manual sync even when scheduled syncing is disabled", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const repoId = insertRepo(db, { forgeId, path: "acme/manual" });
    setNextSyncAt(db, repoId, clock + 60 * 60_000, clock);
    const scheduler = makeScheduler({ settings: fixedSettings({ sync_enabled: false }) });
    await scheduler.start();

    scheduler.enqueueNow(repoId);
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toEqual([repoId]);
  });
});

describe("network circuit breaker", () => {
  async function tripBreaker(scheduler: Scheduler, repos: number[]): Promise<void> {
    await scheduler.start();
    for (let i = 0; i < repos.length; i += 1) {
      clock += 1000;
      scheduler.tick();
      await new Promise((done) => setTimeout(done, 5));
    }
  }

  it("opens after five network failures spread across forges", async () => {
    const forgeA = insertForge(db, { host: "a.test" });
    const forgeB = insertForge(db, { host: "b.test" });
    const repos = [
      insertRepo(db, { forgeId: forgeA, path: "a/one" }),
      insertRepo(db, { forgeId: forgeB, path: "b/one" }),
      insertRepo(db, { forgeId: forgeA, path: "a/two" }),
      insertRepo(db, { forgeId: forgeB, path: "b/two" }),
      insertRepo(db, { forgeId: forgeA, path: "a/three" }),
      insertRepo(db, { forgeId: forgeB, path: "b/three" }),
    ];
    const scheduler = makeScheduler({
      runSync: fakeSync({ outcomeFor: () => "network", intervalMs: 1000 }),
      // One at a time, so the breaker sees each outcome before the next repo is
      // dispatched and the threshold is observable exactly.
      globalSettings: globals({ max_concurrent_syncs: 1, max_concurrent_per_forge: 1 }),
    });

    await tripBreaker(scheduler, repos);

    expect(scheduler.status().breakerOpen).toBe(true);
    expect(started.length).toBe(BREAKER_FAILURE_THRESHOLD);

    // Nothing moves while the breaker is open.
    clock += 1000;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started.length).toBe(BREAKER_FAILURE_THRESHOLD);
  });

  it("probes with a single sync once the pause elapses and doubles on failure", async () => {
    const forgeA = insertForge(db, { host: "a.test" });
    const forgeB = insertForge(db, { host: "b.test" });
    for (let i = 0; i < 4; i += 1) {
      insertRepo(db, { forgeId: i % 2 === 0 ? forgeA : forgeB, path: `x/repo-${String(i)}` });
      insertRepo(db, { forgeId: i % 2 === 0 ? forgeB : forgeA, path: `y/repo-${String(i)}` });
    }
    const scheduler = makeScheduler({
      runSync: fakeSync({ outcomeFor: () => "network", intervalMs: 500 }),
    });
    await scheduler.start();
    for (let i = 0; i < 8; i += 1) {
      clock += 500;
      scheduler.tick();
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(scheduler.status().breakerOpen).toBe(true);
    const beforeProbe = started.length;

    clock += BREAKER_BASE_PAUSE_MS;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    // Exactly one probe, and it failed, so the breaker is open again for twice
    // as long.
    expect(started.length).toBe(beforeProbe + 1);
    expect(scheduler.status().breakerOpen).toBe(true);

    clock += BREAKER_BASE_PAUSE_MS;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started.length).toBe(beforeProbe + 1);

    clock += BREAKER_BASE_PAUSE_MS;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started.length).toBe(beforeProbe + 2);
  });

  it("closes as soon as a sync succeeds", async () => {
    const forgeA = insertForge(db, { host: "a.test" });
    const forgeB = insertForge(db, { host: "b.test" });
    for (let i = 0; i < 6; i += 1) {
      insertRepo(db, { forgeId: i % 2 === 0 ? forgeA : forgeB, path: `z/repo-${String(i)}` });
    }
    let healed = false;
    const scheduler = makeScheduler({
      runSync: fakeSync({ outcomeFor: () => (healed ? null : "network"), intervalMs: 500 }),
    });
    await scheduler.start();
    for (let i = 0; i < 6; i += 1) {
      clock += 500;
      scheduler.tick();
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(scheduler.status().breakerOpen).toBe(true);

    healed = true;
    clock += BREAKER_BASE_PAUSE_MS;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(scheduler.status().breakerOpen).toBe(false);

    const afterProbe = started.length;
    clock += 500;
    scheduler.tick();
    await new Promise((done) => setTimeout(done, 5));
    expect(started.length).toBeGreaterThan(afterProbe);
  });

  it("does not open for failures that are not network related", async () => {
    const forgeA = insertForge(db, { host: "a.test" });
    const forgeB = insertForge(db, { host: "b.test" });
    for (let i = 0; i < 6; i += 1) {
      insertRepo(db, { forgeId: i % 2 === 0 ? forgeA : forgeB, path: `n/repo-${String(i)}` });
    }
    const scheduler = makeScheduler({
      runSync: fakeSync({ outcomeFor: () => "not_found", intervalMs: 500 }),
    });
    await scheduler.start();
    for (let i = 0; i < 6; i += 1) {
      clock += 500;
      scheduler.tick();
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(scheduler.status().breakerOpen).toBe(false);
    expect(started.length).toBeGreaterThanOrEqual(6);
  });
});

describe("persistence across a restart", () => {
  it("resumes the backoff a previous process persisted", async () => {
    const root2 = tempDir("restart");
    try {
      const forgeId = insertForge(db, { host: "a.test" });
      const repoId = insertRepo(db, { forgeId, path: "acme/broken" });
      const origin = await createOrigin(join(root2, "origin"));
      await origin.commitFile("a.txt", "a\n", "one");

      // A real failing sync writes the backoff into next_sync_at.
      const run = await syncRepo({
        repoId,
        db,
        backupsDir: join(root2, "backups"),
        stateDir: join(root2, "state"),
        logger: silentLog,
        settings: fixedSettings(),
        credentials: () => undefined,
        remoteUrl: `${origin.url}-gone`,
        allowFileProtocol: true,
      });
      expect(run.outcome).toBe("error");

      const persisted = db.get<{ next_sync_at: number; consecutive_failures: number }>(
        "SELECT next_sync_at, consecutive_failures FROM repos WHERE id = ?",
        repoId,
      );
      expect(persisted?.consecutive_failures).toBe(1);
      expect(persisted?.next_sync_at).toBeGreaterThan(Date.now());

      // A fresh process starts a fresh scheduler; the row is still backing off.
      clock = Date.now();
      const scheduler = makeScheduler();
      await scheduler.start();
      await new Promise((done) => setTimeout(done, 5));
      expect(started).toEqual([]);

      clock = (persisted?.next_sync_at ?? 0) + 1;
      scheduler.tick();
      await new Promise((done) => setTimeout(done, 5));
      expect(started).toEqual([repoId]);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe("graceful shutdown", () => {
  it("stops dequeuing and waits for the run in flight", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const first = insertRepo(db, { forgeId, path: "acme/first" });
    insertRepo(db, { forgeId, path: "acme/second" });
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      runSync: fakeSync({ hold }),
      globalSettings: globals({ max_concurrent_syncs: 1, max_concurrent_per_forge: 1 }),
      shutdownGraceMs: 5000,
    });

    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(started).toEqual([first]);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await new Promise((done) => setTimeout(done, 10));
    expect(stopped).toBe(false);

    hold.get(first)?.();
    await stopping;
    expect(stopped).toBe(true);
    // The queued repo was never picked up after the stop.
    expect(started).toEqual([first]);
  });

  it("gives up waiting after the grace period", async () => {
    const forgeId = insertForge(db, { host: "a.test" });
    const repoId = insertRepo(db, { forgeId, path: "acme/stuck" });
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({ runSync: fakeSync({ hold }), shutdownGraceMs: 20 });

    await scheduler.start();
    await new Promise((done) => setTimeout(done, 5));
    await scheduler.stop();
    expect(scheduler.status().activeSyncs).toBe(1);
    hold.get(repoId)?.();
  });
});
