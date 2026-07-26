import { notImplemented } from "../notImplemented.ts";

/**
 * The only place in the codebase that runs git. execFile with argument arrays,
 * never a shell. Credentials never enter argv or stored remote URLs: auth goes
 * through a one-shot GIT_ASKPASS script reading AMBER_GIT_USER/AMBER_GIT_PASS.
 */
export interface GitRunOptions {
  cwd?: string;
  /** Injected via askpass env, never via argv or the remote URL. */
  credentials?: { username: string; password: string };
  /** Hard kill timer. Defaults to 1h for fetch/clone, 10 min for plumbing. */
  timeoutMs?: number;
  /** Extra -c overrides on top of the pinned hardening set. */
  config?: Record<string, string>;
  env?: Record<string, string>;
  maxBufferBytes?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_PLUMBING_TIMEOUT_MS = 10 * 60 * 1000;

export function runGit(_args: readonly string[], _options?: GitRunOptions): Promise<GitResult> {
  return notImplemented("runGit");
}

/** Streaming variant for upload-pack, where stdin and stdout are piped. */
export function spawnGit(_args: readonly string[], _options?: GitRunOptions): never {
  return notImplemented("spawnGit");
}

/** Kill every tracked git child on shutdown. */
export function shutdownGit(): Promise<void> {
  return notImplemented("shutdownGit");
}
