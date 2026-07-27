import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AmberEventType } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createAccount, getAccount } from "../src/domain/accounts.ts";
import { runGit } from "../src/sync/gitCli.ts";
import { listSyncRuns, loadSyncTarget, RUN_RETENTION_COUNT } from "../src/sync/repoStore.ts";
import {
  archiveStamp,
  buildRemoteUrl,
  classifyGitError,
  parseBytesFetched,
  refspecsFor,
  repoDir,
  syncRepo,
  type SyncEventPublisher,
  type SyncRepoDeps,
} from "../src/sync/syncRepo.ts";
import {
  createOrigin,
  createTestDb,
  fixedSettings,
  insertForge,
  insertRepo,
  repoSlug,
  silentLog,
  tempDir,
  type OriginRepo,
} from "./helpers/gitFixtures.ts";
import type { ResolvedSettings } from "@amber/shared";

let root: string;
let db: Db;
let origin: OriginRepo;
let repoId: number;
let backupsDir: string;
let stateDir: string;
let events: { type: AmberEventType; payload: Record<string, unknown> }[];

/** Any valid 32 byte key; these tests only need encrypt/decrypt to round trip. */
const SECRET_KEY = Buffer.alloc(32, 7);

const publisher: SyncEventPublisher = {
  publish(type, payload = {}) {
    events.push({ type, payload });
  },
};

function backupPath(): string {
  return repoDir(backupsDir, repoSlug(db, repoId));
}

async function backupGit(args: string[]): Promise<string> {
  const result = await runGit(args, {
    cwd: backupPath(),
    stateDir,
    allowFileProtocol: true,
    allowFailure: true,
  });
  return result.stdout;
}

async function sync(
  settings: Partial<ResolvedSettings> = {},
  overrides: Partial<SyncRepoDeps> = {},
): Promise<ReturnType<typeof syncRepo>> {
  return syncRepo({
    repoId,
    db,
    backupsDir,
    stateDir,
    logger: silentLog,
    events: publisher,
    settings: fixedSettings(settings),
    credentials: () => undefined,
    remoteUrl: origin.url,
    allowFileProtocol: true,
    ...overrides,
  });
}

