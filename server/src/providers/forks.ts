import type { ForgeKind } from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { resolveRepoAccountId } from "../domain/credentials.ts";
import { effectiveIsPrivate, ownerMayUseForgeSql } from "../domain/forges.ts";
import { createConsoleLogger } from "../logging.ts";
import { decryptSecret as domainDecryptSecret } from "../security/secrets.ts";
import { buildBaseUrl, providerForKind, resolveToken } from "./discovery.ts";
import type { HostResolver, PinnedFetch } from "../security/egress.ts";
import type { AccountSyncProvider, DiscoveryContext, ProviderFetch, RepoInfo } from "./types.ts";

/**
 * Background resolver for what only a single-repository GET can tell:
 *
 * - FORK PARENTS. GitHub's list endpoints say only that a repository is a
 *   fork, never of what, so the parent costs one GET per fork.
 * - VISIBILITY. `repos.is_private` is the forge's own answer, read from the
 *   VISIBILITY FIELD of that same response, whoever's token asked (a 200 to
 *   an authenticated request proves nothing by itself). Refreshed at most
 *   daily per repo via `visibility_checked_at`; every repo starts private
 *   (migration 010), so the backfill is simply "never checked" coming first.
 *
 * One GET answers both, so the two ride the same pass. It drips GETs out a
 * small batch per tick, never records a failure as an answer, and keeps
 * anonymous lookups well inside the anonymous rate limit (GitHub allows 60
 * an hour) so the pass never starves the rest of Amber of it.
 */

const HOUR_MS = 3_600_000;
/** An unanswered repository is asked again no sooner than this. */
export const FORK_RECHECK_MS = 24 * HOUR_MS;
/** Visibility is refreshed at most this often per repository. */
export const VISIBILITY_RECHECK_MS = 24 * HOUR_MS;
/** How long a rate limited forge (for that credential) is left alone, across passes. */
export const FORK_RATE_LIMIT_COOLDOWN_MS = HOUR_MS;
export const FORK_BATCH_SIZE = 20;
/**
 * Anonymous lookups per forge per hour. Half of GitHub's anonymous allowance,
 * so trending syncs and anonymous discovery keep the other half.
 */
export const ANONYMOUS_LOOKUPS_PER_HOUR = 30;

export interface AnonymousBudget {
  windowStart: number;
  used: number;
}

export interface ForkResolverDeps {
  log?: Logger;
  secretKey?: Buffer | null;
  now?: () => number;
  /** Passed through to the provider, so tests can supply a stub fetch. */
  fetch?: ProviderFetch;
  /** Egress test seams for restricted forges (security/egress.ts). */
  resolveHost?: HostResolver;
  pinnedFetch?: PinnedFetch;
  decryptSecret?: (key: Buffer, blob: Buffer) => string;
  providerFor?: (kind: ForgeKind) => AccountSyncProvider | undefined;
  /**
   * `<forge id>:<account id or "anon">` -> epoch ms until which that forge is
   * not asked WITH THAT CREDENTIAL. A rate limit is per credential, so one
   * anonymous limit must not stall token-backed lookups. The caller keeps one
   * map alive between passes so a cooldown outlives the pass that set it.
   */
  cooldowns?: Map<string, number>;
  /** forge id -> anonymous lookups spent this hour. Kept alive like cooldowns. */
  anonymousBudget?: Map<number, AnonymousBudget>;
  /** Called with the repo id whenever a parent, "not a fork" or a visibility change is written. */
  onResolved?: (repoId: number) => void;
}

export interface ForkResolverOptions {
  batchSize?: number;
}

export interface ForkResolverResult {
  asked: number;
  resolved: number;
  unknown: number;
  rateLimitedForges: number;
  /** Repositories whose visibility the forge answered this pass. */
  visibilityResolved?: number;
}

interface PendingRow {
  id: number;
  path: string;
  forge_id: number;
  account_override_id: number | null;
  force_anonymous: number;
  owner_user_id: number | null;
  fork_known: number;
  fork_checked_at: number | null;
  visibility_checked_at: number | null;
  kind: ForgeKind;
  protocol: string;
  host: string;
  port: number | null;
  allow_private_network: number;
}

export interface ForkAccountRow {
  username: string;
  secret_enc: Uint8Array | null;
}
type AccountRow = ForkAccountRow;

