import { PERMISSION_KEYS, type Permissions } from "@amber/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUserByEmail, getAdminUser, updateUser, type User } from "../src/domain/users.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  canView,
  enforceRouteAuthz,
  requireRepoEdit,
  requireRepoOwnerOrAdmin,
  requireRepoView,
  isAuthzRequirement,
  meetsRequirement,
  visibleRepoSqlFilter,
  type AuthzRequirement,
} from "../src/security/authz.ts";
import { asUser } from "./helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "./helpers.ts";

/**
 * The route table is the authorization contract. Every /api route declares
 * what it needs, one hook enforces it, and these tests read the LIVE table
 * that Fastify built (collected by an onRoute hook in buildApp), never a grep
 * of the source.
 */

const DEFAULT_USER = "friend@example.com";
const NOTHING_USER = "nobody@example.com";

/**
 * The expected requirement of every /api route. Changing one is a security
 * decision, so it has to be made here on purpose; a route that is added
 * without an entry fails the drift test below.
 */
const EXPECTED: Record<string, AuthzRequirement> = {
  "GET /api/forges": "user",
  "POST /api/forges": "manage_forges",
  "PATCH /api/forges/:id": "manage_forges",
  "DELETE /api/forges/:id": "manage_forges",
  "GET /api/accounts": "user",
  "GET /api/accounts/:id": "user",
  "POST /api/accounts": "import_private",
  "PATCH /api/accounts/:id": "import_private",
  "POST /api/accounts/:id/default": "import_private",
  "DELETE /api/accounts/:id": "user",
  "GET /api/repos": "user",
  "POST /api/repos/bulk": "user",
  "GET /api/repos/:id": "user",
  "PATCH /api/repos/:id": "user",
  "DELETE /api/repos/:id": "user",
  "POST /api/repos/:id/sync": "user",
  "GET /api/repos/:id/runs": "user",
  "POST /api/import/preview": "import",
  "POST /api/import": "import",
  "GET /api/settings/:scopeType": "user",
  "GET /api/settings/:scopeType/:scopeId": "user",
  "PUT /api/settings/global": "manage_settings",
  "PUT /api/settings/forge/:scopeId": "manage_forges",
  "PUT /api/settings/:scopeType": "user",
  "PUT /api/settings/:scopeType/:scopeId": "user",
  "GET /api/repos/:id/effective-settings": "user",
  "GET /api/account-syncs": "user",
  "POST /api/account-syncs": "import",
  "PATCH /api/account-syncs/:id": "user",
  "DELETE /api/account-syncs/:id": "user",
  "POST /api/account-syncs/:id/run": "user",
  "GET /api/git-remote": "admin",
  "PATCH /api/git-remote": "admin",
  "POST /api/git-remote/enable": "admin",
  "POST /api/git-remote/rotate": "admin",
  "POST /api/git-remote/disable": "admin",
  "GET /api/repos/:id/export/:artifact": "export",
  "GET /api/repos/:id/tree": "export",
  "GET /api/repos/:id/blob": "export",
  "GET /api/repos/:id/browse/refs": "browse",
  "GET /api/repos/:id/browse/resolve": "browse",
  "GET /api/repos/:id/browse/contents": "browse",
  "GET /api/repos/:id/browse/raw": "browse",
  "GET /api/repos/:id/browse/commits": "browse",
  "GET /api/repos/:id/browse/commit": "browse",
  "GET /api/status": "user",
  "GET /api/push": "user",
  "POST /api/push/subscriptions": "user",
  "POST /api/push/unsubscribe": "user",
  "POST /api/push/test": "user",
  "GET /api/events": "user",
  "GET /api/me": "user",
  "GET /api/users": "admin",
  "POST /api/users/refresh": "admin",
  "PATCH /api/users/:id": "admin",
  "POST /api/users/:id/adopt-repos": "admin",
  "POST /api/users/:id/revoke-git": "admin",
};

let temp: TempApp;

function noPermissions(): Permissions {
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false])) as Permissions;
}

beforeEach(async () => {
  temp = await createTempApp({ INSECURE_USER_EMAILS: `${DEFAULT_USER}, ${NOTHING_USER}` });
  const nothing = findUserByEmail(temp.db, NOTHING_USER);
  if (nothing === undefined) {
    throw new Error("the stand-in list did not create its users");
  }
  updateUser(temp.db, nothing.id, { permissions: noPermissions() });
});

afterEach(async () => {
  await temp.close();
});

function apiRoutes() {
  return temp.app.amber.routes.filter((route) => route.url.startsWith("/api"));
}

/** Concrete stand-ins for path parameters; the hook runs before the handler. */
function concrete(url: string): string {
  return url.replace(/:artifact/g, "source.zip").replace(/:[A-Za-z]+/g, "1");
}

