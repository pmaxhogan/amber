import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/domain/accounts.ts";
import { ADMIN_ONLY_FORGE_ERROR, HOST_NOT_ENABLED_MESSAGE } from "../../src/domain/forges.ts";
import { createRepo } from "../../src/domain/repos.ts";
import type { User } from "../../src/domain/users.ts";
import { insertAccountSync, runAccountSyncDetailed } from "../../src/providers/discovery.ts";
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
