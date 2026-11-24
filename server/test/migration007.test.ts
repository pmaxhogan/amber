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

interface Seed {
  path: string;
  lastSuccessAt: number | null;
  failures: number;
  /** Error kinds of its runs, oldest first; null is a success. */
  runs: (string | null)[];
  /** A run that started and never finished, newest of all. */
  inFlight?: boolean;
}

function seed(input: Seed): number {
  const id = db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, consecutive_failures,
                        last_sync_at, last_success_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 900, ?, 1, 1)`,
    forgeId,
    input.path,
    input.path,
    `slug-${input.path.replace("/", "-")}`,
    `id-${input.path.replace("/", "-")}`,
    input.failures,
    input.lastSuccessAt,
  ).lastInsertRowid;
  input.runs.forEach((kind, index) => {
    db.run(
      "INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, error_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
      id,
      100 + index,
      200 + index,
      kind === null ? "success" : "error",
      kind,
    );
  });
  if (input.inFlight === true) {
    db.run(
      "INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, created_at, updated_at) VALUES (?, 999, NULL, 'canceled', 1, 1)",
      id,
    );
  }
  return id;
}

function goneAt(id: number): number | null | undefined {
  return db.get<{ gone_at: number | null }>("SELECT gone_at FROM repos WHERE id = ?", id)?.gone_at;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-mig7-"));
  db = openDb(join(dir, "state", "amber.db"));
  migrate(
    db,
    log,
    migrations.filter((migration) => migration.name < "007"),
  );
  forgeId = db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES ('https', 'forge.example.com', NULL, 'github', 1, 1)",
  ).lastInsertRowid;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("007_gone_and_push", () => {
  it("marks what is already gone at upgrade time, and nothing else", () => {
    const deleted = seed({
      path: "a/deleted",
      lastSuccessAt: 50,
      failures: 4,
      runs: [null, "not_found", "not_found"],
    });
    const wentPrivate = seed({
      path: "a/private",
      lastSuccessAt: 50,
      failures: 2,
      runs: ["auth", "auth"],
    });
    const midSync = seed({
      path: "a/midsync",
      lastSuccessAt: 50,
      failures: 3,
      runs: ["not_found", "not_found"],
      inFlight: true,
    });
    const healthy = seed({ path: "a/healthy", lastSuccessAt: 50, failures: 0, runs: [null] });
    const oneBlip = seed({ path: "a/blip", lastSuccessAt: 50, failures: 1, runs: ["not_found"] });
    const neverSynced = seed({
      path: "a/typo",
      lastSuccessAt: null,
      failures: 9,
      runs: ["not_found", "not_found"],
    });
    const offline = seed({
      path: "a/offline",
      lastSuccessAt: 50,
      failures: 6,
      runs: ["network", "network"],
    });

    migrate(db, log);

    expect(goneAt(deleted)).toBe(900);
    expect(goneAt(wentPrivate)).toBe(900);
    expect(goneAt(midSync)).toBe(900);
    expect(goneAt(healthy)).toBeNull();
    expect(goneAt(oneBlip)).toBeNull();
    expect(goneAt(neverSynced)).toBeNull();
    expect(goneAt(offline)).toBeNull();
  });

  it("creates an empty push subscription table with unique endpoints", () => {
    migrate(db, log);

    const insert =
      "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at) VALUES (?, 'k', 'a', 1, 1)";
    expect(db.all("SELECT * FROM push_subscriptions")).toEqual([]);
    db.run(insert, "https://push.example/one");
    expect(() => db.run(insert, "https://push.example/one")).toThrow(/UNIQUE/);
  });
});
