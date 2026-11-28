import {
  type AccountSync,
  type AccountSyncRunResult,
  type AccountSyncSource,
  type AccountSyncVisibility,
  type ForgeKind,
} from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import type { HostResolver, PinnedFetch } from "../security/egress.ts";
import {
  buildSlug as domainBuildSlug,
  generateShortId as domainGenerateShortId,
  deleteRepo as domainDeleteRepo,
  type DeleteRepoOptions,
  type RepoFileRemover,
} from "../domain/repos.ts";
import { ownedAccountId, ownerMayUseAccounts } from "../domain/credentials.ts";
import {
  ADMIN_ONLY_FORGE_ERROR,
  effectiveIsPrivate,
  forgeAllowsPrivateNetwork,
} from "../domain/forges.ts";
import { getUser, isAtOrOverCap, type User } from "../domain/users.ts";
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
 * - sources 'owned', 'namespace' and 'trending' NEVER remove anything. A repository
 *   that disappeared from the listing may have been deleted or transferred
 *   upstream, which is exactly the case the backup exists for. It is logged
 *   and counted as vanished. (A trending sync does not even count it: a
 *   repository drops off the trending list every day by design.)
 * - source 'starred' removes a repository only when the forge confirms the
 *   repository is still there (HTTP 200) and it is simply no longer starred,
 *   and only when this sync created the row (origin 'account_sync'). Any
 *   ambiguity - 404, 403, 5xx, network failure - keeps the backup.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The longest a failed run waits before trying again, whatever its interval. */
export const FAILED_RUN_RETRY_MINUTES = 60;
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
  /** Egress test seams for restricted forges (security/egress.ts). */
  resolveHost?: HostResolver;
  pinnedFetch?: PinnedFetch;
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
  forge_id: number;
  account_id: number | null;
  source: AccountSyncSource;
  namespace: string | null;
  top_n: number | null;
  window_days: number | null;
  visibility: AccountSyncVisibility;
  enabled: number;
  interval_minutes: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  repos_discovered: number | null;
  owner_user_id: number;
  created_at: number;
  updated_at: number;
}

interface AccountRow {
  id: number;
  forge_id: number;
  username: string;
  secret_enc: Uint8Array | null;
  owner_user_id: number;
}

