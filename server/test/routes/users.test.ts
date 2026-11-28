import {
  adoptReposResponseSchema,
  meSchema,
  userListResponseSchema,
  userRefreshResponseSchema,
  userRowSchema,
} from "@amber/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail, getAdminUser } from "../../src/domain/users.ts";
import { CF_ACCESS_HEADER } from "../../src/security/cfAccess.ts";
import {
  ADMIN_EMAIL,
  asUser,
  createAccessKeys,
  FakeClock,
  FakePolicyEndpoint,
  POLICY_ACCOUNT_ID,
  POLICY_ID,
  POLICY_TOKEN,
  secureEnv,
  type AccessKeys,
} from "../helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "../helpers.ts";

/**
 * /api/me and /api/users, with every response run through the shared schema
 * the web app parses with, so the contract cannot drift from the server.
 */

const FRIEND = "friend@example.com";
let temp: TempApp | undefined;
let keys: AccessKeys;

beforeAll(async () => {
  keys = await createAccessKeys();
});

afterEach(async () => {
  await temp?.close();
  temp = undefined;
});

async function insecureApp(): Promise<TempApp> {
  temp = await createTempApp({ AMBER_ADMIN_EMAIL: ADMIN_EMAIL, INSECURE_USER_EMAILS: FRIEND });
  return temp;
}

function addRepo(t: TempApp, name: string, owner: number, bytes: number): number {
  const forgeId = seedForge(t.db);
  return t.db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, owner_user_id,
                        disk_usage_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    forgeId,
    `o/${name}`,
    name,
    `o-${name}-${name.padEnd(8, "q")}`,
    name.padEnd(8, "q"),
    owner,
    bytes,
  ).lastInsertRowid;
}

describe("GET /api/me", () => {
  it("reports the caller's storage against their cap", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, FRIEND)!;
    addRepo(t, "big", friend.id, 6 * 1024 ** 3);

    const me = meSchema.parse(
      (await t.app.inject({ method: "GET", url: "/api/me", headers: asUser(FRIEND) })).json(),
    );
    expect(me.storage).toEqual({
      usedBytes: 6 * 1024 ** 3,
      capBytes: 5 * 1024 ** 3,
      overCap: true,
      atCeiling: false,
    });
    expect(me.policy).toBeNull();

    // Twice the cap: /api/me says syncing is paused.
    addRepo(t, "bigger", friend.id, 4 * 1024 ** 3);
    const after = meSchema.parse(
      (await t.app.inject({ method: "GET", url: "/api/me", headers: asUser(FRIEND) })).json(),
    );
    expect(after.storage).toMatchObject({ overCap: true, atCeiling: true });
  });
});

describe("GET /api/users", () => {
  it("lists every user for the admin, and nobody else", async () => {
    const t = await insecureApp();
    const response = await t.app.inject({ method: "GET", url: "/api/users" });
    expect(response.statusCode).toBe(200);
    const body = userListResponseSchema.parse(response.json());
    expect(body.rows.map((row) => [row.email, row.isAdmin])).toEqual([
      [ADMIN_EMAIL, true],
      [FRIEND, false],
    ]);

    const refused = await t.app.inject({
      method: "GET",
      url: "/api/users",
      headers: asUser(FRIEND),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "forbidden", details: { requires: "admin" } });
  });
});

