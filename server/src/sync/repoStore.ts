import type { ForgeKind, ForgeProtocol, RepoState, SyncErrorKind, SyncRun } from "@amber/shared";
import type { Db } from "../db/db.ts";

/**
 * The narrow slice of the data model the sync engine reads and writes. It is
 * deliberately independent of domain/repos.ts: the sync engine only needs rows
 * and counters, and keeping the SQL here means a sync can run before the REST
 * layer exists.
 */

export interface SyncRepoRow {
  id: number;
  forgeId: number;
  path: string;
  displayName: string;
  slug: string;
  accountOverrideId: number | null;
  forceAnonymous: boolean;
  state: RepoState;
  nextSyncAt: number | null;
  consecutiveFailures: number;
  defaultBranch: string | null;
}

export interface SyncForgeRow {
  id: number;
  protocol: ForgeProtocol;
  host: string;
  port: number | null;
  kind: ForgeKind;
}

export interface SyncTarget {
  repo: SyncRepoRow;
  forge: SyncForgeRow;
}

export interface DueRepo {
  id: number;
  forgeId: number;
  nextSyncAt: number | null;
}

/** Keep the newest 50 runs per repo. */
export const RUN_RETENTION_COUNT = 50;
/** Error rows survive the count cap for 30 days so failures stay diagnosable. */
export const ERROR_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RepoDbRow {
  id: number;
  forge_id: number;
  path: string;
  display_name: string;
  slug: string;
  account_override_id: number | null;
  force_anonymous: number;
  state: string;
  next_sync_at: number | null;
  consecutive_failures: number;
  default_branch: string | null;
  protocol: string;
  host: string;
  port: number | null;
  kind: string;
}

const TARGET_SQL = `
  SELECT r.id, r.forge_id, r.path, r.display_name, r.slug, r.account_override_id,
         r.force_anonymous, r.state, r.next_sync_at, r.consecutive_failures,
         r.default_branch, f.protocol, f.host, f.port, f.kind
    FROM repos r
    JOIN forges f ON f.id = r.forge_id
   WHERE r.id = ?`;

export function loadSyncTarget(db: Db, repoId: number): SyncTarget | undefined {
  const row = db.get<RepoDbRow>(TARGET_SQL, repoId);
  if (row === undefined) {
    return undefined;
  }
  return {
    repo: {
      id: row.id,
      forgeId: row.forge_id,
      path: row.path,
      displayName: row.display_name,
      slug: row.slug,
      accountOverrideId: row.account_override_id,
      forceAnonymous: row.force_anonymous === 1,
      state: row.state as RepoState,
      nextSyncAt: row.next_sync_at,
      consecutiveFailures: row.consecutive_failures,
      defaultBranch: row.default_branch,
    },
    forge: {
      id: row.forge_id,
      protocol: row.protocol as ForgeProtocol,
      host: row.host,
      port: row.port,
      kind: row.kind as ForgeKind,
    },
  };
}

/** Active repos whose next_sync_at has come around (NULL means "never synced"). */
export function listDueRepos(db: Db, now: number, limit = 1000): DueRepo[] {
  return db
    .all<{ id: number; forge_id: number; next_sync_at: number | null }>(
      `SELECT id, forge_id, next_sync_at
         FROM repos
        WHERE state = 'active' AND (next_sync_at IS NULL OR next_sync_at <= ?)
        ORDER BY next_sync_at IS NOT NULL, next_sync_at ASC, id ASC
        LIMIT ?`,
      now,
      limit,
    )
    .map((row) => ({ id: row.id, forgeId: row.forge_id, nextSyncAt: row.next_sync_at }));
}

/** When the scheduler should next wake for a repo that is not due yet. */
export function nextDueAt(db: Db, after: number): number | undefined {
  const row = db.get<{ next_sync_at: number }>(
    `SELECT next_sync_at FROM repos
      WHERE state = 'active' AND next_sync_at IS NOT NULL AND next_sync_at > ?
      ORDER BY next_sync_at ASC LIMIT 1`,
    after,
  );
  return row?.next_sync_at;
}

export function forgeIdForRepo(db: Db, repoId: number): number | undefined {
  return db.get<{ forge_id: number }>("SELECT forge_id FROM repos WHERE id = ?", repoId)?.forge_id;
}

