import { rmSync } from "node:fs";
import { join } from "node:path";
import { repoListQuerySchema, type AmberEventType } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createRepo, getRepoFor, listRepos, listSyncRuns } from "../src/domain/repos.ts";
import {
  lookupRepoInfo,
  resolvePendingForks,
  STARS_ANONYMOUS_RESERVE,
  type AnonymousBudget,
} from "../src/providers/forks.ts";
import { githubProvider, githubStars } from "../src/providers/github.ts";
import type { AccountSyncProvider, DiscoveryContext, RepoInfo } from "../src/providers/types.ts";
import { recordStars, type RepoInfoLookup } from "../src/sync/stars.ts";
import { syncRepo } from "../src/sync/syncRepo.ts";
import {
  createOrigin,
  createTestDb,
  fixedSettings,
  insertForge,
  insertRepo,
  silentLog,
  tempDir,
  type OriginRepo,
} from "./helpers/gitFixtures.ts";
import { findUserByEmail, updateUser } from "../src/domain/users.ts";
import { asUser } from "./helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "./helpers.ts";
import { adminOf, makeUser } from "./helpers/users.ts";
import { context, JSON_HEADERS, mockHttp, type MockHttp } from "./providers/support.ts";

const NOT_FORK = { status: "not_fork" } as const;

function info(stars: number | null, isPrivate: boolean | null = null): RepoInfo {
  return { fork: NOT_FORK, isPrivate, sizeBytes: null, stars };
}

// ---------------------------------------------------------------------------
// The GitHub mapping
// ---------------------------------------------------------------------------

describe("githubStars", () => {
  it.each([
    [0, 0],
    [1234, 1234],
  ])("maps stargazers_count %i", (raw, expected) => {
    expect(githubStars({ stargazers_count: raw })).toBe(expected);
  });

  it("is null when the field is absent", () => {
    expect(githubStars({})).toBeNull();
  });

  it.each(["12", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, null, true])(
    "is null for a malformed count (%s)",
    (raw) => {
      expect(githubStars({ stargazers_count: raw })).toBeNull();
    },
  );
});

