import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/domain/accounts.ts";
import { createRepo } from "../../src/domain/repos.ts";
import type { User } from "../../src/domain/users.ts";
import { CF_ACCESS_HEADER } from "../../src/security/cfAccess.ts";
import {
  asUser,
  createAccessKeys,
  FakePolicyEndpoint,
  secureEnv,
} from "../helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "../helpers.ts";
import { adminOf, makeUser } from "../helpers/users.ts";

/**
 * Object-level access to repositories, driven through the real routes with
 * one identity per row of the permission matrix. The rule under test
 * (docs/ARCHITECTURE.md "Multi-user access control"): a repo the caller
 * cannot view answers EXACTLY like one that does not exist; owners may do
 * everything; modify_others may change state, force_anonymous and clear an
 * override on repos it can see, but never the path or a new override.
 */

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const NOTHING = "nothing@example.com";
const PRIV = "viewpriv@example.com";
const MOD = "modify@example.com";
const GONE = "removed@example.com";

type Who = "admin" | "alice" | "bob" | "nothing" | "priv" | "mod" | "removed";
const WHO: readonly Who[] = ["admin", "alice", "bob", "nothing", "priv", "mod", "removed"];

let temp: TempApp;
let users: Record<Exclude<Who, "admin">, User>;
let admin: User;
let forgeId: number;
let alicePrivate: number;
let alicePublic: number;
let adminPrivate: number;

const NONEXISTENT = 987_654;

function headersFor(who: Who): Record<string, string> {
  const email = {
    admin: null,
    alice: ALICE,
    bob: BOB,
    nothing: NOTHING,
    priv: PRIV,
    mod: MOD,
    removed: GONE,
  }[who];
  return email === null ? {} : asUser(email);
}

