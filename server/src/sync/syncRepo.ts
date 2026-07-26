import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AmberEventType,
  CloneMode,
  ResolvedSettings,
  SyncErrorKind,
  SyncOutcome,
  SyncRun,
} from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { getCredential, markAccountUsed } from "../domain/accounts.ts";
import { resolveSettings } from "../domain/settings.ts";
import { createConsoleLogger } from "../logging.ts";
import { backoffDelayMs, jitteredIntervalMs, RATE_LIMIT_BACKOFF_FACTOR } from "./backoff.ts";
import { directorySizeBytes } from "./diskUsage.ts";
import {
  classifyGitFailure,
  expectedHostForRemote,
  GitError,
  runGit,
  scrubCredentials,
  type GitRunOptions,
} from "./gitCli.ts";
import {
  applyRunToRepo,
  enforceRunRetention,
  finishSyncRun,
  loadSyncTarget,
  resolveRepoAccount,
  startSyncRun,
  type RepoAccount,
  type SyncForgeRow,
  type SyncTarget,
} from "./repoStore.ts";

/**
 * One repo, one sync. Honors clone_mode (bare/mirror/shallow/full), LFS, and
 * paranoid mode (archive-then-update ordering into refs/amber/archive/<ts>/).
 *
 * Everything the engine touches outside its own module is injectable, so a
 * sync can be exercised end to end against a local origin without the REST
 * layer, the settings resolver or the credential store existing yet.
 */

export interface GitCredentials {
  username: string;
  password: string;
}

/** Structural subset of EventBus, so the sync engine never imports it. */
export interface SyncEventPublisher {
  publish(type: AmberEventType, payload?: Record<string, unknown>): void;
}

export type SettingsResolver = (db: Db, repoId: number) => ResolvedSettings;
export type CredentialResolver = (db: Db, target: SyncTarget) => GitCredentials | undefined;

