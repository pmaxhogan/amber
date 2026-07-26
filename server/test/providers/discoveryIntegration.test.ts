import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db/db.ts";
import { migrate } from "../../src/db/migrate.ts";
import { getRepo, listRepos, SHORT_ID_LENGTH } from "../../src/domain/repos.ts";
import { createConsoleLogger } from "../../src/logging.ts";
import { runAccountSync } from "../../src/providers/discovery.ts";
import { JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

/**
 * The unit suite drives discovery with the repo helpers stubbed out so it can
 * assert on the calls. This one leaves every seam at its default, so the real
 * generateShortId, buildSlug and deleteRepo from domain/repos.ts run and the
 * rows they write are read back through the real mapper. Only HTTP is faked.
 */

let db: Db;
let http: MockHttp;
let backupsDir: string;

const log = createConsoleLogger("silent");

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, log);
  http = mockHttp();
  backupsDir = mkdtempSync(join(tmpdir(), "amber-discovery-"));
});

afterEach(async () => {
  db.close();
  await http.close();
  rmSync(backupsDir, { recursive: true, force: true });
});

function seed(): { forgeId: number; accountId: number; syncId: number } {
  const forgeId = Number(
    db.run(
      "INSERT INTO forges (protocol, host, port, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "https",
      "github.com",
      null,
      "github",
      1,
      1,
    ).lastInsertRowid,
  );
  const accountId = Number(
    db.run(
      `INSERT INTO accounts (forge_id, username, secret_enc, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      forgeId,
      "octocat",
      null,
      1,
      1,
      1,
    ).lastInsertRowid,
  );
  return { forgeId, accountId, syncId: 0 };
}

function createSync(accountId: number, source: "owned" | "starred"): number {
  return Number(
    db.run(
      `INSERT INTO account_syncs (account_id, source, visibility, enabled, interval_minutes,
         next_run_at, created_at, updated_at)
       VALUES (?, ?, 'all', 1, 360, NULL, 1, 1)`,
      accountId,
      source,
    ).lastInsertRowid,
  );
}

function githubRepo(fullName: string): Record<string, unknown> {
  return { full_name: fullName, default_branch: "main", private: false };
}

describe("discovery against the real domain layer", () => {
  it("creates repos whose slugs and short ids come from domain/repos.ts", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId, "owned");

    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(200, [githubRepo("octocat/Hello-World"), githubRepo("octocat/spoon-knife")], {
        headers: JSON_HEADERS,
      });

    await runAccountSync(db, syncId, { log, fetch: http.fetch });

    const page = listRepos(db, { page: 1, perPage: 50, sort: "path", dir: "asc" });
    expect(page.total).toBe(2);

    for (const repo of page.rows) {
      // The real generator: 8 chars of base36, and the slug carries it so two
      // repos can never collide on disk however their paths sanitize.
      expect(repo.shortId).toMatch(/^[0-9a-z]{8}$/);
      expect(repo.shortId).toHaveLength(SHORT_ID_LENGTH);
      expect(repo.slug.endsWith(`-${repo.shortId}`)).toBe(true);
      expect(repo.origin).toBe("account_sync");
      expect(repo.managedByAccountSyncId).toBe(syncId);
      expect(repo.defaultBranch).toBe("main");
    }

    expect(page.rows.map((repo) => repo.path)).toEqual([
      "octocat/Hello-World",
      "octocat/spoon-knife",
    ]);
    expect(new Set(page.rows.map((repo) => repo.slug)).size).toBe(2);
  });

  it("deletes the row and the backup directory when a star is confirmed gone", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId, "starred");

    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path.startsWith("/users/octocat/starred"), method: "GET" })
      .reply(200, [githubRepo("octocat/Hello-World"), githubRepo("octocat/keeper")], {
        headers: JSON_HEADERS,
      });

    await runAccountSync(db, syncId, { log, fetch: http.fetch });

    const created = listRepos(db, { page: 1, perPage: 50, sort: "path", dir: "asc" }).rows;
    expect(created).toHaveLength(2);
    const repo = created.find((row) => row.path === "octocat/Hello-World");
    expect(repo).toBeDefined();

    // Stand in for a real backup on disk so the remover has something to remove.
    const dir = join(backupsDir, repo!.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");

    // One repo drops off a still-populated list, and the forge confirms it is
    // still there, so this is a deliberate unstar rather than an outage. An
    // empty list would be refused as mass unstarring and remove nothing.
    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path.startsWith("/users/octocat/starred"), method: "GET" })
      .reply(200, [githubRepo("octocat/keeper")], { headers: JSON_HEADERS });
    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path === "/repos/octocat/Hello-World", method: "GET" })
      .reply(200, githubRepo("octocat/Hello-World"), { headers: JSON_HEADERS });

    await runAccountSync(db, syncId, {
      log,
      fetch: http.fetch,
      removeFiles: async () => {
        rmSync(dir, { recursive: true, force: true });
        await Promise.resolve();
      },
    });

    expect(getRepo(db, repo!.id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    // The repo that is still starred is untouched.
    expect(listRepos(db, { page: 1, perPage: 50, sort: "path", dir: "asc" }).total).toBe(1);
  });

  it("keeps the backup when the forge cannot confirm the repo is still there", async () => {
    const { accountId } = seed();
    const syncId = createSync(accountId, "starred");

    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path.startsWith("/users/octocat/starred"), method: "GET" })
      .reply(200, [githubRepo("octocat/Hello-World"), githubRepo("octocat/keeper")], {
        headers: JSON_HEADERS,
      });

    await runAccountSync(db, syncId, { log, fetch: http.fetch });
    const repo = listRepos(db, { page: 1, perPage: 50, sort: "path", dir: "asc" }).rows.find(
      (row) => row.path === "octocat/Hello-World",
    );
    expect(repo).toBeDefined();

    // Absent from a still-populated list, so the mass-unstar guard does not
    // apply and the upstream check is what decides. The forge 404s: the repo
    // may have been deleted upstream, which is exactly what the backup is for.
    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path.startsWith("/users/octocat/starred"), method: "GET" })
      .reply(200, [githubRepo("octocat/keeper")], { headers: JSON_HEADERS });
    http
      .pool("https://api.github.com")
      .intercept({ path: (path) => path === "/repos/octocat/Hello-World", method: "GET" })
      .reply(404, { message: "Not Found" }, { headers: JSON_HEADERS });

    let removerCalled = false;
    await runAccountSync(db, syncId, {
      log,
      fetch: http.fetch,
      removeFiles: async () => {
        removerCalled = true;
        await Promise.resolve();
      },
    });

    expect(getRepo(db, repo!.id)).toBeDefined();
    expect(removerCalled).toBe(false);
  });
});