describe("the live route table", () => {
  it("has a valid authz declaration on every /api route", () => {
    const routes = apiRoutes();
    // A floor, so a collector that silently stopped seeing routes cannot pass.
    expect(routes.length).toBeGreaterThan(60);
    for (const route of routes) {
      expect(isAuthzRequirement(route.authz), `${route.method} ${route.url}`).toBe(true);
    }
  });

  it("matches the pinned requirement table exactly", () => {
    const live: Record<string, AuthzRequirement | undefined> = {};
    for (const route of apiRoutes()) {
      if (route.method === "HEAD") {
        continue;
      }
      live[`${route.method} ${route.url}`] = route.authz;
    }
    expect(live).toEqual(EXPECTED);
  });

  it("gives every automatic HEAD route its GET's requirement", () => {
    const routes = apiRoutes();
    for (const head of routes.filter((route) => route.method === "HEAD")) {
      const get = routes.find((route) => route.method === "GET" && route.url === head.url);
      expect(get?.authz, head.url).toBe(head.authz);
    }
  });

  it("refuses to register an /api route that declares nothing, or nonsense", () => {
    expect(() => temp.app.get("/api/undeclared", () => ({ ok: true }))).toThrow(/config\.authz/);
    expect(() =>
      temp.app.get(
        "/api/misdeclared",
        { config: { authz: "everyone" as unknown as AuthzRequirement } },
        () => ({ ok: true }),
      ),
    ).toThrow(/config\.authz/);
    // Outside /api the declaration is not required.
    expect(() => temp.app.get("/elsewhere", () => ({ ok: true }))).not.toThrow();
  });
});

describe("coarse enforcement, route by route", () => {
  const identities: { name: string; headers: Record<string, string>; user: () => User }[] = [
    { name: "admin", headers: {}, user: () => getAdminUser(temp.db) },
    {
      name: "default user",
      headers: asUser(DEFAULT_USER),
      user: () => findUserByEmail(temp.db, DEFAULT_USER)!,
    },
    {
      name: "user with nothing",
      headers: asUser(NOTHING_USER),
      user: () => findUserByEmail(temp.db, NOTHING_USER)!,
    },
  ];

  it("lets exactly the identities that meet each requirement through", async () => {
    let denied = 0;
    let allowed = 0;
    for (const route of apiRoutes()) {
      if (route.method === "HEAD") {
        continue;
      }
      const requirement = route.authz as AuthzRequirement;
      for (const identity of identities) {
        const user = identity.user();
        const shouldPass = meetsRequirement(user, requirement);
        // The event stream never ends, so only its refusals can be injected.
        if (route.url === "/api/events" && shouldPass) {
          continue;
        }
        const response = await temp.app.inject({
          method: route.method as "GET",
          url: concrete(route.url),
          headers: identity.headers,
          ...(route.method === "GET" ? {} : { payload: {} }),
        });
        const label = `${identity.name}: ${route.method} ${route.url}`;
        const body = response.headers["content-type"]?.includes("json")
          ? response.json<{ error?: string; details?: Record<string, unknown> }>()
          : {};
        const refusedByHook =
          response.statusCode === 403 &&
          body.error === "forbidden" &&
          (body.details?.["permission"] === requirement || body.details?.["requires"] === "admin");
        if (shouldPass) {
          allowed += 1;
          expect(refusedByHook, label).toBe(false);
        } else {
          denied += 1;
          expect(response.statusCode, label).toBe(403);
          expect(body.error, label).toBe("forbidden");
          expect(
            requirement === "admin" ? body.details?.["requires"] : body.details?.["permission"],
            label,
          ).toBe(requirement === "admin" ? "admin" : requirement);
        }
      }
    }
    // Both branches really ran.
    expect(denied).toBeGreaterThan(30);
    expect(allowed).toBeGreaterThan(60);
  });

  it("answers an unknown /api path with the pinned 404, not a 403, for anyone accepted", async () => {
    for (const identity of identities) {
      const response = await temp.app.inject({
        method: "GET",
        url: "/api/does-not-exist",
        headers: identity.headers,
      });
      expect(response.statusCode, identity.name).toBe(404);
      expect(response.json(), identity.name).toMatchObject({ error: "not_found" });
    }
  });

  it("enforces an /api route registered outside the api plugin, too", async () => {
    temp.app.get("/api/t/admin-only", { config: { authz: "admin" } }, () => ({ ok: true }));
    temp.app.get("/api/t/forges-only", { config: { authz: "manage_forges" } }, () => ({
      ok: true,
    }));
    const asFriend = asUser(DEFAULT_USER);
    expect(
      (await temp.app.inject({ method: "GET", url: "/api/t/admin-only", headers: asFriend }))
        .statusCode,
    ).toBe(403);
    expect(
      (await temp.app.inject({ method: "GET", url: "/api/t/forges-only", headers: asFriend }))
        .statusCode,
    ).toBe(403);
    expect((await temp.app.inject({ method: "GET", url: "/api/t/admin-only" })).statusCode).toBe(
      200,
    );
  });

  it("refuses at request time a route that somehow has no declaration", async () => {
    const bare = Fastify({ loggerInstance: createConsoleLogger("silent") });
    bare.addHook("onRequest", async (request) => {
      request.user = getAdminUser(temp.db);
    });
    bare.addHook("onRequest", enforceRouteAuthz);
    bare.get("/x", () => ({ ok: true }));
    const response = await bare.inject({ method: "GET", url: "/x" });
    expect(response.statusCode).toBe(403);
    await bare.close();
  });
});

