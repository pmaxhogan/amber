import { spawn, type ChildProcessByStdio } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Minimal hardened git spawn helper for the read-only serving paths (the smart
 * HTTP remote and the export endpoints).
 *
 * Nothing here ever takes a credential, a remote, or a network protocol, which
 * is the property that keeps the serving paths independent of the fetch
 * credential machinery in sync/gitCli.ts.
 *
 * TODO: fold this into sync/gitCli.ts. Both wrappers scrub the environment,
 * pin a kill timer, and track children for shutdown, and gitCli's spawnGit is
 * already written as the streaming variant for upload-pack. The merge was
 * deferred because it is not a rename; whoever does it must handle all of:
 *
 *  - Two consumers, not one: gitremote/routes.ts AND export/archive.ts, which
 *    uses runGitOk and spawnGit for git archive, cat-file and ls-tree.
 *  - Return type. spawnGit here returns ChildProcessByStdio<Writable, Readable,
 *    Readable>, so child.stdin/stdout/stderr are non-null. gitCli's returns a
 *    bare ChildProcess, where all three are nullable; gitremote pipes the
 *    request body into stdin and streams stdout straight back, so every site
 *    needs a null check or a typed wrapper.
 *  - maxBuffer. 64MB here vs 4MB in gitCli. A large repository's ref
 *    advertisement can exceed 4MB, so gitCli's cap has to be raised or made
 *    per-call before anything serves through it.
 *  - Four renamed exports the tests and callers use: liveGitProcessCount ->
 *    activeGitProcessCount, GitSpawnError -> GitError, runGitCapture/runGitOk
 *    -> runGit, and buildGitEnv, which gitCli keeps private as buildEnv.
 *  - gitCli's spawnGit calls ensureGitRuntime(stateDir), so the serving paths
 *    would gain a state-directory dependency they do not have today. Note the
 *    flip side: that also means ensureGitRuntime does NOT currently harden the
 *    serving paths, which do their own env scrubbing in buildGitEnv.
 *
 * gitRemote.test.ts, gitRemoteUnits.test.ts and export.test.ts all exercise
 * this module directly and must stay green through the swap.
 */

export interface GitSpawnOptions {
  cwd?: string;
  /** Extra environment on top of the pinned hardening set. */
  env?: Record<string, string>;
  /** Hard kill timer. */
  timeoutMs?: number;
}

export const DEFAULT_PLUMBING_TIMEOUT_MS = 10 * 60 * 1000;
/** Serving a clone of a large repository legitimately takes a while. */
export const DEFAULT_UPLOAD_PACK_TIMEOUT_MS = 60 * 60 * 1000;

/** Cap on the buffered variant, so a hostile repo cannot exhaust memory. */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * A path that does not exist. git skips a configured config file that is
 * missing, which is the portable way to say "read no user or system config".
 */
const NO_CONFIG_FILE = join(tmpdir(), "amber-no-such-gitconfig");

/**
 * Every git invocation runs with the ambient environment scrubbed of GIT_*
 * leakage from the parent process and with config discovery disabled, so a
 * stray ~/.gitconfig on the host cannot change what Amber serves.
 */
export function buildGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_")) {
      continue;
    }
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = NO_CONFIG_FILE;
  env.GIT_CONFIG_SYSTEM = NO_CONFIG_FILE;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  // Nothing on these paths talks to a network, but if a repository config ever
  // tried to, only http(s) would be permitted.
  env.GIT_ALLOW_PROTOCOL = "https:http";
  return { ...env, ...extra };
}

export type GitChild = ChildProcessByStdio<Writable, Readable, Readable>;

const live = new Set<GitChild>();

/** Test and shutdown hook: how many git children are still running. */
export function liveGitProcessCount(): number {
  return live.size;
}

/** Kill every tracked child. Used on shutdown. */
export function killLiveGitProcesses(): void {
  for (const child of live) {
    child.kill("SIGKILL");
  }
}

export class GitSpawnError extends Error {
  override readonly name = "GitSpawnError";
  readonly code: number | null;
  readonly stderr: string;

  // Fields are assigned explicitly rather than declared as constructor
  // parameter properties: node runs TypeScript in strip-only mode, which
  // rejects that syntax, and `npm run dev` runs this file directly.
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Spawn git with an argument array. Never a shell, never an interpolated
 * command string, and callers pass only values they have already validated.
 */
export function spawnGit(args: readonly string[], options: GitSpawnOptions = {}): GitChild {
  const child = spawn("git", [...args], {
    cwd: options.cwd,
    env: buildGitEnv(options.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  }) as GitChild;

  live.add(child);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLUMBING_TIMEOUT_MS;
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();

  child.once("close", () => {
    clearTimeout(timer);
    live.delete(child);
  });
  child.once("error", () => {
    clearTimeout(timer);
    live.delete(child);
  });

  return child;
}

export interface GitCaptureResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** Run git and buffer stdout. For bounded plumbing output only. */
export async function runGitCapture(
  args: readonly string[],
  options: GitSpawnOptions & { maxBufferBytes?: number } = {},
): Promise<GitCaptureResult> {
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const child = spawnGit(args, options);

  return await new Promise<GitCaptureResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        fail(new GitSpawnError(`git ${args[0] ?? ""} produced too much output`, null, stderr));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error: Error) => {
      fail(new GitSpawnError(`Failed to run git: ${error.message}`, null, stderr));
    });
    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ stdout: Buffer.concat(stdout), stderr, code: code ?? -1 });
    });
  });
}

/** Same as runGitCapture but throws unless git exited 0. */
export async function runGitOk(
  args: readonly string[],
  options: GitSpawnOptions & { maxBufferBytes?: number } = {},
): Promise<GitCaptureResult> {
  const result = await runGitCapture(args, options);
  if (result.code !== 0) {
    throw new GitSpawnError(
      `git ${args.join(" ")} exited with ${String(result.code)}`,
      result.code,
      result.stderr.trim(),
    );
  }
  return result;
}
