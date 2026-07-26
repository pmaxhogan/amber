import type {
  AccountSync,
  AccountSyncRunResult,
  AccountSyncSource,
  AccountSyncVisibility,
  ForgeKind,
} from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import {
  buildSlug as domainBuildSlug,
  generateShortId as domainGenerateShortId,
  deleteRepo as domainDeleteRepo,
  type DeleteRepoOptions,
  type RepoFileRemover,
} from "../domain/repos.ts";
import { createConsoleLogger } from "../logging.ts";
import { decryptSecret as domainDecryptSecret } from "../security/secrets.ts";
import { bitbucketProvider } from "./bitbucket.ts";
import { giteaProvider } from "./gitea.ts";
import { githubProvider } from "./github.ts";
import { gitlabProvider } from "./gitlab.ts";
import { ProviderError } from "./http.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
  ProviderFetch,
} from "./types.ts";

/**
 * One account-sync run: enumerate an account's repositories on its forge and
 * upsert repo rows for them.
 *
 * Removal policy, which is the whole point of a backup tool:
 * - source 'owned' NEVER removes anything. A repository that disappeared from
 *   the listing may have been deleted upstream, which is exactly the case the
 *   backup exists for. It is logged and counted as vanished.
 * - source 'starred' removes a repository only when the forge confirms the
 *   repository is still there (HTTP 200) and it is simply no longer starred,
 *   and only when this sync created the row (origin 'account_sync'). Any
 *   ambiguity - 404, 403, 5xx, network failure - keeps the backup.
 */

const MINUTE_MS = 60_000;
/** New repos are spread over at most this window so a first sync does not stampede. */
export const STAGGER_WINDOW_MS = 5 * MINUTE_MS;
const STAGGER_STEP_MAX_MS = 2_000;
/** short_id is random; a collision is vanishingly rare but must not lose a repo. */
const SHORT_ID_ATTEMPTS = 5;

export interface DiscoveryRepoHelpers {
  generateShortId: () => string;
  buildSlug: (path: string, shortId: string) => string;
  /** domain/repos.ts deleteRepo, so the real one is assignable unchanged. */
  deleteRepo: (db: Db, id: number, options?: DeleteRepoOptions) => Promise<void>;
}

export interface DiscoveryDeps {
  /** Callers should pass the app logger; the default swallows output. */
  log?: Logger;
  /** config.secretKey. Only needed when the account has a stored credential. */
  secretKey?: Buffer | null;
  now?: () => number;
  /** Jitter source, injectable for deterministic tests. */
  random?: () => number;
  /** Passed through to the provider, so tests can supply a MockAgent fetch. */
  fetch?: ProviderFetch;
  /**
   * The importer and discovery share these; discovery reaches them through a
   * seam so tests do not need the whole domain layer wired up.
   */
  repos?: Partial<DiscoveryRepoHelpers>;
  /**
   * Deletes a repo's backup directory. Required for a confirmed unstar to free
   * disk; without it domain deleteRepo refuses and the backup is kept.
   */
  removeFiles?: RepoFileRemover;
  decryptSecret?: (key: Buffer, blob: Buffer) => string;
  providerFor?: (kind: ForgeKind) => AccountSyncProvider | undefined;
}

interface AccountSyncRow {
  id: number;
  account_id: number;
  source: AccountSyncSource;
  visibility: AccountSyncVisibility;
  enabled: number;
  interval_minutes: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  repos_discovered: number | null;
  created_at: number;
  updated_at: number;
}

interface AccountRow {
  id: number;
  forge_id: number;
  username: string;
  secret_enc: Uint8Array | null;
}

interface ForgeRow {
  id: number;
  protocol: string;
  host: string;
  port: number | null;
  kind: ForgeKind;
}

interface ManagedRepoRow {
  id: number;
  path: string;
  origin: string;
}

const providers: readonly AccountSyncProvider[] = [
  githubProvider,
  gitlabProvider,
  bitbucketProvider,
  giteaProvider,
];

export function providerForKind(kind: string): AccountSyncProvider | undefined {
  return providers.find((provider) => provider.kind === kind);
}

/** Starred syncs need a provider that can enumerate stars. Only GitHub can. */
export function supportsStarredSync(kind: string): boolean {
  return providerForKind(kind)?.listStarred !== undefined;
}

