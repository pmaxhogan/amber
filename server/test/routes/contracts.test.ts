import {
  accountSyncListResponseSchema,
  accountSchema,
  amberEventSchema,
  bulkRepoResponseSchema,
  effectiveSettingsResponseSchema,
  eventPayloadSchemas,
  forgeSchema,
  gitRemoteConfigSchema,
  pageSchema,
  repoSchema,
  scopeSettingsResponseSchema,
  type AmberEvent,
} from "@amber/shared";
import { z } from "zod";
import type { LightMyRequestResponse } from "fastify";
import type { InjectPayload } from "light-my-request";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AmberApp } from "../../src/app.ts";
import type { Db } from "../../src/db/db.ts";
import { createTempApp, type TempApp } from "../helpers.ts";

/**
 * The API contract the web client parses against.
 *
 * Every assertion here runs a REAL server response through the SAME shared zod
 * schema the browser uses, which is the one thing the component suite cannot
 * do: it stubs the client, so a server that answered in a different shape would
 * still leave those tests green. Anything that drifts breaks here first.
 */

let temp: TempApp;
let app: AmberApp;
let db: Db;

beforeEach(async () => {
  temp = await createTempApp();
  app = temp.app;
  db = temp.db;
});

afterEach(async () => {
  await temp.close();
});

async function json(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: InjectPayload,
): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
}

async function makeRepo(path: string): Promise<number> {
  const response = await json("POST", "/api/import", { text: `https://github.com/${path}` });
  return response.json<{ results: { repoId: number }[] }>().results[0]!.repoId;
}

