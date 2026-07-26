import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type AmberApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { openDb, type Db } from "../../src/db/db.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createConsoleLogger } from "../../src/logging.ts";

/**
 * Integration test scaffolding: real git repositories in temp directories, a
 * real sqlite file, and a real listening Fastify server. Nothing here mocks
 * git, the database, or HTTP.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The developer machine's git identity, credential helper, and global config
 * must not leak into a test. Every git invocation runs with config discovery
 * disabled and prompting off, or a wrong-password clone would block on a
 * credential dialog until the test timed out.
 */
export function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(tmpdir(), "amber-tests-no-such-gitconfig"),
    GIT_CONFIG_SYSTEM: join(tmpdir(), "amber-tests-no-such-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_AUTHOR_NAME: "Amber Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Amber Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    ...extra,
  };
}

export async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? cleanGitEnv(),
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : (error.code ?? 1);
        resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
      },
    );
  });
}

export async function git(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return await run("git", args, options);
}

export async function gitOk(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${String(result.code)}): ${result.stderr}`);
  }
  return result;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `amber-${prefix}-`));
}

export interface Fixture {
  /** Working repository the bare backup was cloned from. */
  sourceDir: string;
  /** Bare directory Amber serves and exports, named after the slug. */
  bareDir: string;
  slug: string;
  headSha: string;
  firstSha: string;
  files: Record<string, string>;
}

export const FIXTURE_FILES: Record<string, string> = {
  "README.md": "# amber fixture\n\nsecond line\n",
  "src/index.ts": 'export const value = 42;\nexport const name = "amber";\n',
  "docs/notes.txt": "notes about the fixture\n",
  "sp ace.txt": "a file whose name contains a space\n",
};

/**
 * Build a real repository with a couple of commits, a tag and a second branch,
 * then mirror it into a bare directory under backupsDir, exactly as the sync
 * engine would leave it.
 */
export async function createRepoFixture(backupsDir: string, slug: string): Promise<Fixture> {
  const root = tempDir("fixture");
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  await gitOk(["init", "-q", "-b", "main"], { cwd: sourceDir });

  writeFileSync(join(sourceDir, "README.md"), "# amber fixture\n");
  await gitOk(["add", "-A"], { cwd: sourceDir });
  await gitOk(["commit", "-qm", "first"], { cwd: sourceDir });
  const firstSha = (await gitOk(["rev-parse", "HEAD"], { cwd: sourceDir })).stdout.trim();

  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    const target = join(sourceDir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  await gitOk(["add", "-A"], { cwd: sourceDir });
  await gitOk(["commit", "-qm", "second"], { cwd: sourceDir });
  await gitOk(["tag", "v1.0.0"], { cwd: sourceDir });
  await gitOk(["branch", "topic"], { cwd: sourceDir });
  const headSha = (await gitOk(["rev-parse", "HEAD"], { cwd: sourceDir })).stdout.trim();

  mkdirSync(backupsDir, { recursive: true });
  const bareDir = join(backupsDir, slug);
  await gitOk(["clone", "-q", "--bare", sourceDir, bareDir]);
  // The sync engine writes archives under refs/amber; the gitdir export has to
  // carry them, so the fixture has one.
  await gitOk(["update-ref", `refs/amber/archive/20260101T000000Z/refs/heads/main`, firstSha], {
    cwd: bareDir,
  });

  return { sourceDir, bareDir, slug, headSha, firstSha, files: FIXTURE_FILES };
}

export interface TestServer {
  app: AmberApp;
  db: Db;
  dataDir: string;
  backupsDir: string;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boot the app on an ephemeral port in insecure mode, which skips CF Access. */
export async function startTestServer(): Promise<TestServer> {
  const dataDir = tempDir("server");
  const config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: dataDir,
    PUBLIC_ORIGIN: "https://amber.example.com",
  });
  const log = createConsoleLogger("silent");
  const db = openDb(join(dataDir, "state", "amber.db"));
  migrate(db, log);
  const app = await buildApp({ config, log, db, version: "test" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  mkdirSync(config.backupsDir, { recursive: true });

  return {
    app,
    db,
    dataDir,
    backupsDir: config.backupsDir,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/** Insert the forge and repo rows the serving paths look up. */
export function insertRepoRow(
  db: Db,
  options: { slug: string; path?: string; displayName?: string; defaultBranch?: string | null },
): number {
  const now = Date.now();
  const forge = db.get<{ id: number }>("SELECT id FROM forges WHERE host = ?", "fixture.invalid");
  const forgeId =
    forge?.id ??
    db.run(
      `INSERT INTO forges (protocol, host, port, kind, created_at, updated_at)
       VALUES ('https', 'fixture.invalid', NULL, 'generic', ?, ?)`,
      now,
      now,
    ).lastInsertRowid;

  const path = options.path ?? `fixtures/${options.slug}`;
  const result = db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, state, consecutive_failures,
                        default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    forgeId,
    path,
    options.displayName ?? options.slug,
    options.slug,
    options.slug.slice(-8).padStart(8, "x"),
    options.defaultBranch === undefined ? "main" : options.defaultBranch,
    now,
    now,
  );
  return result.lastInsertRowid;
}

/** Enable the git remote through the real admin API and return the password. */
export async function enableRemote(server: TestServer): Promise<{
  username: string;
  password: string;
}> {
  const response = await server.app.inject({ method: "POST", url: "/api/git-remote/enable" });
  if (response.statusCode !== 200) {
    throw new Error(`enable failed: ${String(response.statusCode)} ${response.body}`);
  }
  const body = response.json() as { username: string; password: string };
  return { username: body.username, password: body.password };
}