export interface SyncRepoDeps {
  repoId: number;
  /** Set for a manual sync so it can jump the queue. */
  manual?: boolean;
  db: Db;
  backupsDir: string;
  /** Where the scrubbed HOME and the askpass helper live. */
  stateDir?: string;
  logger?: Logger;
  events?: SyncEventPublisher;
  /** AES key for stored account secrets; only used by the default resolver. */
  secretKey?: Buffer | null;
  settings?: SettingsResolver;
  credentials?: CredentialResolver;
  /** Overrides the URL built from the forge. The torture suite points it at file://. */
  remoteUrl?: string;
  /** Test-only: allow file:// origins through GIT_ALLOW_PROTOCOL. */
  allowFileProtocol?: boolean;
  now?: () => number;
  random?: () => number;
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

export const ARCHIVE_REF_PREFIX = "refs/amber/archive";

const MAX_STORED_ERROR_CHARS = 2000;

let fallbackLogger: Logger | undefined;

function loggerFor(deps: SyncRepoDeps): Logger {
  if (deps.logger !== undefined) {
    return deps.logger;
  }
  fallbackLogger ??= createConsoleLogger("silent");
  return fallbackLogger;
}

/** Credential-free clone URL for a repo. Auth always travels via askpass. */
export function buildRemoteUrl(forge: SyncForgeRow, repoPath: string): string {
  const port = forge.port === null ? "" : `:${String(forge.port)}`;
  return `${forge.protocol}://${forge.host}${port}/${repoPath}.git`;
}

export function repoDir(backupsDir: string, slug: string): string {
  return join(backupsDir, slug);
}

/** Map git stderr and HTTP codes onto the sync_runs.error_kind vocabulary. */
export function classifyGitError(stderr: string, code: number): SyncErrorKind {
  return classifyGitFailure(stderr, code);
}

/** yyyymmddThhmmssZ, the archive namespace component. */
export function archiveStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Default credential resolution
// ---------------------------------------------------------------------------

/**
 * The credential for an already-resolved account, or undefined when the
 * account stores no secret (an anonymous fetch). Decryption lives in
 * domain/accounts.ts getCredential, which raises a clear error when a secret
 * exists but AMBER_SECRET_KEY does not.
 *
 * Marking the account used is deliberately NOT done here: an account is
 * "used" when a fetch with its credential actually succeeded, not when the
 * password was read out of the database. performSync does it after the fetch.
 */
function credentialForAccount(
  db: Db,
  secretKey: Buffer | null,
  account: RepoAccount | undefined,
): GitCredentials | undefined {
  if (account === undefined) {
    return undefined;
  }
  const credential = getCredential(db, secretKey, account.id);
  if (credential.secret === null) {
    return undefined;
  }
  return { username: credential.username, password: credential.secret };
}

export function createCredentialResolver(secretKey: Buffer | null): CredentialResolver {
  return (db, target) => credentialForAccount(db, secretKey, resolveRepoAccount(db, target));
}

// ---------------------------------------------------------------------------
// git-lfs availability, probed once per process
// ---------------------------------------------------------------------------

let lfsProbe: Promise<boolean> | undefined;

export function resetLfsProbe(): void {
  lfsProbe = undefined;
}

export async function isGitLfsAvailable(options: GitRunOptions = {}): Promise<boolean> {
  lfsProbe ??= runGit(["lfs", "version"], {
    ...options,
    allowFailure: true,
    timeoutMs: 60_000,
  })
    .then((result) => result.code === 0)
    .catch(() => false);
  return lfsProbe;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

interface SyncStats {
  refsChanged: number | null;
  bytesFetched: number | null;
  paranoidArchived: number | null;
  defaultBranch: string | null;
  lastFetchHead: string | null;
}

const EMPTY_STATS: SyncStats = {
  refsChanged: null,
  bytesFetched: null,
  paranoidArchived: null,
  defaultBranch: null,
  lastFetchHead: null,
};

export async function syncRepo(deps: SyncRepoDeps): Promise<SyncRun> {
  const { db, repoId } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = loggerFor(deps).child({ mod: "sync", repoId });

  const target = loadSyncTarget(db, repoId);
  if (target === undefined) {
    throw new Error(`Cannot sync repo ${String(repoId)}: it does not exist`);
  }
  const settings = (deps.settings ?? resolveSettings)(db, repoId);

  const startedAt = now();
  const runId = startSyncRun(db, repoId, startedAt);
  deps.events?.publish("sync.started", {
    repoId,
    runId,
    manual: deps.manual === true,
    slug: target.repo.slug,
  });
  log.info({ runId, mode: settings.clone_mode, paranoid: settings.paranoid }, "sync started");

  let outcome: SyncOutcome = "success";
  let stats: SyncStats = EMPTY_STATS;
  let error: string | null = null;
  let errorKind: SyncErrorKind | null = null;

  const dir = repoDir(deps.backupsDir, target.repo.slug);

  try {
    stats = await performSync(deps, target, settings, log);
  } catch (cause) {
    outcome = "error";
    errorKind = cause instanceof GitError ? cause.kind : "other";
    error = scrubCredentials(cause instanceof Error ? cause.message : String(cause)).slice(
      0,
      MAX_STORED_ERROR_CHARS,
    );
    log.warn({ runId, errorKind, err: error }, "sync failed");
  }

  let diskUsageBytes: number | null = null;
  try {
    if (existsSync(dir)) {
      diskUsageBytes = await directorySizeBytes(dir);
    }
  } catch {
    // Disk usage is a nicety; never fail a good sync over it.
  }

  const finishedAt = now();
  const intervalMs = settings.sync_interval_minutes * 60_000;
  const consecutiveFailures = outcome === "success" ? 0 : target.repo.consecutiveFailures + 1;
  const nextSyncAt =
    outcome === "success"
      ? finishedAt + jitteredIntervalMs(intervalMs, random)
      : finishedAt +
        backoffDelayMs(consecutiveFailures, intervalMs, random) *
          (errorKind === "rate_limited" ? RATE_LIMIT_BACKOFF_FACTOR : 1);

  const run = db.tx(() => {
    const finished = finishSyncRun(db, runId, {
      finishedAt,
      outcome,
      error,
      errorKind,
      bytesFetched: stats.bytesFetched,
      durationMs: finishedAt - startedAt,
      refsChanged: stats.refsChanged,
      paranoidArchived: stats.paranoidArchived,
    });
    applyRunToRepo(db, repoId, {
      now: finishedAt,
      outcome,
      error,
      nextSyncAt,
      consecutiveFailures,
      diskUsageBytes,
      defaultBranch: stats.defaultBranch ?? target.repo.defaultBranch,
      lastFetchHead: stats.lastFetchHead,
    });
    enforceRunRetention(db, repoId, finishedAt);
    return finished;
  });

  deps.events?.publish("sync.finished", {
    repoId,
    runId,
    outcome,
    errorKind,
    durationMs: run.durationMs,
    refsChanged: run.refsChanged,
    paranoidArchived: run.paranoidArchived,
    diskUsageBytes,
    slug: target.repo.slug,
  });
  log.info({ runId, outcome, refsChanged: run.refsChanged }, "sync finished");

  return run;
}

async function performSync(
  deps: SyncRepoDeps,
  target: SyncTarget,
  settings: ResolvedSettings,
  log: Logger,
): Promise<SyncStats> {
  const now = deps.now ?? Date.now;
  const mode: CloneMode = settings.clone_mode;
  const dir = repoDir(deps.backupsDir, target.repo.slug);
  const remote = deps.remoteUrl ?? buildRemoteUrl(target.forge, target.repo.path);
  // Resolved once: the same account backs the credential presented to the
  // fetch and the last_used_at stamp written after it succeeds.
  const account = resolveRepoAccount(deps.db, target);
  const credentials =
    deps.credentials === undefined
      ? credentialForAccount(deps.db, deps.secretKey ?? null, account)
      : deps.credentials(deps.db, target);

  const base: GitRunOptions = {
    cwd: dir,
    logger: log,
    stateDir: deps.stateDir,
    allowFileProtocol: deps.allowFileProtocol,
  };
  const authed: GitRunOptions = /^https?:\/\//i.test(remote)
    ? {
        ...base,
        credentials,
        expectedHost: expectedHostForRemote(remote),
      }
    : base;

  await mkdir(deps.backupsDir, { recursive: true });
  const layout = await ensureRepo(dir, mode, base);
  const localConfig = await readLocalConfig(base);
  await ensureRemote(localConfig, remote, base);
  await applyParanoidConfig(localConfig, settings.paranoid, base);

  const defaultBranch = await readDefaultBranch(authed, log);

  const before = await readRefs(base);
  const hasArchives = [...before.keys()].some((ref) => ref.startsWith(`${ARCHIVE_REF_PREFIX}/`));

  const fetchResult = await runGit(
    buildFetchArgs(mode, settings, {
      paranoid: settings.paranoid,
      prune: !settings.paranoid && !hasArchives,
      worktree: layout === "worktree",
    }),
    authed,
  );
  const bytesFetched = parseBytesFetched(fetchResult.stderr);

  // The fetch came back, so this account's credential demonstrably works.
  // Recorded here rather than at resolution time so a stored secret that the
  // forge rejects never looks freshly used.
  if (credentials !== undefined && account !== undefined) {
    markAccountUsed(deps.db, account.id, now());
  }

  const after = await readRefs(base);

  let paranoidArchived: number | null = null;
  if (settings.paranoid) {
    paranoidArchived = await archiveLostTips(before, after, archiveStamp(now()), base, log);
  }

  if (settings.lfs_enabled) {
    await fetchLfs(settings.paranoid, defaultBranch, authed, log);
  }

  if (mode === "full" && layout === "worktree") {
    await updateWorkingTree(defaultBranch, after, settings.lfs_enabled, base, log);
  }

  const refsChanged = countChangedRefs(before, after);
  const lastFetchHead =
    defaultBranch === null ? null : (after.get(`refs/heads/${defaultBranch}`) ?? null);

  return { refsChanged, bytesFetched, paranoidArchived, defaultBranch, lastFetchHead };
}

// ---------------------------------------------------------------------------
// Repository setup
// ---------------------------------------------------------------------------

type Layout = "bare" | "worktree";

function detectLayout(dir: string): Layout | undefined {
  if (existsSync(join(dir, ".git"))) {
    return "worktree";
  }
  if (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"))) {
    return "bare";
  }
  return undefined;
}

async function ensureRepo(dir: string, mode: CloneMode, base: GitRunOptions): Promise<Layout> {
  const existing = detectLayout(dir);
  if (existing !== undefined) {
    return existing;
  }
  await mkdir(dir, { recursive: true });
  const wantWorktree = mode === "full";
  await runGit(wantWorktree ? ["init"] : ["init", "--bare"], base);
  return wantWorktree ? "worktree" : "bare";
}

async function readLocalConfig(base: GitRunOptions): Promise<Map<string, string>> {
  const listed = await runGit(["config", "--local", "--list"], { ...base, allowFailure: true });
  const current = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      current.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
    }
  }
  return current;
}

