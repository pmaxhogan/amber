import { PassThrough, type Readable } from "node:stream";
import { BROWSE_OID_PATTERN } from "@amber/shared";
import { spawnGit } from "../gitSpawn.ts";
import type { Logger } from "../logging.ts";

/**
 * The one way the repository browser runs git. Every call is an argument array
 * through spawnGit's scrubbed environment, and adds three guarantees the
 * buffered runGitCapture does not give:
 *
 * - output past a byte cap is cut and flagged instead of failing, and the
 *   child is killed the moment the cap is hit, so a hostile repository cannot
 *   make a request produce unbounded work;
 * - a short timeout (answered as HTTP 504);
 * - the child dies when the client goes away.
 *
 * GIT_NO_REPLACE_OBJECTS is always on, so a `refs/replace/*` ref in a mirrored
 * (hostile) repository cannot change what an object id means. GIT_LITERAL_PATHSPECS
 * is always on: a path that came from a request is
 * matched as plain text, never as a glob or `:(magic)` pathspec.
 */

export class BrowseError extends Error {
  override readonly name = "BrowseError";
  readonly statusCode: number;
  readonly code: string;

  // Not a constructor parameter property: node runs this file in strip-only
  // TypeScript mode.
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function notFound(message: string): BrowseError {
  return new BrowseError(404, "not_found", message);
}

export const BROWSE_GIT_TIMEOUT_MS = 30_000;

export interface GitCtx {
  /** The backup directory, taken from the repository row. */
  dir: string;
  /** Aborted when the client disconnects. */
  signal?: AbortSignal;
  /** Test seam; defaults to BROWSE_GIT_TIMEOUT_MS. */
  timeoutMs?: number;
  log?: Logger;
}

export interface GitRunOptions {
  /** Output past this is dropped, the child is killed, and `truncated` is set. */
  maxBytes: number;
  env?: Record<string, string>;
}

export interface GitRun {
  stdout: Buffer;
  stderr: string;
  /** Null when git was killed because the cap was reached. */
  code: number | null;
  truncated: boolean;
}

/** Most git processes the browser runs at once, across every request. */
export const BROWSE_MAX_GIT_PROCESSES = 4;

interface Waiter {
  grant: () => void;
}

/**
 * A counting gate with a FIFO queue. A slot is held for one git process, never
 * for a whole request, so a request that needs several runs cannot deadlock on
 * itself. Streaming downloads (`openBlobStream`) stay outside it: they hold a
 * process for as long as the client reads.
 */
const gate = { active: 0, queue: [] as Waiter[] };

/** Test seam: how many runs are waiting for a slot. */
export function browseGitQueueLength(): number {
  return gate.queue.length;
}

function acquireSlot(signal: AbortSignal | undefined, budgetMs: number): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new BrowseError(499, "aborted", "The request was cancelled."));
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      gate.active -= 1;
      gate.queue.shift()?.grant();
    };
    if (gate.active < BROWSE_MAX_GIT_PROCESSES) {
      gate.active += 1;
      resolve(release);
      return;
    }
    const leave = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const at = gate.queue.indexOf(waiter);
      if (at >= 0) {
        gate.queue.splice(at, 1);
      }
    };
    const waiter: Waiter = {
      grant: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        gate.active += 1;
        resolve(release);
      },
    };
    const onAbort = (): void => {
      leave();
      reject(new BrowseError(499, "aborted", "The request was cancelled."));
    };
    const timer = setTimeout(
      () => {
        leave();
        reject(new BrowseError(504, "timeout", "Reading this repository took too long."));
      },
      Math.max(budgetMs, 0),
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    gate.queue.push(waiter);
  });
}

/**
 * Run git with the browser's limits. The 30 second budget covers the wait for
 * a slot and the run itself, and a waiter whose client leaves, or whose budget
 * runs out, drops out of the queue without ever starting a process.
 */