export function countForgesWithRepos(db: Db): number {
  const row = db.get<{ n: number }>("SELECT COUNT(DISTINCT forge_id) AS n FROM repos");
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface RepoAccount {
  id: number;
  username: string;
  secretEnc: Uint8Array | null;
}

/**
 * The account whose credential a fetch should present: the repo override, or
 * the forge default. force_anonymous wins over both. Credentials are only ever
 * looked up through the repo's own forge, which is why repos.forge_id and
 * accounts.forge_id are immutable.
 */
export function resolveRepoAccount(db: Db, target: SyncTarget): RepoAccount | undefined {
  if (target.repo.forceAnonymous) {
    return undefined;
  }
  const row =
    target.repo.accountOverrideId === null
      ? db.get<{ id: number; username: string; secret_enc: Uint8Array | null }>(
          "SELECT id, username, secret_enc FROM accounts WHERE forge_id = ? AND is_default = 1",
          target.repo.forgeId,
        )
      : db.get<{ id: number; username: string; secret_enc: Uint8Array | null }>(
          "SELECT id, username, secret_enc FROM accounts WHERE id = ? AND forge_id = ?",
          target.repo.accountOverrideId,
          target.repo.forgeId,
        );
  if (row === undefined) {
    return undefined;
  }
  return { id: row.id, username: row.username, secretEnc: row.secret_enc };
}

export function markAccountUsed(db: Db, accountId: number, at: number): void {
  db.run("UPDATE accounts SET last_used_at = ?, updated_at = ? WHERE id = ?", at, at, accountId);
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

interface RunDbRow {
  id: number;
  repo_id: number;
  started_at: number;
  finished_at: number | null;
  outcome: string;
  error: string | null;
  error_kind: string | null;
  bytes_fetched: number | null;
  duration_ms: number | null;
  refs_changed: number | null;
  paranoid_archived: number | null;
}

function toSyncRun(row: RunDbRow): SyncRun {
  return {
    id: row.id,
    repoId: row.repo_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as SyncRun["outcome"],
    error: row.error,
    errorKind: row.error_kind as SyncErrorKind | null,
    bytesFetched: row.bytes_fetched,
    durationMs: row.duration_ms,
    refsChanged: row.refs_changed,
    paranoidArchived: row.paranoid_archived,
  };
}

/**
 * Opened as "canceled": a run that never reaches finishSyncRun (a crash, a
 * SIGKILL mid-fetch) then reads as canceled rather than silently vanishing.
 */
export function startSyncRun(db: Db, repoId: number, startedAt: number): number {
  return db.run(
    `INSERT INTO sync_runs (repo_id, started_at, outcome, created_at, updated_at)
     VALUES (?, ?, 'canceled', ?, ?)`,
    repoId,
    startedAt,
    startedAt,
    startedAt,
  ).lastInsertRowid;
}

export interface FinishRunPatch {
  finishedAt: number;
  outcome: SyncRun["outcome"];
  error: string | null;
  errorKind: SyncErrorKind | null;
  bytesFetched: number | null;
  durationMs: number;
  refsChanged: number | null;
  paranoidArchived: number | null;
}

export function finishSyncRun(db: Db, runId: number, patch: FinishRunPatch): SyncRun {
  db.run(
    `UPDATE sync_runs
        SET finished_at = ?, outcome = ?, error = ?, error_kind = ?, bytes_fetched = ?,
            duration_ms = ?, refs_changed = ?, paranoid_archived = ?, updated_at = ?
      WHERE id = ?`,
    patch.finishedAt,
    patch.outcome,
    patch.error,
    patch.errorKind,
    patch.bytesFetched,
    patch.durationMs,
    patch.refsChanged,
    patch.paranoidArchived,
    patch.finishedAt,
    runId,
  );
  const row = db.get<RunDbRow>("SELECT * FROM sync_runs WHERE id = ?", runId);
  if (row === undefined) {
    throw new Error(`sync run ${String(runId)} disappeared while it was being written`);
  }
  return toSyncRun(row);
}

export function getSyncRun(db: Db, runId: number): SyncRun | undefined {
  const row = db.get<RunDbRow>("SELECT * FROM sync_runs WHERE id = ?", runId);
  return row === undefined ? undefined : toSyncRun(row);
}

export function listSyncRuns(db: Db, repoId: number): SyncRun[] {
  return db
    .all<RunDbRow>(
      "SELECT * FROM sync_runs WHERE repo_id = ? ORDER BY started_at DESC, id DESC",
      repoId,
    )
    .map(toSyncRun);
}

export interface RepoRunPatch {
  now: number;
  outcome: SyncRun["outcome"];
  error: string | null;
  nextSyncAt: number;
  consecutiveFailures: number;
  diskUsageBytes: number | null;
  defaultBranch: string | null;
  lastFetchHead: string | null;
}

/** Denormalized repo fields the listing screen reads without joining runs. */
export function applyRunToRepo(db: Db, repoId: number, patch: RepoRunPatch): void {
  if (patch.outcome === "success") {
    db.run(
      `UPDATE repos
          SET last_sync_at = ?, last_success_at = ?, last_error = NULL, consecutive_failures = 0,
              next_sync_at = ?, disk_usage_bytes = ?, default_branch = ?, last_fetch_head = ?,
              updated_at = ?
        WHERE id = ?`,
      patch.now,
      patch.now,
      patch.nextSyncAt,
      patch.diskUsageBytes,
      patch.defaultBranch,
      patch.lastFetchHead,
      patch.now,
      repoId,
    );
    return;
  }
  db.run(
    `UPDATE repos
        SET last_sync_at = ?, last_error = ?, consecutive_failures = ?, next_sync_at = ?,
            disk_usage_bytes = COALESCE(?, disk_usage_bytes), updated_at = ?
      WHERE id = ?`,
    patch.now,
    patch.error,
    patch.consecutiveFailures,
    patch.nextSyncAt,
    patch.diskUsageBytes,
    patch.now,
    repoId,
  );
}

export function setNextSyncAt(db: Db, repoId: number, at: number | null, now: number): void {
  db.run("UPDATE repos SET next_sync_at = ?, updated_at = ? WHERE id = ?", at, now, repoId);
}

/**
 * Keep the newest RUN_RETENTION_COUNT runs per repo, plus every error row from
 * the last 30 days regardless of how many newer successes there are.
 */
export function enforceRunRetention(db: Db, repoId: number, now: number): number {
  const cutoff = now - ERROR_RUN_RETENTION_MS;
  return db.run(
    `DELETE FROM sync_runs
      WHERE repo_id = ?
        AND NOT (outcome = 'error' AND started_at >= ?)
        AND id NOT IN (
          SELECT id FROM sync_runs WHERE repo_id = ?
           ORDER BY started_at DESC, id DESC LIMIT ?
        )`,
    repoId,
    cutoff,
    repoId,
    RUN_RETENTION_COUNT,
  ).changes;
}
