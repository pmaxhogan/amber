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

interface Seeded {
  ownedId: number;
  starredId: number;
  namespaceId: number;
  ownedRepoId: number;
  namespaceRepoId: number;
  manualRepoId: number;
}

/** Everything up to 005, with one sync of every pre-006 source managing repos. */
function seedBefore006(): Seeded {
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "006"),
  );
  forgeId = insert(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  );
  accountId = insert(
    "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, 'octocat', 1, 1, 1)",
    forgeId,
  );
  const syncSql =
    "INSERT INTO account_syncs (forge_id, account_id, source, namespace, visibility, enabled, interval_minutes, next_run_at, last_run_at, last_error, repos_discovered, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2)";
  const ownedId = insert(
    syncSql,
    forgeId,
    accountId,
    "owned",
    null,
    "public",
    1,
    90,
    123,
    100,
    null,
    7,
  );
  const starredId = insert(
    syncSql,
    forgeId,
    accountId,
    "starred",
    null,
    "all",
    0,
    360,
    null,
    50,
    "boom",
    3,
  );
  const namespaceId = insert(
    syncSql,
    forgeId,
    null,
    "namespace",
    "nodejs",
    "all",
    1,
    720,
    456,
    null,
    null,
    null,
  );
  const repoSql =
    "INSERT INTO repos (forge_id, path, display_name, slug, short_id, managed_by_account_sync_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)";
  const ownedRepoId = insert(
    repoSql,
    forgeId,
    "octocat/a",
    "a",
    "octocat-a-aaaaaaaa",
    "aaaaaaaa",
    ownedId,
    "account_sync",
  );
  const namespaceRepoId = insert(
    repoSql,
    forgeId,
    "nodejs/node",
    "node",
    "nodejs-node-cccccccc",
    "cccccccc",
    namespaceId,
    "account_sync",
  );
  const manualRepoId = insert(
    repoSql,
    forgeId,
    "octocat/b",
    "b",
    "octocat-b-bbbbbbbb",
    "bbbbbbbb",
    null,
    "manual",
  );
  return { ownedId, starredId, namespaceId, ownedRepoId, namespaceRepoId, manualRepoId };
}

function managedBy(repoId: number): number | null | undefined {
  return db.get<{ managed_by_account_sync_id: number | null }>(
    "SELECT managed_by_account_sync_id FROM repos WHERE id = ?",
    repoId,
  )?.managed_by_account_sync_id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig6-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("006_trending_sync", () => {
  it("keeps every repo linked to the sync that manages it across the rebuild", () => {
    const seeded = seedBefore006();
    migrate(db, log);

    expect(managedBy(seeded.ownedRepoId)).toBe(seeded.ownedId);
    expect(managedBy(seeded.namespaceRepoId)).toBe(seeded.namespaceId);
    expect(managedBy(seeded.manualRepoId)).toBeNull();
  });

  it("carries every existing sync over unchanged, with no trending fields", () => {
    const seeded = seedBefore006();
    const before = db.all<Record<string, unknown>>("SELECT * FROM account_syncs ORDER BY id");
    // Up to 006 only: the row shape is 006's, and later migrations add columns.
    migrate(
      db,
      log,
      migrations.filter((migration) => migration.name < "007"),
    );

    const after = db.all<Record<string, unknown>>("SELECT * FROM account_syncs ORDER BY id");
    expect(after).toHaveLength(3);
    expect(after).toEqual(before.map((row) => ({ ...row, top_n: null, window_days: null })));
    expect(after.map((row) => row.id)).toEqual([
      seeded.ownedId,
      seeded.starredId,
      seeded.namespaceId,
    ]);
  });

  it("does not reuse an id that a deleted sync once had", () => {
    const seeded = seedBefore006();
    db.run("DELETE FROM account_syncs WHERE id = ?", seeded.namespaceId);
    migrate(db, log);

    const next = insert(
      "INSERT INTO account_syncs (forge_id, source, top_n, window_days, created_at, updated_at) VALUES (?, 'trending', 10, 3, 1, 1)",
      forgeId,
    );
    expect(next).toBeGreaterThan(seeded.starredId);
  });

  it("leaves no scratch tables behind and keeps the foreign keys consistent", () => {
    seedBefore006();
    // Up to 006 only: the index list is 006's, and 010 adds an owner index.
    migrate(
      db,
      log,
      migrations.filter((migration) => migration.name < "007"),
    );

    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).not.toContain("account_syncs_006");
    expect(db.all("SELECT name FROM sqlite_temp_master WHERE type = 'table'")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    const indexes = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_syncs' AND name LIKE 'idx_%' ORDER BY name",
      )
      .map((row) => row.name);
    expect(indexes).toEqual([
      "idx_account_syncs_account",
      "idx_account_syncs_account_source",
      "idx_account_syncs_due",
      "idx_account_syncs_forge",
      "idx_account_syncs_namespace",
      "idx_account_syncs_trending",
    ]);
  });

  it("allows one trending sync per forge and window, with no account", () => {
    seedBefore006();
    migrate(db, log);

    const sql =
      "INSERT INTO account_syncs (forge_id, account_id, source, top_n, window_days, created_at, updated_at) VALUES (?, ?, 'trending', ?, ?, 1, 1)";
    expect(insert(sql, forgeId, null, 10, 3)).toBeGreaterThan(0);
    expect(insert(sql, forgeId, null, 10, 365)).toBeGreaterThan(0);
    expect(() => insert(sql, forgeId, null, 50, 3)).toThrow(/UNIQUE/);
    expect(() => insert(sql, forgeId, accountId, 10, 30)).toThrow(/CHECK/);
    expect(() => insert(sql, forgeId, null, null, 30)).toThrow(/CHECK/);
    expect(() => insert(sql, forgeId, null, 10, null)).toThrow(/CHECK/);
    expect(() => insert(sql, forgeId, null, 101, 30)).toThrow(/CHECK/);
    expect(() => insert(sql, forgeId, null, 0, 30)).toThrow(/CHECK/);
  });

  it("keeps the older constraints: trending knobs only on trending, accounts where required", () => {
    seedBefore006();
    migrate(db, log);

    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, account_id, source, top_n, window_days, created_at, updated_at) VALUES (?, ?, 'starred', 5, 3, 1, 1)",
        forgeId,
        accountId,
      ),
    ).toThrow(/CHECK|UNIQUE/);
    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, account_id, source, created_at, updated_at) VALUES (?, NULL, 'owned', 1, 1)",
        forgeId,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, account_id, source, created_at, updated_at) VALUES (?, ?, 'owned', 1, 1)",
        forgeId,
        accountId,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert(
        "INSERT INTO account_syncs (forge_id, source, namespace, created_at, updated_at) VALUES (?, 'namespace', 'NodeJS', 1, 1)",
        forgeId,
      ),
    ).toThrow(/UNIQUE/);
  });
});