/** Collect every event published while `run` executes. */
async function capture(run: () => Promise<unknown>): Promise<AmberEvent[]> {
  const seen: AmberEvent[] = [];
  const off = temp.events.subscribe((event) => seen.push(event));
  try {
    await run();
  } finally {
    off();
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Git remote config
// ---------------------------------------------------------------------------

describe("PATCH /api/git-remote", () => {
  it("renames the user while the remote is disabled and mirrors GET", async () => {
    const patched = await json("PATCH", "/api/git-remote", { username: "backups" });
    expect(patched.statusCode).toBe(200);

    const body = gitRemoteConfigSchema.parse(patched.json());
    expect(body.username).toBe("backups");
    expect(body.enabled).toBe(false);
    expect(body.cloneUrlTemplate).toContain("backups");

    const fetched = await json("GET", "/api/git-remote");
    expect(fetched.json()).toEqual(body);
  });

  it("renames the user while the remote is enabled without touching the password", async () => {
    const enabled = await json("POST", "/api/git-remote/enable");
    const before = enabled.json<{ password: string; rotatedAt: number }>();

    const patched = await json("PATCH", "/api/git-remote", { username: "mirror" });
    const body = gitRemoteConfigSchema.parse(patched.json());

    expect(body.enabled).toBe(true);
    expect(body.username).toBe("mirror");
    // Renaming is not a rotation: the stored hash and its timestamp both stand.
    expect(body.rotatedAt).toBe(before.rotatedAt);
    expect(JSON.stringify(body)).not.toContain(before.password);
  });

  it("rejects a blank username instead of storing one nothing can authenticate as", async () => {
    for (const username of ["", "   "]) {
      const response = await json("PATCH", "/api/git-remote", { username });
      expect(response.statusCode).toBe(400);
    }
    expect((await json("GET", "/api/git-remote")).json<{ username: string }>().username).toBe(
      "amber",
    );
  });

  it("trims the username so a stray space cannot become part of the credential", async () => {
    const patched = await json("PATCH", "/api/git-remote", { username: "  padded  " });
    expect(gitRemoteConfigSchema.parse(patched.json()).username).toBe("padded");
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("settings read and write semantics", () => {
  it("returns only the overrides stored at that scope, never the resolved set", async () => {
    const empty = scopeSettingsResponseSchema.parse(
      (await json("GET", "/api/settings/global")).json(),
    );
    expect(empty.values).toEqual({});
    expect(empty.scopeId).toBeNull();

    await json("PUT", "/api/settings/global", { clone_mode: "mirror" });

    const one = scopeSettingsResponseSchema.parse(
      (await json("GET", "/api/settings/global")).json(),
    );
    // Sparse: the seven keys that were never set stay absent, which is what
    // lets the UI tell "set here" apart from "inherited".
    expect(one.values).toEqual({ clone_mode: "mirror" });
  });

  it("clears an override when a key is written as null and falls back to the next layer", async () => {
    const repoId = await makeRepo("nodejs/node");

    await json("PUT", "/api/settings/global", { clone_mode: "mirror" });
    await json("PUT", `/api/settings/repo/${repoId}`, { clone_mode: "shallow" });

    const beforeClear = effectiveSettingsResponseSchema.parse(
      (await json("GET", `/api/repos/${repoId}/effective-settings`)).json(),
    );
    expect(beforeClear.explanation.clone_mode).toEqual({
      value: "shallow",
      source: "repo",
      sourceId: repoId,
    });

    const cleared = scopeSettingsResponseSchema.parse(
      (await json("PUT", `/api/settings/repo/${repoId}`, { clone_mode: null })).json(),
    );
    expect(cleared.values).toEqual({});

    const afterClear = effectiveSettingsResponseSchema.parse(
      (await json("GET", `/api/repos/${repoId}/effective-settings`)).json(),
    );
    // Not the registry default: resolution falls through to the global layer.
    expect(afterClear.explanation.clone_mode).toEqual({
      value: "mirror",
      source: "global",
      sourceId: null,
    });
  });

  it("round trips a clear on a key that was never set", async () => {
    const response = await json("PUT", "/api/settings/global", { paranoid: null });
    expect(response.statusCode).toBe(200);
    expect(scopeSettingsResponseSchema.parse(response.json()).values).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Collection shapes
// ---------------------------------------------------------------------------

describe("collection response shapes", () => {
  it("answers with bare arrays for forges and accounts", async () => {
    await json("POST", "/api/forges", { host: "github.com" });
    const forgeId = (await json("GET", "/api/forges")).json<{ id: number }[]>()[0]!.id;
    await json("POST", "/api/accounts", { forgeId, username: "octocat", secret: "s3cret" });

    z.array(forgeSchema).parse((await json("GET", "/api/forges")).json());
    z.array(accountSchema).parse((await json("GET", "/api/accounts")).json());
  });

  it("answers with a rows envelope for account syncs", async () => {
    await json("POST", "/api/forges", { host: "github.com" });
    const forgeId = (await json("GET", "/api/forges")).json<{ id: number }[]>()[0]!.id;
    const accountId = (await json("POST", "/api/accounts", { forgeId, username: "octocat" })).json<{
      id: number;
    }>().id;
    await json("POST", "/api/account-syncs", { accountId });

    const body = accountSyncListResponseSchema.parse(
      (await json("GET", "/api/account-syncs")).json(),
    );
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.source).toBe("owned");
  });

  it("answers a bulk action with the full result, not just a count", async () => {
    const first = await makeRepo("nodejs/node");
    const second = await makeRepo("vuejs/core");

    const body = bulkRepoResponseSchema.parse(
      (
        await json("POST", "/api/repos/bulk", { ids: [first, second, 9999], action: "pause" })
      ).json(),
    );
    expect(body).toEqual({
      action: "pause",
      requested: 3,
      affected: 2,
      ids: [first, second],
      missing: [9999],
    });
  });
});

// ---------------------------------------------------------------------------
// Denormalized listing
// ---------------------------------------------------------------------------

describe("GET /api/repos denormalized row fields", () => {
  const repoPageSchema = pageSchema(repoSchema);

  it("carries the resolved clone mode and sync toggle on every row", async () => {
    const repoId = await makeRepo("nodejs/node");

    const defaults = repoPageSchema.parse((await json("GET", "/api/repos")).json());
    expect(defaults.rows[0]).toMatchObject({ cloneMode: "bare", syncEnabled: true });

    await json("PUT", `/api/settings/repo/${repoId}`, {
      clone_mode: "mirror",
      sync_enabled: false,
    });

    const overridden = repoPageSchema.parse((await json("GET", "/api/repos")).json());
    expect(overridden.rows[0]).toMatchObject({ cloneMode: "mirror", syncEnabled: false });
  });

  it("resolves each row against its own layers rather than one shared answer", async () => {
    const first = await makeRepo("nodejs/node");
    await makeRepo("vuejs/core");

    await json("PUT", "/api/settings/global", { clone_mode: "shallow" });
    await json("PUT", `/api/settings/repo/${first}`, { clone_mode: "full" });

    const page = repoPageSchema.parse((await json("GET", "/api/repos?sort=created_at")).json());
    const byId = new Map(page.rows.map((row) => [row.id, row.cloneMode]));
    expect(byId.get(first)).toBe("full");
    expect([...byId.values()].filter((mode) => mode === "shallow")).toHaveLength(1);
  });

  it("carries the newest run outcome and its error kind", async () => {
    const repoId = await makeRepo("nodejs/node");

    const fresh = repoPageSchema.parse((await json("GET", "/api/repos")).json());
    // Never synced: both stay absent rather than guessing an outcome.
    expect(fresh.rows[0]?.lastOutcome).toBeUndefined();
    expect(fresh.rows[0]?.lastErrorKind).toBeUndefined();

    const now = Date.now();
    db.run(
      `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, error, error_kind, duration_ms, created_at, updated_at)
       VALUES (?, ?, ?, 'error', 'boom', 'auth', 5, ?, ?)`,
      repoId,
      now - 1000,
      now - 900,
      now,
      now,
    );
    db.run(
      `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, duration_ms, created_at, updated_at)
       VALUES (?, ?, ?, 'success', 5, ?, ?)`,
      repoId,
      now,
      now + 100,
      now,
      now,
    );

    const latest = repoPageSchema.parse((await json("GET", "/api/repos")).json());
    expect(latest.rows[0]?.lastOutcome).toBe("success");
    expect(latest.rows[0]?.lastErrorKind).toBeUndefined();
  });

  it("does not denormalize onto the single-repo read, which returns the stored row", async () => {
    const repoId = await makeRepo("nodejs/node");
    const one = repoSchema.parse((await json("GET", `/api/repos/${repoId}`)).json());
    expect(one.cloneMode).toBeUndefined();
    expect(one.syncEnabled).toBeUndefined();
  });

  it("resolves a whole page in a bounded number of queries", async () => {
    for (let index = 0; index < 12; index += 1) {
      await makeRepo(`owner/repo-${String(index)}`);
    }

    // The batch resolve is the point: a per-row resolve would be several
    // queries each, so the count has to stay flat as the page grows.
    const counted = new Set<string>();
    const original = db.all.bind(db);
    let calls = 0;
    db.all = ((sql: string, ...params: unknown[]) => {
      calls += 1;
      counted.add(sql);
      return original(sql, ...(params as never[]));
    }) as typeof db.all;
    try {
      const page = pageSchema(repoSchema).parse(
        (await json("GET", "/api/repos?perPage=200")).json(),
      );
      expect(page.rows).toHaveLength(12);
    } finally {
      db.all = original;
    }
    expect(calls).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// SSE contract
// ---------------------------------------------------------------------------

describe("SSE payload contract", () => {
  it("names the subject repoId on every repo event", async () => {
    const created = await capture(() => makeRepo("nodejs/node"));
    const createdEvent = created.find((event) => event.type === "repo.created");
    expect(createdEvent).toBeDefined();
    eventPayloadSchemas["repo.created"].parse(createdEvent?.payload);

    const repoId = (await json("GET", "/api/repos")).json<{ rows: { id: number }[] }>().rows[0]!.id;

    const updated = await capture(() => json("PATCH", `/api/repos/${repoId}`, { state: "paused" }));
    const updatedEvent = updated.find((event) => event.type === "repo.updated");
    expect(eventPayloadSchemas["repo.updated"].parse(updatedEvent?.payload)).toEqual({ repoId });

    const synced = await capture(() => json("POST", `/api/repos/${repoId}/sync`));
    expect(
      eventPayloadSchemas["repo.updated"].parse(
        synced.find((event) => event.type === "repo.updated")?.payload,
      ),
    ).toEqual({ repoId });

    const deleted = await capture(() => json("DELETE", `/api/repos/${repoId}`));
    expect(
      eventPayloadSchemas["repo.deleted"].parse(
        deleted.find((event) => event.type === "repo.deleted")?.payload,
      ),
    ).toEqual({ repoId });
  });

  it("names the subject repoId on bulk actions too", async () => {
    const repoId = await makeRepo("nodejs/node");
    const events = await capture(() =>
      json("POST", "/api/repos/bulk", { ids: [repoId], action: "resume" }),
    );
    const updated = events.find((event) => event.type === "repo.updated");
    expect(eventPayloadSchemas["repo.updated"].parse(updated?.payload)).toEqual({ repoId });
  });

  it("frames every event so the shared envelope schema parses it", async () => {
    const events = await capture(() => makeRepo("nodejs/node"));
    for (const event of events) {
      expect(() => amberEventSchema.parse(event)).not.toThrow();
    }
  });
});
