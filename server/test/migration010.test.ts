import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations.ts";
import { createConsoleLogger } from "../src/logging.ts";

const log = createConsoleLogger("silent");

let dir: string;
let db: Db;

function insert(sql: string, ...params: (string | number | null)[]): number {
  return db.run(sql, ...params).lastInsertRowid;
}

interface Seeded {
  forgeId: number;
  otherForgeId: number;
  defaultAccountId: number;
  secondAccountId: number;
  ownedSyncId: number;
  starredSyncId: number;
  namespaceSyncId: number;
  trendingSyncId: number;
  managedRepoId: number;
  overrideRepoId: number;
  manualRepoId: number;
  pushId: number;
}

/** A populated instance at schema 009: one of everything migration 010 touches. */
function seedAt009(): Seeded {
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "010"),
  );
  const forgeId = insert(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  );
  const otherForgeId = insert(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('http', 'git.example.net', 8080, 'gitea', 1, 1)",
  );
  const defaultAccountId = insert(
    "INSERT INTO accounts (forge_id, username, secret_enc, is_default, created_at, updated_at) VALUES (?, 'octocat', X'0102', 1, 1, 1)",
    forgeId,
  );
  const secondAccountId = insert(
    "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, 'hubot', 0, 1, 1)",
    forgeId,
  );
  const syncSql =
    "INSERT INTO account_syncs (forge_id, account_id, source, namespace, top_n, window_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 2)";
  const ownedSyncId = insert(syncSql, forgeId, defaultAccountId, "owned", null, null, null);
  const starredSyncId = insert(syncSql, forgeId, defaultAccountId, "starred", null, null, null);
  const namespaceSyncId = insert(syncSql, forgeId, null, "namespace", "NodeJS", null, null);
  const trendingSyncId = insert(syncSql, forgeId, null, "trending", null, 25, 3);

  const repoSql =
    "INSERT INTO repos (forge_id, path, display_name, slug, short_id, managed_by_account_sync_id, account_override_id, origin, disk_usage_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)";
  const managedRepoId = insert(
    repoSql,
    forgeId,
    "octocat/a",
    "a",
    "octocat-a-aaaaaaaa",
    "aaaaaaaa",
    ownedSyncId,
    null,
    "account_sync",
    1000,
  );
  const overrideRepoId = insert(
    repoSql,
    forgeId,
    "octocat/b",
    "b",
    "octocat-b-bbbbbbbb",
    "bbbbbbbb",
    null,
    secondAccountId,
    "manual",
    2000,
  );
  const manualRepoId = insert(
    repoSql,
    otherForgeId,
    "team/c",
    "c",
    "team-c-cccccccc",
    "cccccccc",
    null,
    null,
    "manual",
    null,
  );
  insert(
    "INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, created_at, updated_at) VALUES (?, 5, 6, 'success', 5, 6)",
    managedRepoId,
  );
  insert(
    "INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at) VALUES ('repo', ?, 'paranoid', 'true', 1, 1)",
    manualRepoId,
  );
  const pushId = insert(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at) VALUES ('https://push.example.com/abc', 'p', 'a', 1, 1)",
  );
  for (const [key, value] of [
    ["git_remote.enabled", "true"],
    ["git_remote.username", "amber"],
    ["git_remote.password_hash", "scrypt$fake"],
    ["git_remote.rotated_at", "123"],
    ["push.vapid", "{}"],
  ] as const) {
    insert("INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, ?, 1, 1)", key, value);
  }
  return {
    forgeId,
    otherForgeId,
    defaultAccountId,
    secondAccountId,
    ownedSyncId,
    starredSyncId,
    namespaceSyncId,
    trendingSyncId,
    managedRepoId,
    overrideRepoId,
    manualRepoId,
    pushId,
  };
}

const TABLES = [
  "forges",
  "accounts",
  "account_syncs",
  "repos",
  "sync_runs",
  "settings",
  "push_subscriptions",
] as const;

