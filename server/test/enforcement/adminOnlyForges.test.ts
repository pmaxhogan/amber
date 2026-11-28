import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/domain/accounts.ts";
import { ADMIN_ONLY_FORGE_ERROR, HOST_NOT_ENABLED_MESSAGE } from "../../src/domain/forges.ts";
import { createRepo } from "../../src/domain/repos.ts";
import { getUser, type User } from "../../src/domain/users.ts";
import { commitImport } from "../../src/domain/importer.ts";
import { setDefaultResolver } from "../../src/security/egress.ts";
import { refuseAllDns } from "../helpers/egress.ts";
import { insertAccountSync, runAccountSyncDetailed } from "../../src/providers/discovery.ts";
import { resolveGoneOwners } from "../../src/providers/owners.ts";
import { lookupRepoInfo, resolvePendingForks } from "../../src/providers/forks.ts";
import type { AccountSyncProvider } from "../../src/providers/types.ts";
import { Scheduler } from "../../src/sync/scheduler.ts";
import { syncRepo } from "../../src/sync/syncRepo.ts";
import { asUser } from "../helpers/accessFixtures.ts";
import { createRecordingGit } from "../helpers/egress.ts";
import { fixedSettings, silentLog, tempDir } from "../helpers/gitFixtures.ts";
import { createTempApp, type TempApp } from "../helpers.ts";
import { adminOf, makeUser } from "../helpers/users.ts";

/**
 * An UNRESTRICTED forge (allow_private_network = 1) is the admin's own: Amber
 * fetches from its LAN position, so an anonymous clone there already reaches
 * internal services. Nobody else may own a repo, an account or an account
 * sync on one, and the sync refuses as defence in depth.
 */

const FRIEND = "friend@example.com";
const LAN_URL = "http://gitea.lan.example.com/admin/internal";

let temp: TempApp;
let friend: User;
let lanForge: number;