export function mapAccountSync(row: AccountSyncRow): AccountSync {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    visibility: row.visibility,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    reposDiscovered: row.repos_discovered,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAccountSyncRow(db: Db, id: number): AccountSyncRow | undefined {
  return db.get<AccountSyncRow>("SELECT * FROM account_syncs WHERE id = ?", id);
}

/** Every enabled sync whose next_run_at has come around (or was never set). */
export function listDueAccountSyncs(db: Db, now: number = Date.now()): AccountSync[] {
  return db
    .all<AccountSyncRow>(
      `SELECT * FROM account_syncs
        WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY next_run_at IS NULL DESC, next_run_at ASC, id ASC`,
      now,
    )
    .map(mapAccountSync);
}

/**
 * Run every due account sync, one after another. Account sync is a handful of
 * API calls a few times a day, so it deliberately does not need the repo
 * scheduler's worker pool; the scheduler just calls this on its wake loop.
 */
export async function runDueAccountSyncs(
  db: Db,
  deps: DiscoveryDeps = {},
): Promise<AccountSyncRunResult[]> {
  const now = deps.now?.() ?? Date.now();
  const results: AccountSyncRunResult[] = [];
  for (const due of listDueAccountSyncs(db, now)) {
    results.push(await runAccountSyncDetailed(db, due.id, deps));
  }
  return results;
}

/** One account-sync run: enumerate via the provider, then upsert repos. */
export async function runAccountSync(
  db: Db,
  accountSyncId: number,
  deps: DiscoveryDeps = {},
): Promise<AccountSync> {
  const result = await runAccountSyncDetailed(db, accountSyncId, deps);
  return result.accountSync;
}

/** Same run, with the per-run counters the API and the logs report. */
export async function runAccountSyncDetailed(
  db: Db,
  accountSyncId: number,
  deps: DiscoveryDeps = {},
): Promise<AccountSyncRunResult> {
  const log = (deps.log ?? createConsoleLogger("silent")).child({ mod: "discovery" });
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  // domain deleteRepo refuses to drop backup files without a remover, and a
  // confirmed unstar is the one case that should free disk, so the remover the
  // caller supplied is bound in here rather than left to the call site.
  const { removeFiles } = deps;
  const helpers: DiscoveryRepoHelpers = {
    generateShortId: deps.repos?.generateShortId ?? domainGenerateShortId,
    buildSlug: deps.repos?.buildSlug ?? domainBuildSlug,
    deleteRepo:
      deps.repos?.deleteRepo ??
      ((database, id, options = {}): Promise<void> =>
        domainDeleteRepo(database, id, {
          ...options,
          ...(removeFiles === undefined ? {} : { removeFiles }),
        })),
  };
  const decrypt = deps.decryptSecret ?? domainDecryptSecret;
  const providerFor = deps.providerFor ?? providerForKind;

  const row = getAccountSyncRow(db, accountSyncId);
  if (row === undefined) {
    throw new Error(`Account sync ${String(accountSyncId)} does not exist`);
  }

  let discovered = 0;
  let created = 0;
  let linked = 0;
  let vanished = 0;
  let removed = 0;
  let retained = 0;
  let error: string | null = null;

  const startedAt = now();
  try {
    const account = db.get<AccountRow>(
      "SELECT id, forge_id, username, secret_enc FROM accounts WHERE id = ?",
      row.account_id,
    );
    if (account === undefined) {
      throw new Error(`Account ${String(row.account_id)} does not exist`);
    }
    const forge = db.get<ForgeRow>(
      "SELECT id, protocol, host, port, kind FROM forges WHERE id = ?",
      account.forge_id,
    );
    if (forge === undefined) {
      throw new Error(`Forge ${String(account.forge_id)} does not exist`);
    }

    const provider = providerFor(forge.kind);
    if (provider === undefined) {
      throw new Error(
        `Account sync does not support ${forge.kind} forges. Import those repositories manually.`,
      );
    }
    if (row.source === "starred" && provider.listStarred === undefined) {
      throw new Error("Starred sync is GitHub-only for now");
    }

    const context: DiscoveryContext = {
      baseUrl: buildBaseUrl(forge),
      username: account.username,
      // An "anonymous" account sync is simply an accounts row with no stored
      // secret, so account_id stays NOT NULL and nothing here is nullable.
      token: resolveToken(account, deps.secretKey ?? null, decrypt),
      // Visibility is an owned-sync concept; a starred list is whatever it is.
      visibility: row.source === "starred" ? "all" : row.visibility,
      fetch: deps.fetch,
    };

    const iterable =
      row.source === "starred"
        ? (provider.listStarred as (c: DiscoveryContext) => AsyncIterable<DiscoveredRepo>)(context)
        : provider.listRepos(context);

    const byPath = new Map<string, DiscoveredRepo>();
    for await (const repo of iterable) {
      byPath.set(repo.path, repo);
    }
    discovered = byPath.size;

    const upsert = upsertDiscoveredRepos(db, {
      forgeId: forge.id,
      accountSyncId: row.id,
      repos: [...byPath.values()],
      helpers,
      now: now(),
    });
    created = upsert.created;
    linked = upsert.linked;

    const stale = db
      .all<ManagedRepoRow>(
        "SELECT id, path, origin FROM repos WHERE managed_by_account_sync_id = ?",
        row.id,
      )
      .filter((repo) => !byPath.has(repo.path));
    vanished = stale.length;

    if (row.source === "starred") {
      // A listing that comes back completely empty after a run that found
      // repositories is far more likely to be a lost scope or a forge glitch
      // than the account unstarring everything at once. One confirmed unstar is
      // evidence; an empty list is not evidence of N unstars.
      if (discovered === 0 && (row.repos_discovered ?? 0) > 0) {
        retained = stale.length;
        log.warn(
          { accountSyncId: row.id, retained, previouslyDiscovered: row.repos_discovered },
          "starred listing came back empty after a run that found repos, removing nothing",
        );
      } else {
        const outcome = await reconcileUnstarred(stale, {
          db,
          provider,
          context,
          helpers,
          log,
          accountSyncId: row.id,
        });
        removed = outcome.removed;
        retained = outcome.retained;
      }
    } else {
      for (const repo of stale) {
        // Deleted upstream is precisely what a backup is for: keep syncing it.
        log.info(
          { accountSyncId: row.id, path: repo.path, repoId: repo.id },
          "repo is no longer listed on the account, keeping the backup",
        );
      }
    }

    log.info(
      {
        accountSyncId: row.id,
        source: row.source,
        forge: forge.host,
        discovered,
        created,
        linked,
        vanished,
        removed,
        retained,
        durationMs: now() - startedAt,
      },
      "account sync finished",
    );
  } catch (cause) {
    error = describeError(cause);
    log.warn({ accountSyncId, err: error }, "account sync failed");
  }

  const finishedAt = now();
  const nextRunAt = finishedAt + jitteredInterval(row.interval_minutes, random);
  db.run(
    `UPDATE account_syncs
        SET last_run_at = ?, next_run_at = ?, last_error = ?, repos_discovered = ?, updated_at = ?
      WHERE id = ?`,
    finishedAt,
    nextRunAt,
    error,
    error === null ? discovered : row.repos_discovered,
    finishedAt,
    row.id,
  );

  const updated = getAccountSyncRow(db, row.id);
  return {
    accountSync: mapAccountSync(updated ?? row),
    discovered,
    created,
    linked,
    vanished,
    removed,
    retained,
    error,
  };
}

function buildBaseUrl(forge: ForgeRow): string {
  const port = forge.port === null ? "" : `:${String(forge.port)}`;
  return `${forge.protocol}://${forge.host}${port}`;
}

function resolveToken(
  account: AccountRow,
  secretKey: Buffer | null,
  decrypt: (key: Buffer, blob: Buffer) => string,
): string | null {
  if (account.secret_enc === null || account.secret_enc.byteLength === 0) {
    return null;
  }
  if (secretKey === null) {
    throw new Error(
      `Account ${account.username} has a stored credential but AMBER_SECRET_KEY is not configured`,
    );
  }
  return decrypt(secretKey, Buffer.from(account.secret_enc));
}

/** Never let a provider error carry anything but its message into the DB. */
function describeError(cause: unknown): string {
  if (cause instanceof ProviderError) {
    return cause.retryAfterMs === null
      ? cause.message
      : `${cause.message}. Retry after ${String(Math.ceil(cause.retryAfterMs / 1000))}s`;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function jitteredInterval(intervalMinutes: number, random: () => number): number {
  const base = intervalMinutes * MINUTE_MS;
  // +-10%, same shape as the repo scheduler's interval jitter.
  return Math.round(base * (0.9 + random() * 0.2));
}

interface UpsertArgs {
  forgeId: number;
  accountSyncId: number;
  repos: readonly DiscoveredRepo[];
  helpers: DiscoveryRepoHelpers;
  now: number;
}

interface UpsertOutcome {
  created: number;
  linked: number;
}

/**
 * Create rows for repositories we have never seen and link the ones we have.
 * An existing repo keeps its settings, its account override, its schedule and
 * its origin: per-repo configuration always wins over account-level sync.
 */
export function upsertDiscoveredRepos(db: Db, args: UpsertArgs): UpsertOutcome {
  const existing = new Map<string, { id: number; managed: number | null }>();
  for (const repo of args.repos) {
    const found = db.get<{ id: number; managed_by_account_sync_id: number | null }>(
      "SELECT id, managed_by_account_sync_id FROM repos WHERE forge_id = ? AND path = ?",
      args.forgeId,
      repo.path,
    );
    if (found !== undefined) {
      existing.set(repo.path, { id: found.id, managed: found.managed_by_account_sync_id });
    }
  }

  const fresh = args.repos.filter((repo) => !existing.has(repo.path));
  const step =
    fresh.length === 0 ? 0 : Math.min(STAGGER_STEP_MAX_MS, STAGGER_WINDOW_MS / fresh.length);

  let created = 0;
  let linked = 0;

  db.tx(() => {
    let index = 0;
    for (const repo of args.repos) {
      const found = existing.get(repo.path);
      if (found !== undefined) {
        if (found.managed === null) {
          db.run(
            "UPDATE repos SET managed_by_account_sync_id = ?, updated_at = ? WHERE id = ?",
            args.accountSyncId,
            args.now,
            found.id,
          );
          linked += 1;
        }
        continue;
      }
      insertDiscoveredRepo(db, {
        forgeId: args.forgeId,
        accountSyncId: args.accountSyncId,
        repo,
        helpers: args.helpers,
        now: args.now,
        nextSyncAt: args.now + Math.round(step * index),
      });
      created += 1;
      index += 1;
    }
  });

  return { created, linked };
}

interface InsertArgs {
  forgeId: number;
  accountSyncId: number;
  repo: DiscoveredRepo;
  helpers: DiscoveryRepoHelpers;
  now: number;
  nextSyncAt: number;
}

function insertDiscoveredRepo(db: Db, args: InsertArgs): void {
  const displayName = args.repo.path.slice(args.repo.path.lastIndexOf("/") + 1);
  let lastError: unknown;
  for (let attempt = 0; attempt < SHORT_ID_ATTEMPTS; attempt += 1) {
    const shortId = args.helpers.generateShortId();
    const slug = args.helpers.buildSlug(args.repo.path, shortId);
    try {
      db.run(
        `INSERT INTO repos (
           forge_id, path, display_name, slug, short_id, managed_by_account_sync_id,
           origin, state, next_sync_at, consecutive_failures, default_branch,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'account_sync', 'active', ?, 0, ?, ?, ?)`,
        args.forgeId,
        args.repo.path,
        displayName,
        slug,
        shortId,
        args.accountSyncId,
        args.nextSyncAt,
        args.repo.defaultBranch,
        args.now,
        args.now,
      );
      return;
    } catch (cause) {
      lastError = cause;
      if (!isShortIdCollision(cause)) {
        throw cause;
      }
    }
  }
  throw new Error(`Could not allocate a unique short id for ${args.repo.path}`, {
    cause: lastError,
  });
}

function isShortIdCollision(cause: unknown): boolean {
  return cause instanceof Error && /short_id|slug/.test(cause.message);
}

interface ReconcileArgs {
  db: Db;
  provider: AccountSyncProvider;
  context: DiscoveryContext;
  helpers: DiscoveryRepoHelpers;
  log: Logger;
  accountSyncId: number;
}

/**
 * Starred syncs only. For every repo this sync created that is no longer in the
 * fresh starred list, ask the forge whether the repository still exists. Only a
 * definite yes frees disk; anything else keeps the backup and says why.
 */
async function reconcileUnstarred(
  stale: readonly ManagedRepoRow[],
  args: ReconcileArgs,
): Promise<{ removed: number; retained: number }> {
  let removed = 0;
  let retained = 0;

  for (const repo of stale) {
    if (repo.origin !== "account_sync") {
      // Imported by hand at some point: the account sync does not own it.
      args.log.info(
        { accountSyncId: args.accountSyncId, repoId: repo.id, path: repo.path },
        "unstarred repo was imported manually, keeping the backup",
      );
      retained += 1;
      continue;
    }

    let access: string;
    try {
      access = (await args.provider.checkRepoAccess?.(args.context, repo.path)) ?? "unknown";
    } catch (cause) {
      access = "unknown";
      args.log.warn(
        {
          accountSyncId: args.accountSyncId,
          repoId: repo.id,
          path: repo.path,
          err: describeError(cause),
        },
        "could not confirm the unstarred repo upstream, keeping the backup",
      );
    }

    if (access !== "accessible") {
      args.log.info(
        { accountSyncId: args.accountSyncId, repoId: repo.id, path: repo.path, access },
        "unstarred repo is not confirmed reachable upstream, keeping the backup",
      );
      retained += 1;
      continue;
    }

    try {
      await args.helpers.deleteRepo(args.db, repo.id, { withFiles: true });
      removed += 1;
      args.log.info(
        { accountSyncId: args.accountSyncId, repoId: repo.id, path: repo.path },
        "repo was unstarred and is still reachable upstream, removing the backup and its files",
      );
    } catch (cause) {
      retained += 1;
      args.log.warn(
        {
          accountSyncId: args.accountSyncId,
          repoId: repo.id,
          path: repo.path,
          err: describeError(cause),
        },
        "could not remove the unstarred repo, keeping the backup",
      );
    }
  }

  return { removed, retained };
}
