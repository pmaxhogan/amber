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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig5-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("005_last_seen", () => {
  it("backfills last seen from the last successful fetch", () => {
    migrate(
      db,
      log,
      migrations.filter((migration) => migration.name < "005"),
    );
    const forgeId = db.run(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
    ).lastInsertRowid;
    const sql =
      "INSERT INTO repos (forge_id, path, display_name, slug, short_id, last_success_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)";
    db.run(sql, forgeId, "octocat/a", "a", "octocat-a-aaaaaaaa", "aaaaaaaa", 4_000);
    db.run(sql, forgeId, "octocat/b", "b", "octocat-b-bbbbbbbb", "bbbbbbbb", null);

    migrate(db, log);

    const rows = db.all<{ path: string; last_seen_at: number | null }>(
      "SELECT path, last_seen_at FROM repos ORDER BY path",
    );
    expect(rows).toEqual([
      { path: "octocat/a", last_seen_at: 4_000 },
      { path: "octocat/b", last_seen_at: null },
    ]);
  });
});