async function call(
  who: Who,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return temp.app.inject({
    method,
    url,
    headers: headersFor(who),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function repo(owner: User, path: string, isPrivate: boolean): number {
  const id = createRepo(temp.db, { forgeId, path, ownerUserId: owner.id }).id;
  temp.db.run("UPDATE repos SET is_private = ? WHERE id = ?", isPrivate ? 1 : 0, id);
  return id;
}

beforeEach(async () => {
  temp = await createTempApp({
    INSECURE_USER_EMAILS: [ALICE, BOB, NOTHING, PRIV, MOD, GONE].join(","),
  });
  const db = temp.db;
  admin = adminOf(db);
  users = {
    alice: makeUser(db, ALICE),
    bob: makeUser(db, BOB),
    nothing: makeUser(db, NOTHING, {}, { nothing: true }),
    priv: makeUser(db, PRIV, { view_others_private: true }),
    mod: makeUser(db, MOD, { modify_others: true }),
    removed: makeUser(db, GONE, { view_others_private: true }, { removed: true }),
  };
  forgeId = seedForge(db);
  alicePrivate = repo(users.alice, "alice/private", true);
  alicePublic = repo(users.alice, "alice/public", false);
  adminPrivate = repo(admin, "admin/private", true);
});

afterEach(async () => {
  await temp.close();
});

/** Who can see which repo, straight from the visibility rule. */
function expectedVisible(who: Who): number[] {
  switch (who) {
    case "admin":
    case "priv":
      return [alicePrivate, alicePublic, adminPrivate];
    case "alice":
      return [alicePrivate, alicePublic];
    case "bob":
    case "mod":
      return [alicePublic];
    case "nothing":
    case "removed":
      return [];
  }
}

/** A not-found body with the id taken out, so two ids can be compared. */
function normalized(body: string, id: number): string {
  return body.split(String(id)).join("<id>");
}

describe("listing and reading", () => {
  it.each(WHO)("lists exactly what %s can view, with a total that matches", async (who) => {
    const response = await call(who, "GET", "/api/repos?perPage=200&sort=created_at&dir=asc");
    if (who === "removed") {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "not_a_user" });
      return;
    }
    expect(response.statusCode).toBe(200);
    const page = response.json<{ rows: { id: number; mine: boolean }[]; total: number }>();
    expect(page.rows.map((row) => row.id).sort()).toEqual(expectedVisible(who).sort());
    expect(page.total).toBe(expectedVisible(who).length);
  });

  it("totals count only viewable repos even when the page is smaller", async () => {
    for (let index = 0; index < 5; index += 1) {
      repo(admin, `admin/extra-${String(index)}`, true);
    }
    const response = await call("bob", "GET", "/api/repos?perPage=1");
    expect(response.json<{ total: number }>().total).toBe(1);
  });

  it.each(WHO.filter((who) => who !== "removed"))(
    "answers %s's reads of each repo with the repo or the not-found of a missing id",
    async (who) => {
      const missing = await call(who, "GET", `/api/repos/${String(NONEXISTENT)}`);
      expect(missing.statusCode).toBe(404);
      for (const id of [alicePrivate, alicePublic, adminPrivate]) {
        const response = await call(who, "GET", `/api/repos/${String(id)}`);
        if (expectedVisible(who).includes(id)) {
          expect(response.statusCode).toBe(200);
        } else {
          expect(response.statusCode).toBe(404);
          expect(normalized(response.body, id)).toBe(normalized(missing.body, NONEXISTENT));
        }
      }
    },
  );

  it("marks mine for the caller and names the owner to the admin only", async () => {
    const asAlice = await call("alice", "GET", `/api/repos/${String(alicePrivate)}`);
    expect(asAlice.json()).toMatchObject({ mine: true, isPrivate: true });
    expect(asAlice.json()).not.toHaveProperty("owner");

    const asBob = await call("bob", "GET", `/api/repos/${String(alicePublic)}`);
    expect(asBob.json()).toMatchObject({ mine: false, isPrivate: false });
    expect(asBob.json()).not.toHaveProperty("owner");

    const asAdmin = await call("admin", "GET", `/api/repos/${String(alicePrivate)}`);
    expect(asAdmin.json()).toMatchObject({
      mine: false,
      owner: { id: users.alice.id, email: ALICE, removed: false },
    });
  });

  it("filters mine for everyone, and refuses owner filters to anyone but the admin", async () => {
    const mine = await call("alice", "GET", "/api/repos?mine=true");
    expect(mine.json<{ total: number }>().total).toBe(2);
    const bobsMine = await call("bob", "GET", "/api/repos?mine=true");
    expect(bobsMine.json<{ total: number }>().total).toBe(0);

    for (const query of [`ownerId=${String(users.alice.id)}`, "ownerRemoved=true"]) {
      const refused = await call("bob", "GET", `/api/repos?${query}`);
      expect(refused.statusCode, query).toBe(403);
    }
    const byOwner = await call("admin", "GET", `/api/repos?ownerId=${String(users.alice.id)}`);
    expect(byOwner.json<{ total: number }>().total).toBe(2);
  });

  it("lists a removed owner's repos under the admin's ownerRemoved filter", async () => {
    const orphan = repo(users.removed, "gone/one", false);
    const response = await call("admin", "GET", "/api/repos?ownerRemoved=true");
    const page = response.json<{ rows: { id: number; owner: { removed: boolean } }[] }>();
    expect(page.rows.map((row) => row.id)).toEqual([orphan]);
    expect(page.rows[0]?.owner.removed).toBe(true);
  });

  it("keeps the Removed page to view_removed, and to viewable repos within it", async () => {
    temp.db.run("UPDATE repos SET gone_at = 1 WHERE id IN (?, ?)", alicePublic, adminPrivate);
    const refused = await call("bob", "GET", "/api/repos?gone=true");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ details: { permission: "view_removed" } });

    makeUser(temp.db, BOB, { view_removed: true });
    const allowed = await call("bob", "GET", "/api/repos?gone=true");
    expect(allowed.json<{ rows: { id: number }[] }>().rows.map((row) => row.id)).toEqual([
      alicePublic,
    ]);
  });

  it("nulls forkParentRepoId when the caller cannot view the parent", async () => {
    temp.db.run(
      "UPDATE repos SET fork_parent = 'admin/private', fork_known = 1 WHERE id = ?",
      alicePublic,
    );
    const asAdmin = await call("admin", "GET", `/api/repos/${String(alicePublic)}`);
    expect(asAdmin.json()).toMatchObject({ forkParentRepoId: adminPrivate });
    const asBob = await call("bob", "GET", `/api/repos/${String(alicePublic)}`);
    expect(asBob.json()).toMatchObject({ forkParentRepoId: null });
    const listed = await call("bob", "GET", "/api/repos");
    expect(listed.json<{ rows: { forkParentRepoId: unknown }[] }>().rows[0]).toMatchObject({
      forkParentRepoId: null,
    });
  });
});

