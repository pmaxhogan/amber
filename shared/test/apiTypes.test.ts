import { describe, expect, it } from "vitest";
import {
  MAX_PER_PAGE,
  bulkRepoRequestSchema,
  createAccountSchema,
  createForgeSchema,
  forgeSchema,
  healthSchema,
  pageSchema,
  paginationQuerySchema,
  repoListQuerySchema,
  settingsScopeParamsSchema,
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

  it("defaults account sync to every repo every 6 hours", () => {
    expect(upsertAccountSyncSchema.parse({ accountId: 2 })).toEqual({
      accountId: 2,
      source: "owned",
      visibility: "all",
      enabled: true,
      intervalMinutes: 360,
    });
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
