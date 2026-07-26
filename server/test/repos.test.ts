import type { Repo, RepoListQuery } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createAccount } from "../src/domain/accounts.ts";
import { DomainError } from "../src/domain/errors.ts";
import {
  assertSafeSlug,
  buildSlug,
  bulkRepoAction,
  countRepos,
  createRepo,
  deleteRepo,
  displayNameFor,
  findRepoByPath,
  generateShortId,
  getRepo,
  getRepoBySlug,
  isSafeSlug,
  listRepos,
  listSyncRuns,
  normalizeRepoPath,
  requestSyncNow,
  SHORT_ID_LENGTH,
  totalDiskUsageBytes,
  updateRepo,
  type CreateRepoInput,
} from "../src/domain/repos.ts";
import { createTempDb, seedForge, TEST_SECRET_KEY, type TempDb } from "./helpers.ts";

const KEY = Buffer.from(TEST_SECRET_KEY, "hex");

let temp: TempDb;
let db: Db;
let forgeId: number;
let otherForgeId: number;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  forgeId = seedForge(db, "github.com");
  otherForgeId = seedForge(db, "gitlab.com", "gitlab");
});

afterEach(() => {
  temp.close();
});

const make = (path: string, overrides: Partial<CreateRepoInput> = {}) =>
  createRepo(db, { forgeId, path, ...overrides });

const query = (overrides: Partial<RepoListQuery> = {}): RepoListQuery => ({
  page: 1,
  perPage: 50,
  sort: "display_name",
  dir: "asc",
  ...overrides,
});

