import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, readPragma, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations.ts";
import { createConsoleLogger } from "../src/logging.ts";

const log = createConsoleLogger("silent");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-db-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates the parent directory and applies the pragmas", () => {
    expect(readPragma(db, "journal_mode")).toBe("wal");
    expect(readPragma(db, "foreign_keys")).toBe(1);
    expect(readPragma(db, "busy_timeout")).toBe(5000);
    // synchronous FULL is 2.
    expect(readPragma(db, "synchronous")).toBe(2);
  });

  it("round-trips typed helpers", () => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const inserted = db.run("INSERT INTO t (name) VALUES (?)", "alpha");
    expect(inserted.changes).toBe(1);
    expect(inserted.lastInsertRowid).toBe(1);
    expect(db.get<{ name: string }>("SELECT name FROM t WHERE id = ?", 1)).toEqual({
      name: "alpha",
    });
    expect(db.all<{ name: string }>("SELECT name FROM t")).toHaveLength(1);
    expect(db.get("SELECT name FROM t WHERE id = ?", 99)).toBeUndefined();
  });
});

describe("tx", () => {
  beforeEach(() => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  });

  it("commits on success", () => {
    const value = db.tx(() => {
      db.run("INSERT INTO t (name) VALUES (?)", "a");
      return 42;
    });
    expect(value).toBe(42);
    expect(db.all("SELECT * FROM t")).toHaveLength(1);
  });

  it("rolls back on throw", () => {
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t (name) VALUES (?)", "a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all("SELECT * FROM t")).toHaveLength(0);
  });

  it("nests via savepoints, rolling back only the inner scope", () => {
    db.tx(() => {
      db.run("INSERT INTO t (name) VALUES (?)", "outer");
      try {
        db.tx(() => {
          db.run("INSERT INTO t (name) VALUES (?)", "inner");
          throw new Error("inner failed");
        });
      } catch {
        // The outer transaction survives.
      }
    });
    expect(db.all<{ name: string }>("SELECT name FROM t")).toEqual([{ name: "outer" }]);
  });
});

describe("migrate", () => {
  it("applies every migration once and is idempotent", () => {
    const first = migrate(db, log);
    expect(first.applied).toEqual(migrations.map((m) => m.name));

    const second = migrate(db, log);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(migrations.map((m) => m.name));
  });

  it("creates every table the architecture doc specifies", () => {
    migrate(db, log);
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual(
      [
        "account_syncs",
        "accounts",
        "forges",
        "kv",
        "migrations",
        "repos",
        "settings",
        "sync_runs",
      ].sort(),
    );
  });

  it("rolls a failing migration back rather than half-applying it", () => {
    const bad = [{ name: "999_bad", sql: "CREATE TABLE ok (id INTEGER); CREATE TABLE ok (id);" }];
    expect(() => migrate(db, log, bad)).toThrow();
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).not.toContain("ok");
    expect(db.all("SELECT * FROM migrations")).toHaveLength(0);
  });
});

describe("schema constraints", () => {
  /**
   * A host of our own, so a collision here is with the row this hook wrote and
   * never with one of the two forges migration 003 seeds.
   */
  const HOST = "forge.example.com";
  let forgeId: number;

  beforeEach(() => {
    migrate(db, log);
    forgeId = db.run(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "https",
      HOST,
      null,
      "generic",
      1,
      1,
    ).lastInsertRowid;
  });

  it("rejects a duplicate forge on the default port", () => {
    expect(() =>
      db.run(
        "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "https",
        HOST,
        null,
        "generic",
        1,
        1,
      ),
    ).toThrow();
  });

  it("treats an explicit port as a distinct forge", () => {
    expect(() =>
      db.run(
        "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "https",
        HOST,
        8443,
        "generic",
        1,
        1,
      ),
    ).not.toThrow();
  });

  it("allows at most one default account per forge", () => {
    const insert = (username: string, isDefault: number) =>
      db.run(
        "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        forgeId,
        username,
        isDefault,
        1,
        1,
      );
    insert("alice", 1);
    expect(() => insert("bob", 1)).toThrow();
    expect(() => insert("bob", 0)).not.toThrow();
  });

  it("enforces the forge+path uniqueness on repos", () => {
    const insert = (path: string, slug: string, shortId: string) =>
      db.run(
        "INSERT INTO repos (forge_id, path, display_name, slug, short_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        forgeId,
        path,
        path.slice(path.lastIndexOf("/") + 1),
        slug,
        shortId,
        1,
        1,
      );
    insert("nodejs/node", "nodejs-node-aaaaaaaa", "aaaaaaaa");
    expect(() => insert("nodejs/node", "nodejs-node-bbbbbbbb", "bbbbbbbb")).toThrow();
    expect(() => insert("nodejs/undici", "nodejs-undici-cccccccc", "cccccccc")).not.toThrow();
  });

  it("enforces foreign keys", () => {
    expect(() =>
      db.run(
        "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        999,
        "ghost",
        0,
        1,
        1,
      ),
    ).toThrow();
  });

  it("requires scope_id to be null exactly when the scope is global", () => {
    expect(() =>
      db.run(
        "INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "global",
        null,
        "paranoid",
        "true",
        1,
        1,
      ),
    ).not.toThrow();
    expect(() =>
      db.run(
        "INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "global",
        1,
        "paranoid",
        "true",
        1,
        1,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "repo",
        null,
        "paranoid",
        "true",
        1,
        1,
      ),
    ).toThrow();
  });
});
