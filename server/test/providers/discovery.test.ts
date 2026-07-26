import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/db/db.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createConsoleLogger } from "../../src/logging.ts";
import {
  listDueAccountSyncs,
  providerForKind,
  runAccountSync,
  runAccountSyncDetailed,
  runDueAccountSyncs,
  supportsStarredSync,
  type DiscoveryDeps,
} from "../../src/providers/discovery.ts";
import { ProviderError } from "../../src/providers/http.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
  RepoAccess,
} from "../../src/providers/types.ts";

const log = createConsoleLogger("silent");

let dir: string;
let db: Db;
let deletions: { id: number; withFiles: boolean }[];
let shortIdCounter: number;

interface RepoRow {
  id: number;
  path: string;
  slug: string;
  short_id: string;
  origin: string;
  managed_by_account_sync_id: number | null;
  next_sync_at: number | null;
  default_branch: string | null;
  state: string;
}

function repo(path: string, overrides: Partial<DiscoveredRepo> = {}): DiscoveredRepo {
  return {
    path,
    defaultBranch: "main",
    isPrivate: false,
    archived: false,
    description: null,
    ...overrides,
  };
}

/** A provider under full test control: no HTTP, scripted answers per call. */
function fakeProvider(options: {
  repos?: DiscoveredRepo[][];
  starred?: DiscoveredRepo[][];
  access?: Record<string, RepoAccess | Error>;
  onContext?: (context: DiscoveryContext) => void;
  kind?: "github" | "gitlab";
}): AccountSyncProvider & { accessCalls: string[] } {
  let repoCall = 0;
  let starredCall = 0;
  const accessCalls: string[] = [];

  const provider: AccountSyncProvider & { accessCalls: string[] } = {
    kind: options.kind ?? "github",
    accessCalls,
    listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
      options.onContext?.(context);
      const page = options.repos?.[Math.min(repoCall, (options.repos.length || 1) - 1)] ?? [];
      repoCall += 1;
      return toAsync(page);
    },
  };

  if (options.starred !== undefined) {
    provider.listStarred = (context: DiscoveryContext): AsyncIterable<DiscoveredRepo> => {
      options.onContext?.(context);
      const pages = options.starred ?? [];
      const page = pages[Math.min(starredCall, pages.length - 1)] ?? [];
      starredCall += 1;
      return toAsync(page);
    };
    provider.checkRepoAccess = (_context: DiscoveryContext, path: string): Promise<RepoAccess> => {
      accessCalls.push(path);
      const answer = options.access?.[path];
      if (answer instanceof Error) {
        return Promise.reject(answer);
      }
      return Promise.resolve(answer ?? "unknown");
    };
  }

  return provider;
}

async function* toAsync(items: DiscoveredRepo[]): AsyncIterable<DiscoveredRepo> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

function baseDeps(provider: AccountSyncProvider, extra: DiscoveryDeps = {}): DiscoveryDeps {
  return {
    log,
    providerFor: () => provider,
    random: () => 0.5,
    repos: {
      generateShortId: () => {
        shortIdCounter += 1;
        return `sid${String(shortIdCounter).padStart(5, "0")}`;
      },
      buildSlug: (path, shortId) =>
        `${path.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${shortId}`,
      deleteRepo: (database, id, withFiles) => {
        deletions.push({ id, withFiles });
        database.run("DELETE FROM repos WHERE id = ?", id);
        return Promise.resolve();
      },
    },
    ...extra,
  };
}

function seed(options: { kind?: string; secret?: Uint8Array | null } = {}): {
  forgeId: number;
  accountId: number;
} {
  const forgeId = db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    "https",
    "github.com",
    null,
    options.kind ?? "github",
    1,
    1,
  ).lastInsertRowid;
  const accountId = db.run(
    "INSERT INTO accounts (forge_id, username, secret_enc, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    forgeId,
    "octocat",
    options.secret ?? null,
    1,
    1,
    1,
  ).lastInsertRowid;
  return { forgeId, accountId };
}

