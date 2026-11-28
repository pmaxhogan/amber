import type { Db } from "../db/db.ts";
import { getUser, type User } from "./users.ts";

/**
 * WHICH CREDENTIAL A REPOSITORY IS FETCHED WITH. The one rule, in one place;
 * every caller that presents a token (git fetches, the fork and visibility
 * pass, the gone-owner pass, layered settings' "effective account") goes
 * through here and nowhere else:
 *
 *   force_anonymous                                   -> none
 *   the owner is missing or removed                   -> none
 *   the owner is not the admin and lacks import_private -> none
 *   account_override_id, when the OWNER owns it (on another forge: none)
 *   else the owner's default account on this forge
 *   else none
 *
 * An account is NEVER used for a repository its owner does not own. The rule
 * is evaluated at use time from fresh rows, so a permission taken away or an
 * owner removed takes effect on the very next fetch.
 */

/** The facts the rule reads off a repository row. */
export interface RepoCredentialFacts {
  forgeId: number;
  ownerUserId: number | null;
  accountOverrideId: number | null;
  forceAnonymous: boolean;
}

/** Whether a user's own accounts may be used at all. */
export function ownerMayUseAccounts(owner: User | undefined): owner is User {
  if (owner === undefined || owner.removedAt !== null) {
    return false;
  }
  return owner.isAdmin || owner.permissions.import_private;
}

interface AccountOwnerRow {
  id: number;
  forge_id: number;
  owner_user_id: number;
}

/**
 * The owner's own account on the forge: the override when it really is
 * theirs and on this forge, else their default there, else nothing. Shared by
 * the per-repo rule and by account syncs (whose pinned account plays the part
 * of the override).
 */
export function ownedAccountId(
  db: Db,
  ownerUserId: number,
  forgeId: number,
  preferredAccountId: number | null,
): number | null {
  if (preferredAccountId !== null) {
    const preferred = db.get<AccountOwnerRow>(
      "SELECT id, forge_id, owner_user_id FROM accounts WHERE id = ?",
      preferredAccountId,
    );
    if (preferred !== undefined && preferred.owner_user_id === ownerUserId) {
      // The owner's own account, but registered for another host: never
      // presented here, and not silently swapped for a different one either.
      return preferred.forge_id === forgeId ? preferred.id : null;
    }
  }
  const fallback = db.get<{ id: number }>(
    "SELECT id FROM accounts WHERE owner_user_id = ? AND forge_id = ? AND is_default = 1",
    ownerUserId,
    forgeId,
  );
  return fallback?.id ?? null;
}

/** The account id a repository's fetches present, or null for anonymous. */
export function resolveRepoAccountId(db: Db, repo: RepoCredentialFacts): number | null {
  if (repo.forceAnonymous || repo.ownerUserId === null) {
    return null;
  }
  const owner = getUser(db, repo.ownerUserId);
  if (!ownerMayUseAccounts(owner)) {
    return null;
  }
  return ownedAccountId(db, owner.id, repo.forgeId, repo.accountOverrideId);
}

/**
 * The same rule for a page of repositories, in a fixed handful of queries:
 * one for the owners, one for the candidate overrides, one for the owners'
 * default accounts. Keyed by repo id; every requested id is present.
 */
export function resolveRepoAccountIds(
  db: Db,
  repos: readonly (RepoCredentialFacts & { id: number })[],
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const eligible = repos.filter((repo) => !repo.forceAnonymous && repo.ownerUserId !== null);
  for (const repo of repos) {
    out.set(repo.id, null);
  }
  if (eligible.length === 0) {
    return out;
  }

  const ownerIds = [...new Set(eligible.map((repo) => repo.ownerUserId as number))];
  const owners = new Map<number, User>();
  for (const id of ownerIds) {
    const user = getUser(db, id);
    if (ownerMayUseAccounts(user)) {
      owners.set(id, user);
    }
  }
  if (owners.size === 0) {
    return out;
  }

  const overrideIds = [
    ...new Set(
      eligible.map((repo) => repo.accountOverrideId).filter((id): id is number => id !== null),
    ),
  ];
  const overrides = new Map<number, AccountOwnerRow>();
  if (overrideIds.length > 0) {
    for (const row of db.all<AccountOwnerRow>(
      `SELECT id, forge_id, owner_user_id FROM accounts
        WHERE id IN (${overrideIds.map(() => "?").join(", ")})`,
      ...overrideIds,
    )) {
      overrides.set(row.id, row);
    }
  }

  const allowedOwners = [...owners.keys()];
  const defaults = new Map<string, number>();
  for (const row of db.all<AccountOwnerRow>(
    `SELECT id, forge_id, owner_user_id FROM accounts
      WHERE is_default = 1 AND owner_user_id IN (${allowedOwners.map(() => "?").join(", ")})`,
    ...allowedOwners,
  )) {
    defaults.set(`${String(row.owner_user_id)}:${String(row.forge_id)}`, row.id);
  }

  for (const repo of eligible) {
    const ownerId = repo.ownerUserId as number;
    if (!owners.has(ownerId)) {
      continue;
    }
    const override =
      repo.accountOverrideId === null ? undefined : overrides.get(repo.accountOverrideId);
    if (override !== undefined && override.owner_user_id === ownerId) {
      out.set(repo.id, override.forge_id === repo.forgeId ? override.id : null);
      continue;
    }
    out.set(repo.id, defaults.get(`${String(ownerId)}:${String(repo.forgeId)}`) ?? null);
  }
  return out;
}

/** The facts the rule needs, read straight from a repos row. */
export function loadRepoCredentialFacts(db: Db, repoId: number): RepoCredentialFacts | undefined {
  const row = db.get<{
    forge_id: number;
    owner_user_id: number | null;
    account_override_id: number | null;
    force_anonymous: number;
  }>(
    "SELECT forge_id, owner_user_id, account_override_id, force_anonymous FROM repos WHERE id = ?",
    repoId,
  );
  return row === undefined
    ? undefined
    : {
        forgeId: row.forge_id,
        ownerUserId: row.owner_user_id,
        accountOverrideId: row.account_override_id,
        forceAnonymous: row.force_anonymous === 1,
      };
}