/**
 * The credential a repo's own fetches would use, by the one rule in
 * domain/credentials.ts: force_anonymous wins, then only the repo OWNER's own
 * accounts, and only while the owner may use accounts at all. An account from
 * another forge is never used, so a token cannot be presented to a host it
 * was not registered for.
 */
export function accountFor(
  db: Db,
  row: Pick<PendingRow, "forge_id" | "account_override_id" | "force_anonymous" | "owner_user_id">,
): (AccountRow & { id: number }) | undefined {
  const accountId = resolveRepoAccountId(db, {
    forgeId: row.forge_id,
    ownerUserId: row.owner_user_id,
    accountOverrideId: row.account_override_id,
    forceAnonymous: row.force_anonymous === 1,
  });
  if (accountId === null) {
    return undefined;
  }
  return db.get<AccountRow & { id: number }>(
    "SELECT id, username, secret_enc FROM accounts WHERE id = ? AND forge_id = ?",
    accountId,
    row.forge_id,
  );
}

const PENDING_COLUMNS = `r.id, r.path, r.forge_id, r.account_override_id, r.force_anonymous,
  r.owner_user_id, r.fork_known, r.fork_checked_at, r.visibility_checked_at,
  f.kind, f.protocol, f.host, f.port, f.allow_private_network`;

/** Whether the provider can answer at all: one of the two single-repo GETs. */
function canAsk(provider: AccountSyncProvider | undefined): provider is AccountSyncProvider {
  return provider?.getRepoInfo !== undefined || provider?.getForkParent !== undefined;
}

/** One GET through whichever method the provider has. Never throws on a forge failure. */
async function askProvider(
  provider: AccountSyncProvider,
  context: DiscoveryContext,
  path: string,
): Promise<RepoInfo> {
  if (provider.getRepoInfo !== undefined) {
    return provider.getRepoInfo(context, path);
  }
  if (provider.getForkParent !== undefined) {
    return { fork: await provider.getForkParent(context, path), isPrivate: null, sizeBytes: null };
  }
  return { fork: { status: "unknown", rateLimited: false }, isPrivate: null, sizeBytes: null };
}

function contextFor(
  db: Db,
  row: PendingRow,
  deps: ForkResolverDeps,
): { context: DiscoveryContext; accountId: number | null } {
  const decrypt = deps.decryptSecret ?? domainDecryptSecret;
  const account = accountFor(db, row);
  return {
    accountId: account?.id ?? null,
    context: {
      baseUrl: buildBaseUrl(row),
      username: account?.username ?? "",
      token: account === undefined ? null : resolveToken(account, deps.secretKey ?? null, decrypt),
      visibility: "all",
      fetch: deps.fetch,
      restricted: row.allow_private_network !== 1,
      resolveHost: deps.resolveHost,
      pinnedFetch: deps.pinnedFetch,
    },
  };
}

/**
 * Write the visibility answer. The providers map every DEFINITIVE answer to
 * a boolean: the visibility field of a 200, and a refusal (404, or 401/403
 * that is not a rate limit) as private, so a repository that went private
 * upstream stops being shown to others. null is a NON-answer (rate limit,
 * network, 5xx): it only stamps the ask and leaves the flag alone. Returns
 * true when is_private changed.
 *
 * On an unrestricted forge every answer is "private" (domain/forges.ts
 * effectiveIsPrivate): there the API saying public proves nothing about who
 * else may see it.
 */
function writeVisibility(
  db: Db,
  row: Pick<PendingRow, "id" | "path" | "allow_private_network">,
  answer: boolean | null,
  at: number,
): boolean {
  const isPrivate =
    answer === null ? null : effectiveIsPrivate(answer, row.allow_private_network !== 0);
  // Every write is guarded on the path that was ASKED about: a rename that
  // landed while the lookup was in flight names a different upstream, and
  // the old path's answer (or its "checked" stamp) must not be pinned on it.
  const before = db.get<{ is_private: number }>(
    "SELECT is_private FROM repos WHERE id = ? AND path = ?",
    row.id,
    row.path,
  );
  if (before === undefined) {
    return false;
  }
  if (isPrivate === null) {
    db.run(
      "UPDATE repos SET visibility_checked_at = ? WHERE id = ? AND path = ?",
      at,
      row.id,
      row.path,
    );
    return false;
  }
  db.run(
    "UPDATE repos SET is_private = ?, visibility_checked_at = ? WHERE id = ? AND path = ?",
    isPrivate ? 1 : 0,
    at,
    row.id,
    row.path,
  );
  return (before.is_private !== 0) !== isPrivate;
}

