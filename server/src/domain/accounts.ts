import type { Account, CreateAccount, UpdateAccount } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { notImplemented } from "../notImplemented.ts";

/**
 * Invariant enforced here and covered by tests: a forge with at least one
 * account has exactly one default. Deleting the default promotes the oldest
 * remaining account.
 */
export function listAccounts(_db: Db, _forgeId?: number): Account[] {
  return notImplemented("listAccounts");
}

export function getAccount(_db: Db, _id: number): Account | undefined {
  return notImplemented("getAccount");
}

export function getDefaultAccount(_db: Db, _forgeId: number): Account | undefined {
  return notImplemented("getDefaultAccount");
}

export function createAccount(_db: Db, _key: Buffer | null, _input: CreateAccount): Account {
  return notImplemented("createAccount");
}

export function updateAccount(
  _db: Db,
  _key: Buffer | null,
  _id: number,
  _patch: UpdateAccount,
): Account {
  return notImplemented("updateAccount");
}

export function setDefaultAccount(_db: Db, _id: number): Account {
  return notImplemented("setDefaultAccount");
}

export function deleteAccount(_db: Db, _id: number): void {
  return notImplemented("deleteAccount");
}