describe("github getRepoInfo stars over a mocked forge", () => {
  const API = "https://api.github.com";
  let http: MockHttp;

  beforeEach(() => {
    http = mockHttp();
  });

  afterEach(async () => {
    await http.close();
  });

  function ask(path: string): Promise<RepoInfo> {
    const getRepoInfo = githubProvider.getRepoInfo;
    if (getRepoInfo === undefined) {
      throw new Error("the GitHub provider must implement getRepoInfo");
    }
    return getRepoInfo(context({ fetch: http.fetch }), path);
  }

  it("reads stargazers_count from the repository response", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/starry", method: "GET" })
      .reply(
        200,
        { full_name: "me/starry", private: false, fork: false, stargazers_count: 34567 },
        { headers: JSON_HEADERS },
      );
    expect((await ask("me/starry")).stars).toBe(34567);
  });

  it("reports no count when the response omits it", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/plain", method: "GET" })
      .reply(
        200,
        { full_name: "me/plain", private: false, fork: false },
        { headers: JSON_HEADERS },
      );
    expect((await ask("me/plain")).stars).toBeNull();
  });

  it("reports no count on a failure", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/gone", method: "GET" })
      .reply(404, { message: "Not Found" }, { headers: JSON_HEADERS });
    expect((await ask("me/gone")).stars).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recording after a sync
// ---------------------------------------------------------------------------

describe("recording star counts after a sync", () => {
  let root: string;
  let db: Db;
  let origin: OriginRepo;
  let forgeSeq = 0;

  beforeEach(async () => {
    root = tempDir("stars");
    db = createTestDb(root);
    origin = await createOrigin(join(root, "origin"));
    await origin.commitFile("README.md", "hello\n", "initial commit");
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function repoOn(kind: string): number {
    forgeSeq += 1;
    const forgeId = insertForge(db, { host: `forge${String(forgeSeq)}.example.com`, kind });
    return insertRepo(db, { forgeId, path: "acme/widgets" });
  }

  function starsOf(repoId: number): { stars: number | null; stars_checked_at: number | null } {
    return db.get<{ stars: number | null; stars_checked_at: number | null }>(
      "SELECT stars, stars_checked_at FROM repos WHERE id = ?",
      repoId,
    )!;
  }

  function runStars(runId: number): number | null {
    return db.get<{ stars: number | null }>("SELECT stars FROM sync_runs WHERE id = ?", runId)!
      .stars;
  }

  async function sync(
    repoId: number,
    lookup: RepoInfoLookup,
    extra: { remoteUrl?: string; events?: AmberEventType[]; starsTimeoutMs?: number } = {},
  ) {
    return syncRepo({
      repoId,
      db,
      backupsDir: join(root, "backups"),
      stateDir: join(root, "state"),
      logger: silentLog,
      settings: fixedSettings(),
      remoteUrl: extra.remoteUrl ?? origin.url,
      allowFileProtocol: true,
      repoInfo: lookup,
      now: () => 5000,
      ...(extra.starsTimeoutMs === undefined ? {} : { starsTimeoutMs: extra.starsTimeoutMs }),
      events: {
        publish(type) {
          extra.events?.push(type);
        },
      },
    });
  }

  it("writes the count to the repo row and to that run after a successful GitHub sync", async () => {
    const repoId = repoOn("github");
    const asked: { repoId: number; path: string | undefined }[] = [];
    const events: AmberEventType[] = [];
    const run = await sync(
      repoId,
      (_db, id, options) => {
        asked.push({ repoId: id, path: options?.path });
        return Promise.resolve(info(42));
      },
      { events },
    );
    expect(run.outcome).toBe("success");
    expect(run.stars).toBe(42);
    expect(asked).toEqual([{ repoId, path: "acme/widgets" }]);
    expect(starsOf(repoId)).toEqual({ stars: 42, stars_checked_at: 5000 });
    expect(runStars(run.id)).toBe(42);
    // After sync.finished, so the lookup never delays the outcome.
    expect(events.indexOf("repo.updated")).toBeGreaterThan(events.indexOf("sync.finished"));
  });

  it("keeps the last known count when a later lookup answers nothing", async () => {
    const repoId = repoOn("github");
    const first = await sync(repoId, () => Promise.resolve(info(42)));
    const second = await sync(repoId, () => Promise.resolve(null));
    const third = await sync(repoId, () => Promise.resolve(info(null)));
    expect(second.outcome).toBe("success");
    expect(runStars(first.id)).toBe(42);
    expect(runStars(second.id)).toBeNull();
    expect(runStars(third.id)).toBeNull();
    expect(starsOf(repoId).stars).toBe(42);
  });

  it("never looks up after a failed sync", async () => {
    const repoId = repoOn("github");
    let calls = 0;
    const run = await sync(
      repoId,
      () => {
        calls += 1;
        return Promise.resolve(info(9));
      },
      { remoteUrl: `${origin.url}-does-not-exist` },
    );
    expect(run.outcome).toBe("error");
    expect(calls).toBe(0);
    expect(run.stars).toBeNull();
    expect(starsOf(repoId).stars).toBeNull();
  });

  it.each(["generic", "gitlab", "gitea"])("never looks up for a %s forge", async (kind) => {
    const repoId = repoOn(kind);
    let calls = 0;
    const run = await sync(repoId, () => {
      calls += 1;
      return Promise.resolve(info(9));
    });
    expect(run.outcome).toBe("success");
    expect(calls).toBe(0);
    expect(starsOf(repoId).stars).toBeNull();
  });

  it("does not pin the old path's count on a repo renamed during the lookup", async () => {
    const repoId = repoOn("github");
    const run = await sync(repoId, (lookupDb, id) => {
      lookupDb.run("UPDATE repos SET path = 'acme/renamed' WHERE id = ?", id);
      return Promise.resolve(info(7));
    });
    expect(run.outcome).toBe("success");
    expect(run.stars).toBeNull();
    expect(starsOf(repoId).stars).toBeNull();
    expect(runStars(run.id)).toBeNull();
  });

  it("never fails the sync when the lookup throws", async () => {
    const repoId = repoOn("github");
    const run = await sync(repoId, () => Promise.reject(new Error("no secret key")));
    expect(run.outcome).toBe("success");
    expect(starsOf(repoId).stars).toBeNull();
  });

  it("stops waiting for a lookup that outlives the ceiling", async () => {
    const repoId = repoOn("github");
    const started = Date.now();
    const run = await sync(repoId, () => new Promise<RepoInfo | null>(() => undefined), {
      starsTimeoutMs: 20,
    });
    expect(run.outcome).toBe("success");
    expect(run.stars).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// Through the shared lookup: the same rules as every other single-repo GET
// ---------------------------------------------------------------------------

describe("the star lookup goes through lookupRepoInfo's rules", () => {
  let root: string;
  let db: Db;

  beforeEach(() => {
    root = tempDir("stars-rules");
    db = createTestDb(root);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function stub(answer: RepoInfo, seen: DiscoveryContext[]): AccountSyncProvider {
    return {
      kind: "github",
      async *listRepos() {
        // Not used here.
      },
      getRepoInfo: (ctx) => {
        seen.push(ctx);
        return Promise.resolve(answer);
      },
    };
  }

  function record(
    repoId: number,
    provider: AccountSyncProvider,
    budget = new Map<number, AnonymousBudget>(),
  ): Promise<number | null> {
    const runId = db.run(
      "INSERT INTO sync_runs (repo_id, started_at, outcome, created_at, updated_at) VALUES (?, 1, 'success', 1, 1)",
      repoId,
    ).lastInsertRowid;
    return recordStars({
      db,
      repoId,
      runId,
      fetchedPath: "acme/widgets",
      forgeKind: "github",
      lookup: (lookupDb, id, options) =>
        lookupRepoInfo(
          lookupDb,
          id,
          { providerFor: () => provider, cooldowns: new Map(), anonymousBudget: budget },
          options,
        ),
      now: () => 9000,
      log: silentLog,
    });
  }

  function restrictedRepo(ownerUserId: number): number {
    const forgeId = insertForge(db, {
      host: "github.example.com",
      kind: "github",
      allowPrivateNetwork: false,
    });
    return createRepo(db, { forgeId, path: "acme/widgets", ownerUserId }).id;
  }

  it("records the count and applies the same response's visibility answer", async () => {
    const repoId = restrictedRepo(adminOf(db).id);
    db.run("UPDATE repos SET is_private = 1 WHERE id = ?", repoId);
    const seen: DiscoveryContext[] = [];
    expect(await record(repoId, stub(info(321, false), seen))).toBe(321);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.token).toBeNull();
    expect(
      db.get("SELECT stars, stars_checked_at, is_private FROM repos WHERE id = ?", repoId),
    ).toEqual({ stars: 321, stars_checked_at: 9000, is_private: 0 });
  });

  it("does not ask once the forge's anonymous budget is spent", async () => {
    const repoId = restrictedRepo(adminOf(db).id);
    const forgeId = db.get<{ forge_id: number }>(
      "SELECT forge_id FROM repos WHERE id = ?",
      repoId,
    )!.forge_id;
    const seen: DiscoveryContext[] = [];
    const spent = new Map<number, AnonymousBudget>([
      [forgeId, { windowStart: Date.now(), used: 30 }],
    ]);
    expect(await record(repoId, stub(info(5), seen), spent)).toBeNull();
    expect(seen).toEqual([]);
    expect(db.get("SELECT stars FROM repos WHERE id = ?", repoId)).toEqual({ stars: null });
  });

  it("leaves half the anonymous allowance to the visibility pass", async () => {
    const repoId = restrictedRepo(adminOf(db).id);
    const forgeId = db.get<{ forge_id: number }>(
      "SELECT forge_id FROM repos WHERE id = ?",
      repoId,
    )!.forge_id;
    expect(STARS_ANONYMOUS_RESERVE).toBe(15);
    const seen: DiscoveryContext[] = [];
    const provider = stub(info(5, false), seen);
    const budget = new Map<number, AnonymousBudget>([
      [forgeId, { windowStart: Date.now(), used: 15 }],
    ]);

    // Half spent: stars record nothing and spend nothing.
    expect(await record(repoId, provider, budget)).toBeNull();
    expect(seen).toEqual([]);
    expect(budget.get(forgeId)?.used).toBe(15);
    expect(db.get("SELECT stars FROM repos WHERE id = ?", repoId)).toEqual({ stars: null });

    // The visibility pass still has the rest of the allowance.
    const result = await resolvePendingForks(db, {
      providerFor: () => provider,
      cooldowns: new Map(),
      anonymousBudget: budget,
    });
    expect(result.asked).toBe(1);
    expect(seen).toHaveLength(1);
    expect(budget.get(forgeId)?.used).toBe(16);
  });

  it("spends an anonymous lookup while more than half the allowance is left", async () => {
    const repoId = restrictedRepo(adminOf(db).id);
    const forgeId = db.get<{ forge_id: number }>(
      "SELECT forge_id FROM repos WHERE id = ?",
      repoId,
    )!.forge_id;
    const seen: DiscoveryContext[] = [];
    const budget = new Map<number, AnonymousBudget>([
      [forgeId, { windowStart: Date.now(), used: 14 }],
    ]);
    expect(await record(repoId, stub(info(5), seen), budget)).toBe(5);
    expect(seen).toHaveLength(1);
    // Never below half: 15 of 30 remain.
    expect(budget.get(forgeId)?.used).toBe(15);
  });

  it("never asks an unrestricted forge on a non-admin's behalf", async () => {
    const alice = makeUser(db, "alice@example.com", { import_private: true });
    const forgeId = insertForge(db, { host: "lan.example.com", kind: "github" });
    const repoId = createRepo(db, { forgeId, path: "acme/widgets", ownerUserId: alice.id }).id;
    const seen: DiscoveryContext[] = [];
    expect(await record(repoId, stub(info(5), seen))).toBeNull();
    expect(seen).toEqual([]);
  });

  it("does not spend a lookup on a path the repo no longer has", async () => {
    const repoId = restrictedRepo(adminOf(db).id);
    db.run("UPDATE repos SET path = 'acme/other' WHERE id = ?", repoId);
    const seen: DiscoveryContext[] = [];
    expect(await record(repoId, stub(info(5), seen))).toBeNull();
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The API view: sort and redaction
// ---------------------------------------------------------------------------

describe("stars in the repo list and run history", () => {
  let root: string;
  let db: Db;
  let forgeId: number;

  beforeEach(() => {
    root = tempDir("stars-api");
    db = createTestDb(root);
    forgeId = insertForge(db, {
      host: "github.example.com",
      kind: "github",
      allowPrivateNetwork: false,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function repo(
    path: string,
    ownerUserId: number,
    stars: number | null,
    isPrivate: boolean,
  ): number {
    const id = createRepo(db, { forgeId, path, ownerUserId }).id;
    db.run(
      "UPDATE repos SET stars = ?, stars_checked_at = ?, is_private = ? WHERE id = ?",
      stars,
      stars === null ? null : 100,
      isPrivate ? 1 : 0,
      id,
    );
    return id;
  }

  function sorted(viewer = adminOf(db), dir: "asc" | "desc" = "asc"): string[] {
    return listRepos(
      db,
      viewer,
      repoListQuerySchema.parse({ sort: "stars", dir, perPage: 100 }),
    ).rows.map((row) => `${row.path}:${String(row.stars)}`);
  }

  it("sorts by stars with never-reported counts last in both directions", () => {
    const admin = adminOf(db).id;
    repo("acme/none", admin, null, false);
    repo("acme/few", admin, 3, false);
    repo("acme/many", admin, 3000, false);
    repo("acme/zero", admin, 0, false);
    expect(sorted()).toEqual(["acme/zero:0", "acme/few:3", "acme/many:3000", "acme/none:null"]);
    expect(sorted(adminOf(db), "desc")).toEqual([
      "acme/many:3000",
      "acme/few:3",
      "acme/zero:0",
      "acme/none:null",
    ]);
  });

  it("hides a private repo's count from a viewer who is neither owner nor admin", () => {
    const alice = makeUser(db, "alice@example.com", { import_private: true });
    const bob = makeUser(db, "bob@example.com", {
      view_others_public: true,
      view_others_private: true,
    });
    const secret = repo("acme/secret", alice.id, 500, true);
    const open = repo("acme/open", alice.id, 7, false);
    const runSql =
      "INSERT INTO sync_runs (repo_id, started_at, outcome, stars, created_at, updated_at) VALUES (?, 1, 'success', ?, 1, 1)";
    db.run(runSql, secret, 500);
    db.run(runSql, open, 7);

    expect(getRepoFor(db, secret, bob)).toMatchObject({ stars: null, starsCheckedAt: null });
    expect(getRepoFor(db, open, bob)).toMatchObject({ stars: 7, starsCheckedAt: 100 });
    expect(getRepoFor(db, secret, alice)).toMatchObject({ stars: 500, starsCheckedAt: 100 });
    expect(getRepoFor(db, secret, adminOf(db))).toMatchObject({ stars: 500 });

    const query = { page: 1, perPage: 10 };
    expect(listSyncRuns(db, secret, query, bob).rows.map((run) => run.stars)).toEqual([null]);
    expect(listSyncRuns(db, open, query, bob).rows.map((run) => run.stars)).toEqual([7]);
    expect(listSyncRuns(db, secret, query, alice).rows.map((run) => run.stars)).toEqual([500]);

    // The order follows what the viewer is shown, so it cannot leak the hidden count.
    expect(sorted(bob, "desc")).toEqual(["acme/open:7", "acme/secret:null"]);
    expect(sorted(alice, "desc")).toEqual(["acme/secret:500", "acme/open:7"]);
  });
});

describe("stars over HTTP", () => {
  const OWNER = "owner@example.com";
  const OTHER = "other@example.com";
  let temp: TempApp;
  let secret: number;
  let open: number;

  beforeEach(async () => {
    temp = await createTempApp({ INSECURE_USER_EMAILS: `${OWNER},${OTHER}` });
    const owner = findUserByEmail(temp.db, OWNER)!;
    const other = findUserByEmail(temp.db, OTHER)!;
    updateUser(temp.db, other.id, {
      permissions: { view_others_public: true, view_others_private: true },
    });
    const forgeId = seedForge(temp.db);
    secret = createRepo(temp.db, { forgeId, path: "acme/secret", ownerUserId: owner.id }).id;
    open = createRepo(temp.db, { forgeId, path: "acme/open", ownerUserId: owner.id }).id;
    temp.db.run(
      "UPDATE repos SET stars = 900, stars_checked_at = 50, is_private = 1 WHERE id = ?",
      secret,
    );
    temp.db.run(
      "UPDATE repos SET stars = 12, stars_checked_at = 60, is_private = 0 WHERE id = ?",
      open,
    );
    const runSql =
      "INSERT INTO sync_runs (repo_id, started_at, outcome, stars, created_at, updated_at) VALUES (?, 1, 'success', ?, 1, 1)";
    temp.db.run(runSql, secret, 900);
    temp.db.run(runSql, open, 12);
  });

  afterEach(async () => {
    await temp.close();
  });

  interface Row {
    path: string;
    stars: number | null;
    starsCheckedAt: number | null;
  }

  async function list(email: string | null): Promise<Row[]> {
    const response = await temp.app.inject({
      method: "GET",
      url: "/api/repos?sort=stars&dir=desc",
      headers: email === null ? {} : asUser(email),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ rows: Row[] }>().rows.map((row) => ({
      path: row.path,
      stars: row.stars,
      starsCheckedAt: row.starsCheckedAt,
    }));
  }

  async function runs(id: number, email: string | null): Promise<(number | null)[]> {
    const response = await temp.app.inject({
      method: "GET",
      url: `/api/repos/${String(id)}/runs`,
      headers: email === null ? {} : asUser(email),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ rows: { stars: number | null }[] }>().rows.map((run) => run.stars);
  }

  it("sorts by stars and carries the count on rows and runs", async () => {
    expect(await list(null)).toEqual([
      { path: "acme/secret", stars: 900, starsCheckedAt: 50 },
      { path: "acme/open", stars: 12, starsCheckedAt: 60 },
    ]);
    expect(await list(OWNER)).toEqual(await list(null));
    expect(await runs(secret, OWNER)).toEqual([900]);
  });

  it("hides a private repo's count from someone else, in the list order too", async () => {
    expect(await list(OTHER)).toEqual([
      { path: "acme/open", stars: 12, starsCheckedAt: 60 },
      { path: "acme/secret", stars: null, starsCheckedAt: null },
    ]);
    expect(await runs(secret, OTHER)).toEqual([null]);
    expect(await runs(open, OTHER)).toEqual([12]);
  });

  it("refuses an unknown sort", async () => {
    const response = await temp.app.inject({ method: "GET", url: "/api/repos?sort=stargazers" });
    expect(response.statusCode).toBe(400);
  });
});
