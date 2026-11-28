import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AmberEvent, PushPayload, SyncRun } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.ts";
import {
  CAP_REACHED_ERROR,
  CAP_WOULD_NOT_FIT_ERROR,
  firstCloneFacts,
  markFirstCloneRefused,
  refreshCapState,
  remainingAllowanceBytes,
} from "../../src/domain/caps.ts";
import {
  ALREADY_BACKED_UP_MESSAGE,
  commitImport,
  STORAGE_CAP_MESSAGE,
} from "../../src/domain/importer.ts";
import { createRepo } from "../../src/domain/repos.ts";
import { putScopeSettings } from "../../src/domain/settings.ts";
import {
  getUser,
  isAtOrOverCap,
  updateUser,
  userCapBytes,
  userUsageBytes,
  type User,
} from "../../src/domain/users.ts";
import { EventBus, type EventMeta } from "../../src/events.ts";
import {
  createPushNotifier,
  savePushSubscription,
  type PushSender,
} from "../../src/notify/push.ts";
import { runAccountSyncDetailed } from "../../src/providers/discovery.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
  RepoInfo,
} from "../../src/providers/types.ts";
import { setNextSyncAt } from "../../src/sync/repoStore.ts";
import {
  BREAKER_FAILURE_THRESHOLD,
  Scheduler,
  type SchedulerOptions,
} from "../../src/sync/scheduler.ts";
import { syncRepo, type SyncEventPublisher, type SyncRepoDeps } from "../../src/sync/syncRepo.ts";
import { createTempApp, createTempDb, seedForge, type TempApp, type TempDb } from "../helpers.ts";
import { asUser } from "../helpers/accessFixtures.ts";
import {
  createOrigin,
  fixedSettings,
  silentLog,
  tempDir,
  type OriginRepo,
} from "../helpers/gitFixtures.ts";
import { adminOf, makeUser } from "../helpers/users.ts";

/**
 * Storage caps beyond "refuse a new repository at or over the cap" (docs/
 * ARCHITECTURE.md, Multi-user access control, Storage caps): the under to
 * at-or-over transition and its one-time notification, the importer and
 * account sync refusals, the first-clone gate and one-at-a-time rule in the
 * scheduler, and the delete routes that clear the flag again.
 */

const GB = 1024 ** 3;
const CAP = 1000;
const FOREVER = 100_000_000_000_000;

let counter = 0;

/** A fresh non-admin with a cap (null: the global default applies). */
function userWithCap(db: Db, capBytes: number | null = CAP): User {
  counter += 1;
  return makeUser(db, `user${String(counter)}@example.com`, {}, { capBytes });
}

interface RepoSeed {
  /** disk_usage_bytes; null leaves it unknown, like a repo that never synced. */
  usage?: number | null;
  /** The repo has synced successfully before: its next run is not a first clone. */
  synced?: boolean;
  nextSyncAt?: number;
}

function addRepo(db: Db, forgeId: number, owner: User, seed: RepoSeed = {}): number {
  counter += 1;
  const repo = createRepo(db, {
    forgeId,
    path: `acme/repo-${String(counter)}`,
    ownerUserId: owner.id,
  });
  db.run(
    "UPDATE repos SET disk_usage_bytes = ?, last_success_at = ? WHERE id = ?",
    seed.usage ?? null,
    seed.synced === true ? 1 : null,
    repo.id,
  );
  if (seed.nextSyncAt !== undefined) {
    setNextSyncAt(db, repo.id, seed.nextSyncAt, 0);
  }
  return repo.id;
}

function setUsage(db: Db, repoId: number, usage: number): void {
  db.run("UPDATE repos SET disk_usage_bytes = ? WHERE id = ?", usage, repoId);
}

function repoRow(
  db: Db,
  repoId: number,
): {
  last_error: string | null;
  next_sync_at: number | null;
  consecutive_failures: number;
} {
  const row = db.get<{
    last_error: string | null;
    next_sync_at: number | null;
    consecutive_failures: number;
  }>("SELECT last_error, next_sync_at, consecutive_failures FROM repos WHERE id = ?", repoId);
  if (row === undefined) {
    throw new Error(`no repo ${String(repoId)}`);
  }
  return row;
}

function capNotifiedAt(db: Db, user: User): number | null {
  return getUser(db, user.id)?.capNotifiedAt ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Long enough for anything that is going to happen to have happened. */
function settle(): Promise<void> {
  return sleep(40);
}

// ---------------------------------------------------------------------------
// Domain: usage, cap and the transition
// ---------------------------------------------------------------------------

describe("usage and cap", () => {
  let temp: TempDb;
  let db: Db;
  let forgeId: number;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    forgeId = seedForge(db);
  });

  afterEach(() => {
    temp.close();
  });

  it("sums only the repos the user owns, counting unknown sizes as zero", () => {
    const alice = userWithCap(db);
    const bob = userWithCap(db);
    addRepo(db, forgeId, alice, { usage: 300 });
    addRepo(db, forgeId, alice, { usage: null });
    addRepo(db, forgeId, alice, { usage: 200 });
    addRepo(db, forgeId, bob, { usage: 7777 });
    addRepo(db, forgeId, adminOf(db), { usage: 9999 });

    expect(userUsageBytes(db, alice.id)).toBe(500);
    expect(userUsageBytes(db, bob.id)).toBe(7777);
    expect(userUsageBytes(db, makeUser(db, "nobody@example.com").id)).toBe(0);
  });

  it("takes the user's own cap, else the global default, and never caps the admin", () => {
    putScopeSettings(db, "global", null, { default_user_storage_cap_gb: 2 });
    const own = userWithCap(db, 123);
    const inherits = userWithCap(db, null);

    expect(userCapBytes(db, own)).toBe(123);
    expect(userCapBytes(db, inherits)).toBe(2 * GB);
    expect(userCapBytes(db, adminOf(db))).toBeNull();
  });

  it.each([
    { name: "no usage under a real cap", cap: 1000, usage: 0, over: false },
    { name: "one byte under", cap: 1000, usage: 999, over: false },
    { name: "exactly at the cap", cap: 1000, usage: 1000, over: true },
    { name: "over the cap", cap: 1000, usage: 1001, over: true },
    { name: "a zero cap with no repos at all", cap: 0, usage: 0, over: true },
  ])("isAtOrOverCap: $name", ({ cap, usage, over }) => {
    const user = userWithCap(db, cap);
    if (usage > 0) {
      addRepo(db, forgeId, user, { usage });
    }
    expect(isAtOrOverCap(db, user)).toBe(over);
  });

  it("never reports the admin at or over a cap, however much they store", () => {
    addRepo(db, forgeId, adminOf(db), { usage: 50 * GB });
    expect(isAtOrOverCap(db, adminOf(db))).toBe(false);
  });
});

