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
let repoId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig9-"));
  db = openDb(join(dir, "state", "amber.db"));
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "009"),
  );
  const forgeId = db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  ).lastInsertRowid;
  repoId = db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, gone_at, created_at, updated_at)
     VALUES (?, 'a/gone', 'gone', 'a-gone', 'idgone01', 900, 1, 1)`,
    forgeId,
  ).lastInsertRowid;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("009_owner_gone", () => {
  it("leaves existing repos with no answer, even the ones already gone", () => {
    migrate(db, log);

    expect(
      db.get("SELECT owner_gone, owner_checked_at, gone_at FROM repos WHERE id = ?", repoId),
    ).toEqual({ owner_gone: null, owner_checked_at: null, gone_at: 900 });
  });

  it("accepts NULL, 0 and 1 for owner_gone and nothing else", () => {
    migrate(db, log);

    for (const value of [0, 1, null]) {
      db.run("UPDATE repos SET owner_gone = ? WHERE id = ?", value, repoId);
      expect(
        db.get<{ owner_gone: number | null }>("SELECT owner_gone FROM repos WHERE id = ?", repoId)
          ?.owner_gone,
      ).toBe(value);
    }
    expect(() => db.run("UPDATE repos SET owner_gone = 2 WHERE id = ?", repoId)).toThrow(/CHECK/);
  });
});
