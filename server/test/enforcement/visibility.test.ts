import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ForgeKind } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.ts";
import { buildSlug, createRepo, generateShortId, updateRepo } from "../../src/domain/repos.ts";
import { upsertDiscoveredRepos } from "../../src/providers/discovery.ts";
import {
  ANONYMOUS_LOOKUPS_PER_HOUR,
  FORK_BATCH_SIZE,
  FORK_RATE_LIMIT_COOLDOWN_MS,
  FORK_RECHECK_MS,
  VISIBILITY_RECHECK_MS,
  lookupRepoInfo,
  resolvePendingForks,
  type AnonymousBudget,
  type ForkResolverDeps,
} from "../../src/providers/forks.ts";
import { bitbucketVisibility } from "../../src/providers/bitbucket.ts";
import { giteaVisibility } from "../../src/providers/gitea.ts";
import { githubProvider, githubVisibility } from "../../src/providers/github.ts";
import { gitlabVisibility } from "../../src/providers/gitlab.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
  ForkLookup,
  RepoInfo,
} from "../../src/providers/types.ts";
import { syncRepo } from "../../src/sync/syncRepo.ts";
import { createTempDb, seedForge, type TempDb } from "../helpers.ts";
import {
  createOrigin,
  createTestDb,
  fixedSettings,
  insertForge,
  insertRepo,
  silentLog,
  tempDir,
  type OriginRepo,
} from "../helpers/gitFixtures.ts";
import { createRecordingGit, fakeDns, PUBLIC_V4 } from "../helpers/egress.ts";
import { adminOf, makeUser } from "../helpers/users.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "../providers/support.ts";

/**
 * Visibility enforcement. `repos.is_private` decides who may see a repository,
 * so every way it can be written is checked here against the one property that
 * matters: it only ever becomes public (0) on the forge's own word or on an
 * anonymous fetch that worked, and anything unknown, garbage or missing stays
 * private.
 */

const HOUR_MS = 3_600_000;
const NOW = 10 * FORK_RECHECK_MS;

// ---------------------------------------------------------------------------
// 1. The four fail-closed visibility predicates
// ---------------------------------------------------------------------------

const GARBAGE: unknown[] = [undefined, null, "", "false", "true", "yes", 0, 1, [], {}, "PUBLIC"];

