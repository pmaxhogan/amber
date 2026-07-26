import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { createConsoleLogger } from "../src/logging.ts";

const log = createConsoleLogger("silent");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig2-"));
  db = openDb(join(dir, "state", "amber.db"));
  migrate(db, log);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedAccount(username = "octocat"): number {
  db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    "https",
    "github.com",
    null,
    "github",
    1,
    1,
  );
  const account = db.run(
    "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    1,
    username,
    1,
    1,
    1,
  );
  return account.lastInsertRowid;
}

function insertSync(accountId: number, source: string): number {
  return db.run(
    "INSERT INTO account_syncs (account_id, source, visibility, enabled, interval_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    accountId,
    source,
    "all",
    1,
    360,
    1,
    1,
  ).lastInsertRowid;
}

describe("002_starred_sync", () => {
  it("leaves no rebuild leftovers behind", () => {
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .map((row) => row.name);
    expect(tables).toContain("account_syncs");
    expect(tables).not.toContain("account_syncs_002");
  });

  it("keeps the due index and the account index after the table rebuild", () => {
    const indexes = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((row) => row.name);
    expect(indexes).toContain("idx_account_syncs_due");
    expect(indexes).toContain("idx_account_syncs_account");
    expect(indexes).toContain("idx_repos_origin");
  });

  it("allows one owned and one starred sync per account but not two of a kind", () => {
    const accountId = seedAccount();
    expect(() => insertSync(accountId, "owned")).not.toThrow();
    expect(() => insertSync(accountId, "starred")).not.toThrow();
    expect(() => insertSync(accountId, "owned")).toThrow();
  });

  it("rejects an unknown source", () => {
    const accountId = seedAccount();
    expect(() => insertSync(accountId, "forked")).toThrow();
  });

  it("defaults source to owned", () => {
    const accountId = seedAccount();
    db.run(
      "INSERT INTO account_syncs (account_id, visibility, enabled, interval_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      accountId,
      "all",
      1,
      360,
      1,
      1,
    );
    expect(db.get<{ source: string }>("SELECT source FROM account_syncs")).toEqual({
      source: "owned",
    });
  });

  it("still enforces the repos foreign key onto the rebuilt table", () => {
    seedAccount();
    expect(() =>
      db.run(
        "INSERT INTO repos (forge_id, path, display_name, slug, short_id, managed_by_account_sync_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        1,
        "nodejs/node",
        "node",
        "nodejs-node-aaaaaaaa",
        "aaaaaaaa",
        999,
        1,
        1,
      ),
    ).toThrow();
  });

  it("defaults repos.origin to manual and constrains its values", () => {
    seedAccount();
    const insert = (path: string, shortId: string, origin?: string) =>
      origin === undefined
        ? db.run(
            "INSERT INTO repos (forge_id, path, display_name, slug, short_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            1,
            path,
            "x",
            `${path.replace("/", "-")}-${shortId}`,
            shortId,
            1,
            1,
          )
        : db.run(
            "INSERT INTO repos (forge_id, path, display_name, slug, short_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            1,
            path,
            "x",
            `${path.replace("/", "-")}-${shortId}`,
            shortId,
            origin,
            1,
            1,
          );

    insert("a/one", "aaaaaaaa");
    expect(db.get<{ origin: string }>("SELECT origin FROM repos WHERE path = 'a/one'")).toEqual({
      origin: "manual",
    });
    expect(() => insert("a/two", "bbbbbbbb", "account_sync")).not.toThrow();
    expect(() => insert("a/three", "cccccccc", "cloned")).toThrow();
  });
});