beforeEach(async () => {
  root = tempDir("sync");
  backupsDir = join(root, "backups");
  stateDir = join(root, "state");
  db = createTestDb(root);
  events = [];
  const forgeId = insertForge(db, { host: "origin.test" });
  repoId = insertRepo(db, { forgeId, path: "acme/widgets" });
  origin = await createOrigin(join(root, "origin"));
  await origin.commitFile("README.md", "hello\n", "initial commit");
  await origin.git(["branch", "feature/one"]);
  await origin.git(["tag", "-a", "v1.0.0", "-m", "release one"]);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("pure helpers", () => {
  it("builds a credential free remote url", () => {
    expect(
      buildRemoteUrl(
        { id: 1, protocol: "https", host: "github.com", port: null, kind: "github" },
        "nodejs/node",
      ),
    ).toBe("https://github.com/nodejs/node.git");
    expect(
      buildRemoteUrl(
        { id: 1, protocol: "http", host: "git.lan", port: 8080, kind: "gitea" },
        "ops/infra",
      ),
    ).toBe("http://git.lan:8080/ops/infra.git");
  });

  it("uses the documented refspecs per mode", () => {
    expect(refspecsFor("bare")).toEqual(["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
    expect(refspecsFor("full")).toEqual(refspecsFor("bare"));
    expect(refspecsFor("shallow")).toEqual(refspecsFor("bare"));
    expect(refspecsFor("mirror")).toEqual(["+refs/*:refs/*"]);
  });

  it("stamps archives in compact utc", () => {
    expect(archiveStamp(Date.UTC(2026, 6, 26, 4, 5, 6))).toBe("20260726T040506Z");
  });

  it("parses the transferred byte count out of fetch progress", () => {
    expect(
      parseBytesFetched("Receiving objects: 100% (12/12), 1.50 MiB | 3.00 MiB/s, done.\n"),
    ).toBe(1572864);
    expect(parseBytesFetched("Receiving objects: 100% (3/3), 512 B | 512.00 KiB/s, done.")).toBe(
      512,
    );
    expect(parseBytesFetched("Everything up to date")).toBeNull();
  });

  it("exposes the shared classifier", () => {
    expect(classifyGitError("fatal: Authentication failed", 128)).toBe("auth");
  });
});

describe("bare mode", () => {
  it("creates the backup, records the run and updates the repo row", async () => {
    const run = await sync();

    expect(run.outcome).toBe("success");
    expect(run.errorKind).toBeNull();
    expect(run.refsChanged).toBeGreaterThan(0);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.paranoidArchived).toBeNull();
    expect(run.bytesFetched === null || run.bytesFetched > 0).toBe(true);

    const dir = backupPath();
    expect(existsSync(join(dir, "HEAD"))).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(false);

    const refs = await backupGit(["for-each-ref", "--format=%(refname)"]);
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/heads/feature/one");
    expect(refs).toContain("refs/tags/v1.0.0");

    const repo = db.get<{
      last_success_at: number | null;
      next_sync_at: number;
      disk_usage_bytes: number;
      default_branch: string;
      last_fetch_head: string;
      consecutive_failures: number;
      last_error: string | null;
    }>("SELECT * FROM repos WHERE id = ?", repoId);
    expect(repo?.last_success_at).not.toBeNull();
    expect(repo?.next_sync_at).toBeGreaterThan(Date.now());
    expect(repo?.disk_usage_bytes).toBeGreaterThan(0);
    expect(repo?.default_branch).toBe("main");
    expect(repo?.last_fetch_head).toBe(await origin.revParse("main"));
    expect(repo?.consecutive_failures).toBe(0);
    expect(repo?.last_error).toBeNull();
  });

  it("does not store an implausible default branch a hostile origin advertises", async () => {
    // A malicious forge points HEAD at a branch literally named "-p". Left
    // unvalidated, that name flows into `git lfs fetch origin -p` (prune) and
    // is persisted as the default branch. readDefaultBranch must reject it.
    const mainTip = await origin.revParse("main");
    await origin.git(["update-ref", "refs/heads/-p", mainTip]);
    await origin.git(["symbolic-ref", "HEAD", "refs/heads/-p"]);

    const run = await sync();
    expect(run.outcome).toBe("success");

    const repo = db.get<{ default_branch: string | null }>(
      "SELECT default_branch FROM repos WHERE id = ?",
      repoId,
    );
    // Not poisoned with "-p"; the implausible name is dropped to null.
    expect(repo?.default_branch).toBeNull();
  });

  it("resolves the repo against its own forge row", () => {
    const forgeId = db.get<{ forge_id: number }>(
      "SELECT forge_id FROM repos WHERE id = ?",
      repoId,
    )?.forge_id;
    const target = loadSyncTarget(db, repoId);
    // A credential is only ever looked up through this forge, so mixing the
    // two id columns up would hand a token to the wrong host.
    expect(target?.forge.id).toBe(forgeId);
    expect(target?.repo.id).toBe(repoId);
    expect(target?.forge.host).toBe("origin.test");
  });

  it("stores a credential free remote url", async () => {
    await sync();
    const url = (await backupGit(["remote", "get-url", "origin"])).trim();
    expect(url).toBe(origin.url);
    expect(url).not.toMatch(/:\/\/[^/]*@/);
  });

  it("emits a started and a finished event", async () => {
    await sync();
    expect(events.map((event) => event.type)).toEqual(["sync.started", "sync.finished"]);
    expect(events[1]?.payload.outcome).toBe("success");
    expect(events[1]?.payload.repoId).toBe(repoId);
  });

  it("is incremental on the second run", async () => {
    await sync();
    await origin.commitFile("second.txt", "more\n", "second commit");
    const second = await sync();
    expect(second.outcome).toBe("success");
    expect(second.refsChanged).toBe(1);
    expect((await backupGit(["rev-parse", "refs/heads/main"])).trim()).toBe(
      await origin.revParse("main"),
    );
  });

  it("prunes upstream deletions when paranoid mode is off", async () => {
    await sync();
    await origin.git(["branch", "-D", "feature/one"]);
    await origin.git(["tag", "-d", "v1.0.0"]);
    const run = await sync();

    expect(run.outcome).toBe("success");
    const refs = await backupGit(["for-each-ref", "--format=%(refname)"]);
    expect(refs).not.toContain("refs/heads/feature/one");
    expect(refs).not.toContain("refs/tags/v1.0.0");
    expect(refs).not.toContain("refs/amber/archive");
    expect(run.paranoidArchived).toBeNull();
  });

  it("does not set the paranoid git config when paranoid mode is off", async () => {
    await sync();
    const config = await backupGit(["config", "--local", "--list"]);
    expect(config).not.toContain("gc.auto=0");
    expect(config).not.toContain("core.logallrefupdates=always");
  });
});

describe("mirror mode", () => {
  it("copies refs outside heads and tags", async () => {
    const head = await origin.revParse("main");
    await origin.git(["update-ref", "refs/pull/7/head", head]);
    await origin.git(["update-ref", "refs/notes/commits", head]);

    await sync({ clone_mode: "mirror" });

    const refs = await backupGit(["for-each-ref", "--format=%(refname)"]);
    expect(refs).toContain("refs/pull/7/head");
    expect(refs).toContain("refs/notes/commits");
  });
});

describe("shallow mode", () => {
  it("truncates history to the configured depth", async () => {
    await origin.commitFile("a.txt", "a\n", "second");
    await origin.commitFile("b.txt", "b\n", "third");

    await sync({ clone_mode: "shallow", shallow_depth: 1 });

    const count = (await backupGit(["rev-list", "--count", "refs/heads/main"])).trim();
    expect(count).toBe("1");
    expect(existsSync(join(backupPath(), "shallow"))).toBe(true);
  });
});

describe("full mode", () => {
  it("checks out the default branch with hooks and smudge filters disabled", async () => {
    await sync({ clone_mode: "full" });

    const dir = backupPath();
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello\n");

    await origin.commitFile("README.md", "hello again\n", "update readme");
    await sync({ clone_mode: "full" });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello again\n");
  });

  it("updates the checked out branch even though it is HEAD", async () => {
    await sync({ clone_mode: "full" });
    await origin.commitFile("c.txt", "c\n", "third commit");
    const run = await sync({ clone_mode: "full" });
    expect(run.outcome).toBe("success");
    expect((await backupGit(["rev-parse", "HEAD"])).trim()).toBe(await origin.revParse("main"));
  });
});

describe("failures", () => {
  it("records a classified error run and backs off", async () => {
    const missing = `${origin.url}-does-not-exist`;
    const run = await sync({}, { remoteUrl: missing });

    expect(run.outcome).toBe("error");
    expect(run.error).not.toBeNull();
    expect(run.errorKind).not.toBeNull();

    const repo = db.get<{
      consecutive_failures: number;
      next_sync_at: number;
      last_error: string;
      last_success_at: number | null;
    }>("SELECT * FROM repos WHERE id = ?", repoId);
    expect(repo?.consecutive_failures).toBe(1);
    expect(repo?.last_success_at).toBeNull();
    expect(repo?.next_sync_at).toBeGreaterThan(Date.now());
    expect(repo?.last_error).toContain("git");
  });

  it("keeps backing off on repeated failures and resets after a success", async () => {
    const missing = `${origin.url}-does-not-exist`;
    await sync({}, { remoteUrl: missing });
    await sync({}, { remoteUrl: missing });
    expect(
      db.get<{ consecutive_failures: number }>(
        "SELECT consecutive_failures FROM repos WHERE id = ?",
        repoId,
      )?.consecutive_failures,
    ).toBe(2);

    await sync();
    const repo = db.get<{ consecutive_failures: number; last_error: string | null }>(
      "SELECT consecutive_failures, last_error FROM repos WHERE id = ?",
      repoId,
    );
    expect(repo?.consecutive_failures).toBe(0);
    expect(repo?.last_error).toBeNull();
  });

  it("throws for a repo that does not exist", async () => {
    await expect(sync({}, { repoId: 9999 })).rejects.toThrow(/does not exist/);
  });
});

describe("retention", () => {
  it("keeps the newest runs per repo and every recent error", async () => {
    const now = Date.now();
    for (let i = 0; i < RUN_RETENTION_COUNT + 10; i += 1) {
      db.run(
        `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        repoId,
        now - (RUN_RETENTION_COUNT + 20 - i) * 1000,
        now,
        i === 0 ? "error" : "success",
        now,
        now,
      );
    }
    await sync();

    const runs = listSyncRuns(db, repoId);
    expect(runs.length).toBeLessThanOrEqual(RUN_RETENTION_COUNT + 1);
    // The oldest row is an error inside the 30 day window, so it survives the
    // count cap that evicted the successes around it.
    expect(runs.some((run) => run.outcome === "error")).toBe(true);
  });

  it("drops error rows once they age out", async () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db.run(
      `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, created_at, updated_at)
       VALUES (?, ?, ?, 'error', ?, ?)`,
      repoId,
      old,
      old,
      old,
      old,
    );
    for (let i = 0; i < RUN_RETENTION_COUNT; i += 1) {
      db.run(
        `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, created_at, updated_at)
         VALUES (?, ?, ?, 'success', ?, ?)`,
        repoId,
        Date.now() - i,
        Date.now(),
        Date.now(),
        Date.now(),
      );
    }
    await sync();
    const runs = listSyncRuns(db, repoId);
    expect(runs.every((run) => run.startedAt > old)).toBe(true);
  });
});

describe("credential lifecycle", () => {
  /**
   * last_used_at means "this credential worked", so it is stamped after the
   * fetch comes back rather than when the password is read out of the row.
   * These use the real resolver (no credentials override) against a file://
   * origin that ignores auth, so the fetch outcome is what varies.
   */
  function seedAccount(secret: string | null): number {
    const forgeId = loadSyncTarget(db, repoId)?.repo.forgeId;
    expect(forgeId).toBeDefined();
    const now = Date.now();
    const account = createAccount(db, SECRET_KEY, {
      forgeId: forgeId!,
      username: "octocat",
      secret,
      isDefault: true,
    });
    db.run("UPDATE accounts SET last_used_at = NULL, updated_at = ? WHERE id = ?", now, account.id);
    return account.id;
  }

  it("stamps last_used_at once a fetch using the credential succeeds", async () => {
    const accountId = seedAccount("ghp_example_token");
    expect(getAccount(db, accountId)?.lastUsedAt).toBeNull();

    const run = await sync({}, { credentials: undefined, secretKey: SECRET_KEY });

    expect(run.outcome).toBe("success");
    expect(getAccount(db, accountId)?.lastUsedAt).not.toBeNull();
  });

  it("leaves last_used_at alone when the fetch fails", async () => {
    const accountId = seedAccount("ghp_example_token");

    const run = await sync(
      {},
      {
        credentials: undefined,
        secretKey: SECRET_KEY,
        remoteUrl: `${origin.url}-does-not-exist`,
      },
    );

    expect(run.outcome).toBe("error");
    // A stored secret the forge never accepted must not look freshly used.
    expect(getAccount(db, accountId)?.lastUsedAt).toBeNull();
  });

  it("leaves last_used_at alone when the account stores no secret", async () => {
    const accountId = seedAccount(null);

    const run = await sync({}, { credentials: undefined, secretKey: SECRET_KEY });

    expect(run.outcome).toBe("success");
    // Nothing was presented, so nothing was used.
    expect(getAccount(db, accountId)?.lastUsedAt).toBeNull();
  });
});

describe("HEAD in the backup", () => {
  it("points at the upstream default branch in bare mode", async () => {
    await sync();

    // Without this, a clone off the read-only remote lands on an unborn
    // branch and checks out nothing, whatever the backup actually holds.
    expect((await backupGit(["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/main");
    expect((await backupGit(["rev-parse", "--verify", "HEAD"])).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("follows the upstream when its default branch is not called main", async () => {
    await origin.git(["branch", "-m", "main", "trunk"]);
    await sync();

    expect((await backupGit(["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/trunk");
  });

  it("follows a default branch that is renamed after the first sync", async () => {
    await sync();
    expect((await backupGit(["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/main");

    await origin.git(["branch", "-m", "main", "release"]);
    await sync();

    expect((await backupGit(["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/release");
  });

  it("does the same in mirror mode", async () => {
    await sync({ clone_mode: "mirror" });
    expect((await backupGit(["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/main");
  });
});
