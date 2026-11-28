import type { Me } from "@amber/shared";
import { meSchema } from "@amber/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail, listUsers } from "../src/domain/users.ts";
import { POLICY_MAX_AGE_MS, POLICY_STALE_LIMIT_MS } from "../src/security/accessPolicy.ts";
import { CF_ACCESS_HEADER } from "../src/security/cfAccess.ts";
import {
  ADMIN_EMAIL,
  asUser,
  createAccessKeys,
  FakeClock,
  FakePolicyEndpoint,
  secureEnv,
  type AccessKeys,
} from "./helpers/accessFixtures.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

/**
 * The identity path end to end: a real signed Access token through the
 * cfAccessGetKey seam, the real identity hook, and a scripted policy endpoint
 * with a clock the test moves. Nothing here touches the network.
 */

let keys: AccessKeys;
let temp: TempApp | undefined;

beforeAll(async () => {
  keys = await createAccessKeys();
});

afterEach(async () => {
  await temp?.close();
  temp = undefined;
});

interface Harness {
  temp: TempApp;
  clock: FakeClock;
  endpoint: FakePolicyEndpoint;
  get(
    email: string,
    url?: string,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
}

async function secureApp(
  members: readonly string[] = ["friend@example.com"],
  env: Record<string, string> = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const endpoint = new FakePolicyEndpoint(members);
  temp = await createTempApp(secureEnv(env), {
    cfAccessGetKey: keys.getKey,
    accessPolicyFetch: endpoint.fetch,
    now: clock.now,
  });
  const app = temp.app;
  return {
    temp,
    clock,
    endpoint,
    async get(email, url = "/api/me", headers = {}) {
      return app.inject({
        method: "GET",
        url,
        headers: { [CF_ACCESS_HEADER]: await keys.token(email), ...headers },
      });
    },
  };
}

describe("the admin", () => {
  it("is accepted on any valid token and gets every permission", async () => {
    const h = await secureApp([]);
    const response = await h.get(ADMIN_EMAIL);
    expect(response.statusCode).toBe(200);
    const me = meSchema.parse(response.json());
    expect(me).toMatchObject({ email: ADMIN_EMAIL, isAdmin: true });
    expect(Object.values(me.permissions).every(Boolean)).toBe(true);
    expect(me.storage.capBytes).toBeNull();
    // Admin requests never wait on the policy.
    expect(h.endpoint.calls).toHaveLength(0);
  });

  it("is accepted when the policy cannot be read at all", async () => {
    const h = await secureApp();
    h.endpoint.fail(500);
    h.clock.advance(10 * POLICY_STALE_LIMIT_MS);
    expect((await h.get(ADMIN_EMAIL)).statusCode).toBe(200);
    expect((await h.get("ADMIN@example.com")).statusCode).toBe(200);
  });

  it("is never duplicated when its address is also in the policy", async () => {
    const h = await secureApp([ADMIN_EMAIL, "friend@example.com"]);
    expect((await h.get("friend@example.com")).statusCode).toBe(200);
    const admins = listUsers(h.temp.db).filter((user) => user.email === ADMIN_EMAIL);
    expect(admins).toHaveLength(1);
    expect(admins[0]?.isAdmin).toBe(true);
  });

  it("sees the policy status; nobody else does", async () => {
    const h = await secureApp();
    expect((await h.get("friend@example.com")).json<Me>().policy).toBeNull();
    const admin = (await h.get(ADMIN_EMAIL)).json<Me>();
    expect(admin.policy).toMatchObject({ configured: true, stale: false });
    expect(admin.policy?.editUrl).toContain("/one/access-controls/policies/");
  });
});

describe("policy members", () => {
  it("are accepted with the default permissions and a cap", async () => {
    const h = await secureApp();
    const response = await h.get("Friend@Example.com");
    expect(response.statusCode).toBe(200);
    const me = meSchema.parse(response.json());
    expect(me).toMatchObject({ email: "friend@example.com", isAdmin: false });
    expect(me.permissions.import).toBe(true);
    expect(me.permissions.view_others_private).toBe(false);
    expect(me.storage.capBytes).toBe(5 * 1024 ** 3);
  });

  it("refuses a valid token for someone the policy does not list", async () => {
    const h = await secureApp();
    const response = await h.get("stranger@example.com");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_user" });
    // The refusal never echoes the address.
    expect(response.body).not.toContain("stranger@example.com");
    // And creates no row.
    expect(findUserByEmail(h.temp.db, "stranger@example.com")).toBeUndefined();
  });

  it("refuses someone admitted only by a rule Amber cannot enumerate", async () => {
    const h = await secureApp();
    h.endpoint.members([], { include: [{ email_domain: { domain: "example.com" } }] });
    expect((await h.get("anyone@example.com")).statusCode).toBe(403);
  });

  it("drops a removed member within a minute, even with a live Access session", async () => {
    const h = await secureApp();
    expect((await h.get("friend@example.com")).statusCode).toBe(200);

    h.endpoint.members([]);
    h.clock.advance(POLICY_MAX_AGE_MS);
    // A 60 second old copy still answers.
    expect((await h.get("friend@example.com")).statusCode).toBe(200);

    h.clock.advance(1);
    const response = await h.get("friend@example.com");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_user" });
    expect(findUserByEmail(h.temp.db, "friend@example.com")?.removedAt).toBe(h.clock.value);
  });

  it("lets a returning member back in", async () => {
    const h = await secureApp();
    await h.get("friend@example.com");
    h.endpoint.members([]);
    h.clock.advance(POLICY_MAX_AGE_MS + 1);
    expect((await h.get("friend@example.com")).statusCode).toBe(403);

    h.endpoint.members(["friend@example.com"]);
    h.clock.advance(POLICY_MAX_AGE_MS + 1);
    expect((await h.get("friend@example.com")).statusCode).toBe(200);
  });

  it("fails closed with 503 once the copy is 5 minutes old and the policy cannot be read", async () => {
    const h = await secureApp();
    expect((await h.get("friend@example.com")).statusCode).toBe(200);
    h.endpoint.fail(502);

    h.clock.advance(POLICY_STALE_LIMIT_MS - 1);
    expect((await h.get("friend@example.com")).statusCode).toBe(200);

    h.clock.advance(1);
    const response = await h.get("friend@example.com");
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toMatchObject({ error: "policy_unavailable" });
    // The admin is unaffected by the same outage.
    expect((await h.get(ADMIN_EMAIL)).statusCode).toBe(200);
  });

  it("records last_seen_at at most once a minute", async () => {
    const h = await secureApp();
    const start = h.clock.value;
    await h.get("friend@example.com");
    expect(findUserByEmail(h.temp.db, "friend@example.com")?.lastSeenAt).toBe(start);
    h.clock.advance(30_000);
    await h.get("friend@example.com");
    expect(findUserByEmail(h.temp.db, "friend@example.com")?.lastSeenAt).toBe(start);
    h.clock.advance(30_000);
    await h.get("friend@example.com");
    expect(findUserByEmail(h.temp.db, "friend@example.com")?.lastSeenAt).toBe(start + 60_000);
  });

  it("cannot use the insecure-mode header to become someone else", async () => {
    const h = await secureApp(["friend@example.com", "other@example.com"]);
    const response = await h.get("friend@example.com", "/api/me", asUser(ADMIN_EMAIL));
    expect(response.json<Me>()).toMatchObject({ email: "friend@example.com", isAdmin: false });
  });

  it("are refused everywhere outside the public paths, not just under /api", async () => {
    const h = await secureApp();
    expect((await h.get("stranger@example.com", "/")).statusCode).toBe(403);
    expect((await h.get("stranger@example.com", "/healthz")).statusCode).toBe(200);
  });
});

describe("without a policy", () => {
  it("is admin-only", async () => {
    const h = await secureApp([], { CF_API_TOKEN: "", CF_ACCOUNT_ID: "", CF_ACCESS_POLICY_ID: "" });
    expect((await h.get(ADMIN_EMAIL)).statusCode).toBe(200);
    const response = await h.get("friend@example.com");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_user" });
    const admin = (await h.get(ADMIN_EMAIL)).json<Me>();
    expect(admin.policy).toEqual({
      configured: false,
      fetchedAt: null,
      stale: false,
      editUrl: null,
      lastError: null,
    });
  });
});

describe("the legacy CF_ACCESS_ALLOWED_EMAILS fallback", () => {
  it("makes the first entry the admin and ignores the rest", async () => {
    const h = await secureApp([], {
      AMBER_ADMIN_EMAIL: "",
      CF_ACCESS_ALLOWED_EMAILS: "first@example.com, second@example.com",
      CF_API_TOKEN: "",
      CF_ACCOUNT_ID: "",
      CF_ACCESS_POLICY_ID: "",
    });
    expect((await h.get("first@example.com")).json<Me>()).toMatchObject({ isAdmin: true });
    expect((await h.get("second@example.com")).statusCode).toBe(403);
  });
});

describe("insecure mode", () => {
  async function insecureApp(): Promise<TempApp> {
    temp = await createTempApp({
      INSECURE_USER_EMAILS: "friend@example.com",
      AMBER_ADMIN_EMAIL: ADMIN_EMAIL,
    });
    return temp;
  }

  it("is the admin by default", async () => {
    const t = await insecureApp();
    const me = (await t.app.inject({ method: "GET", url: "/api/me" })).json<Me>();
    expect(me).toMatchObject({ email: ADMIN_EMAIL, isAdmin: true });
  });

  it("acts as a listed user when asked, which only ever lowers privilege", async () => {
    const t = await insecureApp();
    const me = (
      await t.app.inject({ method: "GET", url: "/api/me", headers: asUser("Friend@example.com") })
    ).json<Me>();
    expect(me).toMatchObject({ email: "friend@example.com", isAdmin: false });

    const asAdmin = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: asUser(ADMIN_EMAIL),
    });
    expect(asAdmin.json<Me>().isAdmin).toBe(true);
  });

  it("refuses an address that is not in the stand-in list", async () => {
    const t = await insecureApp();
    const response = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: asUser("stranger@example.com"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "not_a_user" });
  });

  it("works with no admin email configured: the admin keeps its placeholder", async () => {
    temp = await createTempApp();
    const me = (await temp.app.inject({ method: "GET", url: "/api/me" })).json<Me>();
    expect(me).toMatchObject({ email: "admin@amber.invalid", isAdmin: true });
  });

  it("refuses a removed user even with the header", async () => {
    const t = await insecureApp();
    const friend = findUserByEmail(t.db, "friend@example.com")!;
    t.db.run("UPDATE users SET removed_at = 1 WHERE id = ?", friend.id);
    const response = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: asUser("friend@example.com"),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("token checks still come first", () => {
  it("answers 401 before any identity question for a bad token", async () => {
    const h = await secureApp();
    const response = await h.temp.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [CF_ACCESS_HEADER]: "not-a-jwt" },
    });
    expect(response.statusCode).toBe(401);
    expect(h.endpoint.calls).toHaveLength(0);
  });
});
