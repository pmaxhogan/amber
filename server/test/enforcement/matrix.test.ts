import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/domain/accounts.ts";
import { createRepo } from "../../src/domain/repos.ts";
import type { User } from "../../src/domain/users.ts";
import { insertAccountSync } from "../../src/providers/discovery.ts";
import {
  lookupRepoInfo,
  resolvePendingForks,
  type AnonymousBudget,
} from "../../src/providers/forks.ts";
import { resolveGoneOwners } from "../../src/providers/owners.ts";
import type { AccountSyncProvider, DiscoveryContext, RepoInfo } from "../../src/providers/types.ts";
import { syncRepo } from "../../src/sync/syncRepo.ts";
import { asUser } from "../helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "../helpers.ts";
import { createOrigin, fixedSettings, silentLog, tempDir } from "../helpers/gitFixtures.ts";
import { makeUser } from "../helpers/users.ts";

/**
 * The full identity matrix (admin, owner, a second default user, a user with
 * nothing, view_others_private, modify_others, manage_forges, and a removed
 * user) over every route group that is not repo-scoped, plus regression pins
 * for the fail-closed corners of the visibility and owner passes.
 */

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const NOTHING = "nothing@example.com";
const PRIV = "viewpriv@example.com";
const MOD = "modify@example.com";
const FORGER = "forger@example.com";
const GONE = "removed@example.com";

type Who = "admin" | "alice" | "bob" | "nothing" | "priv" | "mod" | "forger" | "removed";
const EMAIL: Record<Who, string | null> = {
  admin: null,
  alice: ALICE,
  bob: BOB,
  nothing: NOTHING,
  priv: PRIV,
  mod: MOD,
  forger: FORGER,
  removed: GONE,
};
const WHO = Object.keys(EMAIL) as Who[];

let temp: TempApp;
let alice: User;
let forgeId: number;
let alicesAccount: number;
let alicesSync: number;
let alicesPublicRepo: number;