describe("an invisible repo is indistinguishable from a missing one", () => {
  /** A concrete request for every repo-scoped route in the LIVE route table. */
  function repoScopedRoutes(): { method: string; url: string }[] {
    return temp.app.amber.routes
      .filter(
        (route) =>
          route.method !== "HEAD" &&
          (route.url.startsWith("/api/repos/:id") ||
            route.url === "/api/settings/:scopeType/:scopeId"),
      )
      .map((route) => ({ method: route.method, url: route.url }));
  }

  function concrete(url: string, id: number): string {
    return url
      .replace(":scopeType", "repo")
      .replace(":scopeId", String(id))
      .replace(":id", String(id))
      .replace(":artifact", "source.zip");
  }

  it("has repo-scoped routes to check", () => {
    // A guard against the filter above silently matching nothing.
    expect(repoScopedRoutes().length).toBeGreaterThanOrEqual(15);
  });

  it.each(["bob", "nothing", "mod"] as const)(
    "gives %s the same status and body for an invisible id and a nonexistent one",
    async (who) => {
      let notFound = 0;
      const others: string[] = [];
      for (const route of repoScopedRoutes()) {
        const method = route.method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        const payload = method === "GET" || method === "DELETE" ? undefined : {};
        const invisible = await call(who, method, concrete(route.url, adminPrivate), payload);
        const missing = await call(who, method, concrete(route.url, NONEXISTENT), payload);
        const label = `${who} ${method} ${route.url}`;
        expect(invisible.statusCode, label).toBe(missing.statusCode);
        expect(normalized(invisible.body, adminPrivate), label).toBe(
          normalized(missing.body, NONEXISTENT),
        );
        if (missing.statusCode === 404) {
          notFound += 1;
        } else {
          others.push(`${label} -> ${String(missing.statusCode)}`);
        }
      }
      // Most routes must actually reach the object check (a 400 on both ids
      // proves nothing), or this test would pass vacuously.
      expect(notFound, others.join("\n")).toBeGreaterThanOrEqual(who === "nothing" ? 6 : 10);
      // Nothing about the invisible repo changed along the way.
      const after = await call("admin", "GET", `/api/repos/${String(adminPrivate)}`);
      expect(after.statusCode).toBe(200);
    },
  );
});