function addRun(
  repoId: number,
  outcome: "success" | "error" | "canceled",
  startedAt: number,
): number {
  return db.run(
    `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    repoId,
    startedAt,
    startedAt + 100,
    outcome,
    startedAt,
    startedAt,
  ).lastInsertRowid;
}

describe("generateShortId", () => {
  it("returns 8 base36 characters", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = generateShortId();
      expect(id).toHaveLength(SHORT_ID_LENGTH);
      expect(id).toMatch(/^[0-9a-z]{8}$/);
    }
  });

  it("does not repeat itself across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(generateShortId());
    }
    expect(seen.size).toBe(2000);
  });
});

describe("buildSlug", () => {
  it("sanitizes the path and appends the short id", () => {
    expect(buildSlug("nodejs/node", "abcd1234")).toBe("nodejs-node-abcd1234");
    expect(buildSlug("pub/scm/linux/kernel/git/torvalds/linux", "zzzz0000")).toBe(
      "pub-scm-linux-kernel-git-torvalds-linux-zzzz0000",
    );
  });

  it("lowercases and collapses runs of separators", () => {
    expect(buildSlug("My/Weird  Repo!!Name", "aaaa1111")).toBe("my-weird-repo-name-aaaa1111");
  });

  it("never starts or ends with a separator", () => {
    expect(buildSlug("///", "aaaa1111")).toBe("repo-aaaa1111");
    expect(buildSlug("...", "aaaa1111")).toBe("repo-aaaa1111");
    expect(buildSlug("-leading-and-trailing-", "aaaa1111")).toBe("leading-and-trailing-aaaa1111");
    expect(buildSlug("", "aaaa1111")).toBe("repo-aaaa1111");
  });

  it("caps the length so directory names stay sane", () => {
    const slug = buildSlug("x".repeat(500), "aaaa1111");
    expect(slug.length).toBeLessThanOrEqual(64 + 1 + SHORT_ID_LENGTH);
  });

  it("keeps colliding sanitizations apart via the short id", () => {
    expect(buildSlug("a/b", "aaaa1111")).not.toBe(buildSlug("a-b", "bbbb2222"));
    expect(buildSlug("a/b", "aaaa1111")).toBe("a-b-aaaa1111");
    expect(buildSlug("a-b", "bbbb2222")).toBe("a-b-bbbb2222");
  });

  it("always produces a slug that passes the safety gate", () => {
    for (const path of ["nodejs/node", "..", "///", "A B C", "x".repeat(300), "%2e%2e/etc"]) {
      expect(isSafeSlug(buildSlug(path, generateShortId()))).toBe(true);
    }
  });
});

describe("isSafeSlug", () => {
  it("rejects anything that could escape the backups directory", () => {
    expect(isSafeSlug("..")).toBe(false);
    expect(isSafeSlug("../etc")).toBe(false);
    expect(isSafeSlug("a/../b")).toBe(false);
    expect(isSafeSlug("a/b")).toBe(false);
    expect(isSafeSlug("a\\b")).toBe(false);
    expect(isSafeSlug("/absolute")).toBe(false);
    expect(isSafeSlug("")).toBe(false);
    expect(isSafeSlug(".hidden")).toBe(false);
    expect(isSafeSlug("-leading")).toBe(false);
    expect(isSafeSlug("Upper-case")).toBe(false);
    expect(isSafeSlug("x".repeat(200))).toBe(false);
  });

  it("accepts a generated slug", () => {
    expect(isSafeSlug("nodejs-node-abcd1234")).toBe(true);
    expect(assertSafeSlug("nodejs-node-abcd1234")).toBe("nodejs-node-abcd1234");
    expect(() => assertSafeSlug("../etc")).toThrow(DomainError);
  });
});

describe("normalizeRepoPath and displayNameFor", () => {
  it("strips the leading slash, trailing slash, and .git", () => {
    expect(normalizeRepoPath("/nodejs/node/")).toBe("nodejs/node");
    expect(normalizeRepoPath("nodejs/node.git")).toBe("nodejs/node");
    expect(normalizeRepoPath("nodejs/node.GIT")).toBe("nodejs/node");
    expect(normalizeRepoPath("a//b///c")).toBe("a/b/c");
    expect(normalizeRepoPath("  spaced/path  ")).toBe("spaced/path");
  });

  it("rejects relative segments", () => {
    expect(() => normalizeRepoPath("a/../b")).toThrow(DomainError);
    expect(() => normalizeRepoPath("./a")).toThrow(DomainError);
  });

  it("takes the last segment as the display name", () => {
    expect(displayNameFor("nodejs/node")).toBe("node");
    expect(displayNameFor("solo")).toBe("solo");
  });
});

describe("createRepo", () => {
  it("assigns a display name, short id, and unique slug", () => {
    const repo = make("nodejs/node");
    expect(repo.displayName).toBe("node");
    expect(repo.path).toBe("nodejs/node");
    expect(repo.shortId).toHaveLength(SHORT_ID_LENGTH);
    expect(repo.slug).toBe(`nodejs-node-${repo.shortId}`);
    expect(repo.state).toBe("active");
    expect(repo.consecutiveFailures).toBe(0);
  });

  it("schedules the first sync immediately by default", () => {
    const before = Date.now();
    const repo = make("nodejs/node");
    expect(repo.nextSyncAt).toBeGreaterThanOrEqual(before);
  });

  it("honors an explicit next sync time", () => {
    expect(make("nodejs/node", { nextSyncAt: 1_700_000_000_000 }).nextSyncAt).toBe(
      1_700_000_000_000,
    );
    expect(make("a/b", { nextSyncAt: null }).nextSyncAt).toBeNull();
  });

  it("normalizes the path on the way in", () => {
    expect(make("/nodejs/node.git/").path).toBe("nodejs/node");
  });

  it("rejects a duplicate path on the same forge", () => {
    make("nodejs/node");
    expect(() => make("nodejs/node")).toThrow(DomainError);
    expect(() => make("nodejs/node.git")).toThrow(/already backed up from this forge/);
  });

  it("rejects an empty path and an unknown forge", () => {
    expect(() => make("/")).toThrow(DomainError);
    expect(() => createRepo(db, { forgeId: 999, path: "a/b" })).toThrow(/does not exist/);
  });

  it("allows the same path on a different forge, with a distinct slug", () => {
    const first = make("nodejs/node");
    const second = createRepo(db, { forgeId: otherForgeId, path: "nodejs/node" });
    expect(second.id).not.toBe(first.id);
    expect(second.slug).not.toBe(first.slug);
  });

  it("gives every repo a distinct slug even for paths that sanitize alike", () => {
    // All five sanitize to the body "a-b"; only the short id keeps them apart.
    const paths = ["a/b", "a-b", "A/B", "a b", "a@b"];
    const repos = paths.map((path) => make(path));
    expect(new Set(repos.map((repo) => repo.slug)).size).toBe(paths.length);
    expect(repos.every((repo) => repo.slug.startsWith("a-b-") || repo.slug.startsWith("a-b"))).toBe(
      true,
    );
  });

  it("rejects an account override from another forge", () => {
    const foreign = createAccount(db, KEY, {
      forgeId: otherForgeId,
      username: "someone",
      secret: null,
      isDefault: false,
    });
    expect(() => make("nodejs/node", { accountOverrideId: foreign.id })).toThrow(
      /belongs to a different forge/,
    );
  });

  it("accepts an account override from its own forge", () => {
    const account = createAccount(db, KEY, {
      forgeId,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });
    expect(make("nodejs/node", { accountOverrideId: account.id }).accountOverrideId).toBe(
      account.id,
    );
  });
});

describe("getRepo, getRepoBySlug, findRepoByPath", () => {
  it("looks a repo up by id, slug, and path", () => {
    const repo = make("nodejs/node");
    expect(getRepo(db, repo.id)?.id).toBe(repo.id);
    expect(getRepoBySlug(db, repo.slug)?.id).toBe(repo.id);
    expect(findRepoByPath(db, forgeId, "nodejs/node")?.id).toBe(repo.id);
  });

  it("accepts an optional trailing .git on the slug, as git clone sends", () => {
    const repo = make("nodejs/node");
    expect(getRepoBySlug(db, `${repo.slug}.git`)?.id).toBe(repo.id);
  });

  it("returns undefined for unknown lookups", () => {
    expect(getRepo(db, 999)).toBeUndefined();
    expect(getRepoBySlug(db, "nope-00000000")).toBeUndefined();
    expect(findRepoByPath(db, forgeId, "nope/nope")).toBeUndefined();
  });
});

describe("listRepos", () => {
  beforeEach(() => {
    make("nodejs/node", { nextSyncAt: 300 });
    make("facebook/react", { nextSyncAt: 100 });
    make("vuejs/core", { nextSyncAt: 200, state: "paused" });
    createRepo(db, { forgeId: otherForgeId, path: "gitlab-org/gitlab" });
  });

  it("paginates and reports the unfiltered total", () => {
    const page = listRepos(db, query({ perPage: 2, page: 1 }));
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(4);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(2);

    const second = listRepos(db, query({ perPage: 2, page: 2 }));
    expect(second.rows).toHaveLength(2);
    const firstIds = page.rows.map((repo) => repo.id);
    expect(second.rows.every((repo) => !firstIds.includes(repo.id))).toBe(true);
  });

  it("returns an empty page past the end", () => {
    const page = listRepos(db, query({ perPage: 2, page: 99 }));
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(4);
  });

  it("sorts by each allowlisted column in both directions", () => {
    expect(listRepos(db, query({ sort: "display_name", dir: "asc" })).rows[0]?.displayName).toBe(
      "core",
    );
    expect(listRepos(db, query({ sort: "display_name", dir: "desc" })).rows[0]?.displayName).toBe(
      "react",
    );
    expect(listRepos(db, query({ sort: "path", dir: "asc" })).rows[0]?.path).toBe("facebook/react");
    expect(listRepos(db, query({ sort: "next_sync_at", dir: "asc" })).rows[0]?.path).toBe(
      "facebook/react",
    );
    expect(listRepos(db, query({ sort: "created_at", dir: "asc" })).rows).toHaveLength(4);
    expect(listRepos(db, query({ sort: "last_sync_at" })).rows).toHaveLength(4);
    expect(listRepos(db, query({ sort: "last_success_at" })).rows).toHaveLength(4);
    expect(listRepos(db, query({ sort: "disk_usage_bytes" })).rows).toHaveLength(4);
  });

  it("filters by a case insensitive substring of path or display name", () => {
    expect(listRepos(db, query({ q: "node" })).total).toBe(1);
    expect(listRepos(db, query({ q: "NODE" })).total).toBe(1);
    expect(listRepos(db, query({ q: "core" })).rows[0]?.path).toBe("vuejs/core");
    expect(listRepos(db, query({ q: "gitlab-org" })).total).toBe(1);
    expect(listRepos(db, query({ q: "nothing-here" })).total).toBe(0);
    expect(listRepos(db, query({ q: "   " })).total).toBe(4);
  });

  it("treats LIKE wildcards in the search term as literals", () => {
    make("weird/100%-coverage");
    make("weird/under_score");
    expect(listRepos(db, query({ q: "%" })).total).toBe(1);
    expect(listRepos(db, query({ q: "100%" })).rows[0]?.path).toBe("weird/100%-coverage");
    expect(listRepos(db, query({ q: "_" })).rows[0]?.path).toBe("weird/under_score");
  });

  it("filters by forge and state", () => {
    expect(listRepos(db, query({ forgeId })).total).toBe(3);
    expect(listRepos(db, query({ forgeId: otherForgeId })).total).toBe(1);
    expect(listRepos(db, query({ state: "paused" })).total).toBe(1);
    expect(listRepos(db, query({ state: "active" })).total).toBe(3);
  });

  it("filters by the outcome of the most recent run only", () => {
    const node = findRepoByPath(db, forgeId, "nodejs/node")!;
    const react = findRepoByPath(db, forgeId, "facebook/react")!;
    addRun(node.id, "error", 1000);
    addRun(node.id, "success", 2000);
    addRun(react.id, "success", 1000);
    addRun(react.id, "error", 2000);

    expect(listRepos(db, query({ outcome: "success" })).rows.map((r) => r.id)).toEqual([node.id]);
    expect(listRepos(db, query({ outcome: "error" })).rows.map((r) => r.id)).toEqual([react.id]);
    expect(listRepos(db, query({ outcome: "canceled" })).total).toBe(0);
  });

  it("combines filters", () => {
    expect(listRepos(db, query({ forgeId, state: "active", q: "e" })).total).toBe(2);
  });
});

describe("counts and totals", () => {
  it("counts repos and sums disk usage, coalescing an empty table to zero", () => {
    expect(countRepos(db)).toBe(0);
    expect(totalDiskUsageBytes(db)).toBe(0);

    const a = make("a/b");
    const b = make("c/d");
    expect(countRepos(db)).toBe(2);
    expect(totalDiskUsageBytes(db)).toBe(0);

    db.run("UPDATE repos SET disk_usage_bytes = ? WHERE id = ?", 1500, a.id);
    db.run("UPDATE repos SET disk_usage_bytes = ? WHERE id = ?", 2500, b.id);
    expect(totalDiskUsageBytes(db)).toBe(4000);
  });
});

describe("updateRepo", () => {
  it("pauses and resumes", () => {
    const repo = make("nodejs/node");
    expect(updateRepo(db, repo.id, { state: "paused" }).state).toBe("paused");
    expect(updateRepo(db, repo.id, { state: "active" }).state).toBe("active");
  });

  it("gives a resumed repo a next sync time when it had none", () => {
    const repo = make("nodejs/node", { nextSyncAt: null });
    updateRepo(db, repo.id, { state: "paused" });
    expect(updateRepo(db, repo.id, { state: "active" }).nextSyncAt).not.toBeNull();
  });

  it("sets and clears force_anonymous", () => {
    const repo = make("nodejs/node");
    expect(updateRepo(db, repo.id, { forceAnonymous: true }).forceAnonymous).toBe(true);
    expect(updateRepo(db, repo.id, { forceAnonymous: false }).forceAnonymous).toBe(false);
  });

  it("sets and clears the account override", () => {
    const account = createAccount(db, KEY, {
      forgeId,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });
    const repo = make("nodejs/node");
    expect(updateRepo(db, repo.id, { accountOverrideId: account.id }).accountOverrideId).toBe(
      account.id,
    );
    expect(updateRepo(db, repo.id, { accountOverrideId: null }).accountOverrideId).toBeNull();
  });

  it("refuses an account override that belongs to another forge", () => {
    const foreign = createAccount(db, KEY, {
      forgeId: otherForgeId,
      username: "someone",
      secret: null,
      isDefault: false,
    });
    const repo = make("nodejs/node");
    expect(() => updateRepo(db, repo.id, { accountOverrideId: foreign.id })).toThrow(
      /belongs to a different forge/,
    );
    expect(getRepo(db, repo.id)?.accountOverrideId).toBeNull();
  });

  it("refuses an override that does not exist at all", () => {
    const repo = make("nodejs/node");
    expect(() => updateRepo(db, repo.id, { accountOverrideId: 999 })).toThrow(/does not exist/);
  });

  it("renames the path and the display name, keeping the disk slug fixed", () => {
    const repo = make("nodejs/node");
    const renamed = updateRepo(db, repo.id, { path: "nodejs/node-renamed" });
    expect(renamed.path).toBe("nodejs/node-renamed");
    expect(renamed.displayName).toBe("node-renamed");
    expect(renamed.slug).toBe(repo.slug);
    expect(renamed.shortId).toBe(repo.shortId);
  });

  it("normalizes and validates an edited path", () => {
    const repo = make("nodejs/node");
    expect(updateRepo(db, repo.id, { path: "/nodejs/other.git/" }).path).toBe("nodejs/other");
    expect(() => updateRepo(db, repo.id, { path: "a/../b" })).toThrow(DomainError);
    expect(() => updateRepo(db, repo.id, { path: "/" })).toThrow(DomainError);
  });

  it("refuses to rename onto a path already taken on the same forge", () => {
    make("nodejs/node");
    const other = make("facebook/react");
    expect(() => updateRepo(db, other.id, { path: "nodejs/node" })).toThrow(
      /already backed up from this forge/,
    );
  });

  it("keeps forge_id immutable however it is smuggled into the patch", () => {
    const repo = make("nodejs/node");
    const attack = { path: "nodejs/node", forgeId: otherForgeId } as Parameters<
      typeof updateRepo
    >[2];
    expect(updateRepo(db, repo.id, attack).forgeId).toBe(forgeId);
    expect(getRepo(db, repo.id)?.forgeId).toBe(forgeId);
  });

  it("is a no-op for an empty patch", () => {
    const repo = make("nodejs/node");
    expect(updateRepo(db, repo.id, {}).updatedAt).toBe(repo.updatedAt);
  });

  it("throws for an unknown repo", () => {
    expect(() => updateRepo(db, 999, { state: "paused" })).toThrow(/does not exist/);
  });
});

describe("requestSyncNow", () => {
  it("moves the next sync time to now", () => {
    const repo = make("nodejs/node", { nextSyncAt: Date.now() + 3_600_000 });
    const updated = requestSyncNow(db, repo.id, 1_700_000_000_000);
    expect(updated.nextSyncAt).toBe(1_700_000_000_000);
  });

  it("throws for an unknown repo", () => {
    expect(() => requestSyncNow(db, 999)).toThrow(/does not exist/);
  });
});

describe("deleteRepo", () => {
  it("removes the row and leaves the files alone by default", async () => {
    const repo = make("nodejs/node");
    const removeFiles = vi.fn(async () => {});
    await deleteRepo(db, repo.id, { removeFiles });
    expect(getRepo(db, repo.id)).toBeUndefined();
    expect(removeFiles).not.toHaveBeenCalled();
  });

  it("calls the injected remover with the repo when files are requested", async () => {
    const repo = make("nodejs/node");
    const seen: Repo[] = [];
    await deleteRepo(db, repo.id, {
      withFiles: true,
      removeFiles: async (deleted) => {
        seen.push(deleted);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: repo.id, slug: repo.slug });
    expect(getRepo(db, repo.id)).toBeUndefined();
  });

  it("refuses to delete files with no remover injected", async () => {
    const repo = make("nodejs/node");
    await expect(deleteRepo(db, repo.id, { withFiles: true })).rejects.toThrow(DomainError);
    expect(getRepo(db, repo.id)).toBeDefined();
  });

  it("refuses to act on a repo whose slug is unsafe", async () => {
    const repo = make("nodejs/node");
    db.run("UPDATE repos SET slug = ? WHERE id = ?", "../../etc", repo.id);
    const removeFiles = vi.fn(async () => {});
    await expect(deleteRepo(db, repo.id, { withFiles: true, removeFiles })).rejects.toThrow(
      /unsafe directory name/,
    );
    expect(removeFiles).not.toHaveBeenCalled();
    expect(getRepo(db, repo.id)).toBeDefined();
  });

  it("cascades its sync runs away", async () => {
    const repo = make("nodejs/node");
    addRun(repo.id, "success", 1000);
    await deleteRepo(db, repo.id);
    expect(db.all("SELECT id FROM sync_runs")).toHaveLength(0);
  });

  it("throws for an unknown repo", async () => {
    await expect(deleteRepo(db, 999)).rejects.toThrow(/does not exist/);
  });
});

describe("bulkRepoAction", () => {
  it("pauses and resumes many at once", async () => {
    const ids = [make("a/one").id, make("b/two").id, make("c/three").id];

    const paused = await bulkRepoAction(db, ids, "pause");
    expect(paused).toMatchObject({ action: "pause", requested: 3, affected: 3, missing: [] });
    expect(ids.every((id) => getRepo(db, id)?.state === "paused")).toBe(true);

    await bulkRepoAction(db, ids, "resume");
    expect(ids.every((id) => getRepo(db, id)?.state === "active")).toBe(true);
  });

  it("gives resumed repos a next sync time when they had none", async () => {
    const repo = make("a/one", { nextSyncAt: null });
    await bulkRepoAction(db, [repo.id], "resume");
    expect(getRepo(db, repo.id)?.nextSyncAt).not.toBeNull();
  });

  it("does not push back an existing schedule on resume", async () => {
    const repo = make("a/one", { nextSyncAt: 1_000 });
    await bulkRepoAction(db, [repo.id], "resume");
    expect(getRepo(db, repo.id)?.nextSyncAt).toBe(1_000);
  });

  it("requests an immediate sync", async () => {
    const repo = make("a/one", { nextSyncAt: Date.now() + 3_600_000 });
    const before = Date.now();
    await bulkRepoAction(db, [repo.id], "sync");
    expect(getRepo(db, repo.id)!.nextSyncAt).toBeLessThanOrEqual(Date.now());
    expect(getRepo(db, repo.id)!.nextSyncAt).toBeGreaterThanOrEqual(before);
  });

  it("deletes many, with files when asked", async () => {
    const ids = [make("a/one").id, make("b/two").id];
    const removeFiles = vi.fn(async () => {});
    const result = await bulkRepoAction(db, ids, "delete", { withFiles: true, removeFiles });
    expect(result.affected).toBe(2);
    expect(removeFiles).toHaveBeenCalledTimes(2);
    expect(countRepos(db)).toBe(0);
  });

  it("reports missing ids instead of failing the batch", async () => {
    const repo = make("a/one");
    const result = await bulkRepoAction(db, [repo.id, 998, 999], "pause");
    expect(result).toMatchObject({
      requested: 3,
      affected: 1,
      ids: [repo.id],
      missing: [998, 999],
    });
    expect(getRepo(db, repo.id)?.state).toBe("paused");
  });

  it("handles an empty id list", async () => {
    const result = await bulkRepoAction(db, [], "pause");
    expect(result).toMatchObject({ requested: 0, affected: 0, ids: [], missing: [] });
  });
});

describe("listSyncRuns", () => {
  it("pages newest first", () => {
    const repo = make("nodejs/node");
    addRun(repo.id, "success", 1000);
    addRun(repo.id, "error", 3000);
    addRun(repo.id, "success", 2000);

    const page = listSyncRuns(db, repo.id, { page: 1, perPage: 2 });
    expect(page.total).toBe(3);
    expect(page.rows.map((run) => run.startedAt)).toEqual([3000, 2000]);
    expect(page.rows[0]?.outcome).toBe("error");

    const second = listSyncRuns(db, repo.id, { page: 2, perPage: 2 });
    expect(second.rows.map((run) => run.startedAt)).toEqual([1000]);
  });

  it("returns an empty page for a repo with no runs", () => {
    const repo = make("nodejs/node");
    expect(listSyncRuns(db, repo.id, { page: 1, perPage: 50 })).toMatchObject({
      rows: [],
      total: 0,
    });
  });

  it("throws for an unknown repo", () => {
    expect(() => listSyncRuns(db, 999, { page: 1, perPage: 50 })).toThrow(/does not exist/);
  });
});