function snapshot(): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) {
    out[table] = db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return out;
}

function adminId(): number {
  const row = db.get<{ id: number }>("SELECT id FROM users WHERE is_admin = 1");
  if (row === undefined) {
    throw new Error("no admin row");
  }
  return row.id;
}

function addUser(email: string): number {
  return insert(
    "INSERT INTO users (email, is_admin, permissions, created_at, updated_at) VALUES (?, 0, '{}', 1, 1)",
    email,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig10-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("010_users", () => {
  it("loses nothing: every pre-existing row and column survives unchanged", () => {
    seedAt009();
    const before = snapshot();
    migrate(db, log);
    const after = snapshot();

    for (const table of TABLES) {
      expect(after[table], table).toHaveLength(before[table]!.length);
      after[table]!.forEach((row, index) => {
        const old = before[table]![index]!;
        // Every old column keeps its value; only the new ones are added.
        expect(Object.fromEntries(Object.keys(old).map((key) => [key, row[key]])), table).toEqual(
          old,
        );
      });
    }
  });

  it("creates exactly one admin row, with a placeholder address boot replaces", () => {
    seedAt009();
    migrate(db, log);

    expect(db.all("SELECT email, is_admin, permissions, removed_at FROM users")).toEqual([
      { email: "admin@amber.invalid", is_admin: 1, permissions: "{}", removed_at: null },
    ]);
  });

  it("assigns every existing repo, account, sync and push subscription to the admin", () => {
    seedAt009();
    migrate(db, log);
    const admin = adminId();

    for (const [table, column] of [
      ["repos", "owner_user_id"],
      ["accounts", "owner_user_id"],
      ["account_syncs", "owner_user_id"],
      ["push_subscriptions", "user_id"],
    ] as const) {
      const owners = db.all<{ owner: number | null }>(`SELECT ${column} AS owner FROM ${table}`);
      expect(owners.length, table).toBeGreaterThan(0);
      expect(
        owners.every((row) => row.owner === admin),
        table,
      ).toBe(true);
    }
  });

  it("starts every repo private and unchecked, so the upgrade exposes nothing", () => {
    seedAt009();
    migrate(db, log);

    const rows = db.all<{ is_private: number; visibility_checked_at: number | null }>(
      "SELECT is_private, visibility_checked_at FROM repos",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.is_private === 1 && row.visibility_checked_at === null)).toBe(
      true,
    );
  });

  it("backfills existing forges to allow private networks, and restricts new ones", () => {
    const seeded = seedAt009();
    migrate(db, log);

    const existing = db.all<{ allow_private_network: number }>(
      "SELECT allow_private_network FROM forges",
    );
    // The two seeded by 003 plus the two above.
    expect(existing).toHaveLength(4);
    expect(existing.every((row) => row.allow_private_network === 1)).toBe(true);

    const fresh = insert(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'new.example.org', NULL, 'generic', 1, 1)",
    );
    expect(db.get("SELECT allow_private_network FROM forges WHERE id = ?", fresh)).toEqual({
      allow_private_network: 0,
    });
    expect(seeded.otherForgeId).toBeGreaterThan(0);
    expect(() => db.run("UPDATE forges SET allow_private_network = 2 WHERE id = ?", fresh)).toThrow(
      /CHECK/,
    );
  });

  it("deletes the instance-wide git credential and keeps the kill switch", () => {
    seedAt009();
    migrate(db, log);

    expect(db.all("SELECT key, value FROM kv ORDER BY key")).toEqual([
      { key: "git_remote.enabled", value: "true" },
      { key: "push.vapid", value: "{}" },
    ]);
  });

  it("rebuilds no table: sync links, overrides and cascades are all intact", () => {
    const seeded = seedAt009();
    migrate(db, log);

    expect(
      db.get("SELECT managed_by_account_sync_id FROM repos WHERE id = ?", seeded.managedRepoId),
    ).toEqual({ managed_by_account_sync_id: seeded.ownedSyncId });
    expect(
      db.get("SELECT account_override_id FROM repos WHERE id = ?", seeded.overrideRepoId),
    ).toEqual({ account_override_id: seeded.secondAccountId });
    expect(db.get("SELECT COUNT(*) AS n FROM account_syncs")).toEqual({ n: 4 });
    expect(db.get("SELECT COUNT(*) AS n FROM sync_runs")).toEqual({ n: 1 });
    // No scratch tables, every foreign key holds, and the file is sound.
    expect(db.all("SELECT name FROM sqlite_temp_master WHERE type = 'table'")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("swaps the default-account and sync indexes for per-owner ones", () => {
    seedAt009();
    migrate(db, log);

    const indexes = db
      .all<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
      )
      .reduce<Record<string, string>>((out, row) => ({ ...out, [row.name]: row.sql }), {});
    expect(indexes["idx_accounts_one_default_per_forge"]).toBeUndefined();
    expect(indexes["idx_accounts_one_default_per_owner_forge"]).toContain(
      "(owner_user_id, forge_id) WHERE is_default = 1",
    );
    expect(indexes["idx_account_syncs_account_source"]).toContain(
      "(owner_user_id, account_id, source)",
    );
    expect(indexes["idx_account_syncs_namespace"]).toContain(
      "(owner_user_id, forge_id, namespace COLLATE NOCASE)",
    );
    // Trending is instance-level and stays per forge and window.
    expect(indexes["idx_account_syncs_trending"]).toContain("(forge_id, window_days)");
    expect(indexes["idx_account_syncs_trending"]).not.toContain("owner_user_id");
  });
});

describe("010_users constraints", () => {
  it("allows one default account per owner and forge, not per forge", () => {
    const seeded = seedAt009();
    migrate(db, log);
    const friend = addUser("friend@example.com");

    const sql =
      "INSERT INTO accounts (forge_id, username, is_default, owner_user_id, created_at, updated_at) VALUES (?, ?, 1, ?, 1, 1)";
    // The admin already has a default on this forge.
    expect(() => insert(sql, seeded.forgeId, "third", adminId())).toThrow(/UNIQUE/);
    // An insert that names no owner is the admin's, and is refused the same way.
    expect(() =>
      insert(
        "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, 'fourth', 1, 1, 1)",
        seeded.forgeId,
      ),
    ).toThrow(/UNIQUE/);
    expect(insert(sql, seeded.forgeId, "friendly", friend)).toBeGreaterThan(0);
    expect(() => insert(sql, seeded.forgeId, "friendlier", friend)).toThrow(/UNIQUE/);
  });

  it("keeps one owned and one starred sync per account, and namespaces per owner", () => {
    const seeded = seedAt009();
    migrate(db, log);
    const friend = addUser("friend@example.com");

    const sql =
      "INSERT INTO account_syncs (forge_id, account_id, source, namespace, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)";
    expect(() => insert(sql, seeded.forgeId, seeded.defaultAccountId, "owned", null, null)).toThrow(
      /UNIQUE/,
    );
    // The same name, any case, is a duplicate for the same owner...
    expect(() => insert(sql, seeded.forgeId, null, "namespace", "nodejs", null)).toThrow(/UNIQUE/);
    // ...and allowed for another owner.
    expect(insert(sql, seeded.forgeId, null, "namespace", "nodejs", friend)).toBeGreaterThan(0);
    expect(() => insert(sql, seeded.forgeId, null, "namespace", "NODEJS", friend)).toThrow(
      /UNIQUE/,
    );
  });

  it("keeps trending per forge and window whoever creates it", () => {
    const seeded = seedAt009();
    migrate(db, log);
    const friend = addUser("friend@example.com");

    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, source, top_n, window_days, owner_user_id, created_at, updated_at) VALUES (?, 'trending', 10, 3, ?, 1, 1)",
        seeded.forgeId,
        friend,
      ),
    ).toThrow(/UNIQUE/);
  });

  it("fills a missing owner with the admin and never lets one be cleared", () => {
    const seeded = seedAt009();
    migrate(db, log);
    const friend = addUser("friend@example.com");

    const repoId = insert(
      "INSERT INTO repos (forge_id, path, display_name, slug, short_id, created_at, updated_at) VALUES (?, 'x/new', 'new', 'x-new-dddddddd', 'dddddddd', 1, 1)",
      seeded.forgeId,
    );
    expect(db.get("SELECT owner_user_id FROM repos WHERE id = ?", repoId)).toEqual({
      owner_user_id: adminId(),
    });

    const ownedId = insert(
      "INSERT INTO repos (forge_id, path, display_name, slug, short_id, owner_user_id, created_at, updated_at) VALUES (?, 'x/mine', 'mine', 'x-mine-eeeeeeee', 'eeeeeeee', ?, 1, 1)",
      seeded.forgeId,
      friend,
    );
    expect(db.get("SELECT owner_user_id FROM repos WHERE id = ?", ownedId)).toEqual({
      owner_user_id: friend,
    });

    for (const [table, column] of [
      ["repos", "owner_user_id"],
      ["accounts", "owner_user_id"],
      ["account_syncs", "owner_user_id"],
      ["push_subscriptions", "user_id"],
    ] as const) {
      expect(() => db.run(`UPDATE ${table} SET ${column} = NULL`), table).toThrow(/cannot be NULL/);
    }
    const pushId = insert(
      "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at) VALUES ('https://push.example.com/new', 'p', 'a', 1, 1)",
    );
    expect(db.get("SELECT user_id FROM push_subscriptions WHERE id = ?", pushId)).toEqual({
      user_id: adminId(),
    });
  });

  it("refuses an owner that is not a user, and deleting a user who owns something", () => {
    const seeded = seedAt009();
    migrate(db, log);
    const friend = addUser("friend@example.com");

    expect(() =>
      db.run("UPDATE repos SET owner_user_id = 9999 WHERE id = ?", seeded.manualRepoId),
    ).toThrow(/FOREIGN KEY/);
    db.run("UPDATE repos SET owner_user_id = ? WHERE id = ?", friend, seeded.manualRepoId);
    expect(() => db.run("DELETE FROM users WHERE id = ?", friend)).toThrow(/FOREIGN KEY/);
  });

  it("holds exactly one admin, never removed, with lower case unique addresses", () => {
    seedAt009();
    migrate(db, log);

    expect(() =>
      insert(
        "INSERT INTO users (email, is_admin, created_at, updated_at) VALUES ('second@example.com', 1, 1, 1)",
      ),
    ).toThrow(/UNIQUE/);
    expect(() => db.run("UPDATE users SET removed_at = 5 WHERE is_admin = 1")).toThrow(/CHECK/);
    expect(() => addUser("Mixed@Example.com")).toThrow(/CHECK/);
    addUser("friend@example.com");
    expect(() => addUser("friend@example.com")).toThrow(/UNIQUE/);
    expect(() =>
      insert(
        "INSERT INTO users (email, permissions, created_at, updated_at) VALUES ('json@example.com', 'not json', 1, 1)",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      insert(
        "INSERT INTO users (email, git_username, created_at, updated_at) VALUES ('a@example.com', 'slug', 1, 1)",
      ),
    ).not.toThrow();
    expect(() =>
      insert(
        "INSERT INTO users (email, git_username, created_at, updated_at) VALUES ('b@example.com', 'slug', 1, 1)",
      ),
    ).toThrow(/UNIQUE/);
  });

  it("applies cleanly to a fresh database too", () => {
    migrate(db, log);
    expect(db.get("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1")).toEqual({ n: 1 });
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