async function call(
  who: Who,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  const email = EMAIL[who];
  return temp.app.inject({
    method,
    url,
    headers: email === null ? {} : asUser(email),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeEach(async () => {
  temp = await createTempApp({
    INSECURE_USER_EMAILS: [ALICE, BOB, NOTHING, PRIV, MOD, FORGER, GONE].join(","),
  });
  const db = temp.db;
  alice = makeUser(db, ALICE, { import_private: true });
  makeUser(db, BOB, { import_private: true });
  makeUser(db, NOTHING, {}, { nothing: true });
  makeUser(db, PRIV, { view_others_private: true });
  makeUser(db, MOD, { modify_others: true });
  makeUser(db, FORGER, { manage_forges: true });
  makeUser(db, GONE, { manage_forges: true, import_private: true }, { removed: true });
  forgeId = seedForge(db);
  alicesAccount = createAccount(
    db,
    temp.config.secretKey,
    { forgeId, username: "alice-bot", secret: "a", isDefault: true },
    alice.id,
  ).id;
  alicesSync = insertAccountSync(db, {
    ownerUserId: alice.id,
    forgeId,
    accountId: alicesAccount,
    source: "owned",
    namespace: null,
    visibility: "all",
    enabled: false,
    intervalMinutes: 60,
  }).id;
  alicesPublicRepo = createRepo(db, { forgeId, path: "alice/public", ownerUserId: alice.id }).id;
  db.run("UPDATE repos SET is_private = 0 WHERE id = ?", alicesPublicRepo);
});

afterEach(async () => {
  await temp.close();
});

/**
 * Expected status per identity for one operation on ALICE'S objects. 404 is
 * "cannot see it"; 403 is a coarse permission or "may see, may not change".
 */
const MATRIX: {
  name: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: () => string;
  payload?: (who: Who) => unknown;
  expect: Record<Who, number>;
}[] = [
  {
    name: "read Alice's account",
    method: "GET",
    url: () => `/api/accounts/${String(alicesAccount)}`,
    expect: {
      admin: 200,
      alice: 200,
      bob: 404,
      nothing: 404,
      priv: 404,
      mod: 404,
      forger: 200,
      removed: 403,
    },
  },
  {
    name: "rename Alice's account",
    method: "PATCH",
    url: () => `/api/accounts/${String(alicesAccount)}`,
    payload: (who) => ({ username: `renamed-by-${who}` }),
    expect: {
      // Not the admin either: an account belongs to its owner.
      admin: 403,
      alice: 200,
      bob: 404,
      // No import_private: refused before the object is looked at.
      nothing: 403,
      priv: 403,
      mod: 403,
      forger: 403,
      removed: 403,
    },
  },
  {
    name: "edit Alice's account sync",
    method: "PATCH",
    url: () => `/api/account-syncs/${String(alicesSync)}`,
    payload: () => ({ intervalMinutes: 90 }),
    expect: {
      admin: 200,
      alice: 200,
      bob: 404,
      nothing: 404,
      priv: 404,
      mod: 404,
      forger: 404,
      removed: 403,
    },
  },
  {
    name: "read Alice's account settings",
    method: "GET",
    url: () => `/api/settings/account/${String(alicesAccount)}`,
    expect: {
      admin: 200,
      alice: 200,
      bob: 404,
      nothing: 404,
      priv: 404,
      mod: 404,
      forger: 200,
      removed: 403,
    },
  },
  {
    name: "write Alice's public repo's settings",
    method: "PUT",
    url: () => `/api/settings/repo/${String(alicesPublicRepo)}`,
    payload: () => ({ clone_mode: "mirror" }),
    expect: {
      admin: 200,
      alice: 200,
      bob: 403,
      // view_others_public is off: cannot even see it.
      nothing: 404,
      priv: 403,
      mod: 200,
      forger: 403,
      removed: 403,
    },
  },
  {
    name: "read Alice's public repo's effective settings",
    method: "GET",
    url: () => `/api/repos/${String(alicesPublicRepo)}/effective-settings`,
    expect: {
      admin: 200,
      alice: 200,
      bob: 200,
      nothing: 404,
      priv: 200,
      mod: 200,
      forger: 200,
      removed: 403,
    },
  },
  {
    name: "import a new repository on a known host",
    method: "POST",
    url: () => "/api/import",
    payload: (who) => ({ text: `https://github.com/acme/by-${who}` }),
    expect: {
      admin: 200,
      alice: 200,
      bob: 200,
      nothing: 403,
      priv: 200,
      mod: 200,
      forger: 200,
      removed: 403,
    },
  },
  {
    name: "create a forge",
    method: "POST",
    url: () => "/api/forges",
    payload: (who) => ({ protocol: "https", host: `${who}.example.com` }),
    expect: {
      admin: 201,
      alice: 403,
      bob: 403,
      nothing: 403,
      priv: 403,
      mod: 403,
      forger: 201,
      removed: 403,
    },
  },
  {
    name: "write global settings",
    method: "PUT",
    url: () => "/api/settings/global",
    payload: () => ({ sync_interval_minutes: 240 }),
    expect: {
      admin: 200,
      alice: 403,
      bob: 403,
      nothing: 403,
      priv: 403,
      mod: 403,
      forger: 403,
      removed: 403,
    },
  },
];

describe("the identity matrix", () => {
  for (const row of MATRIX) {
    it.each(WHO)(`${row.name}: %s`, async (who) => {
      const response = await call(who, row.method, row.url(), row.payload?.(who));
      expect(response.statusCode, response.body).toBe(row.expect[who]);
    });
  }

  it.each(WHO)("deleting Alice's account: %s", async (who) => {
    const expected: Record<Who, number> = {
      admin: 204,
      alice: 204,
      bob: 404,
      nothing: 404,
      priv: 404,
      mod: 404,
      forger: 204,
      removed: 403,
    };
    const response = await call(who, "DELETE", `/api/accounts/${String(alicesAccount)}`);
    expect(response.statusCode).toBe(expected[who]);
  });

  it.each(WHO)("listing account syncs: %s sees only what is theirs", async (who) => {
    const response = await call(who, "GET", "/api/account-syncs");
    if (who === "removed") {
      expect(response.statusCode).toBe(403);
      return;
    }
    const ids = response.json<{ rows: { id: number }[] }>().rows.map((row) => row.id);
    expect(ids).toEqual(who === "admin" || who === "alice" ? [alicesSync] : []);
  });
});

describe("fail-closed corners", () => {
  function stub(info: RepoInfo, seen: DiscoveryContext[]): AccountSyncProvider {
    return {
      kind: "github",
      async *listRepos() {
        // Not used by these passes.
      },
      getRepoInfo: (context) => {
        seen.push(context);
        return Promise.resolve(info);
      },
      checkOwner: (context) => {
        seen.push(context);
        return Promise.resolve({ status: "exists" });
      },
    };
  }

  const deps = (provider: AccountSyncProvider, extra: object = {}) => ({
    secretKey: temp.config.secretKey,
    providerFor: () => provider,
    decryptSecret: () => "token",
    cooldowns: new Map<string, number>(),
    anonymousBudget: new Map<number, AnonymousBudget>(),
    ...extra,
  });

  it("puts a public row back to private on a definitive not-visible answer", async () => {
    const seen: DiscoveryContext[] = [];
    await resolvePendingForks(
      temp.db,
      deps(
        // What the providers report for a 404 or a non-rate-limit 403.
        stub(
          { fork: { status: "unknown", rateLimited: false }, isPrivate: true, sizeBytes: null },
          seen,
        ),
      ),
    );
    expect(seen).toHaveLength(1);
    expect(temp.db.get("SELECT is_private AS p FROM repos WHERE id = ?", alicesPublicRepo)).toEqual(
      { p: 1 },
    );
  });

  it("leaves the flag alone on a non-answer (rate limit, network, 5xx)", async () => {
    makeUser(temp.db, ALICE, { import_private: false });
    const seen: DiscoveryContext[] = [];
    await resolvePendingForks(
      temp.db,
      deps(
        stub(
          { fork: { status: "unknown", rateLimited: false }, isPrivate: null, sizeBytes: null },
          seen,
        ),
      ),
    );
    expect(seen[0]?.token).toBeNull();
    expect(temp.db.get("SELECT is_private AS p FROM repos WHERE id = ?", alicesPublicRepo)).toEqual(
      { p: 0 },
    );
  });

  it("makes the cap gate's lookup spend the same anonymous budget as the pass", async () => {
    makeUser(temp.db, ALICE, { import_private: false });
    const seen: DiscoveryContext[] = [];
    const provider = stub({ fork: { status: "not_fork" }, isPrivate: false, sizeBytes: 10 }, seen);
    const budget = new Map<number, AnonymousBudget>([
      [forgeId, { windowStart: Date.now(), used: 30 }],
    ]);
    const info = await lookupRepoInfo(
      temp.db,
      alicesPublicRepo,
      deps(provider, { anonymousBudget: budget }),
    );
    expect(info).toBeNull();
    expect(seen).toEqual([]);
  });

  it("never lets one credential's owner lookup answer for rows another credential asks about", async () => {
    const bob = makeUser(temp.db, BOB, { import_private: true });
    createAccount(
      temp.db,
      temp.config.secretKey,
      { forgeId, username: "bob-bot", secret: "b", isDefault: true },
      bob.id,
    );
    const alicesGone = createRepo(temp.db, { forgeId, path: "acme/one", ownerUserId: alice.id }).id;
    const bobsGone = createRepo(temp.db, { forgeId, path: "acme/two", ownerUserId: bob.id }).id;
    temp.db.run("UPDATE repos SET gone_at = 1 WHERE id IN (?, ?)", alicesGone, bobsGone);
    const seen: DiscoveryContext[] = [];
    await resolveGoneOwners(temp.db, {
      secretKey: temp.config.secretKey,
      providerFor: () =>
        stub({ fork: { status: "not_fork" }, isPrivate: null, sizeBytes: null }, seen),
      decryptSecret: () => "token",
    });
    // One lookup per credential, not one per owner name.
    expect(seen.map((context) => context.username).sort()).toEqual(["alice-bot", "bob-bot"]);
  });

  it("does not let a fetch that started before a rename mark the renamed row public", async () => {
    const root = tempDir("rename-race");
    try {
      const origin = await createOrigin(join(root, "origin"));
      await origin.commitFile("README.md", "hello\n", "initial commit");
      temp.db.run("UPDATE repos SET is_private = 1 WHERE id = ?", alicesPublicRepo);
      let renamed = false;
      const run = await syncRepo({
        repoId: alicesPublicRepo,
        db: temp.db,
        backupsDir: join(root, "backups"),
        stateDir: join(root, "state"),
        logger: silentLog,
        settings: fixedSettings(),
        remoteUrl: origin.url,
        allowFileProtocol: true,
        // Anonymous, and the rename lands while the fetch is in flight.
        credentials: () => {
          temp.db.run("UPDATE repos SET path = 'alice/renamed' WHERE id = ?", alicesPublicRepo);
          renamed = true;
          return undefined;
        },
      });
      expect(run.outcome).toBe("success");
      expect(renamed).toBe(true);
      expect(
        temp.db.get("SELECT is_private AS p FROM repos WHERE id = ?", alicesPublicRepo),
      ).toEqual({ p: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does mark the row public when the anonymous fetch was of the same path", async () => {
    const root = tempDir("no-rename");
    try {
      const origin = await createOrigin(join(root, "origin"));
      await origin.commitFile("README.md", "hello\n", "initial commit");
      temp.db.run("UPDATE repos SET is_private = 1 WHERE id = ?", alicesPublicRepo);
      const run = await syncRepo({
        repoId: alicesPublicRepo,
        db: temp.db,
        backupsDir: join(root, "backups"),
        stateDir: join(root, "state"),
        logger: silentLog,
        settings: fixedSettings(),
        remoteUrl: origin.url,
        allowFileProtocol: true,
        credentials: () => undefined,
      });
      expect(run.outcome).toBe("success");
      expect(
        temp.db.get("SELECT is_private AS p FROM repos WHERE id = ?", alicesPublicRepo),
      ).toEqual({ p: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
