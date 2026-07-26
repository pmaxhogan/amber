import type { Account, CreateAccount, UpdateAccount } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { assertSecretKey, decryptSecret, encryptSecret } from "../security/secrets.ts";
import { conflict, invalid, isUniqueViolation, notFound } from "./errors.ts";
import { requireForge } from "./forges.ts";

/**
 * Accounts hold the credentials Amber presents to a forge, so two rules matter
 * more than the CRUD around them:
 *
 * 1. `forge_id` is IMMUTABLE. A credential can never be moved to another
 *    forge, because that would hand a stored PAT to a host it was never issued
 *    for. UpdateAccount declares no forgeId and no code path here writes it.
 * 2. Secrets are write-only. Nothing in this module returns the plaintext (or
 *    the ciphertext) except getCredential, which exists solely for the sync
 *    engine and is never reachable from a route.
 *
 * Invariant enforced here and covered by tests: a forge with at least one
 * account has exactly one default. Deleting the default promotes the oldest
 * remaining account.
 */

interface AccountRow {
  id: number;
  forge_id: number;
  username: string;
  secret_enc: Uint8Array | null;
  is_default: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * secret_enc is selected as a presence flag, never as bytes, so the encrypted
 * blob cannot end up in a response object by accident.
 */
const ACCOUNT_COLUMNS = `id, forge_id, username,
  CASE WHEN secret_enc IS NULL THEN 0 ELSE 1 END AS has_secret,
  is_default, last_used_at, created_at, updated_at`;

type AccountSelectRow = Omit<AccountRow, "secret_enc"> & { has_secret: number };

function toAccount(row: AccountSelectRow): Account {
  return {
    id: row.id,
    forgeId: row.forge_id,
    username: row.username,
    hasSecret: row.has_secret === 1,
    isDefault: row.is_default === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUsername(username: string): string {
  return username.trim();
}

export function listAccounts(db: Db, forgeId?: number): Account[] {
  const rows =
    forgeId === undefined
      ? db.all<AccountSelectRow>(
          `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY forge_id ASC, created_at ASC, id ASC`,
        )
      : db.all<AccountSelectRow>(
          `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE forge_id = ?
           ORDER BY created_at ASC, id ASC`,
          forgeId,
        );
  return rows.map(toAccount);
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

export function getDefaultAccount(db: Db, forgeId: number): Account | undefined {
  const row = db.get<AccountSelectRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE forge_id = ? AND is_default = 1`,
    forgeId,
  );
  return row === undefined ? undefined : toAccount(row);
}

/** Find an account by forge and username, for the importer's user@ matching. */
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

function countAccounts(db: Db, forgeId: number): number {
  const row = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM accounts WHERE forge_id = ?",
    forgeId,
  );
  return row?.count ?? 0;
}

/** Clear the current default so the partial unique index stays satisfiable. */
function clearDefault(db: Db, forgeId: number, now: number): void {
  db.run(
    "UPDATE accounts SET is_default = 0, updated_at = ? WHERE forge_id = ? AND is_default = 1",
    now,
    forgeId,
  );
}

/**
 * Restore the "exactly one default" invariant after a removal: the oldest
 * remaining account on the forge is promoted. A forge with no accounts left
 * needs no default.
 */
function promoteOldest(db: Db, forgeId: number, now: number): void {
  if (getDefaultAccount(db, forgeId) !== undefined) {
    return;
  }
  const oldest = db.get<{ id: number }>(
    "SELECT id FROM accounts WHERE forge_id = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    forgeId,
  );
  if (oldest === undefined) {
    return;
  }
  db.run("UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?", now, oldest.id);
}

export function createAccount(db: Db, key: Buffer | null, input: CreateAccount): Account {
  const username = normalizeUsername(input.username);
  if (username === "") {
    throw invalid("An account needs a username.");
  }

  return db.tx(() => {
    requireForge(db, input.forgeId);

    // The first account on a forge is always the default, whatever was asked.
    const isFirst = countAccounts(db, input.forgeId) === 0;
    const wantsDefault = isFirst || input.isDefault;

    const secretEnc =
      input.secret === null ? null : encryptSecret(assertSecretKey(key), input.secret);

    const now = Date.now();
    if (wantsDefault) {
      clearDefault(db, input.forgeId, now);
    }

    let id: number;
    try {
      id = db.run(
        `INSERT INTO accounts
           (forge_id, username, secret_enc, is_default, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        input.forgeId,
        username,
        secretEnc,
        wantsDefault ? 1 : 0,
        now,
        now,
      ).lastInsertRowid;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Deliberately says nothing about the submitted secret.
        throw conflict(`An account named "${username}" already exists on this forge.`);
      }
      throw error;
    }
    return requireAccount(db, id);
  });
}

/**
 * Username and secret only. `secret: null` clears the stored credential,
 * omitting it leaves the existing one untouched, and a string overwrites in
 * place. The forge is never part of the update.
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
            throw conflict(`An account named "${username}" already exists on this forge.`);
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

/** Make this account the default for its forge, demoting the previous one. */
export function setDefaultAccount(db: Db, id: number): Account {
  return db.tx(() => {
    const account = requireAccount(db, id);
    if (account.isDefault) {
      return account;
    }
    const now = Date.now();
    clearDefault(db, account.forgeId, now);
    db.run("UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?", now, id);
    return requireAccount(db, id);
  });
}

/**
 * Repos that used this account as an override fall back to the forge default
 * via ON DELETE SET NULL. Deleting the default promotes the oldest remaining
 * account so the forge is never left without one.
 */
export function deleteAccount(db: Db, id: number): void {
  db.tx(() => {
    const account = requireAccount(db, id);
    db.run("DELETE FROM accounts WHERE id = ?", id);
    promoteOldest(db, account.forgeId, Date.now());
  });
}

export interface AccountCredential {
  username: string;
  /** null when the account is stored without a secret (anonymous access). */
  secret: string | null;
}

/**
 * The one place a stored credential is decrypted. For the sync engine only:
 * no route returns this, and the result must never be logged.
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