describe("visibility predicates fail closed", () => {
  const github: [string, { private?: unknown; visibility?: unknown }, boolean | null][] = [
    ["private true, no visibility", { private: true }, true],
    ["private true, visibility public", { private: true, visibility: "public" }, true],
    ["private false, no visibility", { private: false }, false],
    ["private false, visibility public", { private: false, visibility: "public" }, false],
    ["private false, visibility private", { private: false, visibility: "private" }, true],
    ["private false, visibility internal", { private: false, visibility: "internal" }, true],
    ["private false, visibility garbage string", { private: false, visibility: "open" }, null],
    ["private false, visibility number", { private: false, visibility: 1 }, null],
    ["private false, visibility null", { private: false, visibility: null }, null],
    ["private missing, visibility public", { visibility: "public" }, null],
    ["private missing, visibility private", { visibility: "private" }, true],
    ["private missing, visibility internal", { visibility: "internal" }, true],
    ["private missing, visibility missing", {}, null],
    ["private as the string false", { private: "false" }, null],
    ["private as zero", { private: 0 }, null],
    ["private null", { private: null }, null],
    ["private null, visibility public", { private: null, visibility: "public" }, null],
  ];

  it.each(github)("github: %s", (_name, raw, expected) => {
    expect(githubVisibility(raw)).toBe(expected);
  });

  it("github: public only for a literal private:false that is not contradicted", () => {
    for (const isPrivate of GARBAGE.concat([true, false])) {
      for (const visibility of GARBAGE.concat(["public", "private", "internal"])) {
        const answer = githubVisibility({ private: isPrivate, visibility });
        const shouldBePublic =
          isPrivate === false && (visibility === undefined || visibility === "public");
        expect(
          answer === false,
          `private=${JSON.stringify(isPrivate)} visibility=${JSON.stringify(visibility)}`,
        ).toBe(shouldBePublic);
      }
    }
  });

  const gitea: [string, { private?: unknown; internal?: unknown }, boolean | null][] = [
    ["private true", { private: true }, true],
    ["private true, internal false", { private: true, internal: false }, true],
    ["private false", { private: false }, false],
    ["private false, internal false", { private: false, internal: false }, false],
    ["private false, internal true", { private: false, internal: true }, true],
    ["private missing, internal true", { internal: true }, true],
    ["private missing", {}, null],
    ["private missing, internal false", { internal: false }, null],
    ["private as the string false", { private: "false" }, null],
    ["private as zero", { private: 0 }, null],
    ["private null", { private: null }, null],
  ];

  it.each(gitea)("gitea: %s", (_name, raw, expected) => {
    expect(giteaVisibility(raw)).toBe(expected);
  });

  const gitlab: [string, { visibility?: unknown }, boolean | null][] = [
    ["public", { visibility: "public" }, false],
    ["private", { visibility: "private" }, true],
    ["internal", { visibility: "internal" }, true],
    ["missing", {}, null],
    ["null", { visibility: null }, null],
    ["empty string", { visibility: "" }, null],
    ["wrong case", { visibility: "Public" }, null],
    ["trailing space", { visibility: "public " }, null],
    ["a number", { visibility: 20 }, null],
    ["a boolean", { visibility: true }, null],
  ];

  it.each(gitlab)("gitlab: %s", (_name, raw, expected) => {
    expect(gitlabVisibility(raw)).toBe(expected);
  });

  const bitbucket: [string, { is_private?: unknown }, boolean | null][] = [
    ["is_private true", { is_private: true }, true],
    ["is_private false", { is_private: false }, false],
    ["is_private missing", {}, null],
    ["is_private null", { is_private: null }, null],
    ["is_private as the string false", { is_private: "false" }, null],
    ["is_private as zero", { is_private: 0 }, null],
  ];

  it.each(bitbucket)("bitbucket: %s", (_name, raw, expected) => {
    expect(bitbucketVisibility(raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. A real provider, over HTTP
// ---------------------------------------------------------------------------

describe("github getRepoInfo and listings over a mocked forge", () => {
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

  it("reads a public repository: visibility from the field, size in bytes", async () => {
    http.pool(API).intercept({ path: "/repos/me/open", method: "GET" }).reply(
      200,
      {
        full_name: "me/open",
        private: false,
        visibility: "public",
        fork: false,
        size: 10,
        stargazers_count: 1234,
      },
      { headers: JSON_HEADERS },
    );

    expect(await ask("me/open")).toEqual({
      fork: { status: "not_fork" },
      isPrivate: false,
      sizeBytes: 10 * 1024,
      stars: 1234,
    });
  });

  it("reads a private repository as private", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/closed", method: "GET" })
      .reply(
        200,
        { full_name: "me/closed", private: true, visibility: "private", fork: false },
        { headers: JSON_HEADERS },
      );

    expect(await ask("me/closed")).toMatchObject({ isPrivate: true });
  });

  it.each([
    ["no private field", { full_name: "me/odd", fork: false }],
    ["private as a string", { full_name: "me/odd", private: "false", fork: false }],
    [
      "private false but an unknown visibility",
      { full_name: "me/odd", private: false, visibility: "open" },
    ],
  ])("a 200 with %s is an answer that is not public: private", async (_name, body) => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/odd", method: "GET" })
      .reply(200, body, { headers: JSON_HEADERS });

    expect((await ask("me/odd")).isPrivate).toBe(true);
  });

  it.each([
    ["size 0 (not measured yet)", { size: 0 }],
    ["no size", {}],
    ["a string size", { size: "10" }],
    ["a negative size", { size: -4 }],
  ])("reports no size for %s", async (_name, extra) => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/sized", method: "GET" })
      .reply(
        200,
        { full_name: "me/sized", private: false, fork: false, ...extra },
        { headers: JSON_HEADERS },
      );

    expect((await ask("me/sized")).sizeBytes).toBeNull();
  });

  // A definitive refusal is an answer about visibility: whoever asked cannot
  // see it, so it is private (team-lead decision: fail closed on a repo that
  // went private upstream). Only a non-answer leaves the flag alone.
  it("answers an unknown fork but PRIVATE visibility for a 404", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/gone", method: "GET" })
      .reply(404, { message: "Not Found" }, { headers: JSON_HEADERS });

    expect(await ask("me/gone")).toEqual({
      fork: { status: "unknown", rateLimited: false },
      isPrivate: true,
      sizeBytes: null,
      stars: null,
    });
  });

  it("answers private for a 403 that is not a rate limit, and nothing for a 5xx", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/forbidden", method: "GET" })
      .reply(403, { message: "Forbidden" }, { headers: JSON_HEADERS });
    http
      .pool(API)
      .intercept({ path: "/repos/me/broken", method: "GET" })
      .reply(502, { message: "Bad gateway" }, { headers: JSON_HEADERS });

    expect((await ask("me/forbidden")).isPrivate).toBe(true);
    expect((await ask("me/broken")).isPrivate).toBeNull();
  });

  it.each([
    ["403 with the quota spent", 403, { "x-ratelimit-remaining": "0" }],
    ["429", 429, {}],
  ])("reports a rate limit for %s", async (_name, status, headers) => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/limited", method: "GET" })
      .reply(
        status,
        { message: "API rate limit exceeded" },
        { headers: { ...JSON_HEADERS, ...headers } },
      );

    expect(await ask("me/limited")).toEqual({
      fork: { status: "unknown", rateLimited: true },
      isPrivate: null,
      sizeBytes: null,
      stars: null,
    });
  });

  it("a listing marks everything short of a confirmed public as private", async () => {
    const entry = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      full_name: `octocat/${name}`,
      default_branch: "main",
      ...extra,
    });
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(
        200,
        [
          entry("public", { private: false }),
          entry("private", { private: true }),
          entry("missing", {}),
          entry("stringy", { private: "false" }),
          entry("internal", { private: false, visibility: "internal" }),
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(githubProvider.listRepos(context({ fetch: http.fetch })));

    expect(repos.map((repo) => [repo.path, repo.isPrivate])).toEqual([
      ["octocat/public", false],
      ["octocat/private", true],
      ["octocat/missing", true],
      ["octocat/stringy", true],
      ["octocat/internal", true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. The visibility pass, with stub providers
// ---------------------------------------------------------------------------

let temp: TempDb;
let db: Db;
let github: number;
let gitlab: number;
let calls: { path: string; forgeId: number; context: DiscoveryContext }[];
let answers: Map<string, RepoInfo | Error>;
let clock: number;
let seq: number;

const NOT_FORK: ForkLookup = { status: "not_fork" };
const LIMITED: RepoInfo = {
  fork: { status: "unknown", rateLimited: true },
  isPrivate: null,
  sizeBytes: null,
  stars: null,
};

function answer(isPrivate: boolean | null, fork: ForkLookup = NOT_FORK): RepoInfo {
  return { fork, isPrivate, sizeBytes: null, stars: null };
}

interface RepoSpec {
  forgeId?: number;
  path: string;
  owner?: number;
  /** Fork knowledge is settled by default so only visibility drives selection. */
  forkKnown?: boolean;
  isPrivate?: boolean;
  checkedAt?: number | null;
  override?: number | null;
  anonymous?: boolean;
}

function addRepo(spec: RepoSpec): number {
  seq += 1;
  const forgeId = spec.forgeId ?? github;
  return db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, owner_user_id, fork_known,
                        is_private, visibility_checked_at, account_override_id, force_anonymous,
                        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    forgeId,
    spec.path,
    spec.path,
    `slug-${String(seq)}`,
    `id-${String(seq)}`,
    spec.owner ?? adminOf(db).id,
    spec.forkKnown === false ? 0 : 1,
    spec.isPrivate === false ? 0 : 1,
    spec.checkedAt ?? null,
    spec.override ?? null,
    spec.anonymous === true ? 1 : 0,
  ).lastInsertRowid;
}

/** An account whose stored "secret" is the token itself, so the token is observable. */
function addAccount(
  forgeId: number,
  owner: number,
  username: string,
  token: string | null,
  isDefault: boolean,
): number {
  return db.run(
    `INSERT INTO accounts (forge_id, username, secret_enc, is_default, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
    forgeId,
    username,
    token === null ? null : new Uint8Array(Buffer.from(token, "utf8")),
    isDefault ? 1 : 0,
    owner,
  ).lastInsertRowid;
}

interface VisibilityRow {
  is_private: number;
  visibility_checked_at: number | null;
  fork_checked_at: number | null;
  fork_known: number;
  fork_parent: string | null;
}

function row(id: number): VisibilityRow {
  return db.get<VisibilityRow>(
    "SELECT is_private, visibility_checked_at, fork_checked_at, fork_known, fork_parent FROM repos WHERE id = ?",
    id,
  )!;
}

function providerOf(kind: ForgeKind): AccountSyncProvider {
  return {
    kind,
    async *listRepos() {
      await Promise.resolve();
      yield* [];
    },
    getRepoInfo(ctx, path) {
      calls.push({ path, forgeId: forgeIdOf(ctx.baseUrl), context: ctx });
      const given = answers.get(path) ?? answer(null);
      return given instanceof Error ? Promise.reject(given) : Promise.resolve(given);
    },
  };
}

function forgeIdOf(baseUrl: string): number {
  return baseUrl.includes("gitlab") ? gitlab : github;
}

function deps(extra: Partial<ForkResolverDeps> = {}): ForkResolverDeps {
  return {
    now: () => clock,
    secretKey: Buffer.alloc(32, 1),
    decryptSecret: (_key, blob) => blob.toString("utf8"),
    providerFor: (kind) =>
      kind === "gitea" ? { kind, listRepos: providerOf(kind).listRepos } : providerOf(kind),
    ...extra,
  };
}

function askedPaths(): string[] {
  return calls.map((call) => call.path);
}

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  github = seedForge(db, "github.com");
  gitlab = seedForge(db, "gitlab.com", "gitlab");
  calls = [];
  answers = new Map();
  clock = NOW;
  seq = 0;
});

afterEach(() => {
  temp.close();
});

describe("the visibility pass: what it asks and what it writes", () => {
  it("backfills: confirmed-public flips to public, everything else stays private", async () => {
    const open = addRepo({ path: "me/open" });
    const closed = addRepo({ path: "me/closed" });
    const unknown = addRepo({ path: "me/unknown" });
    answers.set("me/open", answer(false));
    answers.set("me/closed", answer(true));
    answers.set("me/unknown", answer(null));
    const resolved: number[] = [];

    const result = await resolvePendingForks(db, deps({ onResolved: (id) => resolved.push(id) }));

    expect(row(open)).toMatchObject({ is_private: 0, visibility_checked_at: NOW });
    expect(row(closed)).toMatchObject({ is_private: 1, visibility_checked_at: NOW });
    expect(row(unknown)).toMatchObject({ is_private: 1, visibility_checked_at: NOW });
    expect(result).toMatchObject({ asked: 3, visibilityResolved: 2 });
    // Only the repo whose visibility actually changed is announced.
    expect(resolved).toEqual([open]);
  });

  it("a repo whose fork is already known but whose visibility was never checked IS asked", async () => {
    const id = addRepo({ path: "me/known-fork", forkKnown: true, checkedAt: null });
    answers.set("me/known-fork", answer(false));

    await resolvePendingForks(db, deps());

    expect(askedPaths()).toEqual(["me/known-fork"]);
    expect(row(id).is_private).toBe(0);
  });

  it("a repo with an unknown fork parent is asked even when its visibility is fresh", async () => {
    const id = addRepo({ path: "me/fork-due", forkKnown: false, checkedAt: NOW });
    answers.set("me/fork-due", answer(true, { status: "fork", parent: "up/stream" }));

    await resolvePendingForks(db, deps());

    expect(row(id)).toMatchObject({ fork_parent: "up/stream", fork_known: 1 });
  });

  it("does not ask about a repo checked less than 24 hours ago, and asks again from 24 hours", async () => {
    const fresh = addRepo({ path: "me/fresh", checkedAt: NOW - VISIBILITY_RECHECK_MS + 1 });
    const stale = addRepo({ path: "me/stale", checkedAt: NOW - VISIBILITY_RECHECK_MS });
    const ancient = addRepo({ path: "me/ancient", checkedAt: 1 });

    await resolvePendingForks(db, deps());

    expect(askedPaths().sort()).toEqual(["me/ancient", "me/stale"]);
    expect(row(fresh).visibility_checked_at).toBe(NOW - VISIBILITY_RECHECK_MS + 1);
    expect(row(stale).visibility_checked_at).toBe(NOW);
    expect(row(ancient).visibility_checked_at).toBe(NOW);
  });

  it("a repo answered now is not asked again an hour later, but is a day later", async () => {
    addRepo({ path: "me/a" });
    answers.set("me/a", answer(true));
    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(1);

    clock = NOW + HOUR_MS;
    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(1);

    clock = NOW + VISIBILITY_RECHECK_MS;
    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(2);
  });

  it("asks never-checked repos before ones that are merely due again", async () => {
    addRepo({ path: "me/due-again", checkedAt: 1 });
    addRepo({ path: "me/never" });

    await resolvePendingForks(db, deps(), { batchSize: 1 });

    expect(askedPaths()).toEqual(["me/never"]);
  });

  it("takes a bounded batch, 20 by default", async () => {
    for (let index = 0; index < FORK_BATCH_SIZE + 5; index += 1) {
      addRepo({ path: `me/r${String(index).padStart(2, "0")}` });
    }

    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(FORK_BATCH_SIZE);
  });

  it.each([
    ["private to public", true, false, 0, true],
    ["public to private", false, true, 1, true],
    ["private confirmed private", true, true, 1, false],
    ["public confirmed public", false, false, 0, false],
  ])("a definite answer, %s", async (_name, before, said, after, announced) => {
    const id = addRepo({ path: "me/a", isPrivate: before });
    answers.set("me/a", answer(said));
    const resolved: number[] = [];

    await resolvePendingForks(db, deps({ onResolved: (repoId) => resolved.push(repoId) }));

    expect(row(id)).toMatchObject({ is_private: after, visibility_checked_at: NOW });
    expect(resolved).toEqual(announced ? [id] : []);
  });

  it.each([
    ["private", true, 1],
    ["public", false, 0],
  ])(
    "an unknown answer stamps the check and leaves a %s repo as it was",
    async (_name, before, after) => {
      const id = addRepo({ path: "me/a", isPrivate: before });
      answers.set("me/a", answer(null));
      const resolved: number[] = [];

      await resolvePendingForks(db, deps({ onResolved: (repoId) => resolved.push(repoId) }));

      expect(row(id)).toMatchObject({ is_private: after, visibility_checked_at: NOW });
      expect(resolved).toEqual([]);
    },
  );

  it("a provider that throws is an unknown answer: nothing becomes public", async () => {
    const id = addRepo({ path: "me/a" });
    answers.set("me/a", new Error("socket exploded"));

    await resolvePendingForks(db, deps());

    expect(row(id).is_private).toBe(1);
  });

  it("falls back to getForkParent, which says nothing about visibility", async () => {
    const id = addRepo({ path: "me/a", isPrivate: true });
    const provider: AccountSyncProvider = {
      kind: "github",
      async *listRepos() {
        await Promise.resolve();
        yield* [];
      },
      getForkParent: () => Promise.resolve({ status: "not_fork" }),
    };

    await resolvePendingForks(db, deps({ providerFor: () => provider }));

    expect(row(id)).toMatchObject({ is_private: 1, visibility_checked_at: NOW });
  });

  it("never asks a forge whose provider cannot answer", async () => {
    const gitea = seedForge(db, "gitea.example.com", "gitea");
    const id = addRepo({ forgeId: gitea, path: "me/a" });

    await resolvePendingForks(db, deps());

    expect(calls).toEqual([]);
    expect(row(id)).toMatchObject({ is_private: 1, visibility_checked_at: null });
  });

  describe("rate limits", () => {
    it("write nothing and cool down the anonymous key for the forge", async () => {
      const id = addRepo({ path: "me/a", isPrivate: false, forkKnown: false });
      answers.set("me/a", LIMITED);
      const cooldowns = new Map<string, number>();

      const result = await resolvePendingForks(db, deps({ cooldowns }));

      expect(row(id)).toMatchObject({
        is_private: 0,
        visibility_checked_at: null,
        fork_checked_at: null,
        fork_known: 0,
      });
      expect([...cooldowns.entries()]).toEqual([
        [`${String(github)}:anon`, NOW + FORK_RATE_LIMIT_COOLDOWN_MS],
      ]);
      expect(result.rateLimitedForges).toBe(1);
      expect(result.visibilityResolved).toBe(0);
    });

    it("cool down the account's own key when a token was presented", async () => {
      const owner = makeUser(db, "owner@example.com", { import_private: true });
      const account = addAccount(github, owner.id, "owner-bot", "tok-owner", true);
      addRepo({ path: "me/a", owner: owner.id });
      answers.set("me/a", LIMITED);
      const cooldowns = new Map<string, number>();

      await resolvePendingForks(db, deps({ cooldowns }));

      expect(calls[0]?.context.token).toBe("tok-owner");
      expect([...cooldowns.keys()]).toEqual([`${String(github)}:${String(account)}`]);
    });

    it("stop further anonymous lookups on that forge for the pass, but not other forges", async () => {
      addRepo({ path: "me/a" });
      addRepo({ path: "me/b" });
      addRepo({ forgeId: gitlab, path: "me/c" });
      answers.set("me/a", LIMITED);

      await resolvePendingForks(db, deps());

      expect(askedPaths()).toEqual(["me/a", "me/c"]);
    });

    it("an anonymous cooldown does not stall a token-backed repo on the same forge", async () => {
      const owner = makeUser(db, "owner@example.com", { import_private: true });
      addAccount(github, owner.id, "owner-bot", "tok-owner", true);
      const anonymous = addRepo({ path: "me/anon" });
      const token = addRepo({ path: "me/token", owner: owner.id });
      answers.set("me/anon", LIMITED);
      answers.set("me/token", answer(false));

      await resolvePendingForks(db, deps());

      expect(askedPaths()).toEqual(["me/anon", "me/token"]);
      expect(row(anonymous).visibility_checked_at).toBeNull();
      expect(row(token)).toMatchObject({ is_private: 0, visibility_checked_at: NOW });
    });

    it("a cooldown left by an earlier pass skips only the cooled credential", async () => {
      const owner = makeUser(db, "owner@example.com", { import_private: true });
      const account = addAccount(github, owner.id, "owner-bot", "tok-owner", true);
      addRepo({ path: "me/anon" });
      addRepo({ path: "me/token", owner: owner.id });
      const cooldowns = new Map([[`${String(github)}:anon`, NOW + 1000]]);

      await resolvePendingForks(db, deps({ cooldowns }));
      expect(askedPaths()).toEqual(["me/token"]);

      calls = [];
      db.run("UPDATE repos SET visibility_checked_at = NULL");
      const tokenCooled = new Map([[`${String(github)}:${String(account)}`, NOW + 1000]]);
      await resolvePendingForks(db, deps({ cooldowns: tokenCooled }));
      expect(askedPaths()).toEqual(["me/anon"]);
    });
  });

  describe("the anonymous budget", () => {
    it("never asks more than the hourly allowance anonymously, then continues once the hour is up", async () => {
      const total = ANONYMOUS_LOOKUPS_PER_HOUR + 10;
      for (let index = 0; index < total; index += 1) {
        addRepo({ path: `me/r${String(index).padStart(2, "0")}` });
      }
      const budget = new Map<number, AnonymousBudget>();
      const options = { batchSize: 1000 };

      const first = await resolvePendingForks(db, deps({ anonymousBudget: budget }), options);
      expect(calls).toHaveLength(ANONYMOUS_LOOKUPS_PER_HOUR);
      expect(first.asked).toBe(ANONYMOUS_LOOKUPS_PER_HOUR);

      clock = NOW + HOUR_MS - 1;
      await resolvePendingForks(db, deps({ anonymousBudget: budget }), options);
      expect(calls).toHaveLength(ANONYMOUS_LOOKUPS_PER_HOUR);

      clock = NOW + HOUR_MS;
      await resolvePendingForks(db, deps({ anonymousBudget: budget }), options);
      expect(calls).toHaveLength(total);
      // Each repo was asked exactly once across the three passes.
      expect(new Set(askedPaths()).size).toBe(total);
    });

    it("is per forge: one forge's spent allowance does not starve another", async () => {
      for (let index = 0; index < ANONYMOUS_LOOKUPS_PER_HOUR + 5; index += 1) {
        addRepo({ path: `me/r${String(index).padStart(2, "0")}` });
      }
      addRepo({ forgeId: gitlab, path: "me/lab" });

      await resolvePendingForks(db, deps(), { batchSize: 1000 });

      expect(calls.filter((call) => call.forgeId === github)).toHaveLength(
        ANONYMOUS_LOOKUPS_PER_HOUR,
      );
      expect(calls.filter((call) => call.forgeId === gitlab)).toHaveLength(1);
    });

    it("is not spent by token-backed lookups", async () => {
      const owner = makeUser(db, "owner@example.com", { import_private: true });
      addAccount(github, owner.id, "owner-bot", "tok-owner", true);
      const count = ANONYMOUS_LOOKUPS_PER_HOUR + 5;
      for (let index = 0; index < count; index += 1) {
        addRepo({ path: `me/r${String(index).padStart(2, "0")}`, owner: owner.id });
      }
      const budget = new Map<number, AnonymousBudget>();

      await resolvePendingForks(db, deps({ anonymousBudget: budget }), { batchSize: 1000 });

      expect(calls).toHaveLength(count);
      expect(budget.size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The credential the pass presents
// ---------------------------------------------------------------------------

describe("the credential the visibility pass presents", () => {
  interface World {
    alice: number;
    bob: number;
    carol: number;
    dave: number;
    erin: number;
    admin: number;
    aliceDefault: number;
    aliceAlt: number;
    aliceOnGitlab: number;
  }
  let world: World;

  beforeEach(() => {
    const alice = makeUser(db, "alice@example.com", { import_private: true });
    const bob = makeUser(db, "bob@example.com", { import_private: true });
    // Carol has her own account but may not use accounts at all.
    const carol = makeUser(db, "carol@example.com", { import_private: false });
    // Dave is removed, and his account is still in the table.
    const dave = makeUser(db, "dave@example.com", { import_private: true }, { removed: true });
    // Erin may use accounts and has none.
    const erin = makeUser(db, "erin@example.com", { import_private: true });
    const admin = adminOf(db);

    const aliceDefault = addAccount(github, alice.id, "alice-bot", "tok-alice", true);
    const aliceAlt = addAccount(github, alice.id, "alice-alt", "tok-alice-alt", false);
    const aliceOnGitlab = addAccount(gitlab, alice.id, "alice-lab", "tok-alice-lab", true);
    addAccount(github, bob.id, "bob-bot", "tok-bob", true);
    addAccount(github, carol.id, "carol-bot", "tok-carol", true);
    addAccount(github, dave.id, "dave-bot", "tok-dave", true);
    addAccount(github, admin.id, "admin-bot", "tok-admin", true);
    world = {
      alice: alice.id,
      bob: bob.id,
      carol: carol.id,
      dave: dave.id,
      erin: erin.id,
      admin: admin.id,
      aliceDefault,
      aliceAlt,
      aliceOnGitlab,
    };
  });

  interface Case {
    name: string;
    spec: (w: World) => Omit<RepoSpec, "path">;
    token: string | null;
    username: string;
  }

  const cases: Case[] = [
    {
      name: "the owner's own default account",
      spec: (w) => ({ owner: w.alice }),
      token: "tok-alice",
      username: "alice-bot",
    },
    {
      name: "the owner's own non-default override",
      spec: (w) => ({ owner: w.alice, override: w.aliceAlt }),
      token: "tok-alice-alt",
      username: "alice-alt",
    },
    {
      name: "another user's account as an override falls back to the repo owner's own default",
      spec: (w) => ({ owner: w.bob, override: w.aliceDefault }),
      token: "tok-bob",
      username: "bob-bot",
    },
    {
      name: "another user's account as an override, owner with no account of their own, is anonymous",
      spec: (w) => ({ owner: w.erin, override: w.aliceDefault }),
      token: null,
      username: "",
    },
    {
      name: "the owner's own account on a different forge is never presented here",
      spec: (w) => ({ owner: w.alice, override: w.aliceOnGitlab }),
      token: null,
      username: "",
    },
    {
      name: "an owner without import_private is anonymous even with a default account",
      spec: (w) => ({ owner: w.carol }),
      token: null,
      username: "",
    },
    {
      name: "a removed owner is anonymous even with a default account",
      spec: (w) => ({ owner: w.dave }),
      token: null,
      username: "",
    },
    {
      name: "force_anonymous wins over the owner's default account",
      spec: (w) => ({ owner: w.alice, anonymous: true }),
      token: null,
      username: "",
    },
    {
      name: "force_anonymous wins over the owner's own override",
      spec: (w) => ({ owner: w.alice, override: w.aliceAlt, anonymous: true }),
      token: null,
      username: "",
    },
    {
      name: "an owner who may use accounts but has none is anonymous",
      spec: (w) => ({ owner: w.erin }),
      token: null,
      username: "",
    },
    {
      name: "the admin's own default account",
      spec: (w) => ({ owner: w.admin }),
      token: "tok-admin",
      username: "admin-bot",
    },
    {
      name: "the admin never borrows a member's account through an override",
      spec: (w) => ({ owner: w.admin, override: w.aliceDefault }),
      token: "tok-admin",
      username: "admin-bot",
    },
  ];

  it.each(cases)("$name", async ({ spec, token, username }) => {
    addRepo({ path: "me/target", ...spec(world) });

    await resolvePendingForks(db, deps());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.context.token).toBe(token);
    expect(calls[0]?.context.username).toBe(username);
  });

  it("the admin with no account on a forge is anonymous there", async () => {
    addRepo({ forgeId: gitlab, path: "me/lab", owner: world.admin });

    await resolvePendingForks(db, deps());

    expect(calls[0]?.context.token).toBeNull();
  });

  it("never hands any user's token to a repo they do not own, whatever the overrides say", async () => {
    // Every member's repo points its override at alice's account.
    for (const owner of [world.bob, world.carol, world.dave, world.erin, world.admin]) {
      addRepo({ path: `me/of-${String(owner)}`, owner, override: world.aliceDefault });
    }

    await resolvePendingForks(db, deps(), { batchSize: 100 });

    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.context.token)).not.toContain("tok-alice");
    expect(calls.map((call) => call.context.token)).not.toContain("tok-alice-alt");
  });

  it("lookupRepoInfo presents the same credential and writes the answer", async () => {
    const own = addRepo({ path: "me/own", owner: world.alice });
    const borrowed = addRepo({
      path: "me/borrowed",
      owner: world.erin,
      override: world.aliceDefault,
    });
    answers.set("me/own", { fork: NOT_FORK, isPrivate: false, sizeBytes: 4096, stars: null });
    answers.set("me/borrowed", answer(false));
    const resolved: number[] = [];
    const seen = deps({ onResolved: (id) => resolved.push(id) });

    expect(await lookupRepoInfo(db, own, seen)).toMatchObject({
      isPrivate: false,
      sizeBytes: 4096,
    });
    await lookupRepoInfo(db, borrowed, seen);

    expect(calls.map((call) => call.context.token)).toEqual(["tok-alice", null]);
    expect(row(own)).toMatchObject({ is_private: 0, visibility_checked_at: NOW });
    expect(resolved).toEqual([own, borrowed]);
  });

  it("lookupRepoInfo writes nothing on a rate limit, and is null for a forge it cannot ask", async () => {
    const limited = addRepo({ path: "me/limited", owner: world.alice, isPrivate: false });
    answers.set("me/limited", LIMITED);

    expect(await lookupRepoInfo(db, limited, deps())).toEqual(LIMITED);
    expect(row(limited)).toMatchObject({ is_private: 0, visibility_checked_at: null });

    const gitea = seedForge(db, "gitea.example.com", "gitea");
    const noProvider = addRepo({ forgeId: gitea, path: "me/x" });
    expect(await lookupRepoInfo(db, noProvider, deps())).toBeNull();
    expect(await lookupRepoInfo(db, 999_999, deps())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Fetch evidence
// ---------------------------------------------------------------------------

describe("what a successful fetch proves about visibility", () => {
  let root: string;
  let fixtureDb: Db;
  let forgeSeq = 0;
  let origin: OriginRepo;

  beforeEach(async () => {
    root = tempDir("visibility");
    fixtureDb = createTestDb(root);
    origin = await createOrigin(join(root, "origin"));
    await origin.commitFile("README.md", "hello\n", "initial commit");
  });

  afterEach(() => {
    fixtureDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A RESTRICTED forge (the default) can only fetch over pinned https, so its
   * fetch goes through the recording git and succeeds with nothing to fetch.
   * An UNRESTRICTED one fetches the local file:// origin for real.
   */
  async function syncOnce(options: {
    kind: string;
    start: 0 | 1;
    authenticated: boolean;
    remoteUrl?: string;
    unrestricted?: boolean;
  }): Promise<{ outcome: string; isPrivate: number }> {
    forgeSeq += 1;
    const unrestricted = options.unrestricted === true || options.remoteUrl !== undefined;
    const forgeId = insertForge(fixtureDb, {
      host: `forge${String(forgeSeq)}.example.com`,
      kind: options.kind,
      allowPrivateNetwork: unrestricted,
    });
    const repoId = insertRepo(fixtureDb, { forgeId, path: "acme/widgets" });
    fixtureDb.run("UPDATE repos SET is_private = ? WHERE id = ?", options.start, repoId);

    const run = await syncRepo({
      repoId,
      db: fixtureDb,
      backupsDir: join(root, "backups"),
      stateDir: join(root, "state"),
      logger: silentLog,
      settings: fixedSettings(),
      credentials: () =>
        options.authenticated ? { username: "someone", password: "pw" } : undefined,
      // Never the real forge API: an unrestricted forge's post-sync star
      // lookup would use the global fetch. A restricted one keeps the default
      // lookup, which the suite's refusing resolver stops before any network.
      ...(unrestricted ? { repoInfo: () => Promise.resolve(null) } : {}),
      ...(unrestricted
        ? { remoteUrl: options.remoteUrl ?? origin.url, allowFileProtocol: true }
        : {
            gitBinary: createRecordingGit(root).binary,
            resolveHost: fakeDns({}, [PUBLIC_V4]),
          }),
    });
    const after = fixtureDb.get<{ is_private: number }>(
      "SELECT is_private FROM repos WHERE id = ?",
      repoId,
    )!;
    return { outcome: run.outcome, isPrivate: after.is_private };
  }

  it.each(["generic", "github"])("an anonymous success makes a %s repo public", async (kind) => {
    expect(await syncOnce({ kind, start: 1, authenticated: false })).toEqual({
      outcome: "success",
      isPrivate: 0,
    });
  });

  // On a forge that may reach private networks, reaching it anonymously only
  // proves AMBER can: nothing there is ever public, whichever way it started.
  it.each([
    ["generic", false, 0],
    ["generic", false, 1],
    ["github", false, 0],
    ["github", true, 0],
    ["gitea", true, 0],
    ["generic", true, 0],
  ] as const)(
    "on an unrestricted %s forge a success (authenticated: %s) leaves the repo private (started %i)",
    async (kind, authenticated, start) => {
      expect(await syncOnce({ kind, start, authenticated, unrestricted: true })).toEqual({
        outcome: "success",
        isPrivate: 1,
      });
    },
  );

  it("an anonymous failure changes nothing, whichever way the row started", async () => {
    const remoteUrl = pathToFileURL(join(root, "no-such-origin")).href;

    for (const start of [0, 1] as const) {
      const result = await syncOnce({
        kind: "generic",
        start,
        authenticated: false,
        remoteUrl,
      });
      expect(result).toEqual({ outcome: "error", isPrivate: start });
    }
  });

  it("an authenticated failure changes nothing either", async () => {
    const remoteUrl = pathToFileURL(join(root, "no-such-origin")).href;

    const result = await syncOnce({ kind: "generic", start: 0, authenticated: true, remoteUrl });

    expect(result).toEqual({ outcome: "error", isPrivate: 0 });
  });

  it.each([0, 1] as const)(
    "an authenticated success on a generic forge ends private (started %i)",
    async (start) => {
      expect(await syncOnce({ kind: "generic", start, authenticated: true })).toEqual({
        outcome: "success",
        isPrivate: 1,
      });
    },
  );

  it.each([
    ["github", 0],
    ["github", 1],
    ["gitlab", 0],
    ["gitlab", 1],
    ["gitea", 0],
    ["bitbucket", 1],
  ] as const)(
    "an authenticated success on a %s forge keeps whatever the row had (started %i)",
    async (kind, start) => {
      expect(await syncOnce({ kind, start, authenticated: true })).toEqual({
        outcome: "success",
        isPrivate: start,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Account sync listings
// ---------------------------------------------------------------------------

describe("account sync listings and visibility", () => {
  function listed(path: string, isPrivate: boolean): DiscoveredRepo {
    return {
      path,
      defaultBranch: "main",
      isPrivate,
      archived: false,
      description: null,
      isFork: null,
      forkParent: null,
    };
  }

  function upsert(
    ownerUserId: number,
    accountSyncId: number,
    repos: DiscoveredRepo[],
    now: number,
  ) {
    return upsertDiscoveredRepos(db, {
      forgeId: github,
      accountSyncId,
      ownerUserId,
      repos,
      helpers: { generateShortId, buildSlug, deleteRepo: () => Promise.resolve() },
      now,
    });
  }

  function syncFor(ownerUserId: number): number {
    const accountId = addAccount(
      github,
      ownerUserId,
      `sync-bot-${String(ownerUserId)}`,
      null,
      true,
    );
    return db.run(
      `INSERT INTO account_syncs (forge_id, account_id, source, visibility, enabled,
         interval_minutes, next_run_at, owner_user_id, created_at, updated_at)
       VALUES (?, ?, 'owned', 'all', 1, 360, NULL, ?, 1, 1)`,
      github,
      accountId,
      ownerUserId,
    ).lastInsertRowid;
  }

  it("a repo created by a sync takes its visibility from the listing and stamps the check", () => {
    const owner = makeUser(db, "owner@example.com", { import_private: true });

    upsert(
      owner.id,
      syncFor(owner.id),
      [listed("me/open", false), listed("me/closed", true)],
      5000,
    );

    const rows = db.all<{ path: string; is_private: number; visibility_checked_at: number | null }>(
      "SELECT path, is_private, visibility_checked_at FROM repos ORDER BY path",
    );
    expect(rows).toEqual([
      { path: "me/closed", is_private: 1, visibility_checked_at: 5000 },
      { path: "me/open", is_private: 0, visibility_checked_at: 5000 },
    ]);
  });

  it("refreshes the sync owner's existing rows from the listing, in both directions", () => {
    const owner = makeUser(db, "owner@example.com", { import_private: true });
    const goesPublic = addRepo({ path: "me/was-private", owner: owner.id, isPrivate: true });
    const goesPrivate = addRepo({ path: "me/was-public", owner: owner.id, isPrivate: false });

    upsert(
      owner.id,
      syncFor(owner.id),
      [listed("me/was-private", false), listed("me/was-public", true)],
      7000,
    );

    expect(row(goesPublic)).toMatchObject({ is_private: 0, visibility_checked_at: 7000 });
    expect(row(goesPrivate)).toMatchObject({ is_private: 1, visibility_checked_at: 7000 });
  });

  it("never touches the visibility of a row another user owns", () => {
    const owner = makeUser(db, "owner@example.com", { import_private: true });
    const theirs = addRepo({ path: "me/theirs", owner: adminOf(db).id, isPrivate: true });
    const theirsPublic = addRepo({
      path: "me/theirs-public",
      owner: adminOf(db).id,
      isPrivate: false,
    });

    upsert(
      owner.id,
      syncFor(owner.id),
      [listed("me/theirs", false), listed("me/theirs-public", true)],
      7000,
    );

    expect(row(theirs)).toMatchObject({ is_private: 1, visibility_checked_at: null });
    expect(row(theirsPublic)).toMatchObject({ is_private: 0, visibility_checked_at: null });
  });
});

// ---------------------------------------------------------------------------
// 7. Changing a repository's path
// ---------------------------------------------------------------------------

describe("updateRepo and visibility", () => {
  function makePublic(path: string): number {
    const owner = makeUser(db, `owner-${path.replace("/", "-")}@example.com`, {});
    const repo = createRepo(db, { forgeId: github, path, ownerUserId: owner.id });
    db.run("UPDATE repos SET is_private = 0, visibility_checked_at = 4242 WHERE id = ?", repo.id);
    return repo.id;
  }

  it("a path change resets the row to private and clears the check stamp", () => {
    const id = makePublic("me/before");

    updateRepo(db, id, { path: "me/after" });

    expect(row(id)).toMatchObject({ is_private: 1, visibility_checked_at: null });
  });

  it("a path change that normalizes to the same path keeps the visibility", () => {
    const id = makePublic("me/same");

    updateRepo(db, id, { path: "/me/same.git" });

    expect(row(id)).toMatchObject({ is_private: 0, visibility_checked_at: 4242 });
  });

  it("other edits keep the visibility", () => {
    const id = makePublic("me/other");

    updateRepo(db, id, { state: "paused" });
    updateRepo(db, id, { forceAnonymous: true });

    expect(row(id)).toMatchObject({ is_private: 0, visibility_checked_at: 4242 });
  });
});

// ---------------------------------------------------------------------------
// Unrestricted forges: nothing there is ever public
// ---------------------------------------------------------------------------

describe("on an unrestricted forge nothing is ever made public", () => {
  let lan: number;

  beforeEach(() => {
    // A forge the admin let reach private networks: there, being able to read
    // a repository says nothing about who else can.
    lan = seedForge(db, "git.lan.example.com", "github");
    db.run("UPDATE forges SET allow_private_network = 1 WHERE id = ?", lan);
  });

  it("the provider pass writes private even when the forge's API says public", async () => {
    const fresh = addRepo({ forgeId: lan, path: "me/open" });
    // Even a row that was public (say the forge was restricted before) goes private.
    const wasPublic = addRepo({ forgeId: lan, path: "me/was-public", isPrivate: false });
    const unknown = addRepo({ forgeId: lan, path: "me/unknown", isPrivate: false });
    answers.set("me/open", answer(false));
    answers.set("me/was-public", answer(false));
    answers.set("me/unknown", answer(null));

    await resolvePendingForks(db, deps());

    expect(row(fresh)).toMatchObject({ is_private: 1, visibility_checked_at: NOW });
    expect(row(wasPublic)).toMatchObject({ is_private: 1, visibility_checked_at: NOW });
    // A non-answer still changes nothing.
    expect(row(unknown)).toMatchObject({ is_private: 0, visibility_checked_at: NOW });
  });

  it("the single-repo lookup does the same", async () => {
    const id = addRepo({ forgeId: lan, path: "me/one", isPrivate: false });
    answers.set("me/one", answer(false));
    await lookupRepoInfo(db, id, deps({ cooldowns: new Map(), anonymousBudget: new Map() }));
    expect(row(id).is_private).toBe(1);
  });

  it("an account sync listing that says public creates and keeps the repo private", () => {
    const owner = makeUser(db, "owner@example.com", { import_private: true });
    const existing = addRepo({
      forgeId: lan,
      path: "me/listed",
      owner: owner.id,
      isPrivate: false,
    });
    const listing = (path: string): DiscoveredRepo => ({
      path,
      defaultBranch: "main",
      isPrivate: false,
      archived: false,
      description: null,
      isFork: null,
      forkParent: null,
    });
    upsertDiscoveredRepos(db, {
      forgeId: lan,
      accountSyncId: db.run(
        `INSERT INTO account_syncs (forge_id, source, namespace, owner_user_id, created_at, updated_at)
         VALUES (?, 'namespace', 'me', ?, 1, 1)`,
        lan,
        owner.id,
      ).lastInsertRowid,
      ownerUserId: owner.id,
      repos: [listing("me/listed"), listing("me/new")],
      helpers: { generateShortId, buildSlug, deleteRepo: () => Promise.resolve() },
      now: 7000,
    });
    expect(
      db.all<{ path: string; is_private: number }>(
        "SELECT path, is_private FROM repos WHERE forge_id = ? ORDER BY path",
        lan,
      ),
    ).toEqual([
      { path: "me/listed", is_private: 1 },
      { path: "me/new", is_private: 1 },
    ]);
    expect(row(existing).is_private).toBe(1);
  });
});

describe("a rename during a visibility lookup", () => {
  it("does not let the old path's answer, or its checked stamp, land on the renamed row", async () => {
    const id = addRepo({ path: "me/old-name", checkedAt: null });
    const renaming = {
      kind: "github",
      listRepos: providerOf("github").listRepos,
      getRepoInfo: () => {
        db.run("UPDATE repos SET path = 'me/new-name' WHERE id = ?", id);
        return Promise.resolve(answer(false));
      },
    } as unknown as AccountSyncProvider;

    await lookupRepoInfo(
      db,
      id,
      deps({ providerFor: () => renaming, cooldowns: new Map(), anonymousBudget: new Map() }),
    );
    expect(row(id)).toMatchObject({ is_private: 1, visibility_checked_at: null });

    // Same for the background pass, with a non-answer.
    db.run("UPDATE repos SET path = 'me/old-name', visibility_checked_at = NULL WHERE id = ?", id);
    const silent = {
      ...renaming,
      getRepoInfo: () => {
        db.run("UPDATE repos SET path = 'me/newer-name' WHERE id = ?", id);
        return Promise.resolve(answer(null));
      },
    } as unknown as AccountSyncProvider;
    await resolvePendingForks(db, deps({ providerFor: () => silent }));
    expect(row(id)).toMatchObject({ is_private: 1, visibility_checked_at: null });
  });
});
