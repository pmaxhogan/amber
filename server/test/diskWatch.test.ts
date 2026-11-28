import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncRun } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createRepo } from "../src/domain/repos.ts";
import type { User } from "../src/domain/users.ts";
import {
  CAP_EXCEEDED_DURING_SYNC_ERROR,
  cleanupPartialFetch,
  DISK_FLOOR_ERROR,
  DiskBudgetError,
  inFlightSyncCount,
  isBelowDiskFloor,
  startDiskWatch,
} from "../src/sync/diskWatch.ts";
import { runGit } from "../src/sync/gitCli.ts";
import { Scheduler } from "../src/sync/scheduler.ts";
import { syncRepo } from "../src/sync/syncRepo.ts";
import { createTempApp, createTempDb, seedForge, type TempApp, type TempDb } from "./helpers.ts";
import { createOrigin, fixedSettings, silentLog, tempDir } from "./helpers/gitFixtures.ts";
import { adminOf, makeUser } from "./helpers/users.ts";

/**
 * The disk guard that runs while a sync runs (sync/diskWatch.ts): the
 * per-owner in-flight budget (twice the cap, minus usage, shared by all of
 * that owner's syncs in flight) and the global free-space floor.
 */

const CAP = 1000;
const GB = 1024 ** 3;

let temp: TempDb;
let db: Db;
let root: string;
let forgeId: number;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  root = tempDir("disk-watch");
  forgeId = seedForge(db);
});

afterEach(() => {
  temp.close();
  rmSync(root, { recursive: true, force: true });
});

function capped(usage: number): { owner: User; dir: string } {
  const owner = makeUser(
    db,
    `owner${String(Math.random()).slice(2, 8)}@example.com`,
    {},
    {
      capBytes: CAP,
    },
  );
  const repo = createRepo(db, { forgeId, path: `a/used-${String(usage)}`, ownerUserId: owner.id });
  db.run("UPDATE repos SET disk_usage_bytes = ? WHERE id = ?", usage, repo.id);
  const dir = join(root, `repo-${String(owner.id)}`);
  mkdirSync(dir, { recursive: true });
  return { owner, dir };
}

/** A size probe the test moves by hand. */
function sizes(): {
  sizeOf: (dir: string) => Promise<number>;
  set: (dir: string, n: number) => void;
} {
  const map = new Map<string, number>();
  return {
    sizeOf: (dir) => Promise.resolve(map.get(dir) ?? 0),
    set: (dir, n) => map.set(dir, n),
  };
}

const plenty = (): Promise<number> => Promise.resolve(100 * GB);

describe("the in-flight budget", () => {
  it("stops a capped owner's sync once its growth passes twice the cap minus usage", async () => {
    const { owner, dir } = capped(400);
    const probe = sizes();
    const watch = await startDiskWatch({
      db,
      ownerUserId: owner.id,
      dir,
      backupsDir: root,
      minFreeBytes: 0,
      pollMs: 1_000_000,
      sizeOf: probe.sizeOf,
      freeBytes: plenty,
    });
    try {
      // Budget: 2 * 1000 - 400 = 1600.
      probe.set(dir, 1600);
      await watch.check();
      expect(watch.signal.aborted).toBe(false);
      probe.set(dir, 1601);
      await watch.check();
      expect(watch.signal.aborted).toBe(true);
      expect(watch.signal.reason).toBeInstanceOf(DiskBudgetError);
      expect((watch.signal.reason as Error).message).toBe(CAP_EXCEEDED_DURING_SYNC_ERROR);
    } finally {
      watch.stop();
    }
    expect(inFlightSyncCount(owner.id)).toBe(0);
  });

  it("shares the budget across ALL of the owner's syncs in flight", async () => {
    const { owner, dir } = capped(0);
    const other = join(root, "second");
    mkdirSync(other);
    const probe = sizes();
    const common = {
      db,
      ownerUserId: owner.id,
      backupsDir: root,
      minFreeBytes: 0,
      pollMs: 1_000_000,
      sizeOf: probe.sizeOf,
      freeBytes: plenty,
    };
    const first = await startDiskWatch({ ...common, dir });
    const second = await startDiskWatch({ ...common, dir: other });
    try {
      expect(inFlightSyncCount(owner.id)).toBe(2);
      // Each alone is under the 2000 budget; together they are not.
      probe.set(dir, 1200);
      await first.check();
      probe.set(other, 900);
      await second.check();
      expect(first.signal.aborted).toBe(false);
      expect(second.signal.aborted).toBe(true);
      // The first notices on its next poll.
      await first.check();
      expect(first.signal.aborted).toBe(true);
    } finally {
      first.stop();
      second.stop();
    }
  });

  it("counts only growth since the sync started, and never applies to the admin", async () => {
    const { owner, dir } = capped(0);
    const probe = sizes();
    probe.set(dir, 5000); // already there before this sync
    const watch = await startDiskWatch({
      db,
      ownerUserId: owner.id,
      dir,
      backupsDir: root,
      minFreeBytes: 0,
      pollMs: 1_000_000,
      sizeOf: probe.sizeOf,
      freeBytes: plenty,
    });
    probe.set(dir, 6000);
    await watch.check();
    expect(watch.signal.aborted).toBe(false);
    watch.stop();

    const adminDir = join(root, "admin");
    mkdirSync(adminDir);
    const admins = await startDiskWatch({
      db,
      ownerUserId: adminOf(db).id,
      dir: adminDir,
      backupsDir: root,
      minFreeBytes: 0,
      pollMs: 1_000_000,
      sizeOf: probe.sizeOf,
      freeBytes: plenty,
    });
    probe.set(adminDir, 900 * GB);
    await admins.check();
    expect(admins.signal.aborted).toBe(false);
    admins.stop();
  });
});