/**
 * The process-wide rate state for single-repository lookups. The background
 * pass and the first-clone cap gate ask the same forges with the same
 * credentials, so they share one anonymous budget and one set of cooldowns:
 * a batch of capped first clones cannot spend the allowance the pass relies
 * on, and a rate limit either of them meets holds back both.
 */
export const processLookupLimits: {
  cooldowns: Map<string, number>;
  anonymousBudget: Map<number, AnonymousBudget>;
} = { cooldowns: new Map(), anonymousBudget: new Map() };

function cooldownKey(forgeId: number, accountId: number | null): string {
  return `${String(forgeId)}:${accountId === null ? "anon" : String(accountId)}`;
}

function isCooled(
  cooldowns: Map<string, number>,
  forgeId: number,
  accountId: number | null,
  at: number,
): boolean {
  return (cooldowns.get(cooldownKey(forgeId, accountId)) ?? 0) > at;
}

/** Spend one anonymous lookup on this forge, or say the hour's budget is gone. */
function spendAnonymous(
  budgets: Map<number, AnonymousBudget>,
  forgeId: number,
  at: number,
): boolean {
  const budget = budgets.get(forgeId);
  if (budget === undefined || at - budget.windowStart >= HOUR_MS) {
    budgets.set(forgeId, { windowStart: at, used: 1 });
    return true;
  }
  if (budget.used >= ANONYMOUS_LOOKUPS_PER_HOUR) {
    return false;
  }
  budget.used += 1;
  return true;
}

/**
 * Ask the forge about one repository now, with the credential its own
 * fetches would use, and write down what it said about visibility. For the
 * first-clone cap gate, which wants the size before a clone starts. It shares
 * the pass's rate state (processLookupLimits unless deps say otherwise), so it
 * never asks with a cooled credential and never overspends the anonymous
 * budget. Null when the forge cannot be asked (generic hosts), the credential
 * is cooling down, or the anonymous budget is spent.
 */
export async function lookupRepoInfo(
  db: Db,
  repoId: number,
  deps: ForkResolverDeps = {},
): Promise<RepoInfo | null> {
  const now = deps.now ?? Date.now;
  const providerFor = deps.providerFor ?? providerForKind;
  const cooldowns = deps.cooldowns ?? processLookupLimits.cooldowns;
  const budgets = deps.anonymousBudget ?? processLookupLimits.anonymousBudget;
  const row = db.get<PendingRow>(
    // Never on behalf of a non-admin on an unrestricted forge (domain/forges.ts).
    `SELECT ${PENDING_COLUMNS} FROM repos r JOIN forges f ON f.id = r.forge_id
      WHERE r.id = ? AND ${ownerMayUseForgeSql("r", "f")}`,
    repoId,
  );
  if (row === undefined) {
    return null;
  }
  const provider = providerFor(row.kind);
  if (!canAsk(provider)) {
    return null;
  }
  const { context, accountId } = contextFor(db, row, deps);
  if (isCooled(cooldowns, row.forge_id, accountId, now())) {
    return null;
  }
  if (context.token === null && !spendAnonymous(budgets, row.forge_id, now())) {
    return null;
  }
  const info = await askProvider(provider, context, row.path);
  if (info.fork.status === "unknown" && info.fork.rateLimited) {
    cooldowns.set(cooldownKey(row.forge_id, accountId), now() + FORK_RATE_LIMIT_COOLDOWN_MS);
    return info;
  }
  if (writeVisibility(db, row, info.isPrivate, now())) {
    deps.onResolved?.(row.id);
  }
  return info;
}

/**
 * Ask the forge about one batch of repositories whose parent nobody knows yet
 * or whose visibility is due. Sequential on purpose, and it never throws: a
 * bad pass is logged and the next tick tries again.
 */
