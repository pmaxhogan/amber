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

function seed(path: string): number {
  return db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
    forgeId,
    path,
    path,
    `slug-${path.replace("/", "-")}`,
    `id-${path.replace("/", "-")}`,
  ).lastInsertRowid;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig8-"));
  db = openDb(join(dir, "state", "amber.db"));
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "008"),
  );
  forgeId = db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  ).lastInsertRowid;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("008_fork_parent", () => {
  it("leaves every existing repo with no answer and nothing to retry", () => {
    const id = seed("a/one");

    migrate(db, log);

    expect(
      db.get("SELECT fork_parent, fork_known, fork_checked_at FROM repos WHERE id = ?", id),
    ).toEqual({ fork_parent: null, fork_known: 0, fork_checked_at: null });
  });

  it("only accepts 0 or 1 for fork_known", () => {
    const id = seed("a/one");
    migrate(db, log);

    expect(() => db.run("UPDATE repos SET fork_known = 2 WHERE id = ?", id)).toThrow(/CHECK/);
    db.run("UPDATE repos SET fork_known = 1, fork_parent = 'x/y' WHERE id = ?", id);
    expect(
      db.get<{ fork_parent: string }>("SELECT fork_parent FROM repos WHERE id = ?", id),
    ).toEqual({
      fork_parent: "x/y",
    });
  });

  it("indexes the unresolved repos the resolver scans", () => {
    migrate(db, log);

    const index = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_repos_fork_unknown'",
    );
    expect(index?.sql).toMatch(/WHERE fork_known = 0/);
  });
});
