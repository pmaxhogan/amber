import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, getAccount } from "../../src/domain/accounts.ts";
import { resolveRepoAccountId } from "../../src/domain/credentials.ts";
import { createRepo } from "../../src/domain/repos.ts";
import { explainSettings } from "../../src/domain/settings.ts";
import { adoptRepos, type User } from "../../src/domain/users.ts";
import {
  insertAccountSync,
  listDueAccountSyncs,
  runAccountSyncDetailed,
} from "../../src/providers/discovery.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
} from "../../src/providers/types.ts";
import { loadSyncTarget, resolveRepoAccount } from "../../src/sync/repoStore.ts";
import { asUser } from "../helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "../helpers.ts";
import { adminOf, makeUser } from "../helpers/users.ts";

/**
 * Who owns what, and whose token fetches what: accounts, forges, account
 * syncs, import and layered settings, through the real routes and the one
 * credential rule (domain/credentials.ts). The adversarial cases are the
 * point: user B must never be able to make user A's token fetch anything.
 */

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const FORGER = "forger@example.com";
const NOTHING = "nothing@example.com";
const NONEXISTENT = 987_654;

let temp: TempApp;
let admin: User;
let alice: User;
let bob: User;
let forgeId: number;

function as(email: string | null): Record<string, string> {
  return email === null ? {} : asUser(email);
}