describe("changing a repo", () => {
  type Expect = number;
  /**
   * Status per identity for one edit of ALICE'S PUBLIC repo (visible to every
   * identity with view_others_public) and of her PRIVATE one (visible to the
   * owner, the admin and priv only). 404 = cannot view; 403 = can view, may
   * not change.
   */
  const STATE_EDIT: Record<Exclude<Who, "removed">, [Expect, Expect]> = {
    admin: [200, 200],
    alice: [200, 200],
    bob: [403, 404],
    nothing: [404, 404],
    priv: [403, 403],
    mod: [200, 404],
  };

  it.each(Object.entries(STATE_EDIT))(
    "pause and force_anonymous: %s gets public %j / private",
    async (who, [publicStatus, privateStatus]) => {
      const caller = who as Exclude<Who, "removed">;
      for (const [id, expected] of [
        [alicePublic, publicStatus],
        [alicePrivate, privateStatus],
      ] as const) {
        const pause = await call(caller, "PATCH", `/api/repos/${String(id)}`, { state: "paused" });
        expect(pause.statusCode, `${caller} pause ${String(id)}`).toBe(expected);
        const anon = await call(caller, "PATCH", `/api/repos/${String(id)}`, {
          forceAnonymous: true,
        });
        expect(anon.statusCode, `${caller} anon ${String(id)}`).toBe(expected);
        const sync = await call(caller, "POST", `/api/repos/${String(id)}/sync`);
        expect(sync.statusCode, `${caller} sync ${String(id)}`).toBe(expected);
      }
    },
  );

  it("lets only the owner and the admin turn force_anonymous OFF", async () => {
    temp.db.run("UPDATE repos SET force_anonymous = 1 WHERE id = ?", alicePublic);
    // Off would let the repo resolve the owner's own default account, like an
    // override: modify_others may not decide that.
    const asMod = await call("mod", "PATCH", `/api/repos/${String(alicePublic)}`, {
      forceAnonymous: false,
    });
    expect(asMod.statusCode).toBe(403);
    expect(asMod.json()).toMatchObject({ details: { requires: "owner" } });
    expect(temp.db.get("SELECT force_anonymous AS f FROM repos WHERE id = ?", alicePublic)).toEqual(
      { f: 1 },
    );
    for (const who of ["alice", "admin"] as const) {
      temp.db.run("UPDATE repos SET force_anonymous = 1 WHERE id = ?", alicePublic);
      const off = await call(who, "PATCH", `/api/repos/${String(alicePublic)}`, {
        forceAnonymous: false,
      });
      expect(off.statusCode, who).toBe(200);
      expect(off.json()).toMatchObject({ forceAnonymous: false });
    }
  });

  it("lets only the owner and the admin change the path, which resets visibility", async () => {
    temp.db.run("UPDATE repos SET visibility_checked_at = 5 WHERE id = ?", alicePublic);
    const asMod = await call("mod", "PATCH", `/api/repos/${String(alicePublic)}`, {
      path: "alice/renamed",
    });
    expect(asMod.statusCode).toBe(403);
    expect(asMod.json()).toMatchObject({ details: { requires: "owner" } });

    const asOwner = await call("alice", "PATCH", `/api/repos/${String(alicePublic)}`, {
      path: "alice/renamed",
    });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json()).toMatchObject({ path: "alice/renamed", isPrivate: true });
    expect(
      temp.db.get("SELECT visibility_checked_at AS at FROM repos WHERE id = ?", alicePublic),
    ).toEqual({ at: null });

    // Now private, so the public-only viewer lost it: a 404, not a 403.
    const asModAgain = await call("mod", "PATCH", `/api/repos/${String(alicePublic)}`, {
      state: "paused",
    });
    expect(asModAgain.statusCode).toBe(404);
  });

  it("does not name an invisible repo when a rename clashes with it", async () => {
    const clash = await call("alice", "PATCH", `/api/repos/${String(alicePublic)}`, {
      path: "admin/private",
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.body).not.toContain("admin/private");

    const visibleClash = await call("admin", "PATCH", `/api/repos/${String(alicePublic)}`, {
      path: "admin/private",
    });
    expect(visibleClash.statusCode).toBe(409);
    expect(visibleClash.body).toContain("already backed up");
  });

  it("only lets an override name an account the repo's OWNER owns", async () => {
    makeUser(temp.db, ALICE, { import_private: true });
    makeUser(temp.db, BOB, { import_private: true });
    const alicesAccount = createAccount(
      temp.db,
      temp.config.secretKey,
      { forgeId, username: "alice-bot", secret: "a-secret", isDefault: true },
      users.alice.id,
    );
    const bobsAccount = createAccount(
      temp.db,
      temp.config.secretKey,
      { forgeId, username: "bob-bot", secret: "b-secret", isDefault: true },
      users.bob.id,
    );
    const adminsAccount = createAccount(
      temp.db,
      temp.config.secretKey,
      { forgeId, username: "admin-bot", secret: "c-secret", isDefault: true },
      admin.id,
    );
    const bobsRepo = repo(users.bob, "bob/repo", false);

    // Bob may not point his repo at Alice's token: it reads as no such account.
    const steal = await call("bob", "PATCH", `/api/repos/${String(bobsRepo)}`, {
      accountOverrideId: alicesAccount.id,
    });
    const nothing = await call("bob", "PATCH", `/api/repos/${String(bobsRepo)}`, {
      accountOverrideId: NONEXISTENT,
    });
    expect(steal.statusCode).toBe(404);
    expect(normalized(steal.body, alicesAccount.id)).toBe(normalized(nothing.body, NONEXISTENT));

    // Not even the admin can hand Alice's repo the admin's (or Bob's) token.
    for (const accountId of [adminsAccount.id, bobsAccount.id]) {
      const response = await call("admin", "PATCH", `/api/repos/${String(alicePublic)}`, {
        accountOverrideId: accountId,
      });
      expect(response.statusCode).toBe(404);
    }

    // modify_others can see the repo but may not set an override at all...
    const asMod = await call("mod", "PATCH", `/api/repos/${String(alicePublic)}`, {
      accountOverrideId: alicesAccount.id,
    });
    expect(asMod.statusCode).toBe(403);

    // ...the owner can, with her own account...
    const asOwner = await call("alice", "PATCH", `/api/repos/${String(alicePublic)}`, {
      accountOverrideId: alicesAccount.id,
    });
    expect(asOwner.json()).toMatchObject({ accountOverrideId: alicesAccount.id });

    // ...and clearing it is the owner's or the admin's call too: it falls back
    // to the owner's default account, which can be wider than the pinned one.
    const clearedByMod = await call("mod", "PATCH", `/api/repos/${String(alicePublic)}`, {
      accountOverrideId: null,
    });
    expect(clearedByMod.statusCode).toBe(403);
    expect(clearedByMod.json()).toMatchObject({ details: { requires: "owner" } });
    expect(
      temp.db.get("SELECT account_override_id AS a FROM repos WHERE id = ?", alicePublic),
    ).toEqual({ a: alicesAccount.id });
    for (const who of ["alice", "admin"] as const) {
      temp.db.run(
        "UPDATE repos SET account_override_id = ? WHERE id = ?",
        alicesAccount.id,
        alicePublic,
      );
      const cleared = await call(who, "PATCH", `/api/repos/${String(alicePublic)}`, {
        accountOverrideId: null,
      });
      expect(cleared.statusCode, who).toBe(200);
      expect(cleared.json()).toMatchObject({ accountOverrideId: null });
    }
  });

  const DELETE_STATUS: Record<Exclude<Who, "removed">, [Expect, Expect]> = {
    admin: [204, 204],
    alice: [204, 204],
    bob: [403, 404],
    nothing: [404, 404],
    priv: [403, 403],
    mod: [204, 404],
  };

  it.each(Object.entries(DELETE_STATUS))(
    "delete: %s gets public %j / private",
    async (who, [publicStatus, privateStatus]) => {
      const caller = who as Exclude<Who, "removed">;
      const pub = await call(caller, "DELETE", `/api/repos/${String(alicePublic)}`);
      expect(pub.statusCode).toBe(publicStatus);
      const priv = await call(caller, "DELETE", `/api/repos/${String(alicePrivate)}`);
      expect(priv.statusCode).toBe(privateStatus);
      const left = temp.db.all<{ id: number }>(
        "SELECT id FROM repos WHERE id IN (?, ?)",
        alicePublic,
        alicePrivate,
      );
      expect(left.length).toBe((publicStatus === 204 ? 0 : 1) + (privateStatus === 204 ? 0 : 1));
    },
  );

  it("refuses a removed user everything, even with permissions on their row", async () => {
    for (const [method, url] of [
      ["GET", `/api/repos/${String(alicePublic)}`],
      ["PATCH", `/api/repos/${String(alicePublic)}`],
      ["DELETE", `/api/repos/${String(alicePublic)}`],
      ["POST", `/api/repos/${String(alicePublic)}/sync`],
      ["GET", "/api/status"],
    ] as const) {
      const response = await call("removed", method, url, method === "PATCH" ? {} : undefined);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: "not_a_user" });
    }
  });

  it("reads run history for anyone who can view the repo, and nobody else", async () => {
    expect((await call("bob", "GET", `/api/repos/${String(alicePublic)}/runs`)).statusCode).toBe(
      200,
    );
    expect((await call("bob", "GET", `/api/repos/${String(alicePrivate)}/runs`)).statusCode).toBe(
      404,
    );
  });
});

