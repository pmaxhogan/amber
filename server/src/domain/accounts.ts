import type { Account, CreateAccount, UpdateAccount } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { assertSecretKey, decryptSecret, encryptSecret } from "../security/secrets.ts";
import { conflict, invalid, isUniqueViolation, notFound } from "./errors.ts";
import { requireForge } from "./forges.ts";

/**
 * Accounts hold the credentials Amber presents to a forge, so these rules
 * matter more than the CRUD around them:
 *
 * 1. `forge_id` is IMMUTABLE. A credential can never be moved to another
 *    forge, because that would hand a stored PAT to a host it was never issued
 *    for. UpdateAccount declares no forgeId and no code path here writes it.
 * 2. Secrets are write-only. Nothing in this module returns the plaintext (or
 *    the ciphertext) except getCredential, which exists solely for the sync
 *    engine and is never reachable from a route.
 * 3. An account belongs to exactly one Amber user (`owner_user_id`) and is
 *    used only for repositories that user owns (domain/credentials.ts). The
 *    owner is immutable here too: no function in this module moves one.
 *
 * Invariant enforced here and covered by tests: for every (owner, forge) pair
 * with at least one account there is exactly one default. Deleting the
 * default promotes that owner's oldest remaining account on the forge.
 */

interface AccountRow {
  id: number;
  forge_id: number;
  username: string;
  secret_enc: Uint8Array | null;
  is_default: number;
  last_used_at: number | null;
  owner_user_id: number;
  created_at: number;
  updated_at: number;
}

/**
 * secret_enc is selected as a presence flag, never as bytes, so the encrypted
 * blob cannot end up in a response object by accident.
 */
const ACCOUNT_COLUMNS = `id, forge_id, username,
  CASE WHEN secret_enc IS NULL THEN 0 ELSE 1 END AS has_secret,
  is_default, last_used_at, owner_user_id, created_at, updated_at`;

type AccountSelectRow = Omit<AccountRow, "secret_enc"> & { has_secret: number };

function toAccount(row: AccountSelectRow): Account {
  return {
    id: row.id,
    forgeId: row.forge_id,
    username: row.username,
    hasSecret: row.has_secret === 1,
    isDefault: row.is_default === 1,
    lastUsedAt: row.last_used_at,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The owner of an account as stored. Every row has one (010 triggers). */
export function accountOwnerId(account: Account): number {
  if (account.ownerUserId === undefined) {
    // toAccount always sets it; an Account without one did not come from here.
    throw new Error(`Account ${String(account.id)} carries no owner`);
  }
  return account.ownerUserId;
}

function normalizeUsername(username: string): string {
  return username.trim();
}

export interface AccountListFilter {
  forgeId?: number;
  /** Only this user's accounts. Absent: every account (manage_forges, admin). */
  ownerUserId?: number;
}

export function listAccounts(db: Db, filter: AccountListFilter = {}): Account[] {
  const where: string[] = [];
  const params: number[] = [];
  if (filter.forgeId !== undefined) {
    where.push("forge_id = ?");
    params.push(filter.forgeId);
  }
  if (filter.ownerUserId !== undefined) {
    where.push("owner_user_id = ?");
    params.push(filter.ownerUserId);
  }
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  return db
    .all<AccountSelectRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts ${whereSql}
        ORDER BY forge_id ASC, created_at ASC, id ASC`,
      ...params,
    )
    .map(toAccount);
}

export function getAccount(db: Db, id: number): Account | undefined {
  const row = db.get<AccountSelectRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`, id);
  return row === undefined ? undefined : toAccount(row);
}

export function requireAccount(db: Db, id: number): Account {
  const account = getAccount(db, id);
  if (account === undefined) {
    throw notFound("Account", id);
  }
  return account;
}

/** The user's default account on a forge. Never another user's. */
export function getDefaultAccount(
  db: Db,
  ownerUserId: number,
  forgeId: number,
): Account | undefined {
  const row = db.get<AccountSelectRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts
      WHERE owner_user_id = ? AND forge_id = ? AND is_default = 1`,
    ownerUserId,
    forgeId,
  );
  return row === undefined ? undefined : toAccount(row);
}

/**
 * Find an account by forge and username, whoever owns it. (forge, username)
 * is unique instance-wide, so this is at most one row. Callers that select a
 * credential for someone must use findOwnAccountByUsername instead.
 */
export function findAccountByUsername(
  db: Db,
  forgeId: number,
  username: string,
): Account | undefined {
  const row = db.get<AccountSelectRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE forge_id = ? AND username = ?`,
    forgeId,
    normalizeUsername(username),
  );
  return row === undefined ? undefined : toAccount(row);
}