/**
 * The remote is a bare url with no configured fetch refspec. Every fetch names
 * its refspecs explicitly, and a configured one would make git opportunistically
 * mirror everything a second time into refs/remotes/origin/.
 */
async function ensureRemote(
  current: Map<string, string>,
  remote: string,
  base: GitRunOptions,
): Promise<void> {
  if (current.get("remote.origin.url") !== remote) {
    await runGit(["config", "--local", "remote.origin.url", remote], base);
  }
  if (current.has("remote.origin.fetch")) {
    await runGit(["config", "--local", "--unset-all", "remote.origin.fetch"], {
      ...base,
      allowFailure: true,
    });
  }
}

/**
 * Paranoid repos never garbage collect, never prune and always keep reflogs.
 * The config is read first so a steady state sync writes nothing.
 */
async function applyParanoidConfig(
  current: Map<string, string>,
  paranoid: boolean,
  base: GitRunOptions,
): Promise<void> {
  for (const [key, value] of Object.entries(PARANOID_GIT_CONFIG)) {
    const present = current.get(key.toLowerCase());
    if (paranoid) {
      if (present !== value) {
        await runGit(["config", "--local", key, value], base);
      }
    } else if (present !== undefined) {
      await runGit(["config", "--local", "--unset-all", key], { ...base, allowFailure: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export function refspecsFor(mode: CloneMode): string[] {
  return mode === "mirror"
    ? ["+refs/*:refs/*"]
    : ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
}

function buildFetchArgs(
  mode: CloneMode,
  settings: ResolvedSettings,
  flags: { paranoid: boolean; prune: boolean; worktree: boolean },
): string[] {
  const args = ["fetch", "--progress", "--force"];
  if (flags.paranoid) {
    args.push("--no-prune");
  } else if (flags.prune) {
    args.push("--prune");
  }
  if (mode === "shallow") {
    args.push("--depth", String(settings.shallow_depth));
  }
  if (flags.worktree) {
    // The working tree is rebuilt from the fetched tip immediately afterwards,
    // so the "would clobber the checked out branch" guard has nothing to protect.
    args.push("--update-head-ok");
  }
  args.push("origin", ...refspecsFor(mode));
  return args;
}

const RECEIVING = /Receiving objects:\s+\d+%\s+\([^)]*\),\s+([\d.]+)\s+(B|KiB|MiB|GiB|TiB)/g;
const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** git only prints a byte count when it actually transferred a pack. */
export function parseBytesFetched(stderr: string): number | null {
  let bytes: number | null = null;
  RECEIVING.lastIndex = 0;
  let match = RECEIVING.exec(stderr);
  while (match !== null) {
    const amount = Number.parseFloat(match[1] ?? "");
    const unit = UNIT_BYTES[match[2] ?? ""];
    if (Number.isFinite(amount) && unit !== undefined) {
      bytes = Math.round(amount * unit);
    }
    match = RECEIVING.exec(stderr);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export async function readRefs(base: GitRunOptions): Promise<Map<string, string>> {
  const result = await runGit(["for-each-ref", "--format=%(objectname) %(refname)"], base);
  const refs = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) {
      refs.set(line.slice(space + 1).trim(), line.slice(0, space));
    }
  }
  return refs;
}

function countChangedRefs(before: Map<string, string>, after: Map<string, string>): number {
  let changed = 0;
  const seen = new Set<string>();
  for (const [ref, sha] of before) {
    if (ref.startsWith(`${ARCHIVE_REF_PREFIX}/`)) {
      continue;
    }
    seen.add(ref);
    if (after.get(ref) !== sha) {
      changed += 1;
    }
  }
  for (const ref of after.keys()) {
    if (!ref.startsWith(`${ARCHIVE_REF_PREFIX}/`) && !seen.has(ref)) {
      changed += 1;
    }
  }
  return changed;
}

async function readDefaultBranch(authed: GitRunOptions, log: Logger): Promise<string | null> {
  const result = await runGit(["ls-remote", "--symref", "origin", "HEAD"], {
    ...authed,
    allowFailure: true,
  });
  if (result.code !== 0) {
    log.debug({ code: result.code }, "could not read the default branch from the origin");
    return null;
  }
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(result.stdout);
  return match?.[1] ?? null;
}

/**
 * Paranoid archival. Every ref tip that upstream rewrote (the old tip is not an
 * ancestor of the new one) or dropped entirely is written to
 * refs/amber/archive/<utc stamp>/<original ref path> so it stays reachable
 * forever. Tags archive on any change at all: a retagged annotated tag can
 * point at the same commit through a brand new tag object, and the ancestry
 * test would wave that through.
 *
 * Deviation from ARCHITECTURE.md worth knowing before "fixing" it: the doc
 * also describes archiving a ref "which vanished upstream while we still have
 * it". Paranoid mode never prunes, so a ref the origin deleted does not change
 * locally at all: the local ref IS the preserved tip, and an archive copy of a
 * ref that still exists would be noise. The only way to detect an upstream
 * deletion would be an extra ls-remote round trip per sync, which buys no
 * durability. The vanished branch here is the one where a previous
 * non-paranoid sync pruned before paranoid mode was turned on.
 */
async function archiveLostTips(
  before: Map<string, string>,
  after: Map<string, string>,
  stamp: string,
  base: GitRunOptions,
  log: Logger,
): Promise<number> {
  const updates: string[] = [];
  const taken = new Set<string>(after.keys());

  for (const [ref, oldSha] of before) {
    if (ref.startsWith(`${ARCHIVE_REF_PREFIX}/`)) {
      continue;
    }
    const newSha = after.get(ref);
    if (newSha === oldSha) {
      continue;
    }
    const rewritten =
      newSha === undefined ||
      ref.startsWith("refs/tags/") ||
      !(await isAncestor(oldSha, newSha, base));
    if (!rewritten) {
      continue;
    }

    let name = `${ARCHIVE_REF_PREFIX}/${stamp}/${ref}`;
    let suffix = 1;
    while (taken.has(name)) {
      suffix += 1;
      name = `${ARCHIVE_REF_PREFIX}/${stamp}/${ref}-${String(suffix)}`;
    }
    taken.add(name);
    updates.push(`update ${name} ${oldSha}`);
    log.info({ ref, oldSha, archive: name }, "archiving a rewritten ref tip");
  }

  if (updates.length === 0) {
    return 0;
  }
  const batch = await runGit(["update-ref", "--stdin"], {
    ...base,
    stdin: `${updates.join("\n")}\n`,
    allowFailure: true,
  });
  if (batch.code === 0) {
    return updates.length;
  }

  // One bad name (a directory/file clash between two archived refs) would fail
  // the whole transaction, and losing every archive because of one of them is
  // exactly the outcome paranoid mode exists to prevent. Retry individually.
  log.warn({ stderr: batch.stderr.trim() }, "batched archive failed, retrying one ref at a time");
  let written = 0;
  for (const update of updates) {
    const [, name, sha] = update.split(" ");
    if (name === undefined || sha === undefined) {
      continue;
    }
    const single = await runGit(["update-ref", name, sha], { ...base, allowFailure: true });
    if (single.code === 0) {
      written += 1;
    } else {
      log.error({ ref: name, sha }, "could not archive a ref tip");
    }
  }
  return written;
}

async function isAncestor(oldSha: string, newSha: string, base: GitRunOptions): Promise<boolean> {
  const result = await runGit(["merge-base", "--is-ancestor", oldSha, newSha], {
    ...base,
    allowFailure: true,
  });
  // 0 means ancestor, 1 means not; anything else (a tagged blob, a broken
  // object) is treated as "not", because archiving too much is harmless.
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// LFS and working trees
// ---------------------------------------------------------------------------

async function fetchLfs(
  paranoid: boolean,
  defaultBranch: string | null,
  authed: GitRunOptions,
  log: Logger,
): Promise<void> {
  if (!(await isGitLfsAvailable({ stateDir: authed.stateDir }))) {
    log.warn("git-lfs is not installed; skipping LFS objects for this repository");
    return;
  }
  const args =
    paranoid || defaultBranch === null
      ? ["lfs", "fetch", "--all", "origin"]
      : ["lfs", "fetch", "origin", defaultBranch];
  const result = await runGit(args, { ...authed, allowFailure: true });
  if (result.code !== 0) {
    // Deliberately not fatal. In paranoid mode --all covers the archived refs
    // too, so an object the origin has already deleted makes git-lfs exit
    // non-zero on every future sync. Failing the run would mean a repository
    // whose upstream rewrote one LFS object could never record a success again,
    // even though its git history is being backed up perfectly.
    log.warn(
      { stderr: scrubCredentials(result.stderr).slice(0, 1000) },
      "git lfs fetch reported errors; some LFS objects may be missing upstream",
    );
  }
}

async function updateWorkingTree(
  defaultBranch: string | null,
  after: Map<string, string>,
  lfsEnabled: boolean,
  base: GitRunOptions,
  log: Logger,
): Promise<void> {
  if (defaultBranch === null || !after.has(`refs/heads/${defaultBranch}`)) {
    log.warn({ defaultBranch }, "no default branch to check out; leaving the working tree alone");
    return;
  }
  const worktree: GitRunOptions = { ...base, workingTree: true };
  await runGit(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], worktree);
  await runGit(["reset", "--hard", "--quiet"], worktree);
  if (lfsEnabled && (await isGitLfsAvailable({ stateDir: base.stateDir }))) {
    await runGit(["lfs", "checkout"], worktree);
  }
}
