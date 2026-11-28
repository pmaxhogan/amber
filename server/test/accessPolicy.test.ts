import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedactedSecret } from "../src/config.ts";
import { bootstrapAdmin, findUserByEmail, listUsers } from "../src/domain/users.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  AccessPolicy,
  KV_POLICY_EMAILS,
  parsePolicyResponse,
  POLICY_FAILURE_BACKOFF_MS,
  POLICY_FETCH_TIMEOUT_MS,
  POLICY_MAX_AGE_MS,
  POLICY_REFRESH_INTERVAL_MS,
  POLICY_STALE_LIMIT_MS,
  type PolicySource,
} from "../src/security/accessPolicy.ts";
import {
  ADMIN_EMAIL,
  FakeClock,
  FakePolicyEndpoint,
  POLICY_ACCOUNT_ID,
  POLICY_ID,
  POLICY_TOKEN,
  policyBody,
} from "./helpers/accessFixtures.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const log = createConsoleLogger("silent");

const SOURCE: PolicySource = {
  kind: "cloudflare",
  accountId: POLICY_ACCOUNT_ID,
  policyId: POLICY_ID,
  apiToken: new RedactedSecret(POLICY_TOKEN),
};

let temp: TempDb;
let clock: FakeClock;
let endpoint: FakePolicyEndpoint;

function makePolicy(source: PolicySource | null = SOURCE): AccessPolicy {
  return new AccessPolicy({ db: temp.db, log, source, fetch: endpoint.fetch, now: clock.now });
}

beforeEach(() => {
  temp = createTempDb();
  bootstrapAdmin(temp.db, log, ADMIN_EMAIL);
  clock = new FakeClock();
  endpoint = new FakePolicyEndpoint(["friend@example.com"]);
});

afterEach(() => {
  vi.useRealTimers();
  temp.close();
});

describe("parsePolicyResponse", () => {
  it("takes explicit email include rules only, lower cased and de-duplicated", () => {
    const parsed = parsePolicyResponse(
      policyBody(["B@Example.com", "a@example.com", "b@example.com"], {
        include: [{ email_domain: { domain: "example.com" } }, { everyone: {} }],
      }),
    );
    expect(parsed.emails).toEqual(["a@example.com", "b@example.com"]);
    expect(parsed.ignoredKinds).toEqual(["email_domain", "everyone"]);
  });

  it("subtracts explicit email exclude rules", () => {
    const parsed = parsePolicyResponse(
      policyBody(["a@example.com", "b@example.com"], {
        exclude: [{ email: { email: "B@example.com" } }, { geo: { country_code: "XX" } }],
      }),
    );
    expect(parsed.emails).toEqual(["a@example.com"]);
  });

  it("treats every unexpected shape as a failed read, never as an empty list", () => {
    for (const body of [
      null,
      {},
      { success: false, result: { include: [] } },
      { success: true },
      { success: true, result: {} },
      { success: true, result: { include: "nope" } },
      { success: true, result: { include: [{ email: { address: "x@example.com" } }] } },
      { success: true, result: { include: [{ email: "x@example.com" }] } },
    ]) {
      expect(() => parsePolicyResponse(body), JSON.stringify(body)).toThrow();
    }
  });

  it("accepts an empty include list as a real answer", () => {
    expect(parsePolicyResponse(policyBody([])).emails).toEqual([]);
  });
});