interface ForgeRow {
  id: number;
  protocol: string;
  host: string;
  port: number | null;
  kind: ForgeKind;
  allow_private_network: number;
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

/** Namespace syncs need a provider that can enumerate any user or organization. */
export function supportsNamespaceSync(kind: string): boolean {
  return providerForKind(kind)?.listNamespaceRepos !== undefined;
}

/** Trending syncs need a provider that can search by creation date and stars. */
export function supportsTrendingSync(kind: string): boolean {
  return providerForKind(kind)?.listTrending !== undefined;
}

/** The trending sync on this forge with this window, if there is one. */
export function findTrendingSync(
  db: Db,
  forgeId: number,
  windowDays: number,
): AccountSyncRow | undefined {
  return db.get<AccountSyncRow>(
    "SELECT * FROM account_syncs WHERE forge_id = ? AND source = 'trending' AND window_days = ?",
    forgeId,
    windowDays,
  );
}

export function mapAccountSync(row: AccountSyncRow): AccountSync {
  return {
    id: row.id,
    forgeId: row.forge_id,
    accountId: row.account_id,
    source: row.source,
    namespace: row.namespace,
    topN: row.top_n,
    windowDays: row.window_days,
    visibility: row.visibility,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    reposDiscovered: row.repos_discovered,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAccountSyncRow(db: Db, id: number): AccountSyncRow | undefined {
  return db.get<AccountSyncRow>("SELECT * FROM account_syncs WHERE id = ?", id);
}

/**
 * The user's namespace sync for this forge and name, compared
 * case-insensitively. Per owner, like the unique index: another user's sync
 * of the same namespace is theirs, and never found (or edited) through here.
 */
export function findNamespaceSync(
  db: Db,
  ownerUserId: number,
  forgeId: number,
  namespace: string,
): AccountSyncRow | undefined {
  return db.get<AccountSyncRow>(
    `SELECT * FROM account_syncs
      WHERE owner_user_id = ? AND forge_id = ? AND source = 'namespace'
        AND namespace = ? COLLATE NOCASE`,
    ownerUserId,
    forgeId,
    namespace,
  );
}

export interface NewAccountSync {
  forgeId: number;
  accountId: number | null;
  source: AccountSyncSource;
  namespace: string | null;
  /** Required for a trending sync, absent or null for every other source. */
  topN?: number | null;
  /** Required for a trending sync, absent or null for every other source. */
  windowDays?: number | null;
  visibility: AccountSyncVisibility;
  enabled: boolean;
  intervalMinutes: number;
  /**
   * The user the sync belongs to, and the owner of every repository it
   * creates. Required: the database would quietly fill in the admin for a
   * forgotten one.
   */
  ownerUserId: number;
}

/** Insert one sync. An enabled one is due at once, so the next timer tick runs it. */
export function insertAccountSync(
  db: Db,
  input: NewAccountSync,
  now: number = Date.now(),
): AccountSync {
  const inserted = db.run(
    `INSERT INTO account_syncs (
       forge_id, account_id, source, namespace, top_n, window_days, visibility, enabled,
       interval_minutes, next_run_at, owner_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.forgeId,
    input.accountId,
    input.source,
    input.namespace,
    input.topN ?? null,
    input.windowDays ?? null,
    input.visibility,
    input.enabled ? 1 : 0,
    input.intervalMinutes,
    input.enabled ? now : null,
    input.ownerUserId,
    now,
    now,
  );
  const row = getAccountSyncRow(db, inserted.lastInsertRowid);
  if (row === undefined) {
    throw new Error("The account sync vanished right after it was created");
  }
  return mapAccountSync(row);
}

/** Every enabled sync whose next_run_at has come around (or was never set). */
/**
 * Whether a sync owned by `owner` may run at all. A removed owner's never
 * does: their accounts are never used, and nothing new is created in their
 * name. Nor does one whose owner has lost `import`: every run can create
 * repositories, which is exactly what `import` grants, and revoking it must
 * stop the syncs that user set up while they held it. Permissions are
 * effective, so the admin always passes.
 */
export function ownerMayRunAccountSync(owner: User | undefined): owner is User {
  return owner !== undefined && owner.removedAt === null && owner.permissions.import;
}

export function listDueAccountSyncs(db: Db, now: number = Date.now()): AccountSync[] {
  const owners = new Map<number, boolean>();
  const mayRun = (ownerId: number): boolean => {
    let decision = owners.get(ownerId);
    if (decision === undefined) {
      decision = ownerMayRunAccountSync(getUser(db, ownerId));
      owners.set(ownerId, decision);
    }
    return decision;
  };
  return db
    .all<AccountSyncRow>(
      // Removed owners are filtered in SQL; the permission is a JSON column
      // with defaults filled in code, so it is judged on the parsed user.
      `SELECT * FROM account_syncs
          WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
            AND owner_user_id IN (SELECT id FROM users WHERE removed_at IS NULL)
          ORDER BY next_run_at IS NULL DESC, next_run_at ASC, id ASC`,
      now,
    )
    .filter((row) => mayRun(row.owner_user_id))
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
    const forge = db.get<ForgeRow>(
      "SELECT id, protocol, host, port, kind, allow_private_network FROM forges WHERE id = ?",
      row.forge_id,
    );
    if (forge === undefined) {
      throw new Error(`Forge ${String(row.forge_id)} does not exist`);
    }
    const owner = getUser(db, row.owner_user_id);
    if (owner === undefined || owner.removedAt !== null) {
      // Not an error the forge can fix: the owner left, so nothing runs in
      // their name and none of their accounts is used.
      throw new Error("The owner of this sync was removed, so it does not run.");
    }
    if (!ownerMayRunAccountSync(owner)) {
      throw new Error("The owner of this sync can no longer import, so it does not run.");
    }
    if (forge.allow_private_network === 1 && !owner.isAdmin) {
      // Defence in depth behind the create-time refusal: covers a forge the
      // admin flipped to unrestricted after this sync was made.
      throw new Error(ADMIN_ONLY_FORGE_ERROR);
    }
    const mayUseAccounts = ownerMayUseAccounts(owner);
    // The account a run presents is always the sync OWNER's own: the pinned
    // one when it really is theirs and on this forge, else (namespace and
    // trending syncs) their default there, read fresh every run so changing
    // the default takes effect. An owner without import_private runs
    // anonymously and sees public repositories only.
    let account: AccountRow | undefined;
    if (row.account_id !== null) {
      account = db.get<AccountRow>(
        "SELECT id, forge_id, username, secret_enc, owner_user_id FROM accounts WHERE id = ?",
        row.account_id,
      );
      if (
        account === undefined ||
        account.owner_user_id !== owner.id ||
        account.forge_id !== forge.id
      ) {
        // Fail closed: never fall back to some other account for a sync that
        // names one, and never use one its owner does not own.
        throw new Error(`Account ${String(row.account_id)} is not usable by this sync`);
      }
    } else if (mayUseAccounts) {
      const defaultId = ownedAccountId(db, owner.id, forge.id, null);
      account =
        defaultId === null
          ? undefined
          : db.get<AccountRow>(
              "SELECT id, forge_id, username, secret_enc, owner_user_id FROM accounts WHERE id = ?",
              defaultId,
            );
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
    if (row.source === "namespace" && provider.listNamespaceRepos === undefined) {
      throw new Error("Syncing a whole user or organization is GitHub-only for now");
    }
    if (row.source === "trending" && provider.listTrending === undefined) {
      throw new Error("Trending sync is GitHub-only for now");
    }

    const context: DiscoveryContext = {
      baseUrl: buildBaseUrl(forge),
      username: account?.username ?? "",
      // An "anonymous" owned or starred sync is simply an accounts row with no
      // stored secret; a namespace sync may also have no account at all.
      token:
        account === undefined || !mayUseAccounts
          ? null
          : resolveToken(account, deps.secretKey ?? null, decrypt),
      // Visibility is an owned-sync concept; a starred list is whatever it is.
      visibility: row.source === "starred" || row.source === "trending" ? "all" : row.visibility,
      fetch: deps.fetch,
      // Fail closed: only an explicit 1 lifts the egress guard.
      restricted: forge.allow_private_network !== 1,
      resolveHost: deps.resolveHost,
      pinnedFetch: deps.pinnedFetch,
    };

    const iterable = listingFor(provider, context, row, startedAt);

    const byPath = new Map<string, DiscoveredRepo>();
    for await (const repo of iterable) {
      byPath.set(repo.path, repo);
    }
    discovered = byPath.size;

    const upsert = upsertDiscoveredRepos(db, {
      forgeId: forge.id,
      accountSyncId: row.id,
      ownerUserId: owner.id,
      // At or over the storage cap, a user's syncs skip NEW discoveries.
      // Repositories they already have keep syncing.
      skipNew: isAtOrOverCap(db, owner),
      repos: [...byPath.values()],
      helpers,
      now: now(),
      // A namespace sync pinned to a specific account fetches what it found
      // with that account, which need not be the forge default. Owned and
      // starred syncs keep their historical behaviour of no override.
      // The pinned account was checked above to be the owner's own.
      accountOverrideId: row.source === "namespace" ? row.account_id : null,
    });
    created = upsert.created;
    linked = upsert.linked;
    if (upsert.skippedForCap > 0) {
      log.info(
        { accountSyncId: row.id, skipped: upsert.skippedForCap },
        "owner is at or over their storage cap, skipping new repositories",
      );
    }

    const stale = db
      // Only the sync owner's repositories: starred auto-removal must never
      // reach a repository someone else owns, whatever links it.
      .all<ManagedRepoRow>(
        "SELECT id, path, origin FROM repos WHERE managed_by_account_sync_id = ? AND owner_user_id = ?",
        row.id,
        owner.id,
      )
      .filter((repo) => !byPath.has(repo.path));
    // Yesterday's trending repositories are all "stale" today, by design. That
    // is not a repository vanishing, so it is neither counted nor logged.
    vanished = row.source === "trending" ? 0 : stale.length;

    if (row.source === "trending") {
      // Nothing to reconcile: whatever trended once stays backed up.
    } else if (row.source === "starred") {
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
          "repo is no longer listed upstream, keeping the backup",
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
  // A failed run comes back within the hour instead of sitting out a whole
  // interval: a daily trending sync that met a rate limit would otherwise skip
  // a day, and the day's list is gone by then.
  const nextRunAt =
    finishedAt +
    jitteredInterval(
      error === null
        ? row.interval_minutes
        : Math.min(row.interval_minutes, FAILED_RUN_RETRY_MINUTES),
      random,
    );
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

function listingFor(
  provider: AccountSyncProvider,
  context: DiscoveryContext,
  row: AccountSyncRow,
  now: number,
): AsyncIterable<DiscoveredRepo> {
  if (
    row.source === "trending" &&
    row.top_n !== null &&
    row.window_days !== null &&
    provider.listTrending !== undefined
  ) {
    return provider.listTrending(context, {
      since: new Date(now - row.window_days * DAY_MS),
      limit: row.top_n,
    });
  }
  if (row.source === "starred" && provider.listStarred !== undefined) {
    return provider.listStarred(context);
  }
  if (
    row.source === "namespace" &&
    row.namespace !== null &&
    provider.listNamespaceRepos !== undefined
  ) {
    return provider.listNamespaceRepos(context, row.namespace);
  }
  return provider.listRepos(context);
}

export function buildBaseUrl(forge: Pick<ForgeRow, "protocol" | "host" | "port">): string {
  const port = forge.port === null ? "" : `:${String(forge.port)}`;
  return `${forge.protocol}://${forge.host}${port}`;
}

export function resolveToken(
  account: Pick<AccountRow, "username" | "secret_enc">,
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
  /** The sync's owner: creates are theirs, and only their rows are linked. */
  ownerUserId: number;
  /** The owner is at or over their storage cap: create nothing new. */
  skipNew?: boolean;
  repos: readonly DiscoveredRepo[];
  helpers: DiscoveryRepoHelpers;
  now: number;
  /** Set on newly created repos only; existing repos keep their own override. */
  accountOverrideId?: number | null;
}

interface UpsertOutcome {
  created: number;
  linked: number;
  /** Repositories not created because the owner is at or over their cap. */
  skippedForCap: number;
}

/**
 * Create rows for repositories we have never seen and link the ones we have.
 * An existing repo keeps its settings, its account override, its schedule and
 * its origin: per-repo configuration always wins over account-level sync.
 */
export function upsertDiscoveredRepos(db: Db, args: UpsertArgs): UpsertOutcome {
  // A listing on an unrestricted forge never makes anything public
  // (domain/forges.ts effectiveIsPrivate): applied once, here, so both the
  // insert and the update below inherit it.
  const unrestricted = forgeAllowsPrivateNetwork(db, args.forgeId);
  const listed = args.repos.map((repo) => ({
    ...repo,
    isPrivate: effectiveIsPrivate(repo.isPrivate, unrestricted),
  }));
  const existing = new Map<string, { id: number; managed: number | null; mine: boolean }>();
  for (const repo of listed) {
    const found = db.get<{
      id: number;
      managed_by_account_sync_id: number | null;
      owner_user_id: number | null;
    }>(
      "SELECT id, managed_by_account_sync_id, owner_user_id FROM repos WHERE forge_id = ? AND path = ?",
      args.forgeId,
      repo.path,
    );
    if (found !== undefined) {
      existing.set(repo.path, {
        id: found.id,
        managed: found.managed_by_account_sync_id,
        mine: found.owner_user_id === args.ownerUserId,
      });
    }
  }

  const fresh = args.skipNew === true ? [] : listed.filter((repo) => !existing.has(repo.path));
  const step =
    fresh.length === 0 ? 0 : Math.min(STAGGER_STEP_MAX_MS, STAGGER_WINDOW_MS / fresh.length);

  let created = 0;
  let linked = 0;
  let skippedForCap = 0;

  db.tx(() => {
    let index = 0;
    for (const repo of listed) {
      const found = existing.get(repo.path);
      if (found !== undefined) {
        if (!found.mine) {
          // Someone else's repository: one sync never links, relabels or
          // otherwise touches a row another user owns.
          continue;
        }
        // Listed means it exists upstream, whichever sync manages the row.
        // Only an unmanaged row is linked to this sync.
        db.run(
          `UPDATE repos
              SET last_seen_at = ?,
                  managed_by_account_sync_id = COALESCE(managed_by_account_sync_id, ?),
                  updated_at = ?
            WHERE id = ?`,
          args.now,
          args.accountSyncId,
          args.now,
          found.id,
        );
        writeListedForkKnowledge(db, found.id, repo, args.now);
        writeListedVisibility(db, found.id, repo, args.now);
        if (found.managed === null) {
          linked += 1;
        }
        continue;
      }
      if (args.skipNew === true) {
        skippedForCap += 1;
        continue;
      }
      insertDiscoveredRepo(db, {
        forgeId: args.forgeId,
        accountSyncId: args.accountSyncId,
        ownerUserId: args.ownerUserId,
        repo,
        helpers: args.helpers,
        now: args.now,
        nextSyncAt: args.now + Math.round(step * index),
        accountOverrideId: args.accountOverrideId ?? null,
      });
      created += 1;
      index += 1;
    }
  });

  return { created, linked, skippedForCap };
}

interface InsertArgs {
  forgeId: number;
  accountSyncId: number;
  ownerUserId: number;
  repo: DiscoveredRepo;
  helpers: DiscoveryRepoHelpers;
  now: number;
  nextSyncAt: number;
  accountOverrideId: number | null;
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
           account_override_id, origin, state, next_sync_at, consecutive_failures,
           default_branch, last_seen_at, owner_user_id, is_private, visibility_checked_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'account_sync', 'active', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        args.forgeId,
        args.repo.path,
        displayName,
        slug,
        shortId,
        args.accountSyncId,
        args.accountOverrideId,
        args.nextSyncAt,
        args.repo.defaultBranch,
        args.now,
        // A discovered repo belongs to whoever owns the sync that found it.
        args.ownerUserId,
        // The listing is the forge's own answer about visibility.
        args.repo.isPrivate ? 1 : 0,
        args.now,
        args.now,
        args.now,
      );
      const inserted = db.get<{ id: number }>(
        "SELECT id FROM repos WHERE forge_id = ? AND path = ?",
        args.forgeId,
        args.repo.path,
      );
      if (inserted !== undefined) {
        writeListedForkKnowledge(db, inserted.id, args.repo, args.now);
      }
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

/**
 * Record what a listing proved about forkness. A listing that says "not a
 * fork" or names the parent is an answer; one that says "fork" without naming
 * the parent, or says nothing, is not, and must not wipe an answer the
 * resolver already got.
 */
function writeListedForkKnowledge(db: Db, repoId: number, repo: DiscoveredRepo, now: number): void {
  if (repo.forkParent === null && repo.isFork !== false) {
    return;
  }
  db.run(
    "UPDATE repos SET fork_parent = ?, fork_known = 1, fork_checked_at = ? WHERE id = ?",
    repo.forkParent,
    now,
    repoId,
  );
}

/**
 * The listing's visibility field is the forge's own answer, so it is written
 * down as such. Providers map anything short of a confirmed "public" to
 * private, so this can only ever expose what the forge said is public.
 */
function writeListedVisibility(db: Db, repoId: number, repo: DiscoveredRepo, now: number): void {
  // Guarded on the listed path like every other visibility writer, so an
  // answer about one path can never land on a row that now names another.
  db.run(
    "UPDATE repos SET is_private = ?, visibility_checked_at = ? WHERE id = ? AND path = ?",
    repo.isPrivate ? 1 : 0,
    now,
    repoId,
    repo.path,
  );
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