/**
 * The `user@` import prefix: an account of THIS user only. Another user's
 * account by that name reads exactly like no account at all.
 */
export function findOwnAccountByUsername(
  db: Db,
  ownerUserId: number,
  forgeId: number,
  username: string,
): Account | undefined {
  const row = db.get<AccountSelectRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts
      WHERE owner_user_id = ? AND forge_id = ? AND username = ?`,
    ownerUserId,
    forgeId,
    normalizeUsername(username),
  );
  return row === undefined ? undefined : toAccount(row);
}

function countAccounts(db: Db, ownerUserId: number, forgeId: number): number {
  const row = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM accounts WHERE owner_user_id = ? AND forge_id = ?",
    ownerUserId,
    forgeId,
  );
  return row?.count ?? 0;
}

/** Clear the owner's current default so the partial unique index stays satisfiable. */
function clearDefault(db: Db, ownerUserId: number, forgeId: number, now: number): void {
  db.run(
    `UPDATE accounts SET is_default = 0, updated_at = ?
      WHERE owner_user_id = ? AND forge_id = ? AND is_default = 1`,
    now,
    ownerUserId,
    forgeId,
  );
}

/**
 * Restore the "exactly one default per owner and forge" invariant after a
 * removal: that owner's oldest remaining account on the forge is promoted.
 * Another user's accounts are never touched.
 */
function promoteOldest(db: Db, ownerUserId: number, forgeId: number, now: number): void {
  if (getDefaultAccount(db, ownerUserId, forgeId) !== undefined) {
    return;
  }
  const oldest = db.get<{ id: number }>(
    `SELECT id FROM accounts WHERE owner_user_id = ? AND forge_id = ?
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    ownerUserId,
    forgeId,
  );
  if (oldest === undefined) {
    return;
  }
  db.run("UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?", now, oldest.id);
}

/**
 * The 409 for a (forge, username) that is already registered. When it is the
 * caller's own account the message says so; when it is someone else's it says
 * nothing about whose, because a forge login is registered by one Amber user
 * and the others have no business learning which.
 */
function duplicateAccount(db: Db, forgeId: number, username: string, ownerUserId: number) {
  const holder = findAccountByUsername(db, forgeId, username);
  if (holder !== undefined && holder.ownerUserId === ownerUserId) {
    return conflict(`An account named "${username}" already exists on this forge.`);
  }
  return conflict("That forge login is already registered in Amber.");
}

/**
 * `ownerUserId` is the Amber user the account belongs to, and it is required:
 * the database would quietly fill in the admin for a forgotten one, which
 * would hand the account to the wrong person.
 */
