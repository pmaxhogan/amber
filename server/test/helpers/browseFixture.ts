import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanGitEnv,
  gitOk,
  insertRepoRow,
  startTestServer,
  tempDir,
  type TestServer,
} from "./gitFixture.ts";

/**
 * Real repositories for the browse tests. A `Work` is a working repository
 * with a deterministic clock; `publish` mirrors it into the backups directory
 * as a bare repo, the way the sync engine leaves one, and adds the database
 * row the routes look up.
 */

export interface Work {
  dir: string;
  git(args: readonly string[]): Promise<string>;
  write(path: string, content: string | Buffer): void;
  /** Stage everything and commit; returns the new commit id. */
  commit(message: string): Promise<string>;
  head(): Promise<string>;
}

export async function createWork(
  options: { objectFormat?: "sha1" | "sha256" } = {},
): Promise<Work> {
  const dir = join(tempDir("browse-work"), "work");
  mkdirSync(dir, { recursive: true });
  const format = options.objectFormat ?? "sha1";
  await gitOk(["init", "-q", "-b", "main", `--object-format=${format}`], { cwd: dir });
  let clock = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;

  const git = async (args: readonly string[]): Promise<string> => {
    clock += 60;
    const stamp = `${String(clock)} +0000`;
    const env = cleanGitEnv({ GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
    return (await gitOk(args, { cwd: dir, env })).stdout;
  };

  return {
    dir,
    git,
    write(path, content) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    async commit(message) {
      await git(["add", "-A"]);
      await git(["commit", "-q", "--allow-empty", "-m", message]);
      return (await git(["rev-parse", "HEAD"])).trim();
    },
    async head() {
      return (await git(["rev-parse", "HEAD"])).trim();
    },
  };
}

export interface Published {
  repoId: number;
  slug: string;
  bareDir: string;
}

let counter = 0;

/** Eight distinct characters: the repos table keys its short id on the last eight of the slug. */
function suffix(): string {
  return counter.toString(16).padStart(8, "0");
}

/** Mirror `work` to a bare backup and register it. */
export async function publish(
  server: TestServer,
  work: Work,
  options: { defaultBranch?: string | null; slug?: string } = {},
): Promise<Published> {
  counter += 1;
  const slug = options.slug ?? `browse-${suffix()}`;
  const bareDir = join(server.backupsDir, slug);
  await gitOk(["clone", "-q", "--bare", work.dir, bareDir]);
  return register(server, slug, options.defaultBranch);
}

/** Add the database row for a backup directory that is already in place. */
export function register(
  server: TestServer,
  slug: string,
  defaultBranch: string | null = "main",
): Published {
  const repoId = insertRepoRow(server.db, { slug, displayName: slug, defaultBranch });
  return { repoId, slug, bareDir: join(server.backupsDir, slug) };
}

/** A repo row whose backup directory does not exist. */
export function publishWithoutDirectory(server: TestServer): number {
  counter += 1;
  return insertRepoRow(server.db, { slug: `browse-missing-${suffix()}` });
}

export interface Reply {
  status: number;
  json: unknown;
  body: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

export async function get(server: TestServer, url: string): Promise<Reply> {
  const response = await server.app.inject({ method: "GET", url });
  const json = ((): unknown => {
    try {
      return response.json();
    } catch {
      return null;
    }
  })();
  return {
    status: response.statusCode,
    json,
    body: response.rawPayload,
    headers: response.headers,
  };
}

export function browseUrl(repoId: number, endpoint: string, query: Record<string, string>): string {
  return `/api/repos/${String(repoId)}/browse/${endpoint}?${new URLSearchParams(query).toString()}`;
}

export async function startServer(): Promise<TestServer> {
  return await startTestServer();
}

export async function stopServer(server: TestServer, ...dirs: string[]): Promise<void> {
  await server.close();
  rmSync(server.dataDir, { recursive: true, force: true });
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Many empty commits in one `git fast-import`, for tests that need two object
 * ids sharing a short prefix.
 */
export async function importCommits(work: Work, count: number): Promise<void> {
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const message = `bulk ${String(index)}\n`;
    lines.push(
      "commit refs/heads/bulk",
      `mark :${String(index)}`,
      `committer Amber Test <test@example.invalid> ${String(1_700_000_000 + index)} +0000`,
      `data ${String(message.length)}`,
      message.trimEnd(),
    );
    if (index > 1) {
      lines.push(`from :${String(index - 1)}`);
    }
    lines.push("");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet"], {
      cwd: work.dir,
      env: cleanGitEnv(),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git fast-import failed: ${stderr}`));
      }
    });
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}