export async function runGit(
  ctx: GitCtx,
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRun> {
  const budget = ctx.timeoutMs ?? BROWSE_GIT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const release = await acquireSlot(ctx.signal, budget);
  try {
    return await spawnAndCollect(ctx, args, options, Math.max(deadline - Date.now(), 1));
  } finally {
    release();
  }
}

function spawnAndCollect(
  ctx: GitCtx,
  args: readonly string[],
  options: GitRunOptions,
  timeoutMs: number,
): Promise<GitRun> {
  return new Promise<GitRun>((resolve, reject) => {
    if (ctx.signal?.aborted === true) {
      reject(new BrowseError(499, "aborted", "The request was cancelled."));
      return;
    }
    const child = spawnGit(["-C", ctx.dir, ...args], {
      env: { GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1", ...options.env },
      // The browser's own timer below fires first; this is the backstop.
      timeoutMs: timeoutMs + 5000,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (): void => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    };

    // git never reads stdin on these paths; closing it keeps a misbehaving
    // command from waiting on it.
    child.stdin.on("error", () => undefined);
    child.stdin.end();

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const room = options.maxBytes - bytes;
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          bytes += room;
        }
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      reject(new BrowseError(500, "git_failed", "Could not run git."));
    });
    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      if (timedOut) {
        reject(new BrowseError(504, "timeout", "Reading this repository took too long."));
        return;
      }
      if (aborted) {
        reject(new BrowseError(499, "aborted", "The request was cancelled."));
        return;
      }
      resolve({
        stdout: Buffer.concat(chunks),
        stderr,
        code: truncated ? null : code,
        truncated,
      });
    });
  });
}

/** Like runGit, but git failing is a server error rather than a result. */
export async function runGitOk(
  ctx: GitCtx,
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRun> {
  const result = await runGit(ctx, args, options);
  if (result.code !== null && result.code !== 0) {
    throw new BrowseError(500, "git_failed", "Could not read this repository.");
  }
  return result;
}

const FULL_OID = BROWSE_OID_PATTERN;

/** A caller-supplied oid reaches git only after it has matched this. */
export function isOid(value: string): boolean {
  return FULL_OID.test(value);
}

/**
 * `<oid>^{type}` as a full object id, or null when it does not exist. The
 * answer is compared with what was asked for by the callers that need an exact
 * match, so an abbreviation can never stand in for a full id.
 */
export async function peelToOid(
  ctx: GitCtx,
  hex: string,
  type: "commit" | "tree",
): Promise<string | null> {
  // The only two shapes that ever get here: lower-case hex, or the literal HEAD.
  if (!/^(?:HEAD|[0-9a-f]{4,64})$/.test(hex)) {
    return null;
  }
  const result = await runGit(
    ctx,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${hex}^{${type}}`],
    { maxBytes: 256 },
  );
  if (result.code !== 0) {
    return null;
  }
  const oid = result.stdout.toString("utf8").trim();
  return isOid(oid) ? oid : null;
}

/**
 * Confirm a full commit id names a commit in THIS backup. 404 otherwise,
 * including for a tree, blob or tag id and for the abbreviation of a longer id
 * (the other hash algorithm's length, say).
 */
export async function requireCommit(ctx: GitCtx, oid: string): Promise<void> {
  const found = await peelToOid(ctx, oid, "commit");
  if (found !== oid) {
    throw notFound("No such commit in this backup.");
  }
}

/**
 * A blob's bytes as a stream. The child is killed when the stream is destroyed,
 * which Fastify does when the client disconnects, so a closed tab does not
 * leave a `cat-file` blocked on a full pipe.
 */
export function openBlobStream(ctx: GitCtx, oid: string): Readable {
  if (!isOid(oid)) {
    throw new BrowseError(400, "bad_request", "Invalid object id");
  }
  const child = spawnGit(["-C", ctx.dir, "cat-file", "blob", oid], {
    // A backup mirrors every ref, refs/replace/* included; none may swap the
    // object a validated id names.
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
    timeoutMs: 30 * 60 * 1000,
  });
  const out = new PassThrough();
  child.stdin.on("error", () => undefined);
  child.stdin.end();
  child.stdout.pipe(out);
  child.stderr.resume();
  child.on("error", (error: Error) => out.destroy(error));
  out.on("close", () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });
  return out;
}
