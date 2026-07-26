import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations.ts";
import { createConsoleLogger } from "../src/logging.ts";

const log = createConsoleLogger("silent");

/** Everything up to but not including the seed, for tests that need a DB mid-history. */
const beforeSeed = migrations.filter((migration) => migration.name !== "003_default_forges");

interface ForgeRow {
  id: number;
  protocol: string;
  host: string;
  port: number | null;
  kind: string;
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig3-"));
  db = openDb(join(dir, "state", "amber.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function forges(): ForgeRow[] {
  return db.all<ForgeRow>("SELECT id, protocol, host, port, kind FROM forges ORDER BY host ASC");
}

function insertForge(protocol: string, host: string, port: number | null, kind: string): void {
  db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    protocol,
    host,
    port,
    kind,
    1,
    1,
  );
}

describe("003_default_forges", () => {
  it("seeds github.com and gitlab.com and nothing else", () => {
    migrate(db, log);

    expect(forges()).toEqual([
      { id: expect.any(Number), protocol: "https", host: "github.com", port: null, kind: "github" },
      { id: expect.any(Number), protocol: "https", host: "gitlab.com", port: null, kind: "gitlab" },
    ]);
  });

  it("stamps both rows with a millisecond timestamp", () => {
    const before = Date.now();
    migrate(db, log);

    // strftime('%s') has second resolution, so the floor is the second before.
    for (const row of db.all<{ created_at: number; updated_at: number }>(
      "SELECT created_at, updated_at FROM forges",
    )) {
      expect(row.created_at).toBeGreaterThanOrEqual(before - 1000);
      expect(row.created_at).toBeLessThanOrEqual(Date.now() + 1000);
      expect(row.updated_at).toBe(row.created_at);
    }
  });

  it("seeds once, however many times the runner is called", () => {
    migrate(db, log);
    const seeded = forges();

    expect(migrate(db, log).applied).toEqual([]);
    expect(forges()).toEqual(seeded);
  });

  it("leaves an install that already uses these hosts alone", () => {
    migrate(db, log, beforeSeed);
    insertForge("https", "github.com", null, "generic");

    migrate(db, log);

    // The pre-existing row keeps its kind and stays the only github.com forge.
    expect(forges().filter((forge) => forge.host === "github.com")).toEqual([
      {
        id: expect.any(Number),
        protocol: "https",
        host: "github.com",
        port: null,
        kind: "generic",
      },
    ]);
  });

  it("guards on the host alone, not the full origin", () => {
    migrate(db, log, beforeSeed);
    // A different protocol and port, so an identity-based guard would not fire.
    insertForge("http", "github.com", 3000, "gitea");

    migrate(db, log);

    expect(forges().map((forge) => `${forge.protocol}://${forge.host}`)).toEqual([
      "http://github.com",
      "https://gitlab.com",
    ]);
  });

  it("stays gone once deleted, which is why this is a migration and not a boot seed", () => {
    migrate(db, log);
    db.run("DELETE FROM forges WHERE host = 'github.com'");

    migrate(db, log);

    expect(forges().map((forge) => forge.host)).toEqual(["gitlab.com"]);
  });
});
