import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

/**
 * Thin typed wrapper over node:sqlite. Single process, single writer, no ORM.
 * Every multi-statement write goes through tx().
 */

export type SqlParams = readonly SQLInputValue[];
export type Row = Record<string, SQLOutputValue>;

export const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = FULL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
] as const;

export interface Db {
  /** First matching row, or undefined. */
  get<T = Row>(sql: string, ...params: SqlParams): T | undefined;
  /** All matching rows. */
  all<T = Row>(sql: string, ...params: SqlParams): T[];
  /** Insert/update/delete. Returns the driver change summary. */
  run(sql: string, ...params: SqlParams): { changes: number; lastInsertRowid: number };
  /** Execute one or more statements with no parameters (DDL, pragmas). */
  exec(sql: string): void;
  /**
   * Run fn inside a transaction. Commits on return, rolls back on throw.
   * Nested calls reuse the outer transaction via savepoints.
   */
  tx<T>(fn: () => T): T;
  close(): void;
  readonly raw: DatabaseSync;
}

/**
 * Open (creating if needed) the sqlite file at `path` and apply the pragmas.
 * Pass ":memory:" for an ephemeral database in tests.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const raw = new DatabaseSync(path);
  for (const pragma of PRAGMAS) {
    // WAL is not available for :memory:, so failures there are expected.
    try {
      raw.exec(pragma);
    } catch (cause) {
      if (path !== ":memory:") {
        throw new Error(`Failed to apply "${pragma}" on ${path}`, { cause });
      }
    }
  }

  let depth = 0;

  const db: Db = {
    get<T = Row>(sql: string, ...params: SqlParams): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T = Row>(sql: string, ...params: SqlParams): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },
    run(sql: string, ...params: SqlParams) {
      const result = raw.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    tx<T>(fn: () => T): T {
      if (depth > 0) {
        const name = `amber_sp_${String(depth)}`;
        raw.exec(`SAVEPOINT ${name}`);
        depth += 1;
        try {
          const value = fn();
          raw.exec(`RELEASE ${name}`);
          return value;
        } catch (error) {
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
          throw error;
        } finally {
          depth -= 1;
        }
      }
      raw.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const value = fn();
        raw.exec("COMMIT");
        return value;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
      }
    },
    close(): void {
      raw.close();
    },
    raw,
  };

  return db;
}

/** Read a pragma back as a scalar, for tests and diagnostics. */
export function readPragma(db: Db, name: string): SQLOutputValue | undefined {
  const row = db.get<Record<string, SQLOutputValue>>(`PRAGMA ${name}`);
  if (row === undefined) {
    return undefined;
  }
  return Object.values(row)[0];
}