function createSync(
  accountId: number,
  source: "owned" | "starred" = "owned",
  overrides: { visibility?: string; enabled?: number; intervalMinutes?: number } = {},
): number {
  return db.run(
    `INSERT INTO account_syncs (account_id, source, visibility, enabled, interval_minutes, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    accountId,
    source,
    overrides.visibility ?? "all",
    overrides.enabled ?? 1,
    overrides.intervalMinutes ?? 360,
    null,
    1,
    1,
  ).lastInsertRowid;
}

function repoRows(): RepoRow[] {
  return db.all<RepoRow>("SELECT * FROM repos ORDER BY path ASC");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-discovery-"));
  db = openDb(join(dir, "state", "amber.db"));
  migrate(db, log);
  deletions = [];
  shortIdCounter = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("providerForKind", () => {
  it("resolves every supported forge kind and nothing else", () => {
    expect(providerForKind("github")?.kind).toBe("github");
    expect(providerForKind("gitlab")?.kind).toBe("gitlab");
    expect(providerForKind("bitbucket")?.kind).toBe("bitbucket");
    expect(providerForKind("gitea")?.kind).toBe("gitea");
    expect(providerForKind("generic")).toBeUndefined();
  });

  it("reports starred support for GitHub only", () => {
    expect(supportsStarredSync("github")).toBe(true);
    expect(supportsStarredSync("gitlab")).toBe(false);
    expect(supportsStarredSync("bitbucket")).toBe(false);
    expect(supportsStarredSync("gitea")).toBe(false);
    expect(supportsStarredSync("generic")).toBe(false);
  });
});

describe("runAccountSync, owned", () => {
  it("creates a repo row per discovered repository on the first run", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId);
    const provider = fakeProvider({
      repos: [[repo("octocat/one"), repo("octocat/two", { defaultBranch: "trunk" })]],
    });

    const result = await runAccountSyncDetailed(
      db,
      syncId,
      baseDeps(provider, { now: () => 1_000 }),
    );

    expect(result.discovered).toBe(2);
    expect(result.created).toBe(2);
    expect(result.linked).toBe(0);
    expect(result.error).toBeNull();

    const rows = repoRows();
    expect(rows.map((row) => row.path)).toEqual(["octocat/one", "octocat/two"]);
    for (const row of rows) {
      expect(row.origin).toBe("account_sync");
      expect(row.managed_by_account_sync_id).toBe(syncId);
      expect(row.state).toBe("active");
      expect(row.slug.endsWith(row.short_id)).toBe(true);
      expect(row.short_id).toHaveLength(8);
    }
    expect(rows[1]?.default_branch).toBe("trunk");

    const sync = result.accountSync;
    expect(sync.reposDiscovered).toBe(2);
    expect(sync.lastRunAt).toBe(1_000);
    expect(sync.lastError).toBeNull();
    // 360 minutes with the injected 0.5 jitter draw lands exactly on the interval.
    expect(sync.nextRunAt).toBe(1_000 + 360 * 60_000);
  });

  it("staggers the first sync of newly created repos", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId);
    const provider = fakeProvider({
      repos: [[repo("octocat/a"), repo("octocat/b"), repo("octocat/c")]],
    });

    await runAccountSync(db, syncId, baseDeps(provider, { now: () => 5_000 }));

    const times = repoRows().map((row) => row.next_sync_at ?? 0);
    expect(times[0]).toBe(5_000);
    expect(times[1]).toBeGreaterThan(times[0] ?? 0);
    expect(times[2]).toBeGreaterThan(times[1] ?? 0);
    // Nothing waits longer than the stagger window.
    expect((times[2] ?? 0) - 5_000).toBeLessThanOrEqual(5 * 60_000);
  });

  it("is idempotent: a second run creates nothing and keeps the same rows", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId);
    const provider = fakeProvider({
      repos: [
        [repo("octocat/one"), repo("octocat/two")],
        [repo("octocat/one"), repo("octocat/two")],
      ],
    });
    const deps = baseDeps(provider, { now: () => 1_000 });

    await runAccountSyncDetailed(db, syncId, deps);
    const before = repoRows();
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.created).toBe(0);
    expect(second.linked).toBe(0);
    expect(second.discovered).toBe(2);
    expect(repoRows()).toEqual(before);
  });

  it("links a manually imported repo instead of duplicating it, and leaves its origin alone", async () => {
    const { forgeId, accountId } = seed();
    const syncId = createSync(accountId);
    const manual = db.run(
      `INSERT INTO repos (forge_id, path, display_name, slug, short_id, state, next_sync_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?)`,
      forgeId,
      "octocat/one",
      "one",
      "octocat-one-manual01",
      "manual01",
      777,
      1,
      1,
    ).lastInsertRowid;
    const provider = fakeProvider({ repos: [[repo("octocat/one"), repo("octocat/two")]] });

    const result = await runAccountSyncDetailed(
      db,
      syncId,
      baseDeps(provider, { now: () => 2_000 }),
    );

    expect(result.created).toBe(1);
    expect(result.linked).toBe(1);
    const rows = repoRows();
    expect(rows).toHaveLength(2);
    const linked = rows.find((row) => row.path === "octocat/one");
    expect(linked?.id).toBe(manual);
    expect(linked?.origin).toBe("manual");
    expect(linked?.managed_by_account_sync_id).toBe(syncId);
    // Repo level settings win: the paused state and its schedule are untouched.
    expect(linked?.state).toBe("paused");
    expect(linked?.next_sync_at).toBe(777);
    expect(linked?.short_id).toBe("manual01");
  });

  it("keeps a repo that disappeared upstream and only counts it", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId);
    const provider = fakeProvider({
      repos: [[repo("octocat/one"), repo("octocat/two")], [repo("octocat/one")]],
    });
    const deps = baseDeps(provider, { now: () => 1_000 });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.vanished).toBe(1);
    expect(second.removed).toBe(0);
    expect(repoRows().map((row) => row.path)).toEqual(["octocat/one", "octocat/two"]);
    expect(deletions).toEqual([]);
  });

  it("passes the forge origin, username and visibility to the provider", async () => {
    db.run(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "http",
      "gitea.example.com",
      3000,
      "gitea",
      1,
      1,
    );
    const accountId = db.run(
      "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      1,
      "maintainer",
      1,
      1,
      1,
    ).lastInsertRowid;
    const syncId = createSync(accountId, "owned", { visibility: "private" });

    let seen: DiscoveryContext | undefined;
    const provider = fakeProvider({ repos: [[]], onContext: (context) => (seen = context) });
    await runAccountSync(db, syncId, baseDeps(provider));

    expect(seen?.baseUrl).toBe("http://gitea.example.com:3000");
    expect(seen?.username).toBe("maintainer");
    expect(seen?.visibility).toBe("private");
    expect(seen?.token).toBeNull();
  });

  it("decrypts the stored credential just in time", async () => {
    const { accountId } = seed({ secret: new Uint8Array([1, 2, 3]) });
    const syncId = createSync(accountId);
    const decryptSecret = vi.fn(() => "ghp_secret");
    let seen: DiscoveryContext | undefined;
    const provider = fakeProvider({ repos: [[]], onContext: (context) => (seen = context) });

    await runAccountSync(
      db,
      syncId,
      baseDeps(provider, { secretKey: Buffer.alloc(32), decryptSecret }),
    );

    expect(decryptSecret).toHaveBeenCalledOnce();
    expect(seen?.token).toBe("ghp_secret");
  });

  it("records a clear error when a credential exists but the key is missing", async () => {
    const { accountId } = seed({ secret: new Uint8Array([1, 2, 3]) });
    const syncId = createSync(accountId);
    const provider = fakeProvider({ repos: [[]] });

    const result = await runAccountSyncDetailed(
      db,
      syncId,
      baseDeps(provider, { secretKey: null }),
    );

    expect(result.error).toContain("AMBER_SECRET_KEY");
    expect(result.accountSync.lastError).toContain("AMBER_SECRET_KEY");
  });

  it("records the provider error, keeps the previous count and reschedules", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId);
    const failing: AccountSyncProvider = {
      kind: "github",
      listRepos(): AsyncIterable<DiscoveredRepo> {
        throw new ProviderError("Forge rate limited the request for /user/repos (HTTP 429)", {
          kind: "rate_limited",
          status: 429,
          retryAfterMs: 90_000,
        });
      },
    };

    const result = await runAccountSyncDetailed(
      db,
      syncId,
      baseDeps(failing, { now: () => 10_000 }),
    );

    expect(result.error).toContain("rate limited");
    expect(result.error).toContain("Retry after 90s");
    expect(result.accountSync.nextRunAt).toBe(10_000 + 360 * 60_000);
    expect(result.accountSync.lastRunAt).toBe(10_000);
  });

  it("refuses a generic forge with an actionable message", async () => {
    const { accountId } = seed({ kind: "generic" });
    const syncId = createSync(accountId);

    const result = await runAccountSyncDetailed(db, syncId, {
      log,
      random: () => 0.5,
    });

    expect(result.error).toContain("does not support generic forges");
  });

  it("throws for an account sync that does not exist", async () => {
    await expect(runAccountSync(db, 4242, { log })).rejects.toThrow("does not exist");
  });

  it("errors cleanly, and without any HTTP call, when a private sync has no credential", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId, "owned", { visibility: "private" });

    // No providerFor override: this exercises the real GitHub client, which
    // refuses before it would reach the network.
    const result = await runAccountSyncDetailed(db, syncId, {
      log,
      random: () => 0.5,
      now: () => 1,
      fetch: () => Promise.reject(new Error("the provider must not make a request")),
    });

    expect(result.error).toContain("needs a stored credential");
    expect(repoRows()).toEqual([]);
  });
});

describe("runAccountSync, starred", () => {
  function starredSetup(pages: DiscoveredRepo[][], access: Record<string, RepoAccess | Error>) {
    const { accountId } = seed();
    const syncId = createSync(accountId, "starred");
    const provider = fakeProvider({ repos: [[]], starred: pages, access });
    return { syncId, provider };
  }

  it("rejects a starred sync on a forge whose provider cannot enumerate stars", async () => {
    const { accountId } = seed({ kind: "gitlab" });
    const syncId = createSync(accountId, "starred");
    const provider = fakeProvider({ repos: [[]], kind: "gitlab" });

    const result = await runAccountSyncDetailed(db, syncId, baseDeps(provider));

    expect(result.error).toBe("Starred sync is GitHub-only for now");
  });

  it("creates rows for stars owned by other people", async () => {
    const { syncId, provider } = starredSetup([[repo("nodejs/node"), repo("sindresorhus/ky")]], {});

    const result = await runAccountSyncDetailed(db, syncId, baseDeps(provider, { now: () => 1 }));

    expect(result.created).toBe(2);
    expect(repoRows().map((row) => row.path)).toEqual(["nodejs/node", "sindresorhus/ky"]);
  });

  it("removes an unstarred repo once the forge confirms it is still there", async () => {
    const { syncId, provider } = starredSetup(
      [[repo("nodejs/node"), repo("sindresorhus/ky")], [repo("nodejs/node")]],
      { "sindresorhus/ky": "accessible" },
    );
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const removedId = repoRows().find((row) => row.path === "sindresorhus/ky")?.id;
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.removed).toBe(1);
    expect(second.retained).toBe(0);
    expect(deletions).toEqual([{ id: removedId, withFiles: true }]);
    expect(repoRows().map((row) => row.path)).toEqual(["nodejs/node"]);
  });

  it("keeps an unstarred repo that answers 404: deleted upstream is what backups are for", async () => {
    const { syncId, provider } = starredSetup(
      [[repo("nodejs/node"), repo("gone/repo")], [repo("nodejs/node")]],
      { "gone/repo": "missing" },
    );
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.removed).toBe(0);
    expect(second.retained).toBe(1);
    expect(deletions).toEqual([]);
    expect(repoRows().map((row) => row.path)).toContain("gone/repo");
  });

  it("keeps an unstarred repo when the forge answers 500", async () => {
    const { syncId, provider } = starredSetup(
      [[repo("nodejs/node"), repo("flaky/repo")], [repo("nodejs/node")]],
      {
        "flaky/repo": new ProviderError("Forge failed while serving /repos/flaky/repo (HTTP 503)", {
          kind: "server",
          status: 503,
        }),
      },
    );
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.removed).toBe(0);
    expect(second.retained).toBe(1);
    expect(repoRows().map((row) => row.path)).toContain("flaky/repo");
  });

  it("keeps an unstarred repo when the check cannot reach the forge at all", async () => {
    const { syncId, provider } = starredSetup(
      [[repo("nodejs/node"), repo("offline/repo")], [repo("nodejs/node")]],
      {
        "offline/repo": new ProviderError("Could not reach the forge at https://github.com", {
          kind: "network",
        }),
      },
    );
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.removed).toBe(0);
    expect(second.retained).toBe(1);
    expect(deletions).toEqual([]);
  });

  it("keeps an unstarred repo when the access answer is ambiguous", async () => {
    const { syncId, provider } = starredSetup(
      [[repo("nodejs/node"), repo("private/repo")], [repo("nodejs/node")]],
      { "private/repo": "unknown" },
    );
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.retained).toBe(1);
    expect(deletions).toEqual([]);
  });

  it("never removes a manually imported repo, and does not even check it upstream", async () => {
    const { forgeId, accountId } = seed();
    const syncId = createSync(accountId, "starred");
    db.run(
      `INSERT INTO repos (forge_id, path, display_name, slug, short_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      forgeId,
      "nodejs/node",
      "node",
      "nodejs-node-manual01",
      "manual01",
      1,
      1,
    );
    const provider = fakeProvider({
      repos: [[]],
      starred: [[repo("nodejs/node")], []],
      access: { "nodejs/node": "accessible" },
    });
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.removed).toBe(0);
    expect(second.retained).toBe(1);
    expect(provider.accessCalls).toEqual([]);
    expect(deletions).toEqual([]);
    expect(repoRows().map((row) => row.origin)).toEqual(["manual"]);
  });

  it("re-creates a repo cleanly when it is starred again", async () => {
    const { syncId, provider } = starredSetup([[repo("nodejs/node")], [], [repo("nodejs/node")]], {
      "nodejs/node": "accessible",
    });
    const deps = baseDeps(provider, { now: () => 1 });

    await runAccountSyncDetailed(db, syncId, deps);
    const firstId = repoRows()[0]?.id;
    await runAccountSyncDetailed(db, syncId, deps);
    expect(repoRows()).toHaveLength(0);

    const third = await runAccountSyncDetailed(db, syncId, deps);
    expect(third.created).toBe(1);
    const rows = repoRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("nodejs/node");
    expect(rows[0]?.id).not.toBe(firstId);
    expect(rows[0]?.origin).toBe("account_sync");
  });

  it("keeps the backup when the delete itself fails", async () => {
    const { syncId, provider } = starredSetup(
      [[repo("nodejs/node"), repo("doomed/repo")], [repo("nodejs/node")]],
      { "doomed/repo": "accessible" },
    );
    const deps = baseDeps(provider, {
      now: () => 1,
      repos: {
        generateShortId: () => {
          shortIdCounter += 1;
          return `sid${String(shortIdCounter).padStart(5, "0")}`;
        },
        buildSlug: (path, shortId) => `${path.replace(/\//g, "-")}-${shortId}`,
        deleteRepo: () => Promise.reject(new Error("disk is read only")),
      },
    });

    await runAccountSyncDetailed(db, syncId, deps);
    const second = await runAccountSyncDetailed(db, syncId, deps);

    expect(second.removed).toBe(0);
    expect(second.retained).toBe(1);
    expect(repoRows().map((row) => row.path)).toContain("doomed/repo");
  });
});