export async function resolvePendingForks(
  db: Db,
  deps: ForkResolverDeps = {},
  options: ForkResolverOptions = {},
): Promise<ForkResolverResult> {
  const log = (deps.log ?? createConsoleLogger("silent")).child({ mod: "forks" });
  const now = deps.now ?? Date.now;
  const providerFor = deps.providerFor ?? providerForKind;
  const cooldowns = deps.cooldowns ?? new Map<string, number>();
  const budgets = deps.anonymousBudget ?? new Map<number, AnonymousBudget>();
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? FORK_BATCH_SIZE));
  const result: ForkResolverResult = {
    asked: 0,
    resolved: 0,
    unknown: 0,
    rateLimitedForges: 0,
    visibilityResolved: 0,
  };

  try {
    const startedAt = now();
    for (const [key, until] of cooldowns) {
      if (until <= startedAt) {
        cooldowns.delete(key);
      }
    }
    const rows = db
      .all<PendingRow>(
        `SELECT ${PENDING_COLUMNS}
           FROM repos r
           JOIN forges f ON f.id = r.forge_id
          WHERE ((r.fork_known = 0 AND (r.fork_checked_at IS NULL OR r.fork_checked_at <= ?))
                 OR r.visibility_checked_at IS NULL
                 OR r.visibility_checked_at <= ?)
            AND ${ownerMayUseForgeSql("r", "f")}
          ORDER BY r.visibility_checked_at IS NOT NULL,
                   r.fork_checked_at IS NOT NULL OR r.fork_known = 1,
                   COALESCE(r.visibility_checked_at, 0), r.fork_checked_at, r.id`,
        startedAt - FORK_RECHECK_MS,
        startedAt - VISIBILITY_RECHECK_MS,
      )
      // Filtered here rather than in SQL so the capability check stays in one
      // place (the provider) and a test can swap providers in.
      .filter((row) => canAsk(providerFor(row.kind)));

    for (const row of rows) {
      if (result.asked >= batchSize) {
        break;
      }
      const provider = providerFor(row.kind);
      if (!canAsk(provider)) {
        continue;
      }

      let info: RepoInfo;
      let accountId: number | null = null;
      try {
        const prepared = contextFor(db, row, deps);
        accountId = prepared.accountId;
        if (isCooled(cooldowns, row.forge_id, accountId, startedAt)) {
          continue;
        }
        if (prepared.context.token === null && !spendAnonymous(budgets, row.forge_id, now())) {
          continue;
        }
        info = await askProvider(provider, prepared.context, row.path);
      } catch (cause) {
        // Providers swallow forge failures themselves; this catches a missing
        // secret key or a corrupt stored credential, which also must not
        // become an answer.
        log.warn(
          { repoId: row.id, err: cause instanceof Error ? cause.message : String(cause) },
          "fork lookup failed",
        );
        info = {
          fork: { status: "unknown", rateLimited: false },
          isPrivate: null,
          sizeBytes: null,
        };
      }
      result.asked += 1;
      const lookup = info.fork;

      if (lookup.status === "unknown" && lookup.rateLimited) {
        // Not an answer and not this repo's fault: leave the stamps alone so
        // it is first in line once the forge has cooled off for this credential.
        cooldowns.set(cooldownKey(row.forge_id, accountId), now() + FORK_RATE_LIMIT_COOLDOWN_MS);
        result.rateLimitedForges += 1;
        log.warn({ forgeId: row.forge_id }, "forge rate limited fork lookups, backing off an hour");
        continue;
      }

      const at = now();
      let changed = writeVisibility(db, row, info.isPrivate, at);
      if (info.isPrivate !== null) {
        result.visibilityResolved = (result.visibilityResolved ?? 0) + 1;
      }

      if (row.fork_known === 0) {
        if (lookup.status === "unknown") {
          db.run(
            "UPDATE repos SET fork_checked_at = ? WHERE id = ? AND fork_known = 0",
            at,
            row.id,
          );
          result.unknown += 1;
          log.debug({ repoId: row.id }, "fork lookup came back unknown");
        } else {
          const parent = lookup.status === "fork" ? lookup.parent : null;
          // The fork_known = 0 guard keeps a listing that answered while we
          // were waiting on the network from being overwritten.
          const written = db.run(
            "UPDATE repos SET fork_parent = ?, fork_known = 1, fork_checked_at = ? WHERE id = ? AND fork_known = 0",
            parent,
            at,
            row.id,
          );
          if (written.changes > 0) {
            result.resolved += 1;
            changed = true;
            log.debug({ repoId: row.id, parent }, "fork lookup resolved");
          }
        }
      }
      if (changed) {
        deps.onResolved?.(row.id);
      }
    }

    if (result.resolved > 0 || (result.visibilityResolved ?? 0) > 0) {
      log.info(
        {
          asked: result.asked,
          resolved: result.resolved,
          visibilityResolved: result.visibilityResolved,
          unknown: result.unknown,
        },
        "resolved fork parents and visibility",
      );
    }
  } catch (cause) {
    log.error({ err: cause instanceof Error ? cause.message : String(cause) }, "fork pass failed");
  }
  return result;
}
