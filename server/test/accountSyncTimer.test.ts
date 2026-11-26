import type { AccountSyncRunResult } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAccountSyncTimer, type AccountSyncTimer } from "../src/accountSyncTimer.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import type { RepoFileRemover } from "../src/domain/repos.ts";
import { createConsoleLogger } from "../src/logging.ts";
import type { DiscoveryDeps } from "../src/providers/discovery.ts";
import type { ForkResolverDeps } from "../src/providers/forks.ts";

let db: Db;
let timer: AccountSyncTimer | undefined;

const log = createConsoleLogger("silent");
const noopRemover: RepoFileRemover = async () => {
  await Promise.resolve();
};

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, log);
});

afterEach(() => {
  timer?.stop();
  timer = undefined;
  db.close();
});

function start(
  run: (database: Db, deps: DiscoveryDeps) => Promise<AccountSyncRunResult[]>,
  removeFiles: RepoFileRemover = noopRemover,
): AccountSyncTimer {
  timer = startAccountSyncTimer({
    db,
    log,
    secretKey: null,
    removeFiles,
    // Long enough that only explicit ticks run during a test.
    intervalMs: 60_000,
    run,
  });
  return timer;
}

describe("account sync timer", () => {
  it("passes the file remover through, so a confirmed unstar can free disk", async () => {
    // This is the wiring that fails silently when missed: domain deleteRepo
    // refuses to drop backup files without a remover, discovery catches the
    // refusal, and every removal is quietly retained forever.
    const seen: DiscoveryDeps[] = [];
    const remover: RepoFileRemover = async () => {
      await Promise.resolve();
    };

    await start((_database, deps) => {
      seen.push(deps);
      return Promise.resolve([]);
    }, remover).tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.removeFiles).toBe(remover);
  });

  it("hands discovery the database and the secret key", async () => {
    const seen: { database: Db; deps: DiscoveryDeps }[] = [];

    await start((database, deps) => {
      seen.push({ database, deps });
      return Promise.resolve([]);
    }).tick();

    expect(seen[0]?.database).toBe(db);
    expect(seen[0]?.deps.secretKey).toBeNull();
    expect(seen[0]?.deps.log).toBeDefined();
  });

  it("does not start a second pass while one is still running", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((done) => {
      release = done;
    });

    const handle = start(async () => {
      started += 1;
      await blocked;
      return [];
    });

    const first = handle.tick();
    // A slow forge can outlast the interval; the overlapping tick is dropped
    // rather than enumerating the same account twice.
    await handle.tick();
    expect(started).toBe(1);

    release?.();
    await first;

    // Once the pass finishes the next tick runs normally.
    await handle.tick();
    expect(started).toBe(2);
  });

  it("survives a failing pass and keeps ticking", async () => {
    let calls = 0;
    const handle = start(() => {
      calls += 1;
      return Promise.reject(new Error("forge exploded"));
    });

    // No throw: a bad pass must never take the process down.
    await handle.tick();
    await handle.tick();
    expect(calls).toBe(2);
  });

  it("stops ticking after stop", async () => {
    let calls = 0;
    const handle = start(() => {
      calls += 1;
      return Promise.resolve([]);
    });
    handle.stop();
    // stop() clears the interval; an explicit tick is still the caller's call.
    await handle.tick();
    expect(calls).toBe(1);
  });
  it("runs the fork resolver after the account syncs, under the same guard", async () => {
    const order: string[] = [];
    let seenDeps: ForkResolverDeps | undefined;
    timer = startAccountSyncTimer({
      db,
      log,
      secretKey: null,
      removeFiles: noopRemover,
      intervalMs: 60_000,
      run: () => {
        order.push("sync");
        return Promise.resolve([]);
      },
      resolveForks: (_database, forkDeps) => {
        order.push("forks");
        seenDeps = forkDeps;
        return Promise.resolve();
      },
    });

    await timer.tick();

    expect(order).toEqual(["sync", "forks"]);
    expect(seenDeps?.cooldowns).toBeInstanceOf(Map);
  });

  it("still resolves forks when the account sync pass throws, and survives a resolver that throws", async () => {
    let forkPasses = 0;
    timer = startAccountSyncTimer({
      db,
      log,
      secretKey: null,
      removeFiles: noopRemover,
      intervalMs: 60_000,
      run: () => Promise.reject(new Error("sync broke")),
      resolveForks: () => {
        forkPasses += 1;
        return Promise.reject(new Error("forks broke"));
      },
    });

    await timer.tick();
    await timer.tick();

    expect(forkPasses).toBe(2);
  });

  it("publishes repo.updated for a repo whose fork parent was written", async () => {
    const published: unknown[] = [];
    timer = startAccountSyncTimer({
      db,
      log,
      secretKey: null,
      removeFiles: noopRemover,
      intervalMs: 60_000,
      events: { publish: (type, payload) => published.push([type, payload]) },
      run: () => Promise.resolve([]),
      resolveForks: (_database, forkDeps) => {
        forkDeps.onResolved?.(7);
        return Promise.resolve();
      },
    });

    await timer.tick();

    expect(published).toEqual([["repo.updated", { repoId: 7 }]]);
  });
});