beforeEach(async () => {
  temp = await createTempApp({ INSECURE_USER_EMAILS: FRIEND });
  friend = makeUser(temp.db, FRIEND, { import_private: true, manage_forges: true });
  const now = Date.now();
  lanForge = temp.db.run(
    `INSERT INTO forges (protocol, host, port, kind, allow_private_network, created_at, updated_at)
     VALUES ('http', 'gitea.lan.example.com', NULL, 'gitea', 1, ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
});

afterEach(async () => {
  await temp.close();
});

function getUserOrThrow(id: number): User {
  const user = getUser(temp.db, id);
  if (user === undefined) {
    throw new Error("no user");
  }
  return user;
}

async function call(email: string | null, method: "GET" | "POST", url: string, payload?: object) {
  return temp.app.inject({
    method,
    url,
    headers: email === null ? {} : asUser(email),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

describe("an unrestricted forge is the admin's alone", () => {
  it("refuses a non-admin's import line exactly like an unknown host, preview and commit", async () => {
    const preview = await call(FRIEND, "POST", "/api/import/preview", { text: LAN_URL });
    expect(preview.json()).toMatchObject({
      results: [{ status: "error", code: "host_not_enabled" }],
    });
    const commit = await call(FRIEND, "POST", "/api/import", { text: LAN_URL });
    expect(commit.json()).toMatchObject({
      failed: 1,
      results: [{ action: "failed", code: "host_not_enabled" }],
    });
    // Same text a host Amber has never heard of gets (for a user who may not
    // add hosts): nothing says this one exists, or what it reaches.
    expect((commit.json() as { results: { message: string }[] }).results[0]?.message).toBe(
      HOST_NOT_ENABLED_MESSAGE,
    );
    expect(temp.db.get("SELECT COUNT(*) AS n FROM repos")).toEqual({ n: 0 });

    // The admin may.
    const asAdmin = await call(null, "POST", "/api/import", { text: LAN_URL });
    expect(asAdmin.json()).toMatchObject({ created: 1 });
  });

  it("refuses a non-admin's account and account sync on it", async () => {
    const account = await call(FRIEND, "POST", "/api/accounts", {
      forgeId: lanForge,
      username: "friend",
      secret: "token",
    });
    expect(account.statusCode).toBe(403);
    expect(account.json()).toMatchObject({ error: "host_not_enabled" });

    const sync = await call(FRIEND, "POST", "/api/account-syncs", {
      forgeId: lanForge,
      source: "namespace",
      namespace: "admin",
    });
    expect(sync.statusCode).toBe(403);
    expect(sync.json()).toMatchObject({ error: "host_not_enabled" });

    const asAdmin = await call(null, "POST", "/api/accounts", {
      forgeId: lanForge,
      username: "admin-bot",
      secret: "token",
    });
    expect(asAdmin.statusCode).toBe(201);
  });

  it("refuses at sync time for a non-admin owner, without touching git or the breaker", async () => {
    // A row that predates the rule, or a forge the admin flipped later.
    const repoId = createRepo(temp.db, {
      forgeId: lanForge,
      path: "admin/internal",
      ownerUserId: friend.id,
    }).id;
    const root = tempDir("admin-only-sync");
    const git = createRecordingGit(root);
    try {
      const run = await syncRepo({
        repoId,
        db: temp.db,
        backupsDir: join(root, "backups"),
        stateDir: join(root, "state"),
        logger: silentLog,
        settings: fixedSettings(),
        gitBinary: git.binary,
      });
      expect(run.outcome).toBe("error");
      expect(run.error).toBe(ADMIN_ONLY_FORGE_ERROR);
      // Not network or timeout, so the circuit breaker never sees it.
      expect(run.errorKind).toBe("other");
      expect(git.networkCalls()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an account sync run for a non-admin owner", async () => {
    const sync = insertAccountSync(temp.db, {
      ownerUserId: friend.id,
      forgeId: lanForge,
      accountId: null,
      source: "namespace",
      namespace: "admin",
      visibility: "all",
      enabled: true,
      intervalMinutes: 60,
    });
    const result = await runAccountSyncDetailed(temp.db, sync.id, {
      providerFor: () => {
        throw new Error("must not reach a provider");
      },
    });
    expect(result.error).toBe(ADMIN_ONLY_FORGE_ERROR);
  });

  it("hides a leftover non-admin repo there from everyone but the admin, its owner too", async () => {
    const repoId = createRepo(temp.db, {
      forgeId: lanForge,
      path: "admin/internal",
      ownerUserId: friend.id,
    }).id;
    makeUser(temp.db, FRIEND, { view_others_private: true, view_others_public: true });
    for (const url of [
      `/api/repos/${String(repoId)}`,
      `/api/repos/${String(repoId)}/runs`,
      `/api/repos/${String(repoId)}/browse/refs`,
      `/api/repos/${String(repoId)}/export/source.zip`,
    ]) {
      expect((await call(FRIEND, "GET", url)).statusCode, url).toBe(404);
    }
    const list = await call(FRIEND, "GET", "/api/repos?mine=true");
    expect((list.json() as { total: number }).total).toBe(0);
    const status = await call(FRIEND, "GET", "/api/status");
    expect(status.json()).toMatchObject({ totalRepos: 0 });

    // The admin still sees it, to adopt or delete it.
    expect((await call(null, "GET", `/api/repos/${String(repoId)}`)).statusCode).toBe(200);
  });

  it("never asks the forge API about a non-admin's repo there, in any background pass", async () => {
    const repoId = createRepo(temp.db, {
      forgeId: lanForge,
      path: "admin/internal",
      ownerUserId: friend.id,
    }).id;
    temp.db.run("UPDATE repos SET gone_at = 1 WHERE id = ?", repoId);
    const adminRepo = createRepo(temp.db, {
      forgeId: lanForge,
      path: "admin/own",
      ownerUserId: adminOf(temp.db).id,
    }).id;
    temp.db.run("UPDATE repos SET gone_at = 1 WHERE id = ?", adminRepo);
    const asked: string[] = [];
    const provider: AccountSyncProvider = {
      listOwned: () => Promise.reject(new Error("unused")),
      getRepoInfo: (_context: unknown, path: string) => {
        asked.push(`info:${path}`);
        return Promise.resolve({ fork: { status: "not_fork" }, isPrivate: false, sizeBytes: 1 });
      },
      checkOwner: (_context: unknown, owner: string) => {
        asked.push(`owner:${owner}`);
        return Promise.resolve({ status: "exists" });
      },
    } as unknown as AccountSyncProvider;
    const deps = { providerFor: () => provider };

    expect(await lookupRepoInfo(temp.db, repoId, deps)).toBeNull();
    await resolvePendingForks(temp.db, deps);
    await resolveGoneOwners(temp.db, deps);
    // Only the admin's repo was ever asked about.
    expect(asked.some((entry) => entry.includes("internal"))).toBe(false);
    expect(asked).toContain("info:admin/own");
    expect(
      temp.db.get("SELECT visibility_checked_at, owner_checked_at FROM repos WHERE id = ?", repoId),
    ).toEqual({ visibility_checked_at: null, owner_checked_at: null });
  });

  it("refuses in the scheduler before the size lookup, without a run", async () => {
    const repoId = createRepo(temp.db, {
      forgeId: lanForge,
      path: "admin/internal",
      ownerUserId: friend.id,
    }).id;
    temp.db.run("UPDATE repos SET next_sync_at = 0 WHERE id = ?", repoId);
    const root = tempDir("admin-only-scheduler");
    const looked: number[] = [];
    const ran: number[] = [];
    const scheduler = new Scheduler({
      db: temp.db,
      backupsDir: join(root, "backups"),
      stateDir: join(root, "state"),
      logger: silentLog,
      now: () => Date.now() + 60_000,
      random: () => 0.5,
      staggerStepMs: 0,
      refreshIntervalMs: 3_600_000,
      settings: fixedSettings({ min_free_disk_gb: 0 }),
      globalSettings: () => fixedSettings({ min_free_disk_gb: 0 })(temp.db, 0),
      repoInfo: (_db, id) => {
        looked.push(id);
        return Promise.resolve(null);
      },
      runSync: (syncDeps) => {
        ran.push(syncDeps.repoId);
        return Promise.reject(new Error("must not run"));
      },
      shutdownGraceMs: 50,
    });
    try {
      await scheduler.start();
      for (let i = 0; i < 200; i += 1) {
        const row = temp.db.get<{ last_error: string | null }>(
          "SELECT last_error FROM repos WHERE id = ?",
          repoId,
        );
        if (row?.last_error != null) {
          break;
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(temp.db.get("SELECT last_error FROM repos WHERE id = ?", repoId)).toEqual({
        last_error: ADMIN_ONLY_FORGE_ERROR,
      });
      expect(looked).toEqual([]);
      expect(ran).toEqual([]);
    } finally {
      await scheduler.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-checks inside the commit transaction (a forge made unrestricted mid-import)", async () => {
    // A NEW host is vetted (DNS) before the transaction. While that check
    // runs, the admin creates the same host as an unrestricted forge.
    setDefaultResolver((host) => {
      const now = Date.now();
      temp.db.run(
        `INSERT INTO forges (protocol, host, port, kind, allow_private_network, created_at, updated_at)
         VALUES ('https', ?, NULL, 'gitea', 1, ?, ?)`,
        host,
        now,
        now,
      );
      return Promise.resolve(["93.184.215.14"]);
    });
    try {
      const result = await commitImport(
        temp.db,
        getUserOrThrow(friend.id),
        "https://raced.example.com/a/b\nhttps://raced.example.com/c",
      );
      expect(result.created).toBe(0);
      expect(result.results.map((line) => line.code)).toEqual([
        "host_not_enabled",
        "host_not_enabled",
      ]);
      expect(temp.db.get("SELECT COUNT(*) AS n FROM repos")).toEqual({ n: 0 });
      expect(temp.db.get("SELECT COUNT(*) AS n FROM account_syncs")).toEqual({ n: 0 });
    } finally {
      setDefaultResolver(refuseAllDns);
    }
  });

  it("still lets the admin own and sync there", () => {
    const admin = adminOf(temp.db);
    expect(() =>
      createAccount(
        temp.db,
        temp.config.secretKey,
        { forgeId: lanForge, username: "ok", secret: "s", isDefault: true },
        admin.id,
      ),
    ).not.toThrow();
  });
});
