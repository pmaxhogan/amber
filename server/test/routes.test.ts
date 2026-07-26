import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings } from "@amber/shared";
import type { LightMyRequestResponse } from "fastify";
import type { InjectPayload } from "light-my-request";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AmberApp } from "../src/app.ts";
import type { Db } from "../src/db/db.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

const SENTINEL = "SENTINEL-github_pat_11ABCDEF-do-not-leak";

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
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  return response;
}

async function makeForge(host = "github.com"): Promise<number> {
  const response = await json("POST", "/api/forges", { host });
  return response.json<{ id: number }>().id;
}

async function makeRepo(forgeId: number, path: string): Promise<number> {
  const response = await json("POST", "/api/import", {
    text: `https://github.com/${path}`,
  });
  void forgeId;
  return response.json<{ results: { repoId: number }[] }>().results[0]!.repoId;
}

// ---------------------------------------------------------------------------
// Forges
// ---------------------------------------------------------------------------

describe("GET/POST /api/forges", () => {
  it("creates a forge with a detected kind and lists it", async () => {
    const created = await json("POST", "/api/forges", { host: "github.com" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ host: "github.com", kind: "github", protocol: "https" });

    const list = await json("GET", "/api/forges");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it("is idempotent and answers 200 the second time", async () => {
    await json("POST", "/api/forges", { host: "github.com" });
    const again = await json("POST", "/api/forges", { host: "github.com" });
    expect(again.statusCode).toBe(200);
    expect((await json("GET", "/api/forges")).json()).toHaveLength(1);
  });

  it("accepts an explicit kind and port", async () => {
    const created = await json("POST", "/api/forges", {
      host: "git.example.com",
      port: 8443,
      kind: "gitea",
    });
    expect(created.json()).toMatchObject({ port: 8443, kind: "gitea" });
  });

  it("rejects a malformed body", async () => {
    expect((await json("POST", "/api/forges", {})).statusCode).toBe(400);
    expect((await json("POST", "/api/forges", { host: "" })).statusCode).toBe(400);
    expect((await json("POST", "/api/forges", { host: "x", port: 70000 })).statusCode).toBe(400);
    expect((await json("POST", "/api/forges", { host: "x", kind: "svn" })).statusCode).toBe(400);
    expect((await json("POST", "/api/forges", { host: "x", protocol: "ftp" })).statusCode).toBe(
      400,
    );
  });
});

describe("PATCH /api/forges/:id keeps the origin immutable", () => {
  it("changes the kind", async () => {
    const id = await makeForge("git.example.com");
    const patched = await json("PATCH", `/api/forges/${String(id)}`, { kind: "gitlab" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ kind: "gitlab", host: "git.example.com" });
  });

  it("ignores a host, protocol, or port sent in the body", async () => {
    const id = await makeForge("github.com");
    const patched = await json("PATCH", `/api/forges/${String(id)}`, {
      kind: "github",
      host: "evil.example.com",
      protocol: "http",
      port: 1337,
    });
    expect(patched.json()).toMatchObject({ host: "github.com", protocol: "https", port: null });

    // Confirmed against a fresh read, not just the write response.
    const list = await json("GET", "/api/forges");
    expect(list.json()).toMatchObject([{ host: "github.com", protocol: "https", port: null }]);
  });

  it("offers no other verb that could rewrite the host", async () => {
    const id = await makeForge("github.com");
    for (const method of ["PUT", "POST"] as const) {
      const response = await json(method, `/api/forges/${String(id)}`, {
        host: "evil.example.com",
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await json("GET", "/api/forges")).json()).toMatchObject([{ host: "github.com" }]);
  });

  it("404s for an unknown id and 400s for a non numeric one", async () => {
    expect((await json("PATCH", "/api/forges/999", { kind: "gitea" })).statusCode).toBe(404);
    expect((await json("PATCH", "/api/forges/abc", { kind: "gitea" })).statusCode).toBe(400);
  });
});

describe("DELETE /api/forges/:id", () => {
  it("removes an unused forge", async () => {
    const id = await makeForge();
    expect((await json("DELETE", `/api/forges/${String(id)}`)).statusCode).toBe(204);
    expect((await json("GET", "/api/forges")).json()).toHaveLength(0);
  });

  it("409s while repositories still reference it", async () => {
    const id = await makeForge();
    await makeRepo(id, "nodejs/node");
    const response = await json("DELETE", `/api/forges/${String(id)}`);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "conflict" });
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe("/api/accounts", () => {
  let forgeId: number;

  beforeEach(async () => {
    forgeId = await makeForge();
  });

  it("creates an account and reports hasSecret without the secret", async () => {
    const created = await json("POST", "/api/accounts", {
      forgeId,
      username: "pmaxhogan",
      secret: SENTINEL,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      username: "pmaxhogan",
      hasSecret: true,
      isDefault: true,
      forgeId,
    });
    expect(created.json()).not.toHaveProperty("secret");
  });

  it("lists, filters by forge, and fetches one", async () => {
    const other = await makeForge("gitlab.com");
    await json("POST", "/api/accounts", { forgeId, username: "gh" });
    const gl = await json("POST", "/api/accounts", { forgeId: other, username: "gl" });

    expect((await json("GET", "/api/accounts")).json()).toHaveLength(2);
    expect((await json("GET", `/api/accounts?forgeId=${String(forgeId)}`)).json()).toHaveLength(1);
    const one = await json("GET", `/api/accounts/${String(gl.json<{ id: number }>().id)}`);
    expect(one.json()).toMatchObject({ username: "gl" });
  });

  it("promotes a default and demotes the previous one", async () => {
    const first = await json("POST", "/api/accounts", { forgeId, username: "first" });
    const second = await json("POST", "/api/accounts", { forgeId, username: "second" });
    const firstId = first.json<{ id: number }>().id;
    const secondId = second.json<{ id: number }>().id;

    const promoted = await json("POST", `/api/accounts/${String(secondId)}/default`);
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ isDefault: true });

    const all = await json("GET", `/api/accounts?forgeId=${String(forgeId)}`);
    const defaults = all.json<{ id: number; isDefault: boolean }[]>().filter((a) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(secondId);
    expect(firstId).not.toBe(secondId);
  });

  it("updates and clears the secret", async () => {
    const created = await json("POST", "/api/accounts", {
      forgeId,
      username: "pmaxhogan",
      secret: SENTINEL,
    });
    const id = created.json<{ id: number }>().id;

    expect(
      (await json("PATCH", `/api/accounts/${String(id)}`, { username: "renamed" })).json(),
    ).toMatchObject({ username: "renamed", hasSecret: true });
    expect(
      (await json("PATCH", `/api/accounts/${String(id)}`, { secret: null })).json(),
    ).toMatchObject({ hasSecret: false });
  });

  it("cannot move an account to another forge through the API", async () => {
    const other = await makeForge("gitlab.com");
    const created = await json("POST", "/api/accounts", {
      forgeId,
      username: "pmaxhogan",
      secret: SENTINEL,
    });
    const id = created.json<{ id: number }>().id;

    const patched = await json("PATCH", `/api/accounts/${String(id)}`, {
      forgeId: other,
      username: "pmaxhogan",
    });
    expect(patched.json()).toMatchObject({ forgeId });

    const fresh = await json("GET", `/api/accounts/${String(id)}`);
    expect(fresh.json()).toMatchObject({ forgeId });
    expect((await json("GET", `/api/accounts?forgeId=${String(other)}`)).json()).toHaveLength(0);
  });

  it("deletes an account and promotes the oldest remaining", async () => {
    const first = await json("POST", "/api/accounts", { forgeId, username: "first" });
    const second = await json("POST", "/api/accounts", { forgeId, username: "second" });
    const firstId = first.json<{ id: number }>().id;

    expect((await json("DELETE", `/api/accounts/${String(firstId)}`)).statusCode).toBe(204);
    const remaining = await json(
      "GET",
      `/api/accounts/${String(second.json<{ id: number }>().id)}`,
    );
    expect(remaining.json()).toMatchObject({ isDefault: true });
  });

  it("409s on a duplicate username", async () => {
    await json("POST", "/api/accounts", { forgeId, username: "pmaxhogan" });
    const dup = await json("POST", "/api/accounts", { forgeId, username: "pmaxhogan" });
    expect(dup.statusCode).toBe(409);
  });

  it("404s for an unknown account and 400s for a bad body", async () => {
    expect((await json("GET", "/api/accounts/999")).statusCode).toBe(404);
    expect((await json("DELETE", "/api/accounts/999")).statusCode).toBe(404);
    expect((await json("POST", "/api/accounts", { username: "x" })).statusCode).toBe(400);
    expect((await json("POST", "/api/accounts", { forgeId, username: "" })).statusCode).toBe(400);
  });
});

describe("no account endpoint ever emits secret material", () => {
  it("keeps the sentinel out of every raw response body", async () => {
    const forgeId = await makeForge();
    const bodies: string[] = [];

    const created = await json("POST", "/api/accounts", {
      forgeId,
      username: "pmaxhogan",
      secret: SENTINEL,
    });
    bodies.push(created.body);
    const id = created.json<{ id: number }>().id;

    bodies.push((await json("GET", "/api/accounts")).body);
    bodies.push((await json("GET", `/api/accounts?forgeId=${String(forgeId)}`)).body);
    bodies.push((await json("GET", `/api/accounts/${String(id)}`)).body);
    bodies.push((await json("PATCH", `/api/accounts/${String(id)}`, { secret: SENTINEL })).body);
    bodies.push((await json("POST", `/api/accounts/${String(id)}/default`)).body);

    // Error paths carry the secret in the request; they must not echo it.
    bodies.push(
      (await json("POST", "/api/accounts", { forgeId, username: "pmaxhogan", secret: SENTINEL }))
        .body,
    );
    bodies.push(
      (await json("POST", "/api/accounts", { forgeId: 999, username: "x", secret: SENTINEL })).body,
    );
    bodies.push((await json("PATCH", "/api/accounts/999", { secret: SENTINEL })).body);

    // And the ciphertext must not leak either.
    const row = db.get<{ secret_enc: Uint8Array }>(
      "SELECT secret_enc FROM accounts WHERE id = ?",
      id,
    );
    const blob = Buffer.from(row!.secret_enc);

    for (const body of bodies) {
      expect(body).not.toContain(SENTINEL);
      expect(body).not.toContain("hunter2");
      expect(body).not.toContain(blob.toString("base64"));
      expect(body).not.toContain(blob.toString("hex"));
      expect(body).not.toContain("secret_enc");
    }
  });
});

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

describe("GET /api/repos", () => {
  beforeEach(async () => {
    await json("POST", "/api/import", {
      text: [
        "https://github.com/nodejs/node",
        "https://github.com/facebook/react",
        "https://gitlab.com/gitlab-org/gitlab",
      ].join("\n"),
    });
  });

  it("returns a page envelope", async () => {
    const response = await json("GET", "/api/repos");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 3, page: 1, perPage: 50 });
    expect(response.json<{ rows: unknown[] }>().rows).toHaveLength(3);
  });

  it("paginates", async () => {
    const first = await json("GET", "/api/repos?perPage=2&page=1");
    const second = await json("GET", "/api/repos?perPage=2&page=2");
    expect(first.json<{ rows: unknown[] }>().rows).toHaveLength(2);
    expect(second.json<{ rows: unknown[] }>().rows).toHaveLength(1);
    expect(second.json()).toMatchObject({ total: 3, page: 2, perPage: 2 });
  });

  it("caps perPage at 200", async () => {
    expect((await json("GET", "/api/repos?perPage=200")).statusCode).toBe(200);
    expect((await json("GET", "/api/repos?perPage=201")).statusCode).toBe(400);
    expect((await json("GET", "/api/repos?perPage=0")).statusCode).toBe(400);
    expect((await json("GET", "/api/repos?page=0")).statusCode).toBe(400);
  });

  it("sorts by an allowlisted column in both directions", async () => {
    const asc = await json("GET", "/api/repos?sort=display_name&dir=asc");
    const desc = await json("GET", "/api/repos?sort=display_name&dir=desc");
    const names = (r: typeof asc) =>
      r.json<{ rows: { displayName: string }[] }>().rows.map((x) => x.displayName);
    expect(names(asc)).toEqual(["gitlab", "node", "react"]);
    expect(names(desc)).toEqual(["react", "node", "gitlab"]);
  });

  it("rejects a sort column that is not on the allowlist", async () => {
    for (const sort of [
      "id",
      "secret_enc",
      "created_at; DROP TABLE repos--",
      "display_name)--",
      "",
    ]) {
      const response = await json("GET", `/api/repos?sort=${encodeURIComponent(sort)}`);
      expect(response.statusCode).toBe(400);
    }
    // Nothing got through: the table is intact and still holds every row.
    expect((await json("GET", "/api/repos")).json()).toMatchObject({ total: 3 });
  });

  it("rejects a direction that is not asc or desc", async () => {
    expect((await json("GET", "/api/repos?dir=sideways")).statusCode).toBe(400);
    expect((await json("GET", "/api/repos?dir=asc--")).statusCode).toBe(400);
  });

  it("filters by q, forgeId, state, and outcome", async () => {
    expect((await json("GET", "/api/repos?q=node")).json()).toMatchObject({ total: 1 });
    expect((await json("GET", "/api/repos?q=NODE")).json()).toMatchObject({ total: 1 });

    const forges = (await json("GET", "/api/forges")).json<{ id: number; host: string }[]>();
    const github = forges.find((forge) => forge.host === "github.com")!.id;
    expect((await json("GET", `/api/repos?forgeId=${String(github)}`)).json()).toMatchObject({
      total: 2,
    });

    const rows = (await json("GET", "/api/repos")).json<{ rows: { id: number }[] }>().rows;
    await json("PATCH", `/api/repos/${String(rows[0]!.id)}`, { state: "paused" });
    expect((await json("GET", "/api/repos?state=paused")).json()).toMatchObject({ total: 1 });
    expect((await json("GET", "/api/repos?state=active")).json()).toMatchObject({ total: 2 });

    const now = Date.now();
    db.run(
      `INSERT INTO sync_runs (repo_id, started_at, outcome, created_at, updated_at)
       VALUES (?, ?, 'error', ?, ?)`,
      rows[1]!.id,
      now,
      now,
      now,
    );
    expect((await json("GET", "/api/repos?outcome=error")).json()).toMatchObject({ total: 1 });
    expect((await json("GET", "/api/repos?outcome=success")).json()).toMatchObject({ total: 0 });
    expect((await json("GET", "/api/repos?outcome=nonsense")).statusCode).toBe(400);
  });
});

describe("/api/repos/:id", () => {
  let repoId: number;
  let forgeId: number;

  beforeEach(async () => {
    const imported = await json("POST", "/api/import", {
      text: "https://github.com/nodejs/node",
    });
    repoId = imported.json<{ results: { repoId: number }[] }>().results[0]!.repoId;
    forgeId = (await json("GET", "/api/forges")).json<{ id: number }[]>()[0]!.id;
  });

  it("returns one repo and 404s for an unknown id", async () => {
    expect((await json("GET", `/api/repos/${String(repoId)}`)).json()).toMatchObject({
      path: "nodejs/node",
      displayName: "node",
    });
    expect((await json("GET", "/api/repos/999")).statusCode).toBe(404);
    expect((await json("GET", "/api/repos/abc")).statusCode).toBe(400);
  });

  it("pauses, resumes, and toggles force_anonymous", async () => {
    expect(
      (await json("PATCH", `/api/repos/${String(repoId)}`, { state: "paused" })).json(),
    ).toMatchObject({ state: "paused" });
    expect(
      (await json("PATCH", `/api/repos/${String(repoId)}`, { forceAnonymous: true })).json(),
    ).toMatchObject({ forceAnonymous: true });
    expect(
      (await json("PATCH", `/api/repos/${String(repoId)}`, { state: "active" })).json(),
    ).toMatchObject({ state: "active" });
  });

  it("sets an account override only from the same forge", async () => {
    const mine = await json("POST", "/api/accounts", { forgeId, username: "pmaxhogan" });
    const otherForge = await makeForge("gitlab.com");
    const theirs = await json("POST", "/api/accounts", {
      forgeId: otherForge,
      username: "someone",
    });

    const ok = await json("PATCH", `/api/repos/${String(repoId)}`, {
      accountOverrideId: mine.json<{ id: number }>().id,
    });
    expect(ok.json()).toMatchObject({ accountOverrideId: mine.json<{ id: number }>().id });

    const rejected = await json("PATCH", `/api/repos/${String(repoId)}`, {
      accountOverrideId: theirs.json<{ id: number }>().id,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ message: string }>().message).toMatch(/different forge/);
  });

  it("renames the path but never the forge", async () => {
    const otherForge = await makeForge("gitlab.com");
    const patched = await json("PATCH", `/api/repos/${String(repoId)}`, {
      path: "nodejs/node-renamed",
      forgeId: otherForge,
    });
    expect(patched.json()).toMatchObject({ path: "nodejs/node-renamed", forgeId });

    const fresh = await json("GET", `/api/repos/${String(repoId)}`);
    expect(fresh.json()).toMatchObject({ forgeId });
  });

  it("requests an immediate sync", async () => {
    const before = Date.now();
    const response = await json("POST", `/api/repos/${String(repoId)}/sync`);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ nextSyncAt: number }>().nextSyncAt).toBeGreaterThanOrEqual(before);
    expect((await json("POST", "/api/repos/999/sync")).statusCode).toBe(404);
  });

  it("pages the sync runs newest first", async () => {
    for (const [startedAt, outcome] of [
      [1000, "success"],
      [3000, "error"],
      [2000, "success"],
    ] as const) {
      db.run(
        `INSERT INTO sync_runs (repo_id, started_at, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        repoId,
        startedAt,
        outcome,
        startedAt,
        startedAt,
      );
    }
    const runs = await json("GET", `/api/repos/${String(repoId)}/runs?perPage=2`);
    expect(runs.json()).toMatchObject({ total: 3, page: 1, perPage: 2 });
    expect(runs.json<{ rows: { startedAt: number }[] }>().rows.map((r) => r.startedAt)).toEqual([
      3000, 2000,
    ]);
    expect((await json("GET", "/api/repos/999/runs")).statusCode).toBe(404);
  });
});

describe("DELETE /api/repos/:id", () => {
  let repoId: number;
  let slug: string;

  beforeEach(async () => {
    const imported = await json("POST", "/api/import", {
      text: "https://github.com/nodejs/node",
    });
    repoId = imported.json<{ results: { repoId: number }[] }>().results[0]!.repoId;
    slug = (await json("GET", `/api/repos/${String(repoId)}`)).json<{ slug: string }>().slug;
  });

  const seedBackupDir = (): string => {
    const dir = join(temp.config.backupsDir, slug);
    mkdirSync(join(dir, "objects"), { recursive: true });
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    return dir;
  };

  it("removes the row and leaves the backup directory by default", async () => {
    const dir = seedBackupDir();
    expect((await json("DELETE", `/api/repos/${String(repoId)}`)).statusCode).toBe(204);
    expect((await json("GET", `/api/repos/${String(repoId)}`)).statusCode).toBe(404);
    expect(existsSync(dir)).toBe(true);
  });

  it("removes the backup directory with ?files=true", async () => {
    const dir = seedBackupDir();
    expect((await json("DELETE", `/api/repos/${String(repoId)}?files=true`)).statusCode).toBe(204);
    expect(existsSync(dir)).toBe(false);
    // Only that repo's directory went; the backups root survives.
    expect(existsSync(temp.config.backupsDir)).toBe(true);
  });

  it("treats files=false and an absent flag the same", async () => {
    const dir = seedBackupDir();
    await json("DELETE", `/api/repos/${String(repoId)}?files=false`);
    expect(existsSync(dir)).toBe(true);
  });

  it("succeeds when the backup directory was never created", async () => {
    expect((await json("DELETE", `/api/repos/${String(repoId)}?files=true`)).statusCode).toBe(204);
  });

  it("refuses to touch the filesystem for a repo with a tampered slug", async () => {
    const dir = seedBackupDir();
    db.run("UPDATE repos SET slug = ? WHERE id = ?", "../../../etc", repoId);
    const response = await json("DELETE", `/api/repos/${String(repoId)}?files=true`);
    expect(response.statusCode).toBe(400);
    expect(existsSync(dir)).toBe(true);
    expect((await json("GET", `/api/repos/${String(repoId)}`)).statusCode).toBe(200);
  });

  it("404s for an unknown repo", async () => {
    expect((await json("DELETE", "/api/repos/999")).statusCode).toBe(404);
  });
});

describe("POST /api/repos/bulk", () => {
  let ids: number[];

  beforeEach(async () => {
    const imported = await json("POST", "/api/import", {
      text: ["github.com/a/one", "github.com/b/two", "github.com/c/three"].join("\n"),
    });
    ids = imported.json<{ results: { repoId: number }[] }>().results.map((r) => r.repoId);
  });

  it("pauses and resumes a selection", async () => {
    const paused = await json("POST", "/api/repos/bulk", { ids, action: "pause" });
    expect(paused.json()).toMatchObject({ action: "pause", requested: 3, affected: 3 });
    expect((await json("GET", "/api/repos?state=paused")).json()).toMatchObject({ total: 3 });

    await json("POST", "/api/repos/bulk", { ids, action: "resume" });
    expect((await json("GET", "/api/repos?state=active")).json()).toMatchObject({ total: 3 });
  });

  it("syncs a selection", async () => {
    const response = await json("POST", "/api/repos/bulk", { ids, action: "sync" });
    expect(response.json()).toMatchObject({ action: "sync", affected: 3 });
  });

  it("deletes a selection, with files when asked", async () => {
    const slugs = (await json("GET", "/api/repos")).json<{ rows: { slug: string }[] }>().rows;
    const dirs = slugs.map((row) => {
      const dir = join(temp.config.backupsDir, row.slug);
      mkdirSync(dir, { recursive: true });
      return dir;
    });

    const response = await json("POST", "/api/repos/bulk", { ids, action: "delete", files: true });
    expect(response.json()).toMatchObject({ action: "delete", affected: 3 });
    expect((await json("GET", "/api/repos")).json()).toMatchObject({ total: 0 });
    expect(dirs.every((dir) => !existsSync(dir))).toBe(true);
  });

  it("reports ids that no longer exist rather than failing the batch", async () => {
    const response = await json("POST", "/api/repos/bulk", {
      ids: [ids[0], 998, 999],
      action: "pause",
    });
    expect(response.json()).toMatchObject({ requested: 3, affected: 1, missing: [998, 999] });
  });

  it("rejects a malformed request", async () => {
    expect((await json("POST", "/api/repos/bulk", { ids: [], action: "pause" })).statusCode).toBe(
      400,
    );
    expect((await json("POST", "/api/repos/bulk", { ids, action: "explode" })).statusCode).toBe(
      400,
    );
    expect((await json("POST", "/api/repos/bulk", { action: "pause" })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("/api/settings", () => {
  let forgeId: number;
  let repoId: number;

  beforeEach(async () => {
    const imported = await json("POST", "/api/import", {
      text: "https://github.com/nodejs/node",
    });
    repoId = imported.json<{ results: { repoId: number }[] }>().results[0]!.repoId;
    forgeId = (await json("GET", "/api/forges")).json<{ id: number }[]>()[0]!.id;
  });

  it("reads and writes the global scope with no scope id", async () => {
    expect((await json("GET", "/api/settings/global")).json()).toEqual({
      scopeType: "global",
      scopeId: null,
      values: {},
    });

    const written = await json("PUT", "/api/settings/global", { clone_mode: "mirror" });
    expect(written.json()).toMatchObject({ values: { clone_mode: "mirror" } });
    expect((await json("GET", "/api/settings/global")).json()).toMatchObject({
      values: { clone_mode: "mirror" },
    });
  });

  it("reads and writes the forge and repo scopes", async () => {
    await json("PUT", `/api/settings/forge/${String(forgeId)}`, { paranoid: true });
    await json("PUT", `/api/settings/repo/${String(repoId)}`, { shallow_depth: 5 });

    expect((await json("GET", `/api/settings/forge/${String(forgeId)}`)).json()).toMatchObject({
      scopeType: "forge",
      scopeId: forgeId,
      values: { paranoid: true },
    });
    expect((await json("GET", `/api/settings/repo/${String(repoId)}`)).json()).toMatchObject({
      values: { shallow_depth: 5 },
    });
  });

  it("clears an override with null", async () => {
    await json("PUT", `/api/settings/repo/${String(repoId)}`, { clone_mode: "mirror" });
    const cleared = await json("PUT", `/api/settings/repo/${String(repoId)}`, {
      clone_mode: null,
    });
    expect(cleared.json()).toMatchObject({ values: {} });
  });

  it("rejects unknown keys and bad values with per key details", async () => {
    const unknown = await json("PUT", "/api/settings/global", { not_a_setting: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: "invalid",
      details: { settings: { not_a_setting: "Unknown setting" } },
    });

    expect((await json("PUT", "/api/settings/global", { clone_mode: "nope" })).statusCode).toBe(
      400,
    );
    expect((await json("PUT", "/api/settings/global", { shallow_depth: 0 })).statusCode).toBe(400);
  });

  it("rejects a global only key at a narrower scope", async () => {
    const response = await json("PUT", `/api/settings/repo/${String(repoId)}`, {
      max_concurrent_syncs: 2,
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown scope type and a scope id that names nothing", async () => {
    expect((await json("GET", "/api/settings/universe")).statusCode).toBe(400);
    expect((await json("GET", "/api/settings/forge/999")).statusCode).toBe(404);
    expect((await json("PUT", "/api/settings/forge/999", { paranoid: true })).statusCode).toBe(404);
    expect((await json("GET", "/api/settings/forge")).statusCode).toBe(400);
  });

  it("explains the effective settings for a repo", async () => {
    await json("PUT", "/api/settings/global", { sync_interval_minutes: 60 });
    await json("PUT", `/api/settings/forge/${String(forgeId)}`, { clone_mode: "mirror" });
    await json("PUT", `/api/settings/repo/${String(repoId)}`, { paranoid: true });

    const response = await json("GET", `/api/repos/${String(repoId)}/effective-settings`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      repoId: number;
      settings: Record<string, unknown>;
      explanation: Record<string, { source: string; sourceId: number | null }>;
    }>();

    expect(body.repoId).toBe(repoId);
    expect(body.settings).toMatchObject({
      sync_interval_minutes: 60,
      clone_mode: "mirror",
      paranoid: true,
      shallow_depth: defaultSettings().shallow_depth,
    });
    expect(body.explanation["sync_interval_minutes"]).toMatchObject({
      source: "global",
      sourceId: null,
    });
    expect(body.explanation["clone_mode"]).toMatchObject({ source: "forge", sourceId: forgeId });
    expect(body.explanation["paranoid"]).toMatchObject({ source: "repo", sourceId: repoId });
    expect(body.explanation["shallow_depth"]).toMatchObject({ source: "default", sourceId: null });
  });

  it("404s the explain view for an unknown repo", async () => {
    expect((await json("GET", "/api/repos/999/effective-settings")).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("/api/import", () => {
  it("previews without writing anything", async () => {
    const response = await json("POST", "/api/import/preview", {
      text: ["https://github.com/nodejs/node", "git@github.com:torvalds/linux.git"].join("\n"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ summary: { total: 2, ok: 1, warning: 0, error: 1 } });
    expect((await json("GET", "/api/repos")).json()).toMatchObject({ total: 0 });
    expect((await json("GET", "/api/forges")).json()).toHaveLength(0);
  });

  it("commits, creating forges and repos", async () => {
    const response = await json("POST", "/api/import", {
      text: ["https://github.com/nodejs/node", "gitlab.com/a/b"].join("\n"),
    });
    expect(response.json()).toMatchObject({ created: 2, updated: 0, failed: 0 });
    expect((await json("GET", "/api/repos")).json()).toMatchObject({ total: 2 });
    expect((await json("GET", "/api/forges")).json()).toHaveLength(2);
  });

  it("is idempotent on a second commit", async () => {
    await json("POST", "/api/import", { text: "https://github.com/nodejs/node" });
    const again = await json("POST", "/api/import", { text: "https://github.com/nodejs/node" });
    expect(again.json()).toMatchObject({ created: 0, updated: 1 });
    expect((await json("GET", "/api/repos")).json()).toMatchObject({ total: 1 });
  });

  it("warns rather than failing when a user prefix names no account", async () => {
    const response = await json("POST", "/api/import", { text: "ghost@github.com/a/b" });
    expect(response.json()).toMatchObject({ created: 1, failed: 0 });
    expect(response.json<{ results: { status: string }[] }>().results[0]?.status).toBe("warning");
    expect((await json("GET", "/api/accounts")).json()).toHaveLength(0);
  });

  it("never echoes a password that was pasted into a URL", async () => {
    const response = await json("POST", "/api/import", {
      text: "https://user:hunter2@github.com/a/b",
    });
    expect(response.json()).toMatchObject({ failed: 1, created: 0 });
    expect(response.body).not.toContain("hunter2");
  });

  it("rejects a malformed body", async () => {
    expect((await json("POST", "/api/import", {})).statusCode).toBe(400);
    expect((await json("POST", "/api/import/preview", { text: 42 })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("GET /api/status", () => {
  it("reports insecure mode, version, and totals", async () => {
    const response = await json("GET", "/api/status");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: "9.9.9-test",
      insecureMode: true,
      queueDepth: 0,
      activeSyncs: 0,
      totalRepos: 0,
      totalDiskUsageBytes: 0,
      breakerOpen: false,
    });
  });

  it("counts repos and sums disk usage", async () => {
    await json("POST", "/api/import", {
      text: ["github.com/a/one", "github.com/b/two"].join("\n"),
    });
    db.run("UPDATE repos SET disk_usage_bytes = 1024");

    expect((await json("GET", "/api/status")).json()).toMatchObject({
      totalRepos: 2,
      totalDiskUsageBytes: 2048,
    });
  });

  it("reads the queue from an attached scheduler", async () => {
    const scheduled = await createTempApp(
      {},
      {
        scheduler: {
          status: () => ({ queueDepth: 7, activeSyncs: 3, breakerOpen: true }),
          enqueueNow: () => {},
        },
      },
    );
    const response = await scheduled.app.inject({ method: "GET", url: "/api/status" });
    expect(response.json()).toMatchObject({ queueDepth: 7, activeSyncs: 3, breakerOpen: true });
    await scheduled.close();
  });

  it("reports insecureMode false when Cloudflare Access is configured", async () => {
    const secure = await createTempApp({
      INSECURE_ALLOW_PUBLIC_ACCESS: "0",
      CF_ACCESS_TEAM_DOMAIN: "amber.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud-value",
      CF_ACCESS_ALLOWED_EMAILS: "max@unbroker.com",
    });
    // Guarded now, so the request is rejected before it reaches the handler.
    const response = await secure.app.inject({ method: "GET", url: "/api/status" });
    expect(response.statusCode).toBe(401);
    expect(secure.config.insecureMode).toBe(false);
    await secure.close();
  });
});

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

describe("error responses", () => {
  it("uses the shared ApiError shape", async () => {
    const response = await json("GET", "/api/repos/999");
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: string; message: string }>();
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("404s an unknown api route in the same shape", async () => {
    const response = await json("GET", "/api/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
  });

  it("400s a malformed JSON body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/forges",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
  });
});