describe("refreshCapState", () => {
  let temp: TempDb;
  let db: Db;
  let forgeId: number;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    forgeId = seedForge(db);
  });

  afterEach(() => {
    temp.close();
  });

  it.each([
    { name: "no usage", usage: 0, expected: null, notified: false },
    { name: "one byte under the cap", usage: CAP - 1, expected: null, notified: false },
    { name: "exactly at the cap", usage: CAP, expected: "reached", notified: true },
    { name: "one byte over the cap", usage: CAP + 1, expected: "reached", notified: true },
    { name: "far over the cap", usage: 50 * CAP, expected: "reached", notified: true },
  ] as const)("$name returns $expected", ({ usage, expected, notified }) => {
    const user = userWithCap(db);
    if (usage > 0) {
      addRepo(db, forgeId, user, { usage });
    }

    expect(refreshCapState(db, user.id, 4242)).toBe(expected);
    expect(capNotifiedAt(db, user)).toBe(notified ? 4242 : null);
  });

  it("walks under, reached, still over, cleared, still under", () => {
    const user = userWithCap(db);
    const repoId = addRepo(db, forgeId, user, { usage: 100 });

    expect(refreshCapState(db, user.id, 1)).toBeNull();

    setUsage(db, repoId, CAP);
    expect(refreshCapState(db, user.id, 2)).toBe("reached");
    expect(capNotifiedAt(db, user)).toBe(2);

    // Idempotent: a second sync that still sees the user over the cap does
    // not announce it again and does not move the original timestamp.
    expect(refreshCapState(db, user.id, 3)).toBeNull();
    setUsage(db, repoId, CAP * 3);
    expect(refreshCapState(db, user.id, 4)).toBeNull();
    expect(capNotifiedAt(db, user)).toBe(2);

    setUsage(db, repoId, CAP - 1);
    expect(refreshCapState(db, user.id, 5)).toBe("cleared");
    expect(capNotifiedAt(db, user)).toBeNull();
    expect(refreshCapState(db, user.id, 6)).toBeNull();
  });

  it("announces a second crossing after the user dropped back under", () => {
    const user = userWithCap(db);
    const repoId = addRepo(db, forgeId, user, { usage: CAP });
    expect(refreshCapState(db, user.id, 1)).toBe("reached");
    setUsage(db, repoId, 0);
    expect(refreshCapState(db, user.id, 2)).toBe("cleared");
    setUsage(db, repoId, CAP);
    expect(refreshCapState(db, user.id, 3)).toBe("reached");
    expect(capNotifiedAt(db, user)).toBe(3);
  });

  it("is decided per cap: the user's own cap beats the global default, and a changed cap re-evaluates", () => {
    putScopeSettings(db, "global", null, { default_user_storage_cap_gb: 1 });
    const inherits = userWithCap(db, null);
    const generous = userWithCap(db, 2 * GB);
    const strict = userWithCap(db, 100);
    addRepo(db, forgeId, inherits, { usage: GB });
    addRepo(db, forgeId, generous, { usage: GB });
    addRepo(db, forgeId, strict, { usage: 100 });

    expect(refreshCapState(db, inherits.id)).toBe("reached");
    expect(refreshCapState(db, generous.id)).toBeNull();
    expect(refreshCapState(db, strict.id)).toBe("reached");

    // Raising the global default frees the user who inherits it, not the one
    // with a stricter cap of their own.
    putScopeSettings(db, "global", null, { default_user_storage_cap_gb: 5 });
    expect(refreshCapState(db, inherits.id)).toBe("cleared");
    expect(refreshCapState(db, strict.id)).toBeNull();

    // Raising a user's own cap clears them; dropping it back to the default
    // (null) is evaluated against the default.
    updateUser(db, strict.id, { storageCapBytes: 101 });
    expect(refreshCapState(db, strict.id)).toBe("cleared");
    updateUser(db, strict.id, { storageCapBytes: null });
    expect(refreshCapState(db, strict.id)).toBeNull();
  });

  it("never reaches for the admin, whatever they store", () => {
    const admin = adminOf(db);
    addRepo(db, forgeId, admin, { usage: 500 * GB });

    expect(refreshCapState(db, admin.id)).toBeNull();
    expect(capNotifiedAt(db, admin)).toBeNull();
  });

  it("answers null for a user that does not exist", () => {
    expect(refreshCapState(db, 987_654)).toBeNull();
  });
});