async function call(
  email: string | null,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return temp.app.inject({
    method,
    url,
    headers: as(email),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function account(owner: User, username: string, isDefault = true, forge = forgeId): number {
  return createAccount(
    temp.db,
    temp.config.secretKey,
    { forgeId: forge, username, secret: `secret-of-${username}`, isDefault },
    owner.id,
  ).id;
}

function repo(owner: User, path: string, override: number | null = null): number {
  return createRepo(temp.db, {
    forgeId,
    path,
    ownerUserId: owner.id,
    accountOverrideId: override,
  }).id;
}

function credentialOf(repoId: number): number | null {
  const target = loadSyncTarget(temp.db, repoId);
  if (target === undefined) {
    throw new Error("no such repo");
  }
  return resolveRepoAccount(temp.db, target)?.id ?? null;
}

/** The normalized body of a 404, so an invisible id and a missing one compare. */
function normalized(body: string, id: number): string {
  return body.split(String(id)).join("<id>");
}

beforeEach(async () => {
  temp = await createTempApp({ INSECURE_USER_EMAILS: [ALICE, BOB, FORGER, NOTHING].join(",") });
  admin = adminOf(temp.db);
  alice = makeUser(temp.db, ALICE, { import_private: true });
  bob = makeUser(temp.db, BOB, { import_private: true });
  makeUser(temp.db, FORGER, { manage_forges: true });
  makeUser(temp.db, NOTHING, {}, { nothing: true });
  forgeId = seedForge(temp.db);
});

afterEach(async () => {
  await temp.close();
});

describe("the credential rule", () => {
  it("only ever resolves the repo OWNER's own accounts", () => {
    const alicesDefault = account(alice, "alice-bot");
    const alicesOther = account(alice, "alice-other", false);
    const bobsDefault = account(bob, "bob-bot");
    account(admin, "admin-bot");

    // Each owner gets their own default.
    expect(credentialOf(repo(alice, "a/plain"))).toBe(alicesDefault);
    expect(credentialOf(repo(bob, "b/plain"))).toBe(bobsDefault);
    // An override the owner owns wins.
    expect(credentialOf(repo(alice, "a/override", alicesOther))).toBe(alicesOther);
    // B pointing his repo at A's account (written behind the API's back) still
    // never presents A's token: it falls to B's own default.
    const sneaky = repo(bob, "b/sneaky");
    temp.db.run("UPDATE repos SET account_override_id = ? WHERE id = ?", alicesDefault, sneaky);
    expect(credentialOf(sneaky)).toBe(bobsDefault);
  });

  it("presents nothing for force_anonymous, a removed owner or one without import_private", () => {
    account(alice, "alice-bot");
    const forced = repo(alice, "a/forced");
    temp.db.run("UPDATE repos SET force_anonymous = 1 WHERE id = ?", forced);
    expect(credentialOf(forced)).toBeNull();

    const plain = repo(alice, "a/plain");
    makeUser(temp.db, ALICE, { import_private: false });
    expect(credentialOf(plain)).toBeNull();

    makeUser(temp.db, ALICE, { import_private: true });
    expect(credentialOf(plain)).not.toBeNull();
    temp.db.run("UPDATE users SET removed_at = 1 WHERE id = ?", alice.id);
    expect(credentialOf(plain)).toBeNull();
  });

  it("never presents the owner's account from another forge", () => {
    const gitlab = seedForge(temp.db, "gitlab.com", "gitlab");
    const elsewhere = account(alice, "alice-gitlab", true, gitlab);
    account(alice, "alice-bot");
    const crossed = repo(alice, "a/crossed");
    temp.db.run("UPDATE repos SET account_override_id = ? WHERE id = ?", elsewhere, crossed);
    expect(credentialOf(crossed)).toBeNull();
  });

  it("gives layered settings exactly the account the fetch would use", () => {
    const alicesDefault = account(alice, "alice-bot");
    const bobsDefault = account(bob, "bob-bot");
    temp.db.run(
      `INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at)
       VALUES ('account', ?, 'clone_mode', '"mirror"', 1, 1), ('account', ?, 'clone_mode', '"full"', 1, 1)`,
      alicesDefault,
      bobsDefault,
    );
    const bobsRepo = repo(bob, "b/r");
    expect(explainSettings(temp.db, bobsRepo).clone_mode).toMatchObject({
      value: "full",
      source: "account",
      sourceId: bobsDefault,
    });
    // Losing import_private takes the account layer away too.
    makeUser(temp.db, BOB, { import_private: false });
    expect(explainSettings(temp.db, bobsRepo).clone_mode.source).toBe("default");
    expect(
      resolveRepoAccountId(temp.db, {
        forgeId,
        ownerUserId: bob.id,
        accountOverrideId: alicesDefault,
        forceAnonymous: false,
      }),
    ).toBeNull();
  });

  it("clears overrides when the admin adopts a removed user's repos", () => {
    const alicesDefault = account(alice, "alice-bot");
    const theirs = repo(alice, "a/r", alicesDefault);
    temp.db.run("UPDATE users SET removed_at = 1 WHERE id = ?", alice.id);
    adoptRepos(temp.db, alice.id);
    const row = temp.db.get<{ owner_user_id: number; account_override_id: number | null }>(
      "SELECT owner_user_id, account_override_id FROM repos WHERE id = ?",
      theirs,
    );
    expect(row).toEqual({ owner_user_id: admin.id, account_override_id: null });
  });
});

describe("accounts API", () => {
  it("lists your own accounts; manage_forges and the admin see all with ownerEmail", async () => {
    const mine = account(alice, "alice-bot");
    const theirs = account(bob, "bob-bot");

    const asAlice = await call(ALICE, "GET", "/api/accounts");
    expect(asAlice.json<{ id: number }[]>().map((row) => row.id)).toEqual([mine]);
    expect(asAlice.json<object[]>()[0]).not.toHaveProperty("ownerEmail");

    for (const email of [FORGER, null]) {
      const all = await call(email, "GET", "/api/accounts");
      const rows = all.json<{ id: number; ownerEmail: string; hasSecret: boolean }[]>();
      expect(rows.map((row) => row.id).sort()).toEqual([mine, theirs].sort());
      expect(rows.find((row) => row.id === theirs)?.ownerEmail).toBe(BOB);
      // Never a secret, for anyone.
      expect(all.body).not.toContain("secret-of-");
    }
  });

  it("answers someone else's account like a missing one for an ordinary user", async () => {
    const theirs = account(bob, "bob-bot");
    for (const [method, path, payload] of [
      ["GET", "", undefined],
      ["PATCH", "", { username: "renamed" }],
      ["POST", "/default", undefined],
      ["DELETE", "", undefined],
    ] as const) {
      const invisible = await call(
        ALICE,
        method,
        `/api/accounts/${String(theirs)}${path}`,
        payload,
      );
      const missing = await call(
        ALICE,
        method,
        `/api/accounts/${String(NONEXISTENT)}${path}`,
        payload,
      );
      expect(invisible.statusCode, `${method} ${path}`).toBe(404);
      expect(normalized(invisible.body, theirs)).toBe(normalized(missing.body, NONEXISTENT));
    }
    expect(getAccount(temp.db, theirs)?.username).toBe("bob-bot");
  });

  it("lets manage_forges delete but never edit or promote someone else's account", async () => {
    const theirs = account(bob, "bob-bot");
    makeUser(temp.db, FORGER, { manage_forges: true, import_private: true });
    const edit = await call(FORGER, "PATCH", `/api/accounts/${String(theirs)}`, {
      secret: "attacker-token",
    });
    expect(edit.statusCode).toBe(403);
    const promote = await call(FORGER, "POST", `/api/accounts/${String(theirs)}/default`);
    expect(promote.statusCode).toBe(403);
    // Not even the admin rewrites a user's token.
    const asAdmin = await call(null, "PATCH", `/api/accounts/${String(theirs)}`, {
      secret: "admin-token",
    });
    expect(asAdmin.statusCode).toBe(403);

    const removed = await call(FORGER, "DELETE", `/api/accounts/${String(theirs)}`);
    expect(removed.statusCode).toBe(204);
  });

  it("creates accounts for their creator, with a default per owner and forge", async () => {
    const first = await call(ALICE, "POST", "/api/accounts", {
      forgeId,
      username: "alice-bot",
      secret: "t",
      isDefault: false,
    });
    const second = await call(BOB, "POST", "/api/accounts", {
      forgeId,
      username: "bob-bot",
      secret: "t",
      isDefault: false,
    });
    expect(first.json()).toMatchObject({ ownerUserId: alice.id, isDefault: true });
    // Bob's first account is HIS default; Alice's stays hers.
    expect(second.json()).toMatchObject({ ownerUserId: bob.id, isDefault: true });
    const aliceRow = await call(
      ALICE,
      "GET",
      `/api/accounts/${String(first.json<{ id: number }>().id)}`,
    );
    expect(aliceRow.json()).toMatchObject({ isDefault: true });
  });

  it("answers a forge login someone else registered with a generic 409", async () => {
    account(bob, "shared-login");
    const response = await call(ALICE, "POST", "/api/accounts", {
      forgeId,
      username: "shared-login",
      secret: "t",
      isDefault: false,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain(BOB);
    expect(response.json<{ message: string }>().message).toBe(
      "That forge login is already registered in Amber.",
    );
  });

  it("needs import_private to create or edit accounts", async () => {
    makeUser(temp.db, ALICE, { import_private: false });
    const response = await call(ALICE, "POST", "/api/accounts", {
      forgeId,
      username: "x",
      secret: null,
      isDefault: false,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("forges API", () => {
  it("emits allowPrivateNetwork and only lets the admin set it", async () => {
    const refused = await call(FORGER, "POST", "/api/forges", {
      protocol: "https",
      host: "git.example.com",
      allowPrivateNetwork: true,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ details: { requires: "admin" } });

    const restricted = await call(FORGER, "POST", "/api/forges", {
      protocol: "https",
      host: "git.example.com",
    });
    expect(restricted.statusCode).toBe(201);
    expect(restricted.json()).toMatchObject({ allowPrivateNetwork: false });
    const id = restricted.json<{ id: number }>().id;

    for (const value of [true, false]) {
      const patch = await call(FORGER, "PATCH", `/api/forges/${String(id)}`, {
        allowPrivateNetwork: value,
      });
      expect(patch.statusCode).toBe(403);
    }
    const byAdmin = await call(null, "PATCH", `/api/forges/${String(id)}`, {
      allowPrivateNetwork: true,
    });
    expect(byAdmin.json()).toMatchObject({ allowPrivateNetwork: true });

    const adminMade = await call(null, "POST", "/api/forges", {
      protocol: "http",
      host: "git.internal.example.com",
      port: 3000,
      allowPrivateNetwork: true,
    });
    expect(adminMade.json()).toMatchObject({ allowPrivateNetwork: true });
  });

  it("needs manage_forges to create, edit or delete a forge", async () => {
    const response = await call(ALICE, "POST", "/api/forges", {
      protocol: "https",
      host: "git.example.com",
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("import", () => {
  const all = (email: string | null) =>
    call(email, "GET", "/api/repos?perPage=200").then((r) => r.json<{ rows: { id: number }[] }>());

  it("makes the importer the owner, never the admin", async () => {
    const response = await call(ALICE, "POST", "/api/import", {
      text: "https://github.com/acme/thing",
    });
    const repoId = response.json<{ results: { repoId: number }[] }>().results[0]?.repoId;
    const row = temp.db.get<{ owner_user_id: number }>(
      "SELECT owner_user_id FROM repos WHERE id = ?",
      repoId ?? 0,
    );
    expect(row?.owner_user_id).toBe(alice.id);
    expect(row?.owner_user_id).not.toBe(admin.id);
  });

  it("selects only the importer's own account by a user@ prefix", async () => {
    account(alice, "alice-bot");
    const response = await call(BOB, "POST", "/api/import", {
      text: "alice-bot@github.com/acme/thing",
    });
    const line = response.json<{ results: { repoId: number; status: string; message: string }[] }>()
      .results[0];
    expect(line?.status).toBe("warning");
    expect(line?.message).toMatch(/have no account named "alice-bot"/);
    const row = temp.db.get<{ account_override_id: number | null }>(
      "SELECT account_override_id FROM repos WHERE id = ?",
      line?.repoId ?? 0,
    );
    expect(row?.account_override_id).toBeNull();
    // The preview says the same and does not reveal that alice-bot exists.
    const preview = await call(BOB, "POST", "/api/import/preview", {
      text: "alice-bot@github.com/acme/other",
    });
    const ghost = await call(BOB, "POST", "/api/import/preview", {
      text: "nobody-bot@github.com/acme/other",
    });
    expect(preview.body.replaceAll("alice-bot", "X")).toBe(
      ghost.body.replaceAll("nobody-bot", "X"),
    );
  });

  it("imports anonymously for a user without import_private, even with their own account named", async () => {
    account(alice, "alice-bot");
    makeUser(temp.db, ALICE, { import_private: false });
    const response = await call(ALICE, "POST", "/api/import", {
      text: "alice-bot@github.com/acme/thing",
    });
    const line = response.json<{ results: { repoId: number; message: string }[] }>().results[0];
    expect(line?.message).toMatch(/anonymously/);
    expect(credentialOf(line?.repoId ?? 0)).toBeNull();
  });

  it("answers an existing repo by whether the importer can view it, changing nothing", async () => {
    const alicesAccount = account(alice, "alice-bot");
    const bobsAccount = account(bob, "bob-bot");
    const existing = repo(alice, "acme/shared", alicesAccount);
    temp.db.run("UPDATE repos SET is_private = 1 WHERE id = ?", existing);

    // Bob cannot see it: the same failure an upstream refusal gives.
    const hidden = await call(BOB, "POST", "/api/import", {
      text: "bob-bot@github.com/acme/shared",
    });
    expect(hidden.json()).toMatchObject({
      failed: 1,
      results: [{ action: "failed", message: "Amber could not import this repository." }],
    });

    // Public now: "already backed up", and neither owner nor override moves.
    temp.db.run("UPDATE repos SET is_private = 0 WHERE id = ?", existing);
    const visible = await call(BOB, "POST", "/api/import", {
      text: "bob-bot@github.com/acme/shared",
    });
    expect(visible.json()).toMatchObject({
      updated: 1,
      results: [{ action: "updated", status: "ok", repoId: existing }],
    });
    const row = temp.db.get<{ owner_user_id: number; account_override_id: number }>(
      "SELECT owner_user_id, account_override_id FROM repos WHERE id = ?",
      existing,
    );
    expect(row).toEqual({ owner_user_id: alice.id, account_override_id: alicesAccount });
    expect(bobsAccount).toBeGreaterThan(0);
  });

  it("refuses a new host without manage_forges, and allows it with", async () => {
    const refused = await call(ALICE, "POST", "/api/import", {
      text: "https://git.example.com/a/b",
    });
    expect(refused.json()).toMatchObject({
      failed: 1,
      results: [
        {
          action: "failed",
          code: "host_not_enabled",
          message: "This host is not enabled on this Amber.",
        },
      ],
    });
    expect(temp.db.get("SELECT COUNT(*) AS n FROM forges WHERE host = 'git.example.com'")).toEqual({
      n: 0,
    });
    const preview = await call(ALICE, "POST", "/api/import/preview", {
      text: "https://git.example.com/a/b",
    });
    expect(preview.json()).toMatchObject({
      results: [{ status: "error", code: "host_not_enabled" }],
    });

    const allowed = await call(FORGER, "POST", "/api/import", {
      text: "https://git.example.com/a/b",
    });
    expect(allowed.json()).toMatchObject({ created: 1 });
    // A forge created by import is restricted.
    expect(
      temp.db.get("SELECT allow_private_network AS p FROM forges WHERE host = 'git.example.com'"),
    ).toEqual({ p: 0 });
  });

  it("refuses new repos at or over the cap, with a code", async () => {
    makeUser(temp.db, ALICE, {}, { capBytes: 100 });
    const first = repo(alice, "acme/big");
    temp.db.run("UPDATE repos SET disk_usage_bytes = 100 WHERE id = ?", first);
    const response = await call(ALICE, "POST", "/api/import", {
      text: "https://github.com/acme/more\nhttps://github.com/acme/big",
    });
    expect(response.json()).toMatchObject({
      created: 0,
      results: [
        { action: "failed", code: "storage_cap_reached" },
        // Already hers: re-import is fine at the cap, it creates nothing.
        { action: "updated" },
      ],
    });
  });

  it("does not let a preview reveal repos the caller cannot view", async () => {
    const hidden = repo(admin, "acme/secret");
    temp.db.run("UPDATE repos SET is_private = 1 WHERE id = ?", hidden);
    const existing = await call(BOB, "POST", "/api/import/preview", {
      text: "https://github.com/acme/secret",
    });
    const absent = await call(BOB, "POST", "/api/import/preview", {
      text: "https://github.com/acme/secreu",
    });
    expect(existing.body.replaceAll("secret", "X")).toBe(absent.body.replaceAll("secreu", "X"));
    expect((await all(BOB)).rows).toEqual([]);
  });

  it("creates namespace syncs per importer and never edits another user's", async () => {
    const alicesAccount = account(alice, "alice-bot");
    const bobsAccount = account(bob, "bob-bot");
    const a = await call(ALICE, "POST", "/api/import", { text: "alice-bot@github.com/acme" });
    const b = await call(BOB, "POST", "/api/import", { text: "bob-bot@github.com/acme" });
    const aliceSync = a.json<{ results: { accountSyncId: number }[] }>().results[0]?.accountSyncId;
    const bobSync = b.json<{ results: { accountSyncId: number }[] }>().results[0]?.accountSyncId;
    expect(aliceSync).not.toBe(bobSync);
    const rows = temp.db.all<{ id: number; owner_user_id: number; account_id: number }>(
      "SELECT id, owner_user_id, account_id FROM account_syncs ORDER BY id",
    );
    expect(rows).toEqual([
      { id: aliceSync, owner_user_id: alice.id, account_id: alicesAccount },
      { id: bobSync, owner_user_id: bob.id, account_id: bobsAccount },
    ]);
  });
});

describe("account syncs API", () => {
  it("refuses another user's account exactly like a missing one", async () => {
    const theirs = account(alice, "alice-bot");
    for (const source of ["owned", "starred", "namespace"] as const) {
      const body = (accountId: number) => ({
        accountId,
        source,
        ...(source === "namespace" ? { namespace: "acme" } : {}),
      });
      const invisible = await call(BOB, "POST", "/api/account-syncs", body(theirs));
      const missing = await call(BOB, "POST", "/api/account-syncs", body(NONEXISTENT));
      expect(invisible.statusCode, source).toBe(404);
      expect(normalized(invisible.body, theirs)).toBe(normalized(missing.body, NONEXISTENT));
    }
    expect(temp.db.all("SELECT id FROM account_syncs")).toEqual([]);
  });

  it("shows, edits, runs and deletes only your own syncs (the admin all)", async () => {
    const alicesAccount = account(alice, "alice-bot");
    const created = await call(ALICE, "POST", "/api/account-syncs", {
      accountId: alicesAccount,
      source: "owned",
      enabled: false,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ownerUserId: alice.id });
    const id = created.json<{ id: number }>().id;

    expect((await call(BOB, "GET", "/api/account-syncs")).json()).toEqual({ rows: [] });
    const adminList = await call(null, "GET", "/api/account-syncs");
    expect(adminList.json()).toMatchObject({ rows: [{ id, ownerEmail: ALICE }] });

    for (const [method, path, payload] of [
      ["PATCH", "", { enabled: true }],
      ["POST", "/run", undefined],
      ["DELETE", "", undefined],
    ] as const) {
      const invisible = await call(BOB, method, `/api/account-syncs/${String(id)}${path}`, payload);
      const missing = await call(
        BOB,
        method,
        `/api/account-syncs/${String(NONEXISTENT)}${path}`,
        payload,
      );
      expect(invisible.statusCode).toBe(404);
      expect(normalized(invisible.body, id)).toBe(normalized(missing.body, NONEXISTENT));
    }
    const asAdmin = await call(null, "PATCH", `/api/account-syncs/${String(id)}`, {
      intervalMinutes: 30,
    });
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe("account sync runs", () => {
  function stubProvider(listing: readonly DiscoveredRepo[], seen: DiscoveryContext[]) {
    const provider: AccountSyncProvider = {
      kind: "github",
      async *listRepos(context) {
        seen.push(context);
        yield* listing;
      },
      async *listNamespaceRepos(context) {
        seen.push(context);
        yield* listing;
      },
      async *listStarred(context) {
        seen.push(context);
        yield* listing;
      },
      checkRepoAccess: () => Promise.resolve("accessible"),
    };
    return provider;
  }

  const listed = (path: string, isPrivate = false): DiscoveredRepo => ({
    path,
    defaultBranch: "main",
    isPrivate,
    archived: false,
    description: null,
    isFork: false,
    forkParent: null,
  });

  const deps = (provider: AccountSyncProvider) => ({
    secretKey: temp.config.secretKey,
    providerFor: () => provider,
    decryptSecret: (_key: Buffer, blob: Buffer) => `token:${blob.length > 0 ? "x" : ""}`,
    repos: { deleteRepo: () => Promise.resolve() },
  });

  it("creates repos owned by the sync's owner and never links another user's", async () => {
    const alicesAccount = account(alice, "alice-bot");
    const bobsRepo = repo(bob, "acme/bobs");
    const sync = insertAccountSync(temp.db, {
      ownerUserId: alice.id,
      forgeId,
      accountId: alicesAccount,
      source: "owned",
      namespace: null,
      visibility: "all",
      enabled: true,
      intervalMinutes: 60,
    });
    const seen: DiscoveryContext[] = [];
    const result = await runAccountSyncDetailed(
      temp.db,
      sync.id,
      deps(stubProvider([listed("acme/new", true), listed("acme/bobs")], seen)),
    );
    expect(result).toMatchObject({ error: null, created: 1, linked: 0 });
    const created = temp.db.get<{ owner_user_id: number; is_private: number }>(
      "SELECT owner_user_id, is_private FROM repos WHERE path = 'acme/new'",
    );
    expect(created).toEqual({ owner_user_id: alice.id, is_private: 1 });
    expect(
      temp.db.get("SELECT managed_by_account_sync_id AS m FROM repos WHERE id = ?", bobsRepo),
    ).toEqual({ m: null });
  });

  it("refuses to run with an account the owner does not own", async () => {
    const alicesAccount = account(alice, "alice-bot");
    const sync = insertAccountSync(temp.db, {
      ownerUserId: bob.id,
      forgeId,
      accountId: null,
      source: "namespace",
      namespace: "acme",
      visibility: "all",
      enabled: true,
      intervalMinutes: 60,
    });
    // Pinned behind the API's back to Alice's account.
    temp.db.run("UPDATE account_syncs SET account_id = ? WHERE id = ?", alicesAccount, sync.id);
    const seen: DiscoveryContext[] = [];
    const result = await runAccountSyncDetailed(temp.db, sync.id, deps(stubProvider([], seen)));
    expect(result.error).toMatch(/not usable/);
    expect(seen).toEqual([]);
  });

  it("runs a namespace sync without an account on the OWNER's default, and only with import_private", async () => {
    account(alice, "alice-bot");
    const bobsDefault = account(bob, "bob-bot");
    const sync = insertAccountSync(temp.db, {
      ownerUserId: bob.id,
      forgeId,
      accountId: null,
      source: "namespace",
      namespace: "acme",
      visibility: "all",
      enabled: true,
      intervalMinutes: 60,
    });
    const seen: DiscoveryContext[] = [];
    await runAccountSyncDetailed(temp.db, sync.id, deps(stubProvider([], seen)));
    expect(seen[0]?.username).toBe("bob-bot");
    expect(seen[0]?.token).not.toBeNull();
    expect(bobsDefault).toBeGreaterThan(0);

    makeUser(temp.db, BOB, { import_private: false });
    await runAccountSyncDetailed(temp.db, sync.id, deps(stubProvider([], seen)));
    expect(seen[1]?.token).toBeNull();
  });

  it("does not run a sync whose owner was removed", async () => {
    const sync = insertAccountSync(temp.db, {
      ownerUserId: alice.id,
      forgeId,
      accountId: null,
      source: "namespace",
      namespace: "acme",
      visibility: "all",
      enabled: true,
      intervalMinutes: 60,
    });
    temp.db.run("UPDATE users SET removed_at = 1 WHERE id = ?", alice.id);
    const due = listDueAccountSyncs(temp.db, Date.now() + 1);
    expect(due.map((row) => row.id)).not.toContain(sync.id);
    const seen: DiscoveryContext[] = [];
    const result = await runAccountSyncDetailed(temp.db, sync.id, deps(stubProvider([], seen)));
    expect(result.error).toMatch(/removed/);
    expect(seen).toEqual([]);
  });

  it("lets starred auto-removal touch only the sync owner's repos", async () => {
    const alicesAccount = account(alice, "alice-bot");
    const sync = insertAccountSync(temp.db, {
      ownerUserId: alice.id,
      forgeId,
      accountId: alicesAccount,
      source: "starred",
      namespace: null,
      visibility: "all",
      enabled: true,
      intervalMinutes: 60,
    });
    // A repo Bob owns that somehow carries Alice's sync link and the
    // account_sync origin: the worst case for a confused removal.
    const bobsRepo = repo(bob, "acme/bobs");
    temp.db.run(
      "UPDATE repos SET managed_by_account_sync_id = ?, origin = 'account_sync' WHERE id = ?",
      sync.id,
      bobsRepo,
    );
    const removed: number[] = [];
    const seen: DiscoveryContext[] = [];
    await runAccountSyncDetailed(temp.db, sync.id, {
      ...deps(stubProvider([listed("acme/other")], seen)),
      repos: {
        deleteRepo: (_db, id) => {
          removed.push(id);
          return Promise.resolve();
        },
      },
    });
    expect(removed).not.toContain(bobsRepo);
  });
});

describe("settings scopes", () => {
  it("guards repo and account scopes per object, reads included", async () => {
    const alicesRepo = repo(alice, "acme/a");
    temp.db.run("UPDATE repos SET is_private = 1 WHERE id = ?", alicesRepo);
    const alicesAccount = account(alice, "alice-bot");

    for (const [scope, id] of [
      ["repo", alicesRepo],
      ["account", alicesAccount],
    ] as const) {
      const read = await call(BOB, "GET", `/api/settings/${scope}/${String(id)}`);
      const readMissing = await call(BOB, "GET", `/api/settings/${scope}/${String(NONEXISTENT)}`);
      expect(read.statusCode, scope).toBe(404);
      expect(normalized(read.body, id)).toBe(normalized(readMissing.body, NONEXISTENT));
      const write = await call(BOB, "PUT", `/api/settings/${scope}/${String(id)}`, {
        clone_mode: "mirror",
      });
      expect(write.statusCode, scope).toBe(404);
      const own = await call(ALICE, "PUT", `/api/settings/${scope}/${String(id)}`, {
        clone_mode: "mirror",
      });
      expect(own.statusCode, scope).toBe(200);
    }
    const effective = await call(BOB, "GET", `/api/repos/${String(alicesRepo)}/effective-settings`);
    expect(effective.statusCode).toBe(404);

    // manage_forges may manage any account's settings.
    const byForger = await call(FORGER, "PUT", `/api/settings/account/${String(alicesAccount)}`, {
      clone_mode: "bare",
    });
    expect(byForger.statusCode).toBe(200);
  });

  it("lets modify_others write a visible repo's settings but not an invisible one's", async () => {
    makeUser(temp.db, BOB, { modify_others: true, import_private: true });
    const visible = repo(alice, "acme/pub");
    temp.db.run("UPDATE repos SET is_private = 0 WHERE id = ?", visible);
    const hidden = repo(alice, "acme/priv");
    const ok = await call(BOB, "PUT", `/api/settings/repo/${String(visible)}`, {
      clone_mode: "mirror",
    });
    expect(ok.statusCode).toBe(200);
    const refused = await call(BOB, "PUT", `/api/settings/repo/${String(hidden)}`, {
      clone_mode: "mirror",
    });
    expect(refused.statusCode).toBe(404);
  });
});
