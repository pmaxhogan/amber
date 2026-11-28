import { describe, expect, it } from "vitest";
import {
  GONE_CONFIRM_MS,
  MAX_PER_PAGE,
  bulkRepoRequestSchema,
  createAccountSchema,
  createForgeSchema,
  dmcaTakedown,
  forgeSchema,
  healthSchema,
  pageSchema,
  parseNamespaceInput,
  paginationQuerySchema,
  repoListQuerySchema,
  repoSchema,
  settingsScopeParamsSchema,
  syncRunSchema,
  supportsNamespaceSyncKind,
  upsertAccountSyncSchema,
} from "../src/apiTypes.ts";

describe("pagination", () => {
  it("applies defaults and coerces query strings", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, perPage: 50 });
    expect(paginationQuerySchema.parse({ page: "3", perPage: "25" })).toEqual({
      page: 3,
      perPage: 25,
    });
  });

  it("caps perPage and rejects page 0", () => {
    expect(paginationQuerySchema.safeParse({ perPage: MAX_PER_PAGE }).success).toBe(true);
    expect(paginationQuerySchema.safeParse({ perPage: MAX_PER_PAGE + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it("wraps rows in an envelope carrying the total", () => {
    const schema = pageSchema(forgeSchema);
    const parsed = schema.parse({
      rows: [
        {
          id: 1,
          protocol: "https",
          host: "github.com",
          port: null,
          kind: "github",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      total: 1,
      page: 1,
      perPage: 50,
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });
});

describe("repo list query", () => {
  it("defaults sort and direction", () => {
    const parsed = repoListQuerySchema.parse({});
    expect(parsed.sort).toBe("display_name");
    expect(parsed.dir).toBe("asc");
  });

  it("rejects an unknown sort field, which keeps the SQL builder safe", () => {
    expect(repoListQuerySchema.safeParse({ sort: "path; DROP TABLE repos" }).success).toBe(false);
    expect(repoListQuerySchema.safeParse({ sort: "disk_usage_bytes" }).success).toBe(true);
  });

  it("coerces the forge filter", () => {
    expect(repoListQuerySchema.parse({ forgeId: "4" }).forgeId).toBe(4);
  });

  it("sorts by stars", () => {
    expect(repoListQuerySchema.parse({ sort: "stars", dir: "desc" })).toMatchObject({
      sort: "stars",
      dir: "desc",
    });
  });
});

describe("star counts", () => {
  it("reads a repo payload from before the columns existed as unknown", () => {
    expect(repoSchema.shape.stars.parse(undefined)).toBeNull();
    expect(repoSchema.shape.starsCheckedAt.parse(undefined)).toBeNull();
    expect(repoSchema.shape.stars.parse(1200)).toBe(1200);
    expect(repoSchema.shape.stars.safeParse(-1).success).toBe(false);
    expect(repoSchema.shape.stars.safeParse(1.5).success).toBe(false);
  });

  it("carries a run's count, null when none was reported", () => {
    const run = {
      id: 1,
      repoId: 2,
      startedAt: 1,
      finishedAt: 2,
      outcome: "success",
      error: null,
      errorKind: null,
      bytesFetched: null,
      durationMs: 1,
      refsChanged: null,
      paranoidArchived: null,
    };
    expect(syncRunSchema.parse({ ...run, stars: 34 }).stars).toBe(34);
    expect(syncRunSchema.parse({ ...run, stars: null }).stars).toBeNull();
    expect(syncRunSchema.safeParse({ ...run, stars: -2 }).success).toBe(false);
    // Required on the wire: the server always sends it.
    expect(syncRunSchema.safeParse(run).success).toBe(false);
  });
});

describe("forge and account payloads", () => {
  it("defaults a new forge to https on the default port", () => {
    expect(createForgeSchema.parse({ host: "github.com" })).toEqual({
      protocol: "https",
      host: "github.com",
      port: null,
    });
  });

  it("rejects an out of range port", () => {
    expect(createForgeSchema.safeParse({ host: "h", port: 0 }).success).toBe(false);
    expect(createForgeSchema.safeParse({ host: "h", port: 65536 }).success).toBe(false);
  });

  it("treats an account secret as optional and defaults isDefault to false", () => {
    expect(createAccountSchema.parse({ forgeId: 1, username: "bob" })).toEqual({
      forgeId: 1,
      username: "bob",
      secret: null,
      isDefault: false,
    });
  });
});

describe("bulk and account sync payloads", () => {
  it("requires at least one id and a known action", () => {
    expect(bulkRepoRequestSchema.safeParse({ ids: [], action: "pause" }).success).toBe(false);
    expect(bulkRepoRequestSchema.safeParse({ ids: [1], action: "explode" }).success).toBe(false);
    expect(bulkRepoRequestSchema.parse({ ids: [1, 2], action: "sync" })).toEqual({
      ids: [1, 2],
      action: "sync",
      files: false,
    });
  });

  it("defaults account sync to every repo, leaving the interval to the route", () => {
    expect(upsertAccountSyncSchema.parse({ accountId: 2 })).toEqual({
      accountId: 2,
      source: "owned",
      visibility: "all",
      enabled: true,
    });
  });

  it("accepts a trending sync by forge, with its own knobs", () => {
    expect(
      upsertAccountSyncSchema.parse({ source: "trending", forgeId: 1, topN: 10, windowDays: 365 }),
    ).toMatchObject({ source: "trending", forgeId: 1, topN: 10, windowDays: 365 });
    expect(upsertAccountSyncSchema.safeParse({ source: "trending", forgeId: 1 }).success).toBe(
      true,
    );
  });

  it("rejects a trending sync with an account, a namespace, no forge or a silly size", () => {
    const bad = [
      { source: "trending" },
      { source: "trending", forgeId: 1, accountId: 2 },
      { source: "trending", forgeId: 1, namespace: "nodejs" },
      { source: "trending", forgeId: 1, topN: 0 },
      { source: "trending", forgeId: 1, topN: 101 },
      { source: "trending", forgeId: 1, windowDays: 0 },
      { source: "trending", forgeId: 1, windowDays: 3651 },
    ];
    for (const body of bad) {
      expect(upsertAccountSyncSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("rejects the trending knobs on every other source", () => {
    expect(upsertAccountSyncSchema.safeParse({ accountId: 2, topN: 5 }).success).toBe(false);
    expect(upsertAccountSyncSchema.safeParse({ accountId: 2, windowDays: 5 }).success).toBe(false);
  });
});

describe("settings scope params", () => {
  it("accepts a global scope with no id and a repo scope with one", () => {
    expect(settingsScopeParamsSchema.parse({ scopeType: "global" })).toEqual({
      scopeType: "global",
    });
    expect(settingsScopeParamsSchema.parse({ scopeType: "repo", scopeId: "12" })).toEqual({
      scopeType: "repo",
      scopeId: 12,
    });
  });

  it("rejects an unknown scope", () => {
    expect(settingsScopeParamsSchema.safeParse({ scopeType: "universe" }).success).toBe(false);
  });
});

describe("health", () => {
  it("only accepts ok: true", () => {
    expect(healthSchema.parse({ ok: true, version: "1.0.0" })).toEqual({
      ok: true,
      version: "1.0.0",
    });
    expect(healthSchema.safeParse({ ok: false, version: "1.0.0" }).success).toBe(false);
  });
});

describe("namespace syncs", () => {
  it("reduces pasted names and profile URLs to the one login", () => {
    expect(parseNamespaceInput("nodejs")).toBe("nodejs");
    expect(parseNamespaceInput("  @nodejs ")).toBe("nodejs");
    expect(parseNamespaceInput("https://github.com/nodejs")).toBe("nodejs");
    expect(parseNamespaceInput("github.com/nodejs/")).toBe("nodejs");
    expect(parseNamespaceInput("https://github.com/nodejs?tab=repositories")).toBe("nodejs");
    expect(parseNamespaceInput("my-org_2")).toBe("my-org_2");
  });

  it("refuses anything that is not exactly one valid name", () => {
    for (const raw of [
      "",
      "nodejs/node",
      "github.com/nodejs/node",
      "..",
      "-lead",
      "a b",
      "x/../y",
    ]) {
      expect(parseNamespaceInput(raw), raw).toBeNull();
    }
  });

  it("requires a namespace and a forge or account on a namespace sync", () => {
    expect(
      upsertAccountSyncSchema.safeParse({ source: "namespace", forgeId: 1, namespace: "x" })
        .success,
    ).toBe(true);
    expect(
      upsertAccountSyncSchema.safeParse({ source: "namespace", accountId: 1, namespace: "x" })
        .success,
    ).toBe(true);
    expect(upsertAccountSyncSchema.safeParse({ source: "namespace", forgeId: 1 }).success).toBe(
      false,
    );
    expect(upsertAccountSyncSchema.safeParse({ source: "namespace", namespace: "x" }).success).toBe(
      false,
    );
    expect(
      upsertAccountSyncSchema.safeParse({ source: "namespace", forgeId: 1, namespace: "a/b" })
        .success,
    ).toBe(false);
  });

  it("keeps namespace and forgeId off owned and starred syncs", () => {
    expect(upsertAccountSyncSchema.safeParse({ accountId: 1 }).success).toBe(true);
    expect(upsertAccountSyncSchema.safeParse({ accountId: 1, namespace: "x" }).success).toBe(false);
    expect(upsertAccountSyncSchema.safeParse({ accountId: 1, forgeId: 1 }).success).toBe(false);
    expect(upsertAccountSyncSchema.safeParse({ source: "starred" }).success).toBe(false);
  });

  it("lists GitHub as the only namespace-capable kind for now", () => {
    expect(supportsNamespaceSyncKind("github")).toBe(true);
    expect(supportsNamespaceSyncKind("gitlab")).toBe(false);
  });
});

describe("gone repositories", () => {
  const LEONIDA =
    "git fetch failed (128): remote: Repository unavailable due to DMCA takedown.\n" +
    "remote: See the takedown notice for more details:\n" +
    "remote:   https://github.com/github/dmca/blob/master/2026/11/2026-11-24-take-two.md.\n" +
    "fatal: unable to access 'https://github.com/realdody/Leonida.git/': The requested URL returned error: 403";

  it("waits hours, not minutes, before a not-found repository counts as gone", () => {
    expect(GONE_CONFIRM_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it("reads a GitHub DMCA takedown, and the notice it links, out of git's error", () => {
    expect(dmcaTakedown("github", LEONIDA)).toEqual({
      noticeUrl: "https://github.com/github/dmca/blob/master/2026/11/2026-11-24-take-two.md",
    });
  });

  it("still reads the takedown when the notice link is missing or points elsewhere", () => {
    expect(dmcaTakedown("github", "remote: Repository unavailable due to DMCA takedown.")).toEqual({
      noticeUrl: null,
    });
    expect(
      dmcaTakedown(
        "github",
        "remote: Repository unavailable due to DMCA takedown.\nremote:   https://evil.example/github/dmca/x.md",
      ),
    ).toEqual({ noticeUrl: null });
  });

  it("is a GitHub-only status: other forges and other errors are not takedowns", () => {
    expect(dmcaTakedown("gitlab", LEONIDA)).toBeNull();
    expect(dmcaTakedown("generic", LEONIDA)).toBeNull();
    expect(dmcaTakedown(undefined, LEONIDA)).toBeNull();
    expect(dmcaTakedown("github", "remote: Repository not found.")).toBeNull();
    expect(dmcaTakedown("github", null)).toBeNull();
  });
});