describe("requirements that depend on the request", () => {
  it("guards global and forge settings writes even through the generic routes", async () => {
    const forgeId = seedForge(temp.db);
    const asFriend = asUser(DEFAULT_USER);
    for (const url of [
      "/api/settings/global",
      "/api/settings/%67lobal",
      "/api/settings/global/1",
      `/api/settings/forge/${String(forgeId)}`,
      "/api/settings/forge",
    ]) {
      const response = await temp.app.inject({
        method: "PUT",
        url,
        headers: asFriend,
        payload: { paranoid: true },
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json<{ error: string }>().error, url).toBe("forbidden");
    }
    // The admin goes through, and the domain answers as before.
    const admin = await temp.app.inject({
      method: "PUT",
      url: "/api/settings/global",
      payload: { paranoid: true },
    });
    expect(admin.statusCode).toBe(200);
  });

  it("keeps trending syncs, which are instance-level, to manage_settings", async () => {
    const forgeId = seedForge(temp.db);
    const asFriend = asUser(DEFAULT_USER);
    const create = await temp.app.inject({
      method: "POST",
      url: "/api/account-syncs",
      headers: asFriend,
      payload: { source: "trending", forgeId },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ details: { permission: "manage_settings" } });

    const made = await temp.app.inject({
      method: "POST",
      url: "/api/account-syncs",
      payload: { source: "trending", forgeId, enabled: false },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ id: number }>().id;

    for (const [method, url, payload] of [
      ["PATCH", `/api/account-syncs/${String(id)}`, { topN: 5 }],
      ["POST", `/api/account-syncs/${String(id)}/run`, undefined],
      ["DELETE", `/api/account-syncs/${String(id)}`, undefined],
    ] as const) {
      const response = await temp.app.inject({
        method,
        url,
        headers: asFriend,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    const patched = await temp.app.inject({
      method: "PATCH",
      url: `/api/account-syncs/${String(id)}`,
      payload: { topN: 5 },
    });
    expect(patched.statusCode).toBe(200);
  });
});

describe("object-level helpers", () => {
  const base: User = {
    id: 10,
    email: "u@example.com",
    isAdmin: false,
    permissions: {
      ...noPermissions(),
    },
    storageCapBytes: null,
    gitUsername: null,
    hasGitPassword: false,
    gitRotatedAt: null,
    removedAt: null,
    lastSeenAt: null,
    capNotifiedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const withPerms = (perms: Partial<Permissions>): User => ({
    ...base,
    permissions: { ...base.permissions, ...perms },
  });

  it("canView follows the visibility rule exactly", () => {
    const mine = { ownerUserId: 10, isPrivate: true };
    const othersPublic = { ownerUserId: 11, isPrivate: false };
    const othersPrivate = { ownerUserId: 11, isPrivate: true };
    const ownerless = { ownerUserId: null, isPrivate: true };

    expect(canView(base, mine)).toBe(true);
    expect(canView(base, othersPublic)).toBe(false);
    expect(canView(base, othersPrivate)).toBe(false);
    expect(canView(withPerms({ view_others_public: true }), othersPublic)).toBe(true);
    expect(canView(withPerms({ view_others_public: true }), othersPrivate)).toBe(false);
    expect(canView(withPerms({ view_others_private: true }), othersPrivate)).toBe(true);
    expect(canView(withPerms({ view_others_private: true }), othersPublic)).toBe(false);
    expect(canView(base, ownerless)).toBe(false);
    expect(canView({ ...base, isAdmin: true }, othersPrivate)).toBe(true);
    expect(canView({ ...base, removedAt: 1 }, mine)).toBe(false);
  });

  it("visibleRepoSqlFilter agrees with canView row for row", () => {
    const db = temp.db;
    const forgeId = seedForge(db);
    const admin = getAdminUser(db);
    const friend = findUserByEmail(db, DEFAULT_USER)!;
    const rows: { owner: number; isPrivate: number }[] = [
      { owner: admin.id, isPrivate: 1 },
      { owner: admin.id, isPrivate: 0 },
      { owner: friend.id, isPrivate: 1 },
      { owner: friend.id, isPrivate: 0 },
    ];
    rows.forEach((row, index) => {
      db.run(
        `INSERT INTO repos (forge_id, path, display_name, slug, short_id, owner_user_id, is_private,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        forgeId,
        `o/r${String(index)}`,
        `r${String(index)}`,
        `o-r${String(index)}-aaaaaaa${String(index)}`,
        `aaaaaaa${String(index)}`,
        row.owner,
        row.isPrivate,
      );
    });

    const users: User[] = [
      admin,
      friend,
      { ...friend, permissions: { ...friend.permissions, view_others_public: false } },
      { ...friend, permissions: { ...friend.permissions, view_others_private: true } },
      { ...friend, removedAt: 5 },
    ];
    for (const user of users) {
      const filter = visibleRepoSqlFilter(user, "r");
      const visible = db
        .all<{ id: number }>(
          `SELECT r.id FROM repos r WHERE ${filter.sql} ORDER BY r.id`,
          ...filter.params,
        )
        .map((row) => row.id);
      const expected = db
        .all<{ id: number; owner_user_id: number; is_private: number }>(
          "SELECT id, owner_user_id, is_private FROM repos ORDER BY id",
        )
        .filter((row) =>
          canView(user, { ownerUserId: row.owner_user_id, isPrivate: row.is_private === 1 }),
        )
        .map((row) => row.id);
      expect(visible).toEqual(expected);
    }
    expect(() => visibleRepoSqlFilter(admin, "repos; DROP TABLE repos")).toThrow(/unsafe/);
  });

  it("requireRepoView, requireRepoEdit and requireRepoOwnerOrAdmin answer 404, 403 or the repo", async () => {
    const db = temp.db;
    const forgeId = seedForge(db);
    const admin = getAdminUser(db);
    const friend = findUserByEmail(db, DEFAULT_USER)!;
    const insertRepo = (name: string, owner: number, isPrivate: number): number =>
      db.run(
        `INSERT INTO repos (forge_id, path, display_name, slug, short_id, owner_user_id, is_private,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        forgeId,
        `o/${name}`,
        name,
        `o-${name}-${name.padEnd(8, "z")}`,
        name.padEnd(8, "z"),
        owner,
        isPrivate,
      ).lastInsertRowid;
    const adminPrivate = insertRepo("ap", admin.id, 1);
    const adminPublic = insertRepo("apub", admin.id, 0);
    const friendOwn = insertRepo("fo", friend.id, 1);

    const app = temp.app;
    app.get("/api/t/view/:id", { config: { authz: "user" } }, (request) =>
      requireRepoView(request, Number((request.params as { id: string }).id)),
    );
    app.get("/api/t/edit/:id", { config: { authz: "user" } }, (request) =>
      requireRepoEdit(request, Number((request.params as { id: string }).id)),
    );
    app.get("/api/t/own/:id", { config: { authz: "user" } }, (request) =>
      requireRepoOwnerOrAdmin(request, Number((request.params as { id: string }).id)),
    );
    const status = async (kind: string, id: number, headers: Record<string, string> = {}) =>
      (await app.inject({ method: "GET", url: `/api/t/${kind}/${String(id)}`, headers }))
        .statusCode;
    const asFriend = asUser(DEFAULT_USER);

    // The friend (defaults: view_others_public, no modify_others).
    expect(await status("view", adminPrivate, asFriend)).toBe(404);
    expect(await status("view", 9999, asFriend)).toBe(404);
    expect(await status("view", adminPublic, asFriend)).toBe(200);
    expect(await status("edit", adminPublic, asFriend)).toBe(403);
    expect(await status("own", adminPublic, asFriend)).toBe(403);
    expect(await status("edit", adminPrivate, asFriend)).toBe(404);
    expect(await status("view", friendOwn, asFriend)).toBe(200);
    expect(await status("edit", friendOwn, asFriend)).toBe(200);
    expect(await status("own", friendOwn, asFriend)).toBe(200);

    updateUser(db, friend.id, { permissions: { modify_others: true } });
    expect(await status("edit", adminPublic, asFriend)).toBe(200);
    // modify_others never covers what decides the owner's token.
    expect(await status("own", adminPublic, asFriend)).toBe(403);

    // The admin sees and owns-or-admins everything.
    for (const id of [adminPrivate, adminPublic, friendOwn]) {
      expect(await status("own", id)).toBe(200);
    }
  });
});