describe("bulk actions", () => {
  it("applies the single-repo rules per repo and reports refusals without leaking", async () => {
    const bobsRepo = repo(users.bob, "bob/own", true);
    const response = await call("bob", "POST", "/api/repos/bulk", {
      ids: [bobsRepo, alicePublic, alicePrivate, NONEXISTENT],
      action: "pause",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requested: 4,
      affected: 1,
      ids: [bobsRepo],
      // Invisible and nonexistent read the same.
      missing: [alicePrivate, NONEXISTENT],
      refused: [{ id: alicePublic, error: "forbidden" }],
    });
    const states = temp.db.all<{ id: number; state: string }>(
      "SELECT id, state FROM repos ORDER BY id",
    );
    expect(states.filter((row) => row.state === "paused").map((row) => row.id)).toEqual([bobsRepo]);
  });

  it("lets modify_others act on what it can view, and deletes only that", async () => {
    const response = await call("mod", "POST", "/api/repos/bulk", {
      ids: [alicePublic, alicePrivate, adminPrivate],
      action: "delete",
    });
    expect(response.json()).toMatchObject({
      affected: 1,
      ids: [alicePublic],
      missing: [alicePrivate, adminPrivate],
    });
    expect(temp.db.all("SELECT id FROM repos ORDER BY id")).toEqual([
      { id: alicePrivate },
      { id: adminPrivate },
    ]);
  });

  it("keeps the original response shape when nothing was refused", async () => {
    const response = await call("admin", "POST", "/api/repos/bulk", {
      ids: [alicePublic],
      action: "resume",
    });
    expect(response.json()).not.toHaveProperty("refused");
  });
});

