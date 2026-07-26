import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSettings, type ResolvedSettings } from "@amber/shared";
import { openDb, type Db } from "../../src/db/db.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createConsoleLogger } from "../../src/logging.ts";
import { runGit, type GitResult, type GitRunOptions } from "../../src/sync/gitCli.ts";
import type { SettingsResolver } from "../../src/sync/syncRepo.ts";

/**
 * Fixtures shared by the sync integration suites. Origins are real git
 * repositories on disk reached over file://, never a bare path: a bare path
 * would make git hardlink objects into the backup, and every durability
 * assertion in the torture suite would then pass for the wrong reason.
 */

export const silentLog = createConsoleLogger("silent");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `amber-${prefix}-`));
}

/** Deterministic identity and timestamps so commit SHAs never depend on the clock. */
const FIXTURE_ENV = {
  GIT_AUTHOR_NAME: "Amber Test",
  GIT_AUTHOR_EMAIL: "test@amber.invalid",
  GIT_COMMITTER_NAME: "Amber Test",
  GIT_COMMITTER_EMAIL: "test@amber.invalid",
};

export interface OriginRepo {
  dir: string;
  /** file:// URL, the only transport the tests hand to the sync engine. */
  url: string;
  git(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
  writeFile(relativePath: string, content: string): void;
  commit(message: string): Promise<string>;
  commitFile(relativePath: string, content: string, message: string): Promise<string>;
  revParse(rev: string): Promise<string>;
  refs(): Promise<Map<string, string>>;
}

export function openOrigin(dir: string): OriginRepo {
  let clock = Date.UTC(2026, 0, 1, 12, 0, 0);

  const git = async (args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> => {
    clock += 60_000;
    const stamp = `${String(Math.floor(clock / 1000))} +0000`;
    return runGit(args, {
      cwd: dir,
      allowFileProtocol: true,
      timeoutMs: 120_000,
      ...options,
      env: { ...FIXTURE_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp, ...options.env },
    });
  };

  return {
    dir,
    url: pathToFileURL(dir).href,
    git,
    writeFile(relativePath, content) {
      const full = join(dir, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    },
    async commit(message) {
      await git(["add", "--all", "."]);
      await git(["commit", "--allow-empty", "-m", message]);
      return (await git(["rev-parse", "HEAD"])).stdout.trim();
    },
    async commitFile(relativePath, content, message) {
      this.writeFile(relativePath, content);
      return this.commit(message);
    },
    async revParse(rev) {
      return (await git(["rev-parse", rev])).stdout.trim();
    },
    async refs() {
      const result = await git(["for-each-ref", "--format=%(objectname) %(refname)"]);
      const map = new Map<string, string>();
      for (const line of result.stdout.split("\n")) {
        const space = line.indexOf(" ");
        if (space > 0) {
          map.set(line.slice(space + 1).trim(), line.slice(0, space));
        }
      }
      return map;
    },
  };
}

/** A fresh non-bare origin with one commit on main. */
export async function createOrigin(dir: string): Promise<OriginRepo> {
  mkdirSync(dir, { recursive: true });
  const origin = openOrigin(dir);
  await origin.git(["init", "--initial-branch=main"]);
  // upload-pack over file:// refuses to serve a repo it considers untrusted
  // when the checkout is owned by another uid; the tests always own theirs.
  await origin.git(["config", "--local", "user.name", "Amber Test"]);
  await origin.git(["config", "--local", "user.email", "test@amber.invalid"]);
  return origin;
}

// ---------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------

export function createTestDb(dir: string): Db {
  const db = openDb(join(dir, "state", "amber.db"));
  migrate(db, silentLog);
  return db;
}

export function insertForge(
  db: Db,
  values: { protocol?: string; host: string; port?: number | null; kind?: string } = {
    host: "example.test",
  },
): number {
  const now = Date.now();
  return db.run(
    "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    values.protocol ?? "https",
    values.host,
    values.port ?? null,
    values.kind ?? "generic",
    now,
    now,
  ).lastInsertRowid;
}

export function insertRepo(
  db: Db,
  values: { forgeId: number; path: string; slug?: string; shortId?: string; state?: string },
): number {
  const now = Date.now();
  const shortId = values.shortId ?? Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  const slug = values.slug ?? `${values.path.replace(/[^a-z0-9]+/gi, "-")}-${shortId}`;
  return db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, state, next_sync_at,
                        consecutive_failures, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    values.forgeId,
    values.path,
    values.path.slice(values.path.lastIndexOf("/") + 1),
    slug,
    shortId,
    values.state ?? "active",
    now,
    now,
    now,
  ).lastInsertRowid;
}

export function repoSlug(db: Db, repoId: number): string {
  const row = db.get<{ slug: string }>("SELECT slug FROM repos WHERE id = ?", repoId);
  if (row === undefined) {
    throw new Error(`no repo ${String(repoId)}`);
  }
  return row.slug;
}

/**
 * Stand-in for domain/settings.resolveSettings, which the sync engine only
 * ever reaches through an injected resolver.
 */
export function fixedSettings(overrides: Partial<ResolvedSettings> = {}): SettingsResolver {
  const resolved: ResolvedSettings = { ...defaultSettings(), ...overrides };
  return () => resolved;
}
