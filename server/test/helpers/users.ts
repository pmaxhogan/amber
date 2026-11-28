import { PERMISSION_KEYS, type Permissions } from "@amber/shared";
import type { Db } from "../../src/db/db.ts";
import {
  ensureMemberRow,
  getAdminUser,
  requireUser,
  updateUser,
  type User,
} from "../../src/domain/users.ts";

/**
 * Users for domain-level tests, straight into the users table. Route tests
 * that go through the identity hook use INSECURE_USER_EMAILS and asUser()
 * instead; both end up as the same rows.
 */

export function adminOf(db: Db): User {
  return getAdminUser(db);
}

export function noPermissions(): Permissions {
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false])) as Permissions;
}

/** A non-admin user with the new-user defaults, then `permissions` applied on top. */
export function makeUser(
  db: Db,
  email: string,
  permissions: Partial<Permissions> = {},
  options: { removed?: boolean; nothing?: boolean; capBytes?: number | null } = {},
): User {
  const user = ensureMemberRow(db, email);
  const base = options.nothing === true ? noPermissions() : {};
  updateUser(db, user.id, {
    permissions: { ...base, ...permissions },
    ...(options.capBytes === undefined ? {} : { storageCapBytes: options.capBytes }),
  });
  if (options.removed === true) {
    db.run("UPDATE users SET removed_at = ? WHERE id = ?", Date.now(), user.id);
  }
  return requireUser(db, user.id);
}

/** Re-read a user, for after a test changed their row. */
export function fresh(db: Db, user: User): User {
  return requireUser(db, user.id);
}
