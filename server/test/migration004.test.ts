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
let forgeId: number;
let accountId: number;

function insert(sql: string, ...params: (string | number | null)[]): number {
  return db.run(sql, ...params).lastInsertRowid;
}

/** Everything up to 003, plus an owned sync that manages one repo. */
function seedBefore004(): { syncId: number; managedRepoId: number; manualRepoId: number } {
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "004"),
  );
  forgeId = insert(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  );
  accountId = insert(
    "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, 'octocat', 1, 1, 1)",
    forgeId,
  );
  const syncId = insert(
    "INSERT INTO account_syncs (account_id, source, visibility, enabled, interval_minutes, next_run_at, repos_discovered, created_at, updated_at) VALUES (?, 'owned', 'public', 1, 90, 123, 7, 1, 2)",
    accountId,
  );
  const managedRepoId = insert(
    "INSERT INTO repos (forge_id, path, display_name, slug, short_id, managed_by_account_sync_id, origin, created_at, updated_at) VALUES (?, 'octocat/a', 'a', 'octocat-a-aaaaaaaa', 'aaaaaaaa', ?, 'account_sync', 1, 1)",
    forgeId,
    syncId,
  );
  const manualRepoId = insert(
    "INSERT INTO repos (forge_id, path, display_name, slug, short_id, created_at, updated_at) VALUES (?, 'octocat/b', 'b', 'octocat-b-bbbbbbbb', 'bbbbbbbb', 1, 1)",
    forgeId,
  );
  return { syncId, managedRepoId, manualRepoId };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig4-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("004_namespace_sync", () => {
  it("keeps every repo linked to the sync that manages it across the rebuild", () => {
    const seeded = seedBefore004();
    migrate(db, log);

    const managed = db.get<{ managed_by_account_sync_id: number | null }>(
      "SELECT managed_by_account_sync_id FROM repos WHERE id = ?",
      seeded.managedRepoId,
    );
    expect(managed?.managed_by_account_sync_id).toBe(seeded.syncId);
    const manual = db.get<{ managed_by_account_sync_id: number | null }>(
      "SELECT managed_by_account_sync_id FROM repos WHERE id = ?",
      seeded.manualRepoId,
    );
    expect(manual?.managed_by_account_sync_id).toBeNull();
  });

  it("carries every existing sync over with its id, forge and schedule", () => {
    const seeded = seedBefore004();
    migrate(db, log);

    const row = db.get<Record<string, unknown>>(
      "SELECT * FROM account_syncs WHERE id = ?",
      seeded.syncId,
    );
    expect(row).toMatchObject({
      forge_id: forgeId,
      account_id: accountId,
      source: "owned",
      namespace: null,
      visibility: "public",
      interval_minutes: 90,
      next_run_at: 123,
      repos_discovered: 7,
      created_at: 1,
      updated_at: 2,
    });
  });

  it("leaves no scratch tables behind and keeps the foreign keys consistent", () => {
    seedBefore004();
    migrate(db, log);

    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).not.toContain("account_syncs_004");
    expect(db.all("SELECT name FROM sqlite_temp_master WHERE type = 'table'")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("allows one namespace sync per forge and name, case-insensitively, with no account", () => {
    seedBefore004();
    migrate(db, log);

    const sql =
      "INSERT INTO account_syncs (forge_id, account_id, source, namespace, created_at, updated_at) VALUES (?, ?, 'namespace', ?, 1, 1)";
    insert(sql, forgeId, null, "nodejs");
    expect(() => insert(sql, forgeId, null, "NodeJS")).toThrow(/UNIQUE/);
    expect(() => insert(sql, forgeId, accountId, "nodejs")).toThrow(/UNIQUE/);
    expect(insert(sql, forgeId, accountId, "vuejs")).toBeGreaterThan(0);
  });

  it("still allows one owned and one starred sync per account, and no more", () => {
    seedBefore004();
    migrate(db, log);

    const sql =
      "INSERT INTO account_syncs (forge_id, account_id, source, created_at, updated_at) VALUES (?, ?, ?, 1, 1)";
    expect(() => insert(sql, forgeId, accountId, "owned")).toThrow(/UNIQUE/);
    expect(insert(sql, forgeId, accountId, "starred")).toBeGreaterThan(0);
    expect(() => insert(sql, forgeId, accountId, "starred")).toThrow(/UNIQUE/);
  });

  it("rejects a namespace on the wrong source and an accountless owned sync", () => {
    seedBefore004();
    migrate(db, log);

    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, account_id, source, namespace, created_at, updated_at) VALUES (?, ?, 'starred', 'nodejs', 1, 1)",
        forgeId,
        accountId,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, account_id, source, created_at, updated_at) VALUES (?, NULL, 'owned', 1, 1)",
        forgeId,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, account_id, source, created_at, updated_at) VALUES (?, NULL, 'namespace', 1, 1)",
        forgeId,
      ),
    ).toThrow(/CHECK/);
  });

  it("drops a forge's syncs with the forge", () => {
    seedBefore004();
    migrate(db, log);
    const other = insert(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'other.example.com', NULL, 'github', 1, 1)",
    );
    insert(
      "INSERT INTO account_syncs (forge_id, source, namespace, created_at, updated_at) VALUES (?, 'namespace', 'nodejs', 1, 1)",
      other,
    );
    db.run("DELETE FROM forges WHERE id = ?", other);
    expect(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM account_syncs WHERE forge_id = ?", other)?.n,
    ).toBe(0);
  });
});
