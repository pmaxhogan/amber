import type { SyncErrorKind, SyncRun } from "@amber/shared";
import { notImplemented } from "../notImplemented.ts";

export interface SyncRepoDeps {
  repoId: number;
  /** Set for a manual sync so it can jump the queue. */
  manual?: boolean;
}

/**
 * One repo, one sync. Honors clone_mode (bare/mirror/shallow/full), LFS, and
 * paranoid mode (archive-then-update ordering into refs/amber/archive/<ts>/).
 */
export function syncRepo(_deps: SyncRepoDeps): Promise<SyncRun> {
  return notImplemented("syncRepo");
}

/** Map git stderr and HTTP codes onto the sync_runs.error_kind vocabulary. */
export function classifyGitError(_stderr: string, _code: number): SyncErrorKind {
  return notImplemented("classifyGitError");
}

/** Repo-level git config applied once when paranoid mode is turned on. */
export const PARANOID_GIT_CONFIG: Readonly<Record<string, string>> = {
  "gc.auto": "0",
  "gc.pruneExpire": "never",
  "gc.reflogExpireUnreachable": "never",
  "gc.reflogExpire": "never",
  "core.logAllRefUpdates": "always",
  "fetch.prune": "false",
};