describe("AccessPolicy.refresh", () => {
  it("reads the policy with the bearer token and reconciles the users table", async () => {
    const policy = makePolicy();
    const outcome = await policy.refresh();

    expect(outcome).toEqual({
      ok: true,
      error: null,
      changes: { created: 1, removed: 0, restored: 0 },
    });
    expect(endpoint.calls).toHaveLength(1);
    expect(endpoint.calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${POLICY_ACCOUNT_ID}/access/policies/${POLICY_ID}`,
    );
    expect(endpoint.calls[0]?.authorization).toBe(`Bearer ${POLICY_TOKEN}`);
    expect(findUserByEmail(temp.db, "friend@example.com")?.removedAt).toBeNull();
    expect(policy.emails()).toEqual(["friend@example.com"]);
    expect(policy.fetchedAt).toBe(clock.value);
  });

  it("never creates a second admin row, nor removes the admin when it is absent", async () => {
    endpoint.members([ADMIN_EMAIL.toUpperCase(), "friend@example.com"]);
    const policy = makePolicy();
    await policy.refresh();
    expect(listUsers(temp.db).map((user) => [user.email, user.isAdmin])).toEqual([
      [ADMIN_EMAIL, true],
      ["friend@example.com", false],
    ]);

    endpoint.members([]);
    clock.advance(1);
    await policy.refresh();
    const admin = findUserByEmail(temp.db, ADMIN_EMAIL);
    expect(admin?.isAdmin).toBe(true);
    expect(admin?.removedAt).toBeNull();
    expect(findUserByEmail(temp.db, "friend@example.com")?.removedAt).toBe(clock.value);
  });

  it("does not reconcile on a failed read: nobody is removed by an outage", async () => {
    const policy = makePolicy();
    await policy.refresh();

    for (const answer of [
      { kind: "status", status: 403 },
      { kind: "ok", body: { success: false, errors: [], result: null } },
      { kind: "ok", body: { success: true, result: { include: null } } },
      { kind: "throw", error: new TypeError("fetch failed") },
    ] as const) {
      endpoint.answer = answer;
      clock.advance(POLICY_FAILURE_BACKOFF_MS);
      const outcome = await policy.refresh();
      expect(outcome.ok, JSON.stringify(answer)).toBe(false);
      expect(findUserByEmail(temp.db, "friend@example.com")?.removedAt).toBeNull();
      expect(policy.emails()).toEqual(["friend@example.com"]);
    }
  });

  it("keeps the token out of every error message", async () => {
    endpoint.answer = { kind: "throw", error: new Error(`boom with ${POLICY_TOKEN} inside`) };
    const outcome = await makePolicy().refresh();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).not.toContain(POLICY_TOKEN);
    expect(outcome.error).toContain("[redacted]");
  });

  it("is single flight: concurrent callers share one request", async () => {
    endpoint.answer = { kind: "hang" };
    const policy = makePolicy();
    const first = policy.refresh();
    const second = policy.refresh();
    const third = policy.membership("friend@example.com");
    endpoint.members(["friend@example.com"]);
    // Let the hung request reach the endpoint, then answer it.
    await Promise.resolve();
    endpoint.release();

    expect((await first).ok).toBe(true);
    expect(await second).toEqual(await first);
    expect(await third).toBe("allow");
    expect(endpoint.calls).toHaveLength(1);
  });

  it("backs off for 30 seconds after a failure without calling out", async () => {
    endpoint.fail(500);
    const policy = makePolicy();
    expect((await policy.refresh()).ok).toBe(false);
    expect(endpoint.calls).toHaveLength(1);

    endpoint.members(["friend@example.com"]);
    clock.advance(POLICY_FAILURE_BACKOFF_MS - 1);
    expect((await policy.refresh()).ok).toBe(false);
    expect(endpoint.calls).toHaveLength(1);

    clock.advance(1);
    expect((await policy.refresh()).ok).toBe(true);
    expect(endpoint.calls).toHaveLength(2);
  });

  it("gives up after 15 seconds and aborts the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    endpoint.answer = { kind: "hang" };
    const pending = makePolicy().refresh();
    await vi.advanceTimersByTimeAsync(POLICY_FETCH_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/15 seconds/);
    expect(endpoint.calls[0]?.signal.aborted).toBe(true);
  });

  it("mirrors the last good copy to kv and starts from it after a restart", async () => {
    await makePolicy().refresh();
    expect(
      temp.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", KV_POLICY_EMAILS)?.value,
    ).toBe(JSON.stringify(["friend@example.com"]));

    endpoint.fail(500);
    clock.advance(POLICY_MAX_AGE_MS + 1);
    const restarted = makePolicy();
    expect(restarted.emails()).toEqual(["friend@example.com"]);
    // The copy is over a minute old, the refresh fails, the copy is young
    // enough: still a member.
    expect(await restarted.membership("friend@example.com")).toBe("allow");
  });

  it("ignores a mirror it cannot read", () => {
    temp.db.run(
      "INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, 'not json', 1, 1), ('access_policy.fetched_at', '5', 1, 1)",
      KV_POLICY_EMAILS,
    );
    expect(makePolicy().emails()).toBeNull();
  });
});

describe("THE MEMBERSHIP RULE", () => {
  it("answers allow and not_member from a fresh copy", async () => {
    const policy = makePolicy();
    expect(await policy.membership("Friend@Example.com")).toBe("allow");
    expect(await policy.membership("stranger@example.com")).toBe("not_member");
    expect(endpoint.calls).toHaveLength(1);
  });

  it("refreshes a copy older than 60 seconds, and not one exactly 60 seconds old", async () => {
    const policy = makePolicy();
    await policy.membership("friend@example.com");

    clock.advance(POLICY_MAX_AGE_MS);
    await policy.membership("friend@example.com");
    expect(endpoint.calls).toHaveLength(1);

    clock.advance(1);
    await policy.membership("friend@example.com");
    expect(endpoint.calls).toHaveLength(2);
  });

  it("drops a removed user within a minute", async () => {
    const policy = makePolicy();
    expect(await policy.membership("friend@example.com")).toBe("allow");

    endpoint.members([]);
    clock.advance(POLICY_MAX_AGE_MS + 1);
    expect(await policy.membership("friend@example.com")).toBe("not_member");
  });

  it("uses a copy under 5 minutes old when the refresh fails, and fails closed at 5 minutes", async () => {
    const policy = makePolicy();
    await policy.refresh();
    endpoint.fail(503);

    clock.advance(POLICY_STALE_LIMIT_MS - 1);
    expect(await policy.membership("friend@example.com")).toBe("allow");
    // Inside the backoff the refresh fails without a call, and the rule
    // still answers from the copy.
    expect(await policy.membership("stranger@example.com")).toBe("not_member");

    clock.advance(1);
    expect(await policy.membership("friend@example.com")).toBe("unavailable");
    expect(await policy.membership("stranger@example.com")).toBe("unavailable");
  });

  it("fails closed when there has never been a good read", async () => {
    endpoint.fail(500);
    expect(await makePolicy().membership("friend@example.com")).toBe("unavailable");
  });

  it("is admin-only without a policy, and constant with the insecure stand-in", async () => {
    expect(await makePolicy(null).membership("friend@example.com")).toBe("not_member");

    const standIn = makePolicy({ kind: "static", emails: ["Friend@example.com"] });
    clock.advance(10 * POLICY_STALE_LIMIT_MS);
    expect(await standIn.membership("friend@example.com")).toBe("allow");
    expect(await standIn.membership("stranger@example.com")).toBe("not_member");
    expect(standIn.status().stale).toBe(false);
    expect(endpoint.calls).toHaveLength(0);
    // The stand-in reconciles once, so its users have rows.
    expect(findUserByEmail(temp.db, "friend@example.com")).toBeDefined();
  });
});

describe("AccessPolicy.status", () => {
  it("links the policy editor and reports a failed refresh as stale", async () => {
    const policy = makePolicy();
    expect(policy.status()).toMatchObject({ configured: true, fetchedAt: null, stale: true });
    expect(policy.status().editUrl).toBe(
      `https://dash.cloudflare.com/${POLICY_ACCOUNT_ID}/one/access-controls/policies/${POLICY_ID}/edit`,
    );

    await policy.refresh();
    expect(policy.status()).toMatchObject({
      fetchedAt: clock.value,
      stale: false,
      lastError: null,
    });

    endpoint.fail(500);
    clock.advance(POLICY_FAILURE_BACKOFF_MS);
    await policy.refresh();
    expect(policy.status().stale).toBe(true);
    expect(policy.status().lastError).toMatch(/500/);
  });

  it("says not configured, with no link, when there is no policy", () => {
    expect(makePolicy(null).status()).toEqual({
      configured: false,
      fetchedAt: null,
      stale: false,
      editUrl: null,
      lastError: null,
    });
  });
});

describe("AccessPolicy background timer", () => {
  it("refreshes every 5 minutes until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const policy = makePolicy();
    policy.start();
    policy.start();

    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_INTERVAL_MS);
    expect(endpoint.calls).toHaveLength(1);
    clock.advance(POLICY_REFRESH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_INTERVAL_MS);
    expect(endpoint.calls).toHaveLength(2);

    policy.stop();
    await vi.advanceTimersByTimeAsync(3 * POLICY_REFRESH_INTERVAL_MS);
    expect(endpoint.calls).toHaveLength(2);
  });
});
