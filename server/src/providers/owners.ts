import type { ForgeKind } from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { createConsoleLogger } from "../logging.ts";
import { decryptSecret as domainDecryptSecret } from "../security/secrets.ts";
import { buildBaseUrl, providerForKind, resolveToken } from "./discovery.ts";
import { accountFor } from "./forks.ts";
import type { AccountSyncProvider, DiscoveryContext, OwnerLookup, ProviderFetch } from "./types.ts";

/**
 * Background resolver for "is the owner of this gone repository gone too". A
 * deleted or suspended account answers 404 on every repository it owned, so
 * one lookup per owner explains all of them. Only repositories that are
 * already gone are looked at, at most a bounded number of owners per pass, and
 * a failed lookup is never written down as an answer.
 */

const HOUR_MS = 3_600_000;
/** An owner is asked again no sooner than this: accounts get hidden and restored. */
export const OWNER_RECHECK_MS = 6 * HOUR_MS;
/** How long a rate limited forge is left alone, across passes. */
export const OWNER_RATE_LIMIT_COOLDOWN_MS = HOUR_MS;
export const OWNER_BATCH_SIZE = 20;

export interface OwnerResolverDeps {
  log?: Logger;
  secretKey?: Buffer | null;
  now?: () => number;
  fetch?: ProviderFetch;
  decryptSecret?: (key: Buffer, blob: Buffer) => string;
  providerFor?: (kind: ForgeKind) => AccountSyncProvider | undefined;
  /** forge id -> epoch ms until which that forge is not asked; kept by the caller. */
  cooldowns?: Map<number, number>;
  /** Called with the repo id whenever its owner_gone value actually changed. */
  onResolved?: (repoId: number) => void;
}

export interface OwnerResolverOptions {
  /** Owners (not repositories) looked up per pass. */
  batchSize?: number;
}

export interface OwnerResolverResult {
  asked: number;
  resolved: number;
  unknown: number;
  rateLimitedForges: number;
}

interface DueRow {
  id: number;
  path: string;
  forge_id: number;
  account_override_id: number | null;
  force_anonymous: number;
  owner_user_id: number | null;
  kind: ForgeKind;
  protocol: string;
  host: string;
  port: number | null;
}

interface GoneRow {
  id: number;
  owner_gone: number | null;
}

/** The first path segment: the user or organization on every supported forge. */
function ownerOf(path: string): string | null {
  const slash = path.indexOf("/");
  return slash > 0 ? path.slice(0, slash) : null;
}

/**
 * Ask the forge whether the owners of gone repositories still exist. Sequential,
 * and it never throws: a bad pass is logged and the next tick tries again.
 */
