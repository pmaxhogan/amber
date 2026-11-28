import type { Account } from "@amber/shared";

/** The pieces of a repository row that say who owns it. */
export interface OwnedRepo {
  mine?: boolean | undefined;
  owner?: { id: number; email: string; removed: boolean } | undefined;
}

/**
 * Who owns a repository, as far as this caller can tell: themselves, the owner
 * the API names (admin only), or nobody known.
 */
export function repoOwnerId(repo: OwnedRepo, selfId: number | null): number | null {
  if (repo.mine === true) return selfId;
  return repo.owner?.id ?? null;
}

/**
 * Accounts that could be used for a repository: its owner's. An account never
 * fetches for anyone but the user who registered it, so a list that carries
 * other people's accounts (the admin's view) is narrowed to the owner's.
 * Accounts without an owner field come from a server that predates users.
 */
export function accountsOfOwner(accounts: Account[], ownerId: number | null): Account[] {
  if (ownerId === null) return [];
  return accounts.filter(
    (account) => account.ownerUserId === undefined || account.ownerUserId === ownerId,
  );
}
