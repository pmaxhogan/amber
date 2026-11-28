import {
  allPermissions,
  defaultPermissions,
  fillPermissionDefaults,
  type Permissions,
  type StorageUsage,
  type UpdateUser,
  type UserRow,
} from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { DomainError, notFound } from "./errors.ts";
import { resolveGlobalSettings } from "./settings.ts";

/**
 * Users: the admin plus everyone the Cloudflare Access policy lists. A row
 * exists for every identity Amber has ever admitted and is never deleted, so
 * who owned what survives a removal. Exactly one row is the admin, enforced
 * by a partial unique index.
 *
 * This module does no HTTP and knows nothing about Cloudflare: the policy
 * reader hands it a list of emails and it reconciles the table against them.
 */

/**
 * The address migration 010 gives the admin row before boot knows the real
 * one. The .invalid TLD is reserved (RFC 2606), so it can never collide with
 * an address an identity provider vouches for.
 */
export const ADMIN_PLACEHOLDER_EMAIL = "admin@amber.invalid";

/** last_seen_at is a hint, not an audit log: at most one write a minute. */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

const BYTES_PER_GB = 1024 ** 3;

interface UserDbRow {
  id: number;
  email: string;
  is_admin: number;
  permissions: string;
  storage_cap_bytes: number | null;
  git_username: string | null;
  git_password_hash: string | null;
  git_rotated_at: number | null;
  removed_at: number | null;
  last_seen_at: number | null;
  cap_notified_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * A user as the server works with it. `permissions` is EFFECTIVE: every key
 * is true for the admin whatever the row stores. The git password hash never
 * leaves the database through this type.
 */
export interface User {
  id: number;
  email: string;
  isAdmin: boolean;
  permissions: Permissions;
  storageCapBytes: number | null;
  gitUsername: string | null;
  hasGitPassword: boolean;
  gitRotatedAt: number | null;
  removedAt: number | null;
  lastSeenAt: number | null;
  capNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReconcileChanges {
  created: number;
  removed: number;
  restored: number;
}

const USER_COLUMNS = `id, email, is_admin, permissions, storage_cap_bytes, git_username,
  git_password_hash, git_rotated_at, removed_at, last_seen_at, cap_notified_at,
  created_at, updated_at`;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseStoredPermissions(raw: string): Permissions {
  try {
    return fillPermissionDefaults(JSON.parse(raw));
  } catch {
    // A row that cannot be read grants the new-user defaults, never more.
    return defaultPermissions();
  }
}

function toUser(row: UserDbRow): User {
  const isAdmin = row.is_admin === 1;
  return {
    id: row.id,
    email: row.email,
    isAdmin,
    permissions: isAdmin ? allPermissions() : parseStoredPermissions(row.permissions),
    storageCapBytes: row.storage_cap_bytes,
    gitUsername: row.git_username,
    hasGitPassword: row.git_password_hash !== null,
    gitRotatedAt: row.git_rotated_at,
    removedAt: row.removed_at,
    lastSeenAt: row.last_seen_at,
    capNotifiedAt: row.cap_notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getUser(db: Db, id: number): User | undefined {
  const row = db.get<UserDbRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id);
  return row === undefined ? undefined : toUser(row);
}

export function requireUser(db: Db, id: number): User {
  const user = getUser(db, id);
  if (user === undefined) {
    throw notFound("User", id);
  }
  return user;
}

export function findUserByEmail(db: Db, email: string): User | undefined {
  const row = db.get<UserDbRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = ?`,
    normalizeEmail(email),
  );
  return row === undefined ? undefined : toUser(row);
}

/**
 * The admin row. Migration 010 creates it and nothing deletes it, so its
 * absence is a corrupted database, not a state to recover from silently.
 */
export function getAdminUser(db: Db): User {
  const row = db.get<UserDbRow>(`SELECT ${USER_COLUMNS} FROM users WHERE is_admin = 1`);
  if (row === undefined) {
    throw new Error("The users table has no admin row. Migration 010 should have created it.");
  }
  return toUser(row);
}

/** Every row, the admin first, then by email. */
export function listUsers(db: Db): User[] {
  return db
    .all<UserDbRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY is_admin DESC, email ASC`)
    .map(toUser);
}

// ---------------------------------------------------------------------------
// Admin bootstrap
// ---------------------------------------------------------------------------

/**
 * Point the admin row at the configured admin email, once per boot.
 *
 * The admin row is updated in place and never duplicated, so the admin keeps
 * everything it owns when the address changes. When the new address already
 * belongs to an ordinary user row, that row is RETIRED rather than merged:
 * it is marked removed, loses its git password, and its address is replaced
 * with a placeholder so the admin row can take the real one. Its repositories
 * stay where they are and the admin (the same person, now) can adopt them.
 * Refusing to boot instead would leave an operator with no way out but SQL.
 *
 * `adminEmail` null (insecure mode without AMBER_ADMIN_EMAIL) leaves the row
 * as it is.
 */
export function bootstrapAdmin(
  db: Db,
  log: Logger,
  adminEmail: string | null,
  now: number = Date.now(),
): User {
  return db.tx(() => {
    const admin = getAdminUser(db);
    if (adminEmail === null) {
      return admin;
    }
    const email = normalizeEmail(adminEmail);
    if (admin.email === email) {
      return admin;
    }

    const clash = findUserByEmail(db, email);
    if (clash !== undefined && !clash.isAdmin) {
      db.run(
        `UPDATE users
            SET email = ?, removed_at = COALESCE(removed_at, ?), git_password_hash = NULL,
                git_rotated_at = NULL, updated_at = ?
          WHERE id = ?`,
        `retired-${String(clash.id)}@amber.invalid`,
        now,
        now,
        clash.id,
      );
      // Ids only: addresses stay out of the logs.
      log.warn(
        { retiredUserId: clash.id, adminUserId: admin.id },
        "the admin email belonged to an ordinary user; that row was retired and its " +
          "repositories can be adopted from the Users page",
      );
    }

    db.run("UPDATE users SET email = ?, updated_at = ? WHERE id = ?", email, now, admin.id);
    log.info({ adminUserId: admin.id }, "admin email set from configuration");
    return requireUser(db, admin.id);
  });
}

// ---------------------------------------------------------------------------
// Reconciliation against the access policy
// ---------------------------------------------------------------------------

/**
 * Make the table agree with the policy's email list, in one transaction.
 *
 * - A new email gets a row with the default permissions.
 * - A row whose email left the list gets `removed_at`, and its git password
 *   hash is DELETED: the credential dies on the sync that notices.
 * - A row whose email came back has `removed_at` cleared. Its git password
 *   stays gone; it has to mint a new one.
 *
 * The admin row is never touched: it is never created a second time even
 * when the admin's address is in the list (it normally is), and it is never
 * marked removed when it is not.
 */
export function reconcileUsers(
  db: Db,
  emails: Iterable<string>,
  now: number = Date.now(),
): ReconcileChanges {
  const wanted = new Set<string>();
  for (const email of emails) {
    const normalized = normalizeEmail(email);
    if (normalized !== "") {
      wanted.add(normalized);
    }
  }

  return db.tx(() => {
    const changes: ReconcileChanges = { created: 0, removed: 0, restored: 0 };
    const rows = db.all<{ id: number; email: string; is_admin: number; removed_at: number | null }>(
      "SELECT id, email, is_admin, removed_at FROM users",
    );
    const known = new Set<string>();

    for (const row of rows) {
      known.add(row.email);
      if (row.is_admin === 1) {
        continue;
      }
      const listed = wanted.has(row.email);
      if (listed && row.removed_at !== null) {
        db.run("UPDATE users SET removed_at = NULL, updated_at = ? WHERE id = ?", now, row.id);
        changes.restored += 1;
      } else if (!listed && row.removed_at === null) {
        db.run(
          `UPDATE users
              SET removed_at = ?, git_password_hash = NULL, git_rotated_at = NULL, updated_at = ?
            WHERE id = ?`,
          now,
          now,
          row.id,
        );
        changes.removed += 1;
      }
    }

    const defaults = JSON.stringify(defaultPermissions());
    for (const email of wanted) {
      if (known.has(email)) {
        continue;
      }
      db.run(
        `INSERT INTO users (email, is_admin, permissions, created_at, updated_at)
         VALUES (?, 0, ?, ?, ?)`,
        email,
        defaults,
        now,
        now,
      );
      changes.created += 1;
    }
    return changes;
  });
}

/**
 * The row for a policy member that has none yet. Reconciliation normally
 * creates it; this covers the gap when the copy in use was loaded from the kv
 * mirror rather than freshly reconciled. Never creates an admin row and never
 * revives a removed one.
 */
export function ensureMemberRow(db: Db, email: string, now: number = Date.now()): User {
  const normalized = normalizeEmail(email);
  const existing = findUserByEmail(db, normalized);
  if (existing !== undefined) {
    return existing;
  }
  db.run(
    `INSERT INTO users (email, is_admin, permissions, created_at, updated_at)
     VALUES (?, 0, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
    normalized,
    JSON.stringify(defaultPermissions()),
    now,
    now,
  );
  const created = findUserByEmail(db, normalized);
  if (created === undefined) {
    throw new Error("A user row vanished right after it was created");
  }
  return created;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Admin edits of a user: permissions merged key by key, and the storage cap
 * (null returns the user to the global default). The admin row is immutable:
 * nobody, the admin included, can edit it through the API.
 */
export function updateUser(db: Db, id: number, patch: UpdateUser, now: number = Date.now()): User {
  return db.tx(() => {
    const user = requireUser(db, id);
    if (user.isAdmin) {
      throw new DomainError("immutable", "The admin account cannot be edited.");
    }
    if (patch.permissions !== undefined) {
      const merged: Permissions = { ...user.permissions };
      for (const [key, value] of Object.entries(patch.permissions)) {
        if (typeof value === "boolean") {
          merged[key as keyof Permissions] = value;
        }
      }
      db.run(
        "UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(merged),
        now,
        id,
      );
      // Losing `git` revokes the credential, exactly like revokeGitPassword:
      // re-granting it later must need a fresh mint, never revive the old one.
      if (user.permissions.git && !merged.git) {
        db.run(
          `UPDATE users SET git_password_hash = NULL, git_rotated_at = NULL, updated_at = ?
            WHERE id = ?`,
          now,
          id,
        );
      }
    }
    if (patch.storageCapBytes !== undefined) {
      db.run(
        "UPDATE users SET storage_cap_bytes = ?, updated_at = ? WHERE id = ?",
        patch.storageCapBytes,
        now,
        id,
      );
    }
    return requireUser(db, id);
  });
}

/**
 * Delete a user's git password. The username stays: it is stable across
 * rotations, so a re-minted credential keeps the same clone URLs.
 */
export function revokeGitPassword(db: Db, id: number, now: number = Date.now()): User {
  requireUser(db, id);
  db.run(
    `UPDATE users SET git_password_hash = NULL, git_rotated_at = NULL, updated_at = ?
      WHERE id = ?`,
    now,
    id,
  );
  return requireUser(db, id);
}

/**
 * Record that a user was seen, at most once a minute. Does not move
 * updated_at: being seen is not an edit.
 */
export function touchLastSeen(db: Db, user: User, now: number = Date.now()): void {
  if (user.lastSeenAt !== null && now - user.lastSeenAt < LAST_SEEN_RESOLUTION_MS) {
    return;
  }
  db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, user.id);
}

/**
 * The admin becomes the owner of every repository `fromUserId` owns, and each
 * one's account override is cleared: an override names an account of the OLD
 * owner, and no user's token may fetch for someone else.
 */
export function adoptRepos(db: Db, fromUserId: number, now: number = Date.now()): number {
  return db.tx(() => {
    const from = requireUser(db, fromUserId);
    if (from.isAdmin) {
      throw new DomainError("invalid", "The admin already owns these repositories.");
    }
    const admin = getAdminUser(db);
    return db.run(
      `UPDATE repos SET owner_user_id = ?, account_override_id = NULL, updated_at = ?
        WHERE owner_user_id = ?`,
      admin.id,
      now,
      from.id,
    ).changes;
  });
}

// ---------------------------------------------------------------------------
// Storage usage and caps
// ---------------------------------------------------------------------------

/** The sum of disk usage over the repositories the user owns. */
export function userUsageBytes(db: Db, userId: number): number {
  const row = db.get<{ total: number | null }>(
    "SELECT SUM(disk_usage_bytes) AS total FROM repos WHERE owner_user_id = ?",
    userId,
  );
  return row?.total ?? 0;
}

/** The global default cap, from the `default_user_storage_cap_gb` setting. */
export function defaultStorageCapBytes(db: Db): number {
  const gb = resolveGlobalSettings(db).default_user_storage_cap_gb;
  return Math.round(gb * BYTES_PER_GB);
}

/** The cap in force for a user: their own, else the global default. Null for the admin. */
export function userCapBytes(db: Db, user: User): number | null {
  if (user.isAdmin) {
    return null;
  }
  return user.storageCapBytes ?? defaultStorageCapBytes(db);
}

export function userStorage(db: Db, user: User): StorageUsage {
  const usedBytes = userUsageBytes(db, user.id);
  const capBytes = userCapBytes(db, user);
  return { usedBytes, capBytes, overCap: capBytes !== null && usedBytes >= capBytes };
}

/** True when a new repository must be refused for this user. The admin never is. */
export function isAtOrOverCap(db: Db, user: User): boolean {
  return userStorage(db, user).overCap;
}

// ---------------------------------------------------------------------------
// API rows
// ---------------------------------------------------------------------------

function toUserRow(
  user: User,
  usage: { usedBytes: number; repoCount: number },
  defaultCap: number,
): UserRow {
  const capBytes = user.isAdmin ? null : (user.storageCapBytes ?? defaultCap);
  return {
    id: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    permissions: user.permissions,
    storageCapBytes: user.storageCapBytes,
    capBytes,
    usedBytes: usage.usedBytes,
    overCap: capBytes !== null && usage.usedBytes >= capBytes,
    repoCount: usage.repoCount,
    removedAt: user.removedAt,
    lastSeenAt: user.lastSeenAt,
    hasGitPassword: user.hasGitPassword,
    capNotifiedAt: user.capNotifiedAt,
    createdAt: user.createdAt,
  };
}

/** Every user as GET /api/users returns them, in a fixed number of queries. */
export function listUserRows(db: Db): UserRow[] {
  const usage = new Map<number, { usedBytes: number; repoCount: number }>();
  for (const row of db.all<{ owner_user_id: number; used: number | null; repos: number }>(
    `SELECT owner_user_id, SUM(disk_usage_bytes) AS used, COUNT(*) AS repos
       FROM repos WHERE owner_user_id IS NOT NULL GROUP BY owner_user_id`,
  )) {
    usage.set(row.owner_user_id, { usedBytes: row.used ?? 0, repoCount: row.repos });
  }
  const defaultCap = defaultStorageCapBytes(db);
  return listUsers(db).map((user) =>
    toUserRow(user, usage.get(user.id) ?? { usedBytes: 0, repoCount: 0 }, defaultCap),
  );
}

export function userRow(db: Db, user: User): UserRow {
  const row = db.get<{ used: number | null; repos: number }>(
    "SELECT SUM(disk_usage_bytes) AS used, COUNT(*) AS repos FROM repos WHERE owner_user_id = ?",
    user.id,
  );
  return toUserRow(
    user,
    { usedBytes: row?.used ?? 0, repoCount: row?.repos ?? 0 },
    defaultStorageCapBytes(db),
  );
}