export async function resolveGoneOwners(
  db: Db,
  deps: OwnerResolverDeps = {},
  options: OwnerResolverOptions = {},
): Promise<OwnerResolverResult> {
  const log = (deps.log ?? createConsoleLogger("silent")).child({ mod: "owners" });
  const now = deps.now ?? Date.now;
  const providerFor = deps.providerFor ?? providerForKind;
  const decrypt = deps.decryptSecret ?? domainDecryptSecret;
  const cooldowns = deps.cooldowns ?? new Map<number, number>();
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? OWNER_BATCH_SIZE));
  const result: OwnerResolverResult = { asked: 0, resolved: 0, unknown: 0, rateLimitedForges: 0 };

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

    const due = db
      .all<DueRow>(
        `SELECT r.id, r.path, r.forge_id, r.account_override_id, r.force_anonymous, r.owner_user_id,
                f.kind, f.protocol, f.host, f.port
           FROM repos r
           JOIN forges f ON f.id = r.forge_id
          WHERE r.gone_at IS NOT NULL
            AND (r.owner_checked_at IS NULL
                 OR r.owner_checked_at <= ?
                 OR r.owner_checked_at < r.gone_at)
          ORDER BY r.owner_checked_at IS NOT NULL, r.owner_checked_at, r.id`,
        startedAt - OWNER_RECHECK_MS,
      )
      .filter((row) => providerFor(row.kind)?.checkOwner !== undefined)
      .filter((row) => !coolForges.has(row.forge_id));

    // One lookup per (forge, owner, credential), owners compared without
    // regard to case. The credential is part of the key: what one user's token
    // can see must never be written onto rows another user's fetches would
    // ask about with a different credential (or none).
    const groups = new Map<string, { row: DueRow; owner: string; accountId: number | null }>();
    for (const row of due) {
      const owner = ownerOf(row.path);
      if (owner === null) {
        continue;
      }
      const accountId = accountFor(db, row)?.id ?? null;
      const key = `${String(row.forge_id)}\u0000${owner.toLowerCase()}\u0000${String(accountId)}`;
      if (!groups.has(key)) {
        groups.set(key, { row, owner, accountId });
      }
      if (groups.size >= batchSize) {
        break;
      }
    }

    for (const { row, owner, accountId } of groups.values()) {
      if (coolForges.has(row.forge_id)) {
        continue;
      }
      const provider = providerFor(row.kind);
      if (provider?.checkOwner === undefined) {
        continue;
      }

      let lookup: OwnerLookup;
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
        lookup = await provider.checkOwner(context, owner);
      } catch (cause) {
        // Providers swallow forge failures themselves; this catches a missing
        // secret key or a corrupt stored credential, which also must not
        // become an answer.
        log.warn(
          { repoId: row.id, err: cause instanceof Error ? cause.message : String(cause) },
          "owner lookup failed",
        );
        lookup = { status: "unknown", rateLimited: false };
      }
      result.asked += 1;

      if (lookup.status === "unknown" && lookup.rateLimited) {
        // Not an answer: leave owner_checked_at alone so these are first in
        // line once the forge has cooled off.
        coolForges.add(row.forge_id);
        cooldowns.set(row.forge_id, now() + OWNER_RATE_LIMIT_COOLDOWN_MS);
        result.rateLimitedForges += 1;
        log.warn(
          { forgeId: row.forge_id },
          "forge rate limited owner lookups, backing off an hour",
        );
        continue;
      }

      // Every gone repo of this owner on this forge that would be asked with
      // the SAME credential shares the answer, whether or not it was the one
      // that made the owner due.
      const siblings = db
        .all<
          GoneRow &
            Pick<DueRow, "forge_id" | "account_override_id" | "force_anonymous" | "owner_user_id">
        >(
          `SELECT id, owner_gone, forge_id, account_override_id, force_anonymous, owner_user_id
             FROM repos
            WHERE forge_id = ? AND gone_at IS NOT NULL
              AND lower(substr(path, 1, instr(path, '/') - 1)) = ?`,
          row.forge_id,
          owner.toLowerCase(),
        )
        .filter((sibling) => (accountFor(db, sibling)?.id ?? null) === accountId);
      const at = now();

      if (lookup.status === "unknown") {
        for (const sibling of siblings) {
          db.run("UPDATE repos SET owner_checked_at = ? WHERE id = ?", at, sibling.id);
        }
        result.unknown += 1;
        log.debug({ forgeId: row.forge_id, owner }, "owner lookup came back unknown");
        continue;
      }

      const value = lookup.status === "missing" ? 1 : 0;
      for (const sibling of siblings) {
        const written = db.run(
          "UPDATE repos SET owner_gone = ?, owner_checked_at = ? WHERE id = ? AND gone_at IS NOT NULL",
          value,
          at,
          sibling.id,
        );
        if (written.changes > 0 && sibling.owner_gone !== value) {
          result.resolved += 1;
          log.debug({ repoId: sibling.id, ownerGone: value === 1 }, "owner lookup resolved");
          deps.onResolved?.(sibling.id);
        }
      }
    }

    if (result.resolved > 0) {
      log.info(
        { asked: result.asked, resolved: result.resolved, unknown: result.unknown },
        "resolved gone owners",
      );
    }
  } catch (cause) {
    log.error({ err: cause instanceof Error ? cause.message : String(cause) }, "owner pass failed");
  }
  return result;
}
