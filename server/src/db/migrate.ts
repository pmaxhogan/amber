import type { Logger } from "pino";
import type { Db } from "./db.ts";
import { migrations as defaultMigrations, type Migration } from "./migrations.ts";

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply every pending migration in order, each in its own transaction, and
 * record it in the migrations table. Safe to call on every boot.
 */
export function migrate(
  db: Db,
  log: Logger,
  list: readonly Migration[] = defaultMigrations,
): MigrateResult {
  db.exec(MIGRATIONS_TABLE);

  const appliedNames = new Set(
    db.all<{ name: string }>("SELECT name FROM migrations").map((row) => row.name),
  );

  const result: MigrateResult = { applied: [], alreadyApplied: [] };

  for (const migration of list) {
    if (appliedNames.has(migration.name)) {
      result.alreadyApplied.push(migration.name);
      continue;
    }
    const startedAt = Date.now();
    db.tx(() => {
      db.exec(migration.sql);
      db.run("INSERT INTO migrations (name, applied_at) VALUES (?, ?)", migration.name, Date.now());
    });
    result.applied.push(migration.name);
    log.info(
      { migration: migration.name, durationMs: Date.now() - startedAt },
      "applied migration",
    );
  }

  if (result.applied.length === 0) {
    log.debug({ count: result.alreadyApplied.length }, "database schema up to date");
  } else {
    log.info({ applied: result.applied }, "database migrated");
  }

  return result;
}
