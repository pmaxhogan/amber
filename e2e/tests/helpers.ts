import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";

const run = promisify(execFile);

/** A small, stable, genuinely public repo. Two commits and no LFS. */
export const FIXTURE_REPO = "https://github.com/octocat/Hello-World";
export const FIXTURE_PATH = "octocat/Hello-World";

export interface RepoRow {
  id: number;
  path: string;
  slug: string;
  lastSuccessAt: number | null;
  lastError: string | null;
  diskUsageBytes: number | null;
  cloneMode?: string;
  lastOutcome?: string;
}

/** Read the listing straight from the API, for polling that a sync landed. */
export async function fetchRepos(request: APIRequestContext): Promise<RepoRow[]> {
  const response = await request.get("/api/repos?perPage=200");
  if (!response.ok()) {
    throw new Error(`GET /api/repos failed with ${String(response.status())}`);
  }
  const body = (await response.json()) as { rows: RepoRow[] };
  return body.rows;
}

/**
 * Poll until the named repo reports a successful sync. A first clone over the
 * network is the slow step, so this is generous; it fails loudly with the
 * recorded error rather than timing out silently on a repo that errored.
 */
export async function waitForFirstSync(
  request: APIRequestContext,
  path: string,
  timeoutMs = 120_000,
): Promise<RepoRow> {
  const deadline = Date.now() + timeoutMs;
  let last: RepoRow | undefined;
  while (Date.now() < deadline) {
    const rows = await fetchRepos(request);
    last = rows.find((row) => row.path === path);
    if (last?.lastSuccessAt != null) {
      return last;
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  const detail = last?.lastError ?? "the repo never appeared in the listing";
  throw new Error(`${path} did not sync within ${String(timeoutMs)}ms: ${detail}`);
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git with a scrubbed environment so the developer's own credential
 * helpers, proxies, and askpass never take part in a test.
 */
export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(cause),
    };
  }
}

/** A temp directory that the caller is expected to clean up. */
export function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `amber-e2e-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
