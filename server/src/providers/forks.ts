import type { ForgeKind } from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { createConsoleLogger } from "../logging.ts";
import { decryptSecret as domainDecryptSecret } from "../security/secrets.ts";
import { buildBaseUrl, providerForKind, resolveToken } from "./discovery.ts";
import type { AccountSyncProvider, DiscoveryContext, ForkLookup, ProviderFetch } from "./types.ts";

/**
 * Background resolver for "what is this repository a fork of". GitHub's list
 * endpoints say only that a repository is a fork, never of what, so the parent
 * costs one GET per fork. This drips those GETs out a small batch per tick,
 * never-asked repositories first, and never records a failure as an answer.
 */

const HOUR_MS = 3_600_000;
/** An unanswered repository is asked again no sooner than this. */
export const FORK_RECHECK_MS = 24 * HOUR_MS;
/** How long a rate limited forge is left alone, across passes. */
export const FORK_RATE_LIMIT_COOLDOWN_MS = HOUR_MS;
export const FORK_BATCH_SIZE = 20;

export interface ForkResolverDeps {
  log?: Logger;
  secretKey?: Buffer | null;
  now?: () => number;
  /** Passed through to the provider, so tests can supply a stub fetch. */
  fetch?: ProviderFetch;
  decryptSecret?: (key: Buffer, blob: Buffer) => string;
  providerFor?: (kind: ForgeKind) => AccountSyncProvider | undefined;
  /**
   * forge id -> epoch ms until which that forge is not asked. The caller keeps
   * one map alive between passes so a cooldown outlives the pass that set it.
   */
  cooldowns?: Map<number, number>;
  /** Called with the repo id whenever a parent (or "not a fork") is written. */
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
}

interface PendingRow {
  id: number;
  path: string;
  forge_id: number;
  account_override_id: number | null;
  force_anonymous: number;
  kind: ForgeKind;
  protocol: string;
  host: string;
  port: number | null;
}

interface AccountRow {
  username: string;
  secret_enc: Uint8Array | null;
}

/**
 * The credential a repo's own fetches would use: force_anonymous wins, then
 * the override, then the forge default. An account from another forge is never
 * used, so a token cannot be presented to a host it was not registered for.
 */
function accountFor(db: Db, row: PendingRow): AccountRow | undefined {
  if (row.force_anonymous === 1) {
    return undefined;
  }
  return row.account_override_id === null
    ? db.get<AccountRow>(
        "SELECT username, secret_enc FROM accounts WHERE forge_id = ? AND is_default = 1",
        row.forge_id,
      )
    : db.get<AccountRow>(
        "SELECT username, secret_enc FROM accounts WHERE id = ? AND forge_id = ?",
        row.account_override_id,
        row.forge_id,
      );
}

/**
 * Ask the forge about one batch of repositories whose parent nobody knows yet.
 * Sequential on purpose, and it never throws: a bad pass is logged and the next
 * tick tries again.
 */
export async function resolvePendingForks(
  db: Db,
  deps: ForkResolverDeps = {},
  options: ForkResolverOptions = {},
): Promise<ForkResolverResult> {
  const log = (deps.log ?? createConsoleLogger("silent")).child({ mod: "forks" });
  const now = deps.now ?? Date.now;
  const providerFor = deps.providerFor ?? providerForKind;
  const decrypt = deps.decryptSecret ?? domainDecryptSecret;
  const cooldowns = deps.cooldowns ?? new Map<number, number>();
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? FORK_BATCH_SIZE));
  const result: ForkResolverResult = { asked: 0, resolved: 0, unknown: 0, rateLimitedForges: 0 };

  try {
    const startedAt = now();
    const coolForges = new Set<number>();
    for (const [forgeId, until] of cooldowns) {
      if (until > startedAt) {
        coolForges.add(forgeId);
      } else {
        cooldowns.delete(forgeId);
      }
    }

    const rows = db
      .all<PendingRow>(
        `SELECT r.id, r.path, r.forge_id, r.account_override_id, r.force_anonymous,
                f.kind, f.protocol, f.host, f.port
           FROM repos r
           JOIN forges f ON f.id = r.forge_id
          WHERE r.fork_known = 0
            AND (r.fork_checked_at IS NULL OR r.fork_checked_at <= ?)
          ORDER BY r.fork_checked_at IS NOT NULL, r.fork_checked_at, r.id`,
        startedAt - FORK_RECHECK_MS,
      )
      // Filtered here rather than in SQL so the capability check stays in one
      // place (the provider) and a test can swap providers in.
      .filter((row) => providerFor(row.kind)?.getForkParent !== undefined)
      .filter((row) => !coolForges.has(row.forge_id))
      .slice(0, batchSize);

    for (const row of rows) {
      if (coolForges.has(row.forge_id)) {
        continue;
      }
      const provider = providerFor(row.kind);
      if (provider?.getForkParent === undefined) {
        continue;
      }

      let lookup: ForkLookup;
      try {
        const account = accountFor(db, row);
        const context: DiscoveryContext = {
          baseUrl: buildBaseUrl(row),
          username: account?.username ?? "",
          token:
            account === undefined ? null : resolveToken(account, deps.secretKey ?? null, decrypt),
          visibility: "all",
          fetch: deps.fetch,
        };
        lookup = await provider.getForkParent(context, row.path);
      } catch (cause) {
        // Providers swallow forge failures themselves; this catches a missing
        // secret key or a corrupt stored credential, which also must not
        // become an answer.
        log.warn(
          { repoId: row.id, err: cause instanceof Error ? cause.message : String(cause) },
          "fork lookup failed",
        );
        lookup = { status: "unknown", rateLimited: false };
      }
      result.asked += 1;

      if (lookup.status === "unknown" && lookup.rateLimited) {
        // Not an answer and not this repo's fault: leave fork_checked_at alone
        // so it is first in line once the forge has cooled off.
        coolForges.add(row.forge_id);
        cooldowns.set(row.forge_id, now() + FORK_RATE_LIMIT_COOLDOWN_MS);
        result.rateLimitedForges += 1;
        log.warn({ forgeId: row.forge_id }, "forge rate limited fork lookups, backing off an hour");
        continue;
      }

      const at = now();
      if (lookup.status === "unknown") {
        db.run("UPDATE repos SET fork_checked_at = ? WHERE id = ? AND fork_known = 0", at, row.id);
        result.unknown += 1;
        log.debug({ repoId: row.id }, "fork lookup came back unknown");
        continue;
      }

      const parent = lookup.status === "fork" ? lookup.parent : null;
      // The fork_known = 0 guard keeps a listing that answered while we were
      // waiting on the network from being overwritten.
      const written = db.run(
        "UPDATE repos SET fork_parent = ?, fork_known = 1, fork_checked_at = ? WHERE id = ? AND fork_known = 0",
        parent,
        at,
        row.id,
      );
      if (written.changes > 0) {
        result.resolved += 1;
        log.debug({ repoId: row.id, parent }, "fork lookup resolved");
        deps.onResolved?.(row.id);
      }
    }

    if (result.resolved > 0) {
      log.info(
        { asked: result.asked, resolved: result.resolved, unknown: result.unknown },
        "resolved fork parents",
      );
    }
  } catch (cause) {
    log.error({ err: cause instanceof Error ? cause.message : String(cause) }, "fork pass failed");
  }
  return result;
}