describe("the free-space floor", () => {
  it("stops anyone's sync, the admin's included, below the floor", async () => {
    let free = 10 * GB;
    const watch = await startDiskWatch({
      db,
      ownerUserId: adminOf(db).id,
      dir: join(root, "x"),
      backupsDir: root,
      minFreeBytes: 5 * GB,
      pollMs: 1_000_000,
      freeBytes: () => Promise.resolve(free),
    });
    await watch.check();
    expect(watch.signal.aborted).toBe(false);
    free = 5 * GB - 1;
    await watch.check();
    expect(watch.signal.aborted).toBe(true);
    expect((watch.signal.reason as Error).message).toBe(DISK_FLOOR_ERROR);
    watch.stop();
  });

  it("is off at 0 and does not count an unreadable volume as full", async () => {
    expect(await isBelowDiskFloor(root, 0, () => Promise.resolve(0))).toBe(false);
    expect(await isBelowDiskFloor(root, 1, () => Promise.reject(new Error("EIO")))).toBe(false);
    expect(await isBelowDiskFloor(root, 2, () => Promise.resolve(1))).toBe(true);
    // The real probe answers for a real directory.
    expect(await isBelowDiskFloor(root, 1)).toBe(false);
  });
});

describe("aborting git", () => {
  /** A git that hangs on fetch (and its children with it) until killed. */
  function slowGit(): string {
    const binary = join(root, "slow-git.sh");
    writeFileSync(
      binary,
      '#!/bin/sh\nfor a in "$@"; do if [ "$a" = "fetch" ]; then sleep 30; fi; done\nexec git "$@"\n',
    );
    chmodSync(binary, 0o755);
    return binary;
  }

  it("kills the process and rejects with the abort reason", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = runGit(["fetch", "origin"], {
      binary: slowGit(),
      stateDir: join(root, "state"),
      signal: controller.signal,
      allowFailure: true,
    });
    setTimeout(() => {
      controller.abort(new DiskBudgetError("disk_floor"));
    }, 100);
    await expect(run).rejects.toBeInstanceOf(DiskBudgetError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("stops a real sync mid-fetch, records it, and removes the partial files", async () => {
    const owner = makeUser(db, "fill@example.com", {}, { capBytes: CAP });
    const origin = await createOrigin(join(root, "origin"));
    await origin.commitFile("README.md", "hi\n", "initial");
    const repoId = createRepo(db, { forgeId, path: "a/fill", ownerUserId: owner.id }).id;
    db.run("UPDATE forges SET allow_private_network = 1 WHERE id = ?", forgeId);
    const backupsDir = join(root, "backups");
    const slug = db.get<{ slug: string }>("SELECT slug FROM repos WHERE id = ?", repoId)?.slug;
    const repoDir = join(backupsDir, String(slug));
    let calls = 0;
    const run: SyncRun = await syncRepo({
      repoId,
      db,
      backupsDir,
      stateDir: join(root, "state"),
      logger: silentLog,
      settings: fixedSettings({ min_free_disk_gb: 0 }),
      credentials: () => undefined,
      remoteUrl: origin.url,
      allowFileProtocol: true,
      gitBinary: slowGit(),
      diskWatch: {
        pollMs: 20,
        // Nothing grows until the repository is initialised; from then on
        // every read sees a flood, and plants what a killed index-pack leaves
        // behind, so the abort lands while git is fetching.
        sizeOf: (dir) => {
          if (!existsSync(join(dir, "objects", "pack"))) {
            return Promise.resolve(0);
          }
          calls += 1;
          writeFileSync(join(dir, "objects", "pack", "tmp_pack_abc"), "partial");
          return Promise.resolve(50 * CAP);
        },
      },
    });
    expect(run.outcome).toBe("error");
    expect(run.errorKind).toBe("disk");
    expect(run.error).toBe(CAP_EXCEEDED_DURING_SYNC_ERROR);
    expect(existsSync(join(repoDir, "objects", "pack", "tmp_pack_abc"))).toBe(false);
    expect(existsSync(join(repoDir, "objects"))).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect(inFlightSyncCount(owner.id)).toBe(0);
  });
});

describe("cleanupPartialFetch", () => {
  it("removes temporary packs, quarantines and partial LFS, and nothing else", async () => {
    const dir = join(root, "bare");
    mkdirSync(join(dir, "objects", "pack"), { recursive: true });
    mkdirSync(join(dir, "objects", "incoming-xyz"), { recursive: true });
    mkdirSync(join(dir, "lfs", "incomplete"), { recursive: true });
    mkdirSync(join(dir, "lfs", "objects"), { recursive: true });
    writeFileSync(join(dir, "objects", "pack", "tmp_pack_1"), "x");
    writeFileSync(join(dir, "objects", "pack", "pack-good.pack"), "x");
    writeFileSync(join(dir, "lfs", "incomplete", "abc"), "x");
    writeFileSync(join(dir, "lfs", "objects", "keep"), "x");
    await cleanupPartialFetch(dir);
    expect(existsSync(join(dir, "objects", "pack", "tmp_pack_1"))).toBe(false);
    expect(existsSync(join(dir, "objects", "incoming-xyz"))).toBe(false);
    expect(existsSync(join(dir, "lfs", "incomplete"))).toBe(false);
    expect(existsSync(join(dir, "objects", "pack", "pack-good.pack"))).toBe(true);
    expect(existsSync(join(dir, "lfs", "objects", "keep"))).toBe(true);
  });
});

describe("before a sync starts", () => {
  let schedulers: Scheduler[] = [];

  afterEach(async () => {
    for (const scheduler of schedulers) {
      await scheduler.stop();
    }
    schedulers = [];
  });

  it("refuses to start anyone's sync below the floor, without a run or the breaker", async () => {
    const repoId = createRepo(db, { forgeId, path: "a/admins", ownerUserId: adminOf(db).id }).id;
    db.run("UPDATE repos SET next_sync_at = 0 WHERE id = ?", repoId);
    const started: number[] = [];
    const clock = Date.now() + 60_000;
    const scheduler = new Scheduler({
      db,
      backupsDir: root,
      stateDir: join(root, "state"),
      logger: silentLog,
      now: () => clock,
      random: () => 0.5,
      staggerStepMs: 0,
      refreshIntervalMs: 3_600_000,
      settings: fixedSettings({ min_free_disk_gb: 5 }),
      globalSettings: () => fixedSettings({ min_free_disk_gb: 5 })(db, 0),
      freeDiskBytes: () => Promise.resolve(GB),
      runSync: (deps) => {
        started.push(deps.repoId);
        return Promise.reject(new Error("must not run"));
      },
      shutdownGraceMs: 50,
      repoInfo: () => Promise.resolve(null),
    });
    schedulers.push(scheduler);
    await scheduler.start();
    for (let i = 0; i < 200; i += 1) {
      const row = db.get<{ last_error: string | null }>(
        "SELECT last_error FROM repos WHERE id = ?",
        repoId,
      );
      if (row?.last_error !== null && row?.last_error !== undefined) {
        break;
      }
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(started).toEqual([]);
    expect(
      db.get("SELECT last_error, consecutive_failures FROM repos WHERE id = ?", repoId),
    ).toEqual({ last_error: DISK_FLOOR_ERROR, consecutive_failures: 0 });
    expect(db.get("SELECT COUNT(*) AS n FROM sync_runs WHERE repo_id = ?", repoId)).toEqual({
      n: 0,
    });
    expect(scheduler.status().breakerOpen).toBe(false);
  });
});

describe("GET /api/status disk", () => {
  let app: TempApp;

  afterEach(async () => {
    await app.close();
  });

  it("shows the admin the volume against the floor, and nobody else", async () => {
    app = await createTempApp(
      { INSECURE_USER_EMAILS: "friend@example.com" },
      { freeDiskBytes: () => Promise.resolve(GB) },
    );
    makeUser(app.db, "friend@example.com");
    const admin = await app.app.inject({ method: "GET", url: "/api/status" });
    expect(admin.json()).toMatchObject({
      disk: { freeBytes: GB, minFreeBytes: 5 * GB, belowFloor: true },
    });
    const friend = await app.app.inject({
      method: "GET",
      url: "/api/status",
      headers: { "x-amber-insecure-user": "friend@example.com" },
    });
    expect(friend.json()).not.toHaveProperty("disk");
  });
});
