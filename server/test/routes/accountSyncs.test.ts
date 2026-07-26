import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountSync, AmberEvent } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AmberApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { openDb, type Db } from "../../src/db/db.ts";
import { migrate } from "../../src/db/migrate.ts";
import { EventBus } from "../../src/events.ts";
import { createConsoleLogger } from "../../src/logging.ts";

let dir: string;
let db: Db;
let app: AmberApp;
let events: EventBus;
let seen: AmberEvent[];

function seedForge(kind: string, host: string): number {
  return db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    "https",
    host,
    null,
    kind,
    1,
    1,
  ).lastInsertRowid;
}

function seedAccount(forgeId: number, username: string): number {
  return db.run(
    "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    forgeId,
    username,
    0,
    1,
    1,
  ).lastInsertRowid;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "amber-routes-"));
  const config = loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: dir });
  const log = createConsoleLogger("silent");
  db = openDb(join(dir, "state", "amber.db"));
  migrate(db, log);
  events = new EventBus();
  seen = [];
  events.subscribe((event) => seen.push(event));
  app = await buildApp({ config, log, db, events, version: "9.9.9-test" });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/account-syncs", () => {
  it("creates an owned sync with the documented defaults", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<AccountSync>();
    expect(body).toMatchObject({
      accountId,
      source: "owned",
      visibility: "all",
      enabled: true,
      intervalMinutes: 360,
      lastRunAt: null,
      reposDiscovered: null,
    });
    expect(body.nextRunAt).not.toBeNull();
  });

  it("accepts an explicit visibility and interval on an owned sync", async () => {
    const accountId = seedAccount(seedForge("gitlab", "gitlab.com"), "tanuki");

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, visibility: "private", intervalMinutes: 60, enabled: false },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<AccountSync>()).toMatchObject({
      visibility: "private",
      intervalMinutes: 60,
      enabled: false,
      nextRunAt: null,
    });
  });

  it("creates a starred sync on GitHub", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, source: "starred" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<AccountSync>().source).toBe("starred");
  });

  it("allows one owned and one starred sync for the same account", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    const owned = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });
    const starred = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, source: "starred" },
    });

    expect(owned.statusCode).toBe(201);
    expect(starred.statusCode).toBe(201);
  });

  it("rejects a duplicate account and source pair", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    await app.inject({ method: "POST", url: "/api/account-syncs", payload: { accountId } });

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain("already has a owned sync");
  });

  it("rejects visibility on a starred sync", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, source: "starred", visibility: "public" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain("owned syncs only");
  });

  it("rejects a starred sync anywhere but GitHub", async () => {
    const accountId = seedAccount(seedForge("gitea", "gitea.example.com"), "maintainer");

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, source: "starred" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe(
      "Starred sync is GitHub-only for now",
    );
  });

  it("rejects a generic forge", async () => {
    const accountId = seedAccount(seedForge("generic", "git.example.com"), "someone");

    const response = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain("generic forges");
  });

  it("rejects an unknown account and a malformed body", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId: 999 },
    });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId: "nope", source: "forked" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("invalid_body");
  });
});

describe("GET /api/account-syncs", () => {
  it("lists every sync and filters by account", async () => {
    const forgeId = seedForge("github", "github.com");
    const first = seedAccount(forgeId, "octocat");
    const second = seedAccount(forgeId, "hubot");
    await app.inject({ method: "POST", url: "/api/account-syncs", payload: { accountId: first } });
    await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId: first, source: "starred" },
    });
    await app.inject({ method: "POST", url: "/api/account-syncs", payload: { accountId: second } });

    const all = await app.inject({ method: "GET", url: "/api/account-syncs" });
    expect(all.json<{ rows: AccountSync[] }>().rows).toHaveLength(3);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/account-syncs?accountId=${String(first)}`,
    });
    const rows = filtered.json<{ rows: AccountSync[] }>().rows;
    expect(rows.map((row) => row.source).sort()).toEqual(["owned", "starred"]);
  });

  it("rejects a malformed query", async () => {
    const response = await app.inject({ method: "GET", url: "/api/account-syncs?accountId=abc" });
    expect(response.statusCode).toBe(400);
  });
});

describe("PATCH /api/account-syncs/:id", () => {
  it("updates visibility, interval and enabled state", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    const created = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });
    const id = created.json<AccountSync>().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/account-syncs/${String(id)}`,
      payload: { visibility: "public", intervalMinutes: 30, enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AccountSync>()).toMatchObject({
      visibility: "public",
      intervalMinutes: 30,
      enabled: false,
      nextRunAt: null,
    });
  });

  it("makes a re-enabled sync due immediately", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    const created = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, enabled: false },
    });
    const id = created.json<AccountSync>().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/account-syncs/${String(id)}`,
      payload: { enabled: true },
    });

    expect(response.json<AccountSync>().nextRunAt).not.toBeNull();
  });

  it("rejects setting a visibility on a starred sync", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    const created = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, source: "starred" },
    });
    const id = created.json<AccountSync>().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/account-syncs/${String(id)}`,
      payload: { visibility: "private" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("404s for an unknown id and 400s for a malformed body", async () => {
    expect(
      (await app.inject({ method: "PATCH", url: "/api/account-syncs/77", payload: {} })).statusCode,
    ).toBe(404);

    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    const created = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });
    const id = created.json<AccountSync>().id;
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/account-syncs/${String(id)}`,
      payload: { intervalMinutes: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("DELETE /api/account-syncs/:id", () => {
  it("deletes the sync and unlinks its repos without touching the backups", async () => {
    const forgeId = seedForge("github", "github.com");
    const accountId = seedAccount(forgeId, "octocat");
    const created = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId },
    });
    const id = created.json<AccountSync>().id;
    db.run(
      `INSERT INTO repos (forge_id, path, display_name, slug, short_id, managed_by_account_sync_id, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'account_sync', ?, ?)`,
      forgeId,
      "octocat/one",
      "one",
      "octocat-one-aaaaaaaa",
      "aaaaaaaa",
      id,
      1,
      1,
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/account-syncs/${String(id)}`,
    });
    expect(response.statusCode).toBe(204);

    const repo = db.get<{ managed_by_account_sync_id: number | null }>(
      "SELECT managed_by_account_sync_id FROM repos WHERE path = ?",
      "octocat/one",
    );
    expect(repo?.managed_by_account_sync_id).toBeNull();

    const again = await app.inject({ method: "DELETE", url: `/api/account-syncs/${String(id)}` });
    expect(again.statusCode).toBe(404);
  });
});

describe("POST /api/account-syncs/:id/run", () => {
  it("runs now, reports the counters and publishes an event", async () => {
    const accountId = seedAccount(seedForge("github", "github.com"), "octocat");
    const created = await app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { accountId, visibility: "private" },
    });
    const id = created.json<AccountSync>().id;

    // The account has no stored credential, so the GitHub client refuses before
    // it would reach the network: a run that records an error, not a throw.
    const response = await app.inject({
      method: "POST",
      url: `/api/account-syncs/${String(id)}/run`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ error: string | null; discovered: number }>();
    expect(body.error).toContain("needs a stored credential");
    expect(body.discovered).toBe(0);
    expect(seen.map((event) => event.type)).toContain("account_sync.finished");
  });

  it("404s for an unknown id", async () => {
    const response = await app.inject({ method: "POST", url: "/api/account-syncs/91/run" });
    expect(response.statusCode).toBe(404);
  });
});