describe("first clone helpers", () => {
  let temp: TempDb;
  let db: Db;
  let forgeId: number;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    forgeId = seedForge(db);
  });

  afterEach(() => {
    temp.close();
  });

  it("firstCloneFacts says whether the next sync is a capped owner's first clone", () => {
    const user = userWithCap(db);
    const unsynced = addRepo(db, forgeId, user);
    const synced = addRepo(db, forgeId, user, { synced: true });
    const admins = addRepo(db, forgeId, adminOf(db));

    expect(firstCloneFacts(db, unsynced)).toMatchObject({
      firstClone: true,
      cappedOwner: { id: user.id },
    });
    expect(firstCloneFacts(db, synced)).toMatchObject({
      firstClone: false,
      cappedOwner: { id: user.id },
    });
    // The admin is uncapped, so there is no capped owner to gate.
    expect(firstCloneFacts(db, admins)).toEqual({ firstClone: true, cappedOwner: null });
    expect(firstCloneFacts(db, 987_654)).toEqual({ firstClone: false, cappedOwner: null });
  });

  it.each([
    { name: "plenty left", cap: 1000, usage: 400, expected: 600 },
    { name: "nothing left", cap: 1000, usage: 1000, expected: 0 },
    { name: "never negative when over", cap: 1000, usage: 1700, expected: 0 },
  ])("remainingAllowanceBytes: $name", ({ cap, usage, expected }) => {
    const user = userWithCap(db, cap);
    addRepo(db, forgeId, user, { usage });
    expect(remainingAllowanceBytes(db, user)).toBe(expected);
  });

  it("remainingAllowanceBytes is null for the admin", () => {
    expect(remainingAllowanceBytes(db, adminOf(db))).toBeNull();
  });

  it("markFirstCloneRefused records the reason and the retry time, and nothing else", () => {
    const repoId = addRepo(db, forgeId, userWithCap(db));
    markFirstCloneRefused(db, repoId, CAP_REACHED_ERROR, 5_000, 1_000);

    expect(repoRow(db, repoId)).toEqual({
      last_error: CAP_REACHED_ERROR,
      next_sync_at: 5_000,
      consecutive_failures: 0,
    });
    // No run row: nothing was fetched, and a failure would feed the backoff.
    expect(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_runs WHERE repo_id = ?", repoId)?.n,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

describe("commitImport at the cap", () => {
  let temp: TempDb;
  let db: Db;
  let forgeId: number;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    forgeId = seedForge(db);
  });

  afterEach(() => {
    temp.close();
  });

  const repoCount = (): number => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM repos")?.n ?? 0;

  it.each([
    { name: "exactly at the cap", cap: CAP, usage: CAP, refused: true },
    { name: "over the cap", cap: CAP, usage: CAP + 500, refused: true },
    { name: "a zero cap", cap: 0, usage: 0, refused: true },
    { name: "one byte under the cap", cap: CAP, usage: CAP - 1, refused: false },
  ])("a new repository line, $name", async ({ cap, usage, refused }) => {
    const user = userWithCap(db, cap);
    if (usage > 0) {
      addRepo(db, forgeId, user, { usage });
    }
    const before = repoCount();

    const result = await commitImport(db, user, "https://github.com/acme/brand-new");

    const line = result.results[0];
    if (refused) {
      expect(result).toMatchObject({ created: 0, updated: 0, failed: 1 });
      expect(line).toMatchObject({
        action: "failed",
        status: "error",
        code: "storage_cap_reached",
        message: STORAGE_CAP_MESSAGE,
      });
      expect(repoCount()).toBe(before);
    } else {
      expect(result).toMatchObject({ created: 1, failed: 0 });
      expect(line?.code).toBeUndefined();
      expect(repoCount()).toBe(before + 1);
    }
  });

  it("keeps existing repositories importable: a re-import still says already backed up", async () => {
    const user = userWithCap(db);
    const first = await commitImport(db, user, "https://github.com/acme/kept");
    expect(first.created).toBe(1);

    addRepo(db, forgeId, user, { usage: CAP });
    expect(isAtOrOverCap(db, user)).toBe(true);

    const again = await commitImport(
      db,
      user,
      ["https://github.com/acme/kept", "https://github.com/acme/new-one"].join("\n"),
    );

    expect(again).toMatchObject({ created: 0, updated: 1, failed: 1 });
    expect(again.results[0]).toMatchObject({
      action: "updated",
      message: ALREADY_BACKED_UP_MESSAGE,
    });
    expect(again.results[0]?.code).toBeUndefined();
    expect(again.results[1]).toMatchObject({ action: "failed", code: "storage_cap_reached" });
  });

  it("never refuses the admin", async () => {
    addRepo(db, forgeId, adminOf(db), { usage: 500 * GB });
    const result = await commitImport(db, adminOf(db), "https://github.com/acme/admins-new");
    expect(result).toMatchObject({ created: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Account sync discovery
// ---------------------------------------------------------------------------

describe("account sync discovery at the cap", () => {
  let temp: TempDb;
  let db: Db;
  let forgeId: number;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    forgeId = db.run(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "https",
      "forge.example.com",
      null,
      "github",
      1,
      1,
    ).lastInsertRowid;
  });

  afterEach(() => {
    temp.close();
  });

  function discovered(path: string): DiscoveredRepo {
    return {
      path,
      defaultBranch: "main",
      isPrivate: false,
      archived: false,
      description: null,
      isFork: null,
      forkParent: null,
    };
  }

  function provider(listing: DiscoveredRepo[]): AccountSyncProvider {
    return {
      kind: "github",
      listRepos(_context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
        return (async function* () {
          await Promise.resolve();
          for (const item of listing) {
            yield item;
          }
        })();
      },
    };
  }

  /** An owned-repositories sync for `owner`, on its own anonymous account. */
  function syncFor(owner: User): number {
    const accountId = db.run(
      `INSERT INTO accounts (forge_id, username, secret_enc, is_default, owner_user_id, created_at, updated_at)
       VALUES (?, ?, NULL, 1, ?, 1, 1)`,
      forgeId,
      `octo${String(owner.id)}`,
      owner.id,
    ).lastInsertRowid;
    return db.run(
      `INSERT INTO account_syncs
         (forge_id, account_id, source, visibility, enabled, interval_minutes, next_run_at,
          owner_user_id, created_at, updated_at)
       VALUES (?, ?, 'owned', 'all', 1, 360, NULL, ?, 1, 1)`,
      forgeId,
      accountId,
      owner.id,
    ).lastInsertRowid;
  }

  function paths(owner: User): string[] {
    return db
      .all<{ path: string }>(
        "SELECT path FROM repos WHERE owner_user_id = ? ORDER BY path",
        owner.id,
      )
      .map((row) => row.path);
  }

  function run(syncId: number, listing: DiscoveredRepo[]) {
    return runAccountSyncDetailed(db, syncId, {
      log: silentLog,
      providerFor: () => provider(listing),
      random: () => 0.5,
      now: () => 5_000,
    });
  }

  it("creates nothing new at the cap but still links and refreshes the owner's existing row", async () => {
    const user = userWithCap(db);
    const existing = createRepo(db, {
      forgeId,
      path: "octo/already-mine",
      ownerUserId: user.id,
    });
    setUsage(db, existing.id, CAP);
    const syncId = syncFor(user);

    const result = await run(syncId, [
      discovered("octo/already-mine"),
      discovered("octo/new-one"),
      discovered("octo/new-two"),
    ]);

    expect(result.error).toBeNull();
    expect(result).toMatchObject({ discovered: 3, created: 0, linked: 1 });
    expect(paths(user)).toEqual(["octo/already-mine"]);
    expect(
      db.get<{ managed: number | null; seen: number | null }>(
        "SELECT managed_by_account_sync_id AS managed, last_seen_at AS seen FROM repos WHERE id = ?",
        existing.id,
      ),
    ).toEqual({ managed: syncId, seen: 5_000 });
  });

  it("creates the new repositories one byte under the cap", async () => {
    const user = userWithCap(db);
    const existing = createRepo(db, { forgeId, path: "octo/old", ownerUserId: user.id });
    setUsage(db, existing.id, CAP - 1);

    const result = await run(syncFor(user), [discovered("octo/old"), discovered("octo/fresh")]);

    expect(result).toMatchObject({ created: 1, linked: 1 });
    expect(paths(user)).toEqual(["octo/fresh", "octo/old"]);
  });

  it("resumes discovering once the owner is back under the cap", async () => {
    const user = userWithCap(db);
    const existing = createRepo(db, { forgeId, path: "octo/heavy", ownerUserId: user.id });
    setUsage(db, existing.id, CAP);
    const syncId = syncFor(user);
    const listing = [discovered("octo/heavy"), discovered("octo/later")];

    expect((await run(syncId, listing)).created).toBe(0);
    setUsage(db, existing.id, 10);
    expect((await run(syncId, listing)).created).toBe(1);
    expect(paths(user)).toEqual(["octo/heavy", "octo/later"]);
  });

  it("never skips the admin's discoveries", async () => {
    const admin = adminOf(db);
    const heavy = createRepo(db, { forgeId, path: "octo/admin-heavy", ownerUserId: admin.id });
    setUsage(db, heavy.id, 900 * GB);

    const result = await run(syncFor(admin), [discovered("octo/admin-new")]);

    expect(result.created).toBe(1);
    expect(paths(admin)).toContain("octo/admin-new");
  });
});

// ---------------------------------------------------------------------------
// Scheduler: the first-clone gate and the one-at-a-time rule
// ---------------------------------------------------------------------------

describe("scheduler first-clone gate", () => {
  let temp: TempDb;
  let db: Db;
  let root: string;
  let forgeId: number;
  let clock: number;
  let started: number[];
  let updated: number[];
  let schedulers: Scheduler[];
  let intervalMs: number;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    root = tempDir("caps-scheduler");
    forgeId = seedForge(db);
    // Ahead of the wall clock the rows are stamped with, so they are due.
    clock = Date.now() + 60_000;
    started = [];
    updated = [];
    schedulers = [];
    intervalMs = fixedSettings()(db, 0).sync_interval_minutes * 60_000;
  });

  afterEach(async () => {
    for (const scheduler of schedulers) {
      await scheduler.stop();
    }
    temp.close();
    rmSync(root, { recursive: true, force: true });
  });

  function makeRun(repoId: number): SyncRun {
    return {
      id: 1,
      repoId,
      startedAt: clock,
      finishedAt: clock,
      outcome: "success",
      error: null,
      errorKind: null,
      bytesFetched: null,
      durationMs: 0,
      refsChanged: null,
      paranoidArchived: null,
    };
  }

  interface Harness {
    repoInfo?: SchedulerOptions["repoInfo"];
    /** Runs park until the test releases them through this map. */
    hold?: Map<number, () => void>;
    /** What a finished run did to the database, in place of a real clone. */
    onRun?: (repoId: number) => void;
  }

  function makeScheduler(harness: Harness = {}): Scheduler {
    const events: SyncEventPublisher = {
      publish(type, payload = {}) {
        if (type === "repo.updated" && typeof payload["repoId"] === "number") {
          updated.push(payload["repoId"]);
        }
      },
    };
    const runSync = async (deps: SyncRepoDeps): Promise<SyncRun> => {
      started.push(deps.repoId);
      const { hold } = harness;
      if (hold !== undefined) {
        await new Promise<void>((release) => {
          hold.set(deps.repoId, release);
        });
      }
      harness.onRun?.(deps.repoId);
      setNextSyncAt(db, deps.repoId, clock + 3_600_000, clock);
      return makeRun(deps.repoId);
    };
    const scheduler = new Scheduler({
      db,
      backupsDir: join(root, "backups"),
      stateDir: join(root, "state"),
      logger: silentLog,
      now: () => clock,
      random: () => 0.5,
      staggerStepMs: 0,
      refreshIntervalMs: 3_600_000,
      settings: fixedSettings(),
      globalSettings: () =>
        fixedSettings({ max_concurrent_syncs: 20, max_concurrent_per_forge: 20 })(db, 0),
      runSync,
      shutdownGraceMs: 50,
      events,
      // Never reach a forge: the default would ask a real one.
      repoInfo: harness.repoInfo ?? (() => Promise.resolve(null)),
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  function info(sizeBytes: number | null): RepoInfo {
    return { fork: { status: "not_fork" }, isPrivate: null, sizeBytes };
  }

  /** A capped owner at their cap (via one synced repo that is not due) and a first clone. */
  function ownerAtCap(usage = CAP): { owner: User; first: number; heavy: number } {
    const owner = userWithCap(db);
    const heavy = addRepo(db, forgeId, owner, { usage, synced: true, nextSyncAt: FOREVER });
    const first = addRepo(db, forgeId, owner);
    return { owner, first, heavy };
  }

  function runCount(repoId: number): number {
    return (
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_runs WHERE repo_id = ?", repoId)?.n ?? 0
    );
  }

  it.each([
    { name: "exactly at the cap", usage: CAP },
    { name: "over the cap", usage: CAP + 777 },
  ])("refuses a first clone $name without calling the runner", async ({ usage }) => {
    const { first } = ownerAtCap(usage);
    const infoCalls: number[] = [];
    const scheduler = makeScheduler({
      repoInfo: (_db, repoId) => {
        infoCalls.push(repoId);
        return Promise.resolve(null);
      },
    });

    await scheduler.start();
    await until(() => repoRow(db, first).last_error !== null, "the refusal");
    await settle();

    expect(started).toEqual([]);
    expect(repoRow(db, first)).toEqual({
      last_error: CAP_REACHED_ERROR,
      next_sync_at: clock + intervalMs,
      consecutive_failures: 0,
    });
    expect(updated).toContain(first);
    expect(runCount(first)).toBe(0);
    // Already over: the forge is not even asked.
    expect(infoCalls).toEqual([]);
    expect(scheduler.status()).toEqual({ queueDepth: 0, activeSyncs: 0, breakerOpen: false });
  });

  it("retries a refused first clone on its normal schedule once there is room", async () => {
    const { first, heavy } = ownerAtCap();
    const scheduler = makeScheduler();
    await scheduler.start();
    await until(() => repoRow(db, first).last_error !== null, "the refusal");
    expect(started).toEqual([]);

    setUsage(db, heavy, 10);
    // Not before the retry time: ticking early changes nothing.
    scheduler.tick();
    await settle();
    expect(started).toEqual([]);

    clock += intervalMs + 1;
    scheduler.tick();
    await until(() => started.includes(first), "the retried first clone");
  });

  it("does not feed the circuit breaker, however many first clones are refused", async () => {
    const owner = userWithCap(db);
    addRepo(db, forgeId, owner, { usage: CAP, synced: true, nextSyncAt: FOREVER });
    const refused = Array.from({ length: BREAKER_FAILURE_THRESHOLD + 2 }, () =>
      addRepo(db, forgeId, owner),
    );
    const admins = addRepo(db, forgeId, adminOf(db));
    const scheduler = makeScheduler();

    await scheduler.start();
    await until(
      () => refused.every((id) => repoRow(db, id).last_error === CAP_REACHED_ERROR),
      "every refusal",
    );
    await until(() => started.includes(admins), "the admin's clone");

    expect(started).toEqual([admins]);
    expect(scheduler.status().breakerOpen).toBe(false);
    for (const id of refused) {
      expect(repoRow(db, id).consecutive_failures).toBe(0);
      expect(runCount(id)).toBe(0);
    }
  });

  it.each([
    { name: "one byte more than the room left", size: 601, refused: true },
    { name: "far more than the room left", size: 50_000, refused: true },
    { name: "exactly the room left", size: 600, refused: false },
    { name: "less than the room left", size: 1, refused: false },
    { name: "an empty repository", size: 0, refused: false },
  ])("with the forge reporting $name", async ({ size, refused }) => {
    const owner = userWithCap(db);
    addRepo(db, forgeId, owner, { usage: 400, synced: true, nextSyncAt: FOREVER });
    const first = addRepo(db, forgeId, owner);
    const infoCalls: number[] = [];
    const scheduler = makeScheduler({
      repoInfo: (_db, repoId) => {
        infoCalls.push(repoId);
        return Promise.resolve(info(size));
      },
    });

    await scheduler.start();
    if (refused) {
      await until(() => repoRow(db, first).last_error !== null, "the refusal");
      await settle();
      expect(started).toEqual([]);
      expect(repoRow(db, first)).toEqual({
        last_error: CAP_WOULD_NOT_FIT_ERROR,
        next_sync_at: clock + intervalMs,
        consecutive_failures: 0,
      });
      expect(updated).toContain(first);
    } else {
      await until(() => started.includes(first), "the clone");
      expect(repoRow(db, first).last_error).toBeNull();
    }
    expect(infoCalls).toEqual([first]);
  });

  it.each([
    { name: "no answer at all", repoInfo: () => Promise.resolve(null) },
    { name: "an answer without a size", repoInfo: () => Promise.resolve(info(null)) },
    { name: "a rejected lookup", repoInfo: () => Promise.reject(new Error("forge down")) },
    {
      name: "a lookup that throws",
      repoInfo: (): Promise<RepoInfo | null> => {
        throw new Error("boom");
      },
    },
  ])("lets the clone proceed on $name", async ({ repoInfo }) => {
    const owner = userWithCap(db);
    addRepo(db, forgeId, owner, { usage: 400, synced: true, nextSyncAt: FOREVER });
    const first = addRepo(db, forgeId, owner);
    const scheduler = makeScheduler({ repoInfo });

    await scheduler.start();
    await until(() => started.includes(first), "the clone");

    expect(repoRow(db, first).last_error).toBeNull();
  });

  it("does not apply to a repo that has synced before, even at the cap", async () => {
    const owner = userWithCap(db);
    addRepo(db, forgeId, owner, { usage: CAP * 2, synced: true, nextSyncAt: FOREVER });
    const resync = addRepo(db, forgeId, owner, { usage: 5, synced: true });
    const infoCalls: number[] = [];
    const scheduler = makeScheduler({
      repoInfo: (_db, repoId) => {
        infoCalls.push(repoId);
        return Promise.resolve(info(10 * CAP));
      },
    });

    await scheduler.start();
    await until(() => started.includes(resync), "the existing repo's sync");

    expect(repoRow(db, resync).last_error).toBeNull();
    expect(infoCalls).toEqual([]);
  });

  it("does not apply to the admin's first clone, and does not ask the forge for it", async () => {
    addRepo(db, forgeId, adminOf(db), { usage: 900 * GB, synced: true, nextSyncAt: FOREVER });
    const first = addRepo(db, forgeId, adminOf(db));
    const infoCalls: number[] = [];
    const scheduler = makeScheduler({
      repoInfo: (_db, repoId) => {
        infoCalls.push(repoId);
        return Promise.resolve(info(10 * GB));
      },
    });

    await scheduler.start();
    await until(() => started.includes(first), "the admin's clone");

    expect(repoRow(db, first).last_error).toBeNull();
    expect(infoCalls).toEqual([]);
  });

  it("gates a manual sync now exactly like a scheduled one", async () => {
    const { first } = ownerAtCap();
    const room = userWithCap(db);
    const open = addRepo(db, forgeId, room, { nextSyncAt: FOREVER });
    const scheduler = makeScheduler();
    // Neither is due: only the manual request can put them in the queue.
    setNextSyncAt(db, first, FOREVER, 0);
    await scheduler.start();
    await settle();
    expect(started).toEqual([]);

    scheduler.enqueueNow(first);
    await until(() => repoRow(db, first).last_error !== null, "the manual refusal");
    await settle();
    expect(started).toEqual([]);
    expect(repoRow(db, first).last_error).toBe(CAP_REACHED_ERROR);
    expect(repoRow(db, first).next_sync_at).toBe(clock + intervalMs);
    expect(updated).toContain(first);

    // The same request for an owner with room goes straight through.
    scheduler.enqueueNow(open);
    await until(() => started.includes(open), "the manual clone under the cap");
  });

  it("runs a capped owner's first clones one at a time while others run alongside", async () => {
    const alice = userWithCap(db, 1_000_000);
    const bob = userWithCap(db, 1_000_000);
    const a1 = addRepo(db, forgeId, alice);
    const a2 = addRepo(db, forgeId, alice);
    const aResync = addRepo(db, forgeId, alice, { usage: 10, synced: true });
    const b1 = addRepo(db, forgeId, bob);
    const m1 = addRepo(db, forgeId, adminOf(db));
    const m2 = addRepo(db, forgeId, adminOf(db));
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({ hold });

    await scheduler.start();
    await until(() => started.length >= 5, "the concurrent runs");
    await settle();

    // Everything except one of Alice's two first clones is running together:
    // her already-synced repo, Bob's first clone, and both of the admin's.
    expect(started).toHaveLength(5);
    expect(started).toEqual(expect.arrayContaining([aResync, b1, m1, m2]));
    const aliceFirsts = started.filter((id) => id === a1 || id === a2);
    expect(aliceFirsts).toHaveLength(1);
    expect(scheduler.status()).toMatchObject({ activeSyncs: 5, queueDepth: 1 });

    const [running] = aliceFirsts;
    const waiting = running === a1 ? a2 : a1;
    hold.get(running ?? 0)?.();
    await until(() => started.includes(waiting), "Alice's second first clone");
    expect(started).toHaveLength(6);
  });

  it("re-checks the cap for a waiting first clone once the one ahead of it has finished", async () => {
    const owner = userWithCap(db);
    const a1 = addRepo(db, forgeId, owner);
    const a2 = addRepo(db, forgeId, owner);
    const hold = new Map<number, () => void>();
    const scheduler = makeScheduler({
      hold,
      // The finished clone filled the allowance, like a big repository would.
      onRun: (repoId) => {
        setUsage(db, repoId, CAP);
        db.run("UPDATE repos SET last_success_at = ? WHERE id = ?", clock, repoId);
      },
    });

    await scheduler.start();
    await until(() => started.length === 1, "the first of the two clones");
    await settle();
    expect(started).toHaveLength(1);

    const [running] = started;
    const waiting = running === a1 ? a2 : a1;
    hold.get(running ?? 0)?.();
    await until(() => repoRow(db, waiting).last_error !== null, "the waiting clone's refusal");
    await settle();

    expect(started).toEqual([running]);
    expect(repoRow(db, waiting).last_error).toBe(CAP_REACHED_ERROR);
    expect(runCount(waiting)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Push notification on a cap crossing
// ---------------------------------------------------------------------------

describe("cap reached notification", () => {
  let temp: TempDb;
  let db: Db;
  let sent: { endpoint: string; payload: PushPayload }[];
  let send: PushSender;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    sent = [];
    send = (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as PushPayload });
      return Promise.resolve();
    };
  });

  afterEach(() => {
    temp.close();
  });

  function notifier() {
    return createPushNotifier({
      db,
      log: silentLog,
      publicOrigin: "https://amber.example.com",
      send,
      batchWindowMs: 5,
    });
  }

  function subscribe(user: User, name: string): string {
    const endpoint = `https://push.example.com/${name}`;
    savePushSubscription(db, {
      endpoint,
      p256dh: `key-${name}`,
      auth: `auth-${name}`,
      userAgent: name,
      userId: user.id,
    });
    return endpoint;
  }

  const finished: AmberEvent = { type: "sync.finished", at: 1, payload: { repoId: 1 } };

  it("goes to the capped user and the admin, with different text, and to nobody else", async () => {
    const admin = adminOf(db);
    const alice = makeUser(db, "alice@example.com", {}, { capBytes: CAP });
    const carol = makeUser(db, "carol@example.com");
    const aliceTwo = [subscribe(alice, "alice-phone"), subscribe(alice, "alice-laptop")];
    const adminOne = subscribe(admin, "admin-phone");
    const carolOne = subscribe(carol, "carol-phone");

    const push = notifier();
    push.handleEvent(finished, { capReachedUserId: alice.id });
    await push.flush();

    expect(sent.map((item) => item.endpoint).sort()).toEqual([...aliceTwo, adminOne].sort());
    expect(sent.some((item) => item.endpoint === carolOne)).toBe(false);
    const toAlice = sent.filter((entry) => aliceTwo.includes(entry.endpoint));
    for (const item of toAlice) {
      expect(item.payload).toMatchObject({
        title: "You reached your storage cap",
        tag: "amber-cap",
      });
    }
    const toAdmin = sent.find((item) => item.endpoint === adminOne);
    expect(toAdmin?.payload.title).toBe("A user reached their storage cap");
    expect(toAdmin?.payload.body).toContain("alice@example.com");
    // The user's own text must not name anyone else.
    expect(JSON.stringify(toAlice)).not.toContain("carol@example.com");
  });

  it("sends nothing for an event without a cap crossing, or for a user that is gone", async () => {
    const admin = adminOf(db);
    const alice = makeUser(db, "alice@example.com");
    subscribe(admin, "admin-phone");
    subscribe(alice, "alice-phone");

    const push = notifier();
    push.handleEvent(finished);
    push.handleEvent(finished, {});
    push.handleEvent(finished, { capReachedUserId: 987_654 });
    await push.flush();

    expect(sent).toEqual([]);
  });

  it("tells the admin once, not twice, when the capped user is the admin", async () => {
    const admin = adminOf(db);
    subscribe(admin, "admin-phone");

    const push = notifier();
    push.handleEvent(finished, { capReachedUserId: admin.id });
    await push.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.title).toBe("You reached your storage cap");
  });
});

describe("a real sync that crosses the cap", () => {
  let temp: TempDb;
  let db: Db;
  let root: string;
  let origin: OriginRepo;
  let forgeId: number;
  let sent: { endpoint: string; title: string }[];

  beforeEach(async () => {
    temp = createTempDb();
    db = temp.db;
    root = tempDir("caps-sync");
    forgeId = seedForge(db);
    origin = await createOrigin(join(root, "origin"));
    await origin.commitFile("README.md", "hello\n", "initial commit");
    sent = [];
  });

  afterEach(() => {
    temp.close();
    rmSync(root, { recursive: true, force: true });
  });

  function sync(repoId: number, events: SyncEventPublisher): ReturnType<typeof syncRepo> {
    return syncRepo({
      repoId,
      db,
      backupsDir: join(root, "backups"),
      stateDir: join(root, "state"),
      logger: silentLog,
      events,
      settings: fixedSettings(),
      credentials: () => undefined,
      remoteUrl: origin.url,
      allowFileProtocol: true,
    });
  }

  it("sets cap_notified_at, tells the user and the admin once, and not on the next sync", async () => {
    const admin = adminOf(db);
    // One byte of room: the first clone is certain to cross it.
    const alice = makeUser(db, "alice@example.com", {}, { capBytes: 1 });
    const carol = makeUser(db, "carol@example.com");
    const repoId = addRepo(db, forgeId, alice);

    const bus = new EventBus();
    const finishedMeta: EventMeta[] = [];
    bus.subscribe((event, meta) => {
      if (event.type === "sync.finished") {
        finishedMeta.push(meta);
      }
    });
    const push = createPushNotifier({
      db,
      log: silentLog,
      publicOrigin: "https://amber.example.com",
      send: (subscription, payload) => {
        sent.push({
          endpoint: subscription.endpoint,
          title: (JSON.parse(payload) as PushPayload).title,
        });
        return Promise.resolve();
      },
    });
    bus.tap((event, meta) => {
      push.handleEvent(event, meta);
    });
    for (const [user, name] of [
      [alice, "alice"],
      [admin, "admin"],
      [carol, "carol"],
    ] as const) {
      savePushSubscription(db, {
        endpoint: `https://push.example.com/${name}`,
        p256dh: `key-${name}`,
        auth: `auth-${name}`,
        userAgent: name,
        userId: user.id,
      });
    }

    expect(capNotifiedAt(db, alice)).toBeNull();
    const run = await sync(repoId, bus);
    expect(run.outcome).toBe("success");
    await push.flush();

    expect(userUsageBytes(db, alice.id)).toBeGreaterThan(1);
    expect(capNotifiedAt(db, alice)).not.toBeNull();
    expect(finishedMeta).toEqual([{ capReachedUserId: alice.id }]);
    expect(sent.map((item) => item.endpoint).sort()).toEqual([
      "https://push.example.com/admin",
      "https://push.example.com/alice",
    ]);

    // Still over the cap on the next sync: no second announcement.
    await sync(repoId, bus);
    await push.flush();
    expect(finishedMeta).toEqual([{ capReachedUserId: alice.id }, {}]);
    expect(sent).toHaveLength(2);
  });

  it("carries no cap meta for the admin's repository, whatever it weighs", async () => {
    const repoId = addRepo(db, forgeId, adminOf(db));
    const metas: EventMeta[] = [];
    const publisher: SyncEventPublisher = {
      publish(type, _payload, meta) {
        if (type === "sync.finished") {
          metas.push(meta ?? {});
        }
      },
    };

    await sync(repoId, publisher);

    expect(metas).toEqual([{}]);
    expect(capNotifiedAt(db, adminOf(db))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deleting repositories clears the flag again
// ---------------------------------------------------------------------------

describe("deleting repositories under the cap", () => {
  const ALICE = "alice@example.com";
  const BOB = "bob@example.com";
  let temp: TempApp;
  let forgeId: number;
  let alice: User;
  let bob: User;

  beforeEach(async () => {
    temp = await createTempApp({ INSECURE_USER_EMAILS: `${ALICE},${BOB}` });
    forgeId = seedForge(temp.db);
    alice = makeUser(temp.db, ALICE, {}, { capBytes: CAP });
    bob = makeUser(temp.db, BOB, {}, { capBytes: CAP });
  });

  afterEach(async () => {
    await temp.close();
  });

  /** Repos owned by `owner`, then the transition a sync would have recorded. */
  function overCap(owner: User, usages: number[]): number[] {
    const ids = usages.map((usage) => addRepo(temp.db, forgeId, owner, { usage, synced: true }));
    expect(refreshCapState(temp.db, owner.id, 77)).toBe("reached");
    return ids;
  }

  async function overCapSeenByMe(email: string): Promise<boolean> {
    const response = await temp.app.inject({
      method: "GET",
      url: "/api/me",
      headers: asUser(email),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ storage: { overCap: boolean } }>().storage.overCap;
  }

  it("clears the flag when the owner deletes enough to be back under", async () => {
    const [first] = overCap(alice, [600, 600]);
    expect(await overCapSeenByMe(ALICE)).toBe(true);

    const response = await temp.app.inject({
      method: "DELETE",
      url: `/api/repos/${String(first)}`,
      headers: asUser(ALICE),
    });

    expect(response.statusCode).toBe(204);
    expect(capNotifiedAt(temp.db, alice)).toBeNull();
    expect(await overCapSeenByMe(ALICE)).toBe(false);
  });

  it("keeps the flag, and its original time, while the owner is still at or over the cap", async () => {
    const [first] = overCap(alice, [600, 600, 600]);

    const response = await temp.app.inject({
      method: "DELETE",
      url: `/api/repos/${String(first)}`,
      headers: asUser(ALICE),
    });

    expect(response.statusCode).toBe(204);
    expect(capNotifiedAt(temp.db, alice)).toBe(77);
  });

  it("clears the OWNER's flag when the admin deletes their repository", async () => {
    const [first] = overCap(alice, [600, 600]);
    overCap(bob, [600, 600]);

    const response = await temp.app.inject({
      method: "DELETE",
      url: `/api/repos/${String(first)}`,
    });

    expect(response.statusCode).toBe(204);
    expect(capNotifiedAt(temp.db, alice)).toBeNull();
    // Someone else's flag is untouched, and the admin never had one.
    expect(capNotifiedAt(temp.db, bob)).toBe(77);
    expect(capNotifiedAt(temp.db, adminOf(temp.db))).toBeNull();
  });

  it("clears every affected owner on a bulk delete", async () => {
    const aliceIds = overCap(alice, [600, 600]);
    const bobIds = overCap(bob, [700, 700]);

    const response = await temp.app.inject({
      method: "POST",
      url: "/api/repos/bulk",
      payload: { action: "delete", ids: [aliceIds[0], bobIds[0]] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ affected: number }>().affected).toBe(2);
    expect(capNotifiedAt(temp.db, alice)).toBeNull();
    expect(capNotifiedAt(temp.db, bob)).toBeNull();
  });

  it("clears the owner's flag on their own bulk delete too", async () => {
    const ids = overCap(alice, [600, 600]);

    const response = await temp.app.inject({
      method: "POST",
      url: "/api/repos/bulk",
      headers: asUser(ALICE),
      payload: { action: "delete", ids },
    });

    expect(response.statusCode).toBe(200);
    expect(capNotifiedAt(temp.db, alice)).toBeNull();
  });
});