describe("scheduling helpers", () => {
  it("lists only enabled syncs that are due, never-run ones first", () => {
    const { accountId } = seed();
    const owned = createSync(accountId, "owned");
    const starred = createSync(accountId, "starred");
    const disabled = db.run(
      `INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      1,
      "other",
      0,
      1,
      1,
    ).lastInsertRowid;
    const off = createSync(disabled, "owned", { enabled: 0 });

    db.run("UPDATE account_syncs SET next_run_at = ? WHERE id = ?", 5_000, starred);
    db.run("UPDATE account_syncs SET next_run_at = ? WHERE id = ?", 50_000, off);

    const due = listDueAccountSyncs(db, 10_000).map((row) => row.id);
    expect(due).toEqual([owned, starred]);

    db.run("UPDATE account_syncs SET next_run_at = ? WHERE id = ?", 90_000, owned);
    expect(listDueAccountSyncs(db, 10_000).map((row) => row.id)).toEqual([starred]);
  });

  it("runs every due sync and reschedules them", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId);
    const provider = fakeProvider({ repos: [[repo("octocat/one")]] });

    const results = await runDueAccountSyncs(db, baseDeps(provider, { now: () => 3_000 }));

    expect(results).toHaveLength(1);
    expect(results[0]?.created).toBe(1);
    expect(listDueAccountSyncs(db, 3_000)).toEqual([]);
    expect(results[0]?.accountSync.id).toBe(syncId);
  });
});