describe("PATCH /api/users/:id", () => {
  it("merges permissions and sets the cap", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, FRIEND)!;
    const response = await t.app.inject({
      method: "PATCH",
      url: `/api/users/${String(friend.id)}`,
      payload: { permissions: { manage_forges: true }, storageCapBytes: 1024 },
    });
    expect(response.statusCode).toBe(200);
    const row = userRowSchema.parse(response.json());
    expect(row.permissions.manage_forges).toBe(true);
    expect(row.permissions.import).toBe(true);
    expect(row.storageCapBytes).toBe(1024);
    expect(row.capBytes).toBe(1024);

    // The change applies to the user's very next request.
    const me = meSchema.parse(
      (await t.app.inject({ method: "GET", url: "/api/me", headers: asUser(FRIEND) })).json(),
    );
    expect(me.permissions.manage_forges).toBe(true);
  });

  it("rejects unknown fields and unknown permission keys", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, FRIEND)!;
    for (const payload of [
      { isAdmin: true },
      { email: "x@example.com" },
      { permissions: { superuser: true } },
      { permissions: { git: "yes" } },
      { storageCapBytes: -1 },
    ]) {
      const response = await t.app.inject({
        method: "PATCH",
        url: `/api/users/${String(friend.id)}`,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(findUserByEmail(t.db, FRIEND)?.isAdmin).toBe(false);
  });

  it("leaves the admin row immutable", async () => {
    const t = await insecureApp();
    const admin = getAdminUser(t.db);
    const response = await t.app.inject({
      method: "PATCH",
      url: `/api/users/${String(admin.id)}`,
      payload: { permissions: { git: false } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "immutable" });
  });

  it("cannot be used by a user on themselves", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, FRIEND)!;
    const response = await t.app.inject({
      method: "PATCH",
      url: `/api/users/${String(friend.id)}`,
      headers: asUser(FRIEND),
      payload: { permissions: { manage_settings: true } },
    });
    expect(response.statusCode).toBe(403);
    expect(findUserByEmail(t.db, FRIEND)?.permissions.manage_settings).toBe(false);
  });
});

describe("POST /api/users/:id/adopt-repos and /revoke-git", () => {
  it("moves a user's repositories to the admin", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, FRIEND)!;
    const repoId = addRepo(t, "theirs", friend.id, 1);
    const response = await t.app.inject({
      method: "POST",
      url: `/api/users/${String(friend.id)}/adopt-repos`,
    });
    expect(adoptReposResponseSchema.parse(response.json())).toEqual({
      userId: friend.id,
      adopted: 1,
    });
    expect(t.db.get("SELECT owner_user_id FROM repos WHERE id = ?", repoId)).toEqual({
      owner_user_id: getAdminUser(t.db).id,
    });
  });

  it("deletes a user's git password", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, FRIEND)!;
    t.db.run(
      "UPDATE users SET git_username = 'abcdefghij', git_password_hash = 'scrypt$x' WHERE id = ?",
      friend.id,
    );
    const response = await t.app.inject({
      method: "POST",
      url: `/api/users/${String(friend.id)}/revoke-git`,
    });
    expect(response.statusCode).toBe(200);
    expect(userRowSchema.parse(response.json()).hasGitPassword).toBe(false);
    expect(
      (await t.app.inject({ method: "POST", url: "/api/users/9999/revoke-git" })).statusCode,
    ).toBe(404);
  });
});

describe("POST /api/users/refresh", () => {
  it("re-reads the policy, reconciles, and reports what changed", async () => {
    const clock = new FakeClock();
    const endpoint = new FakePolicyEndpoint([FRIEND]);
    temp = await createTempApp(secureEnv(), {
      cfAccessGetKey: keys.getKey,
      accessPolicyFetch: endpoint.fetch,
      now: clock.now,
    });
    const headers = { [CF_ACCESS_HEADER]: await keys.token(ADMIN_EMAIL) };

    const first = userRefreshResponseSchema.parse(
      (await temp.app.inject({ method: "POST", url: "/api/users/refresh", headers })).json(),
    );
    expect(first).toMatchObject({
      ok: true,
      error: null,
      changes: { created: 1, removed: 0, restored: 0 },
    });
    expect(first.policy.editUrl).toBe(
      `https://dash.cloudflare.com/${POLICY_ACCOUNT_ID}/one/access-controls/policies/${POLICY_ID}/edit`,
    );

    endpoint.fail(500);
    const failed = await temp.app.inject({ method: "POST", url: "/api/users/refresh", headers });
    const body = userRefreshResponseSchema.parse(failed.json());
    expect(body).toMatchObject({ ok: false, changes: { created: 0, removed: 0, restored: 0 } });
    expect(body.policy.stale).toBe(true);
    // No response anywhere carries the API token.
    expect(failed.body).not.toContain(POLICY_TOKEN);
    const me = await temp.app.inject({ method: "GET", url: "/api/me", headers });
    expect(me.body).not.toContain(POLICY_TOKEN);
  });
});