describe("browse and export", () => {
  it("answers an invisible repo exactly like a missing one, on top of the coarse permission", async () => {
    mkdirSync(join(temp.config.backupsDir, "placeholder"), { recursive: true });
    for (const path of [
      "browse/refs",
      "browse/resolve?rev=main",
      "browse/contents?rev=main&path=",
      "browse/raw?rev=main&path=README.md",
      "browse/commits?rev=main",
      "browse/commit?rev=main",
      "tree?ref=main",
      "blob?ref=main&path=README.md",
      "export/source.zip",
    ]) {
      const invisible = await call("bob", "GET", `/api/repos/${String(adminPrivate)}/${path}`);
      const missing = await call("bob", "GET", `/api/repos/${String(NONEXISTENT)}/${path}`);
      expect(invisible.statusCode, path).toBe(missing.statusCode);
      expect(normalized(invisible.body, adminPrivate), path).toBe(
        normalized(missing.body, NONEXISTENT),
      );
    }
  });

  it("still needs browse or export on a repo the caller owns", async () => {
    makeUser(temp.db, ALICE, { browse: false, export: false });
    const browse = await call("alice", "GET", `/api/repos/${String(alicePublic)}/browse/refs`);
    expect(browse.statusCode).toBe(403);
    const exported = await call(
      "alice",
      "GET",
      `/api/repos/${String(alicePublic)}/export/source.zip`,
    );
    expect(exported.statusCode).toBe(403);
  });
});

describe("the raw route's own onRequest hook", () => {
  /**
   * browse/raw carries a route-level onRequest (it sets safety headers). This
   * pins that the identity and authz hooks, registered at the root, still run
   * before it in the REAL (non-insecure) configuration.
   */
  it("stays behind identity and authz", async () => {
    const keys = await createAccessKeys();
    const endpoint = new FakePolicyEndpoint([ALICE]);
    const secure = await createTempApp(secureEnv(), {
      cfAccessGetKey: keys.getKey,
      accessPolicyFetch: endpoint.fetch,
    });
    try {
      const url = "/api/repos/1/browse/raw?rev=main&path=README.md";
      const anonymous = await secure.app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(401);

      // A member without `browse` is stopped by the authz hook, not the handler.
      const member = makeUser(secure.db, ALICE, { browse: false });
      expect(member.permissions.browse).toBe(false);
      const refused = await secure.app.inject({
        method: "GET",
        url,
        headers: { [CF_ACCESS_HEADER]: await keys.token(ALICE) },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ details: { permission: "browse" } });

      // An outsider with a valid token is refused by identity.
      const outsider = await secure.app.inject({
        method: "GET",
        url,
        headers: { [CF_ACCESS_HEADER]: await keys.token("stranger@example.com") },
      });
      expect(outsider.statusCode).toBe(403);
      expect(outsider.json()).toMatchObject({ error: "not_a_user" });
    } finally {
      await secure.close();
    }
  });
});
