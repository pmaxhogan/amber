import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations.ts";
import { createConsoleLogger } from "../src/logging.ts";

const log = createConsoleLogger("silent");
const TABLES = ["forges", "users", "repos", "sync_runs"] as const;

let dir: string;
let db: Db;
let repoIds: number[];
let runIds: number[];

/** A populated instance at schema 010: repos with history, one gone. */
function seedAt010(): void {
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "011"),
  );
  const forgeId = db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  ).lastInsertRowid;
  const repoSql = `INSERT INTO repos (forge_id, path, display_name, slug, short_id, gone_at,
      disk_usage_bytes, is_private, owner_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE is_admin = 1), 1, 2)`;
  repoIds = [
    db.run(repoSql, forgeId, "a/live", "live", "a-live", "idlive01", null, 1000, 0).lastInsertRowid,
    db.run(repoSql, forgeId, "a/gone", "gone", "a-gone", "idgone01", 900, 2000, 1).lastInsertRowid,
  ];
  const runSql = `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, error,
      error_kind, bytes_fetched, duration_ms, refs_changed, paranoid_archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 10, 20, 1, 0, 1, 1)`;
  runIds = [
    db.run(runSql, repoIds[0]!, 100, 110, "success", null, null).lastInsertRowid,
    db.run(runSql, repoIds[1]!, 200, 210, "error", "not found", "not_found").lastInsertRowid,
  ];
}

function snapshot(): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`),
    ]),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig11-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("011_stars", () => {
  it("loses nothing: every pre-existing row and column survives unchanged", () => {
    seedAt010();
    const before = snapshot();
    migrate(db, log);
    const after = snapshot();
    for (const table of TABLES) {
      expect(after[table], table).toHaveLength(before[table]!.length);
      after[table]!.forEach((row, index) => {
        const old = before[table]![index]!;
        expect(Object.fromEntries(Object.keys(old).map((key) => [key, row[key]])), table).toEqual(
          old,
        );
      });
    }
  });

  it("adds the columns as unknown, with no backfill", () => {
    seedAt010();
    migrate(db, log);
    expect(db.all("SELECT stars, stars_checked_at FROM repos ORDER BY id")).toEqual([
      { stars: null, stars_checked_at: null },
      { stars: null, stars_checked_at: null },
    ]);
    expect(db.all("SELECT stars FROM sync_runs ORDER BY id")).toEqual([
      { stars: null },
      { stars: null },
    ]);
  });

  it("accepts a count and refuses a negative one", () => {
    seedAt010();
    migrate(db, log);
    db.run("UPDATE repos SET stars = 12, stars_checked_at = 5 WHERE id = ?", repoIds[0]!);
    db.run("UPDATE sync_runs SET stars = 0 WHERE id = ?", runIds[0]!);
    expect(db.get("SELECT stars FROM repos WHERE id = ?", repoIds[0]!)).toEqual({ stars: 12 });
    expect(() => db.run("UPDATE repos SET stars = -1 WHERE id = ?", repoIds[0]!)).toThrow();
    expect(() => db.run("UPDATE sync_runs SET stars = -1 WHERE id = ?", runIds[0]!)).toThrow();
  });

  it("rebuilds no table: deleting a repo still cascades to its runs", () => {
    seedAt010();
    migrate(db, log);
    db.run("UPDATE sync_runs SET stars = 3 WHERE id = ?", runIds[1]!);
    db.run("DELETE FROM repos WHERE id = ?", repoIds[1]!);
    expect(db.all("SELECT id, stars FROM sync_runs ORDER BY id")).toEqual([
      { id: runIds[0]!, stars: null },
    ]);
  });
});