export function createAccount(
  db: Db,
  key: Buffer | null,
  input: CreateAccount,
  ownerUserId: number,
): Account {
  const username = normalizeUsername(input.username);
  if (username === "") {
    throw invalid("An account needs a username.");
  }

  return db.tx(() => {
    requireForge(db, input.forgeId);

    // The owner's first account on a forge is always their default.
    const isFirst = countAccounts(db, ownerUserId, input.forgeId) === 0;
    const wantsDefault = isFirst || input.isDefault;

    const secretEnc =
      input.secret === null ? null : encryptSecret(assertSecretKey(key), input.secret);

    const now = Date.now();
    if (wantsDefault) {
      clearDefault(db, ownerUserId, input.forgeId, now);
    }

    let id: number;
    try {
      id = db.run(
        `INSERT INTO accounts
           (forge_id, username, secret_enc, is_default, last_used_at, owner_user_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        input.forgeId,
        username,
        secretEnc,
        wantsDefault ? 1 : 0,
        ownerUserId,
        now,
        now,
      ).lastInsertRowid;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Deliberately says nothing about the submitted secret.
        throw duplicateAccount(db, input.forgeId, username, ownerUserId);
      }
      throw error;
    }
    return requireAccount(db, id);
  });
}

/**
 * Username and secret only. `secret: null` clears the stored credential,
 * omitting it leaves the existing one untouched, and a string overwrites in
 * place. The forge and the owner are never part of the update.
 */
export function updateAccount(
  db: Db,
  key: Buffer | null,
  id: number,
  patch: UpdateAccount,
): Account {
  return db.tx(() => {
    const existing = requireAccount(db, id);
    const now = Date.now();

    if (patch.username !== undefined) {
      const username = normalizeUsername(patch.username);
      if (username === "") {
        throw invalid("An account needs a username.");
      }
      if (username !== existing.username) {
        try {
          db.run(
            "UPDATE accounts SET username = ?, updated_at = ? WHERE id = ?",
            username,
            now,
            id,
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw duplicateAccount(db, existing.forgeId, username, accountOwnerId(existing));
          }
          throw error;
        }
      }
    }

    if (patch.secret !== undefined) {
      const secretEnc =
        patch.secret === null ? null : encryptSecret(assertSecretKey(key), patch.secret);
      db.run("UPDATE accounts SET secret_enc = ?, updated_at = ? WHERE id = ?", secretEnc, now, id);
    }

    return requireAccount(db, id);
  });
}

/** Make this account its owner's default for its forge, demoting their previous one. */
export function setDefaultAccount(db: Db, id: number): Account {
  return db.tx(() => {
    const account = requireAccount(db, id);
    if (account.isDefault) {
      return account;
    }
    const now = Date.now();
    clearDefault(db, accountOwnerId(account), account.forgeId, now);
    db.run("UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?", now, id);
    return requireAccount(db, id);
  });
}

/**
 * Repos that used this account as an override fall back to their owner's
 * default via ON DELETE SET NULL. Deleting the default promotes the owner's
 * oldest remaining account on the forge, so that owner is never left without
 * one while they still have accounts there.
 */
export function deleteAccount(db: Db, id: number): void {
  db.tx(() => {
    const account = requireAccount(db, id);
    // Owned and starred syncs are the account's and cascade away with it. A
    // namespace sync only borrowed the account, so it falls back to its
    // owner's default instead of silently ending a whole organization's backups.
    db.run(
      "UPDATE account_syncs SET account_id = NULL, updated_at = ? WHERE account_id = ? AND source = 'namespace'",
      Date.now(),
      id,
    );
    db.run("DELETE FROM accounts WHERE id = ?", id);
    promoteOldest(db, accountOwnerId(account), account.forgeId, Date.now());
  });
}

export interface AccountCredential {
  username: string;
  /** null when the account is stored without a secret (anonymous access). */
  secret: string | null;
}

/**
 * The one place a stored credential is decrypted. For the sync engine only:
 * no route returns this, and the result must never be logged. Which account
 * may be decrypted for which repository is decided before this is called, by
 * domain/credentials.ts.
 */
export function getCredential(db: Db, key: Buffer | null, accountId: number): AccountCredential {
  const row = db.get<{ username: string; secret_enc: Uint8Array | null }>(
    "SELECT username, secret_enc FROM accounts WHERE id = ?",
    accountId,
  );
  if (row === undefined) {
    throw notFound("Account", accountId);
  }
  if (row.secret_enc === null) {
    return { username: row.username, secret: null };
  }
  return {
    username: row.username,
    secret: decryptSecret(assertSecretKey(key), Buffer.from(row.secret_enc)),
  };
}

/** Stamp last_used_at after the sync engine presents this account's credential. */
export function markAccountUsed(db: Db, accountId: number, at: number = Date.now()): void {
  db.run("UPDATE accounts SET last_used_at = ?, updated_at = ? WHERE id = ?", at, at, accountId);
}
