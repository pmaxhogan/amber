import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type AmberApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { EventBus } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";

/**
 * Shared fixtures for the server suite. Everything runs against a real
 * node:sqlite file with the real migrations applied: no db mocking, per the
 * testing section of the architecture doc.
 */

/** A well formed AES key for tests that need to store account secrets. */
export const TEST_SECRET_KEY = "a".repeat(64);

export interface TempDb {
  db: Db;
  dir: string;
  close(): void;
}

export function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "amber-db-"));
  const db = openDb(join(dir, "amber.db"));
  migrate(db, createConsoleLogger("silent"));
  return {
    db,
    dir,
    close(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TempApp {
  app: AmberApp;
  db: Db;
  config: Config;
  events: EventBus;
  dir: string;
  close(): Promise<void>;
}

/**
 * A full app in insecure mode (no Cloudflare Access), which is how the route
 * tests drive app.inject without minting a JWT for every call.
 */
export async function createTempApp(
  env: Record<string, string> = {},
  extra: { scheduler?: Parameters<typeof buildApp>[0]["scheduler"] } = {},
): Promise<TempApp> {
  const dir = mkdtempSync(join(tmpdir(), "amber-app-"));
  const config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: dir,
    AMBER_SECRET_KEY: TEST_SECRET_KEY,
    /**
     * Point the frontend at a directory that does not exist, so these tests
     * always describe an API-only app.
     *
     * Without this the default resolves to the repo's own web/dist, which is
     * present on a machine that has run a build and absent in CI, where only
     * the shared workspace is built. The route tests would then exercise two
     * different apps depending on where they ran: one with the SPA fallback
     * installed and one without. web.test.ts is the only place that opts into
     * a real dist, and it passes WEB_DIST_DIR explicitly.
     */
    WEB_DIST_DIR: join(dir, "no-frontend-here"),
    ...env,
  });
  const log = createConsoleLogger("silent");
  const db = openDb(config.dbPath);
  migrate(db, log);
  const events = new EventBus();
  const app = await buildApp({
    config,
    log,
    db,
    events,
    version: "9.9.9-test",
    ...(extra.scheduler === undefined ? {} : { scheduler: extra.scheduler }),
  });

  return {
    app,
    db,
    config,
    events,
    dir,
    async close(): Promise<void> {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert a forge directly, for tests that only care about what hangs off it. */
export function seedForge(
  db: Db,
  host = "github.com",
  kind = "github",
  protocol = "https",
  port: number | null = null,
): number {
  const now = Date.now();
  return db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    protocol,
    host,
    port,
    kind,
    now,
    now,
  ).lastInsertRowid;
}
