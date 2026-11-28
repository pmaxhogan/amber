import { allPermissions, defaultPermissions } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { putScopeSettings } from "../src/domain/settings.ts";
import {
  ADMIN_PLACEHOLDER_EMAIL,
  adoptRepos,
  bootstrapAdmin,
  defaultStorageCapBytes,
  ensureMemberRow,
  findUserByEmail,
  getAdminUser,
  isAtOrOverCap,
  LAST_SEEN_RESOLUTION_MS,
  listUserRows,
  reconcileUsers,
  requireUser,
  revokeGitPassword,
  touchLastSeen,
  updateUser,
  userStorage,
} from "../src/domain/users.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, seedForge, type TempDb } from "./helpers.ts";

const log = createConsoleLogger("silent");
const GB = 1024 ** 3;

let temp: TempDb;

beforeEach(() => {
  temp = createTempDb();
});

afterEach(() => {
  temp.close();
});

function addRepo(path: string, ownerUserId: number | null, diskUsageBytes: number | null): number {
  const forgeId = seedForge(temp.db);
  const shortId = path
    .replace(/[^a-z]/g, "")
    .padEnd(8, "x")
    .slice(0, 8);
  return temp.db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, owner_user_id,
                        disk_usage_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    forgeId,
    path,
    path,
    `${path.replace(/\//g, "-")}-${shortId}`,
    shortId,
    ownerUserId,
    diskUsageBytes,
  ).lastInsertRowid;
}

function setGitPassword(userId: number): void {
  temp.db.run(
    "UPDATE users SET git_username = ?, git_password_hash = 'scrypt$x', git_rotated_at = 9 WHERE id = ?",
    `user${String(userId)}`,
    userId,
  );
}

describe("bootstrapAdmin", () => {
  it("fills the placeholder in, once, and is idempotent", () => {
    expect(getAdminUser(temp.db).email).toBe(ADMIN_PLACEHOLDER_EMAIL);
    const admin = bootstrapAdmin(temp.db, log, "Admin@Example.com");
    expect(admin.email).toBe("admin@example.com");
    expect(admin.isAdmin).toBe(true);
    expect(bootstrapAdmin(temp.db, log, "admin@example.com").id).toBe(admin.id);
  });

  it("updates the single admin row when the configured address changes, keeping what it owns", () => {
    const first = bootstrapAdmin(temp.db, log, "admin@example.com");
    const repoId = addRepo("a/b", first.id, 10);

    const second = bootstrapAdmin(temp.db, log, "new-admin@example.com");
    expect(second.id).toBe(first.id);
    expect(temp.db.get("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1")).toEqual({ n: 1 });
    expect(temp.db.get("SELECT owner_user_id FROM repos WHERE id = ?", repoId)).toEqual({
      owner_user_id: first.id,
    });
    expect(findUserByEmail(temp.db, "admin@example.com")).toBeUndefined();
  });

  it("retires an ordinary row that held the new admin address instead of duplicating it", () => {
    bootstrapAdmin(temp.db, log, "admin@example.com");
    reconcileUsers(temp.db, ["friend@example.com"]);
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    setGitPassword(friend.id);
    const repoId = addRepo("friend/repo", friend.id, 5);

    const admin = bootstrapAdmin(temp.db, log, "friend@example.com", 1234);
    expect(admin.email).toBe("friend@example.com");
    expect(admin.isAdmin).toBe(true);

    const retired = requireUser(temp.db, friend.id);
    expect(retired.isAdmin).toBe(false);
    expect(retired.email).toBe(`retired-${String(friend.id)}@amber.invalid`);
    expect(retired.removedAt).toBe(1234);
    expect(retired.hasGitPassword).toBe(false);
    // The repositories stay with the retired row, ready to be adopted.
    expect(adoptRepos(temp.db, friend.id)).toBe(1);
    expect(temp.db.get("SELECT owner_user_id FROM repos WHERE id = ?", repoId)).toEqual({
      owner_user_id: admin.id,
    });
  });

  it("leaves the row alone when no admin email is configured", () => {
    expect(bootstrapAdmin(temp.db, log, null).email).toBe(ADMIN_PLACEHOLDER_EMAIL);
  });
});

describe("reconcileUsers", () => {
  beforeEach(() => {
    bootstrapAdmin(temp.db, log, "admin@example.com");
  });

  it("creates new emails with the default permissions", () => {
    expect(reconcileUsers(temp.db, [" Friend@Example.com ", "", "other@example.com"], 50)).toEqual({
      created: 2,
      removed: 0,
      restored: 0,
    });
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    expect(friend.permissions).toEqual(defaultPermissions());
    expect(friend.createdAt).toBe(50);
  });

  it("marks a departed email removed and deletes its git password, then restores it", () => {
    reconcileUsers(temp.db, ["friend@example.com"]);
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    setGitPassword(friend.id);

    expect(reconcileUsers(temp.db, [], 77)).toEqual({ created: 0, removed: 1, restored: 0 });
    const removed = requireUser(temp.db, friend.id);
    expect(removed.removedAt).toBe(77);
    expect(removed.hasGitPassword).toBe(false);
    // The username survives: it is stable across rotations.
    expect(removed.gitUsername).toBe(`user${String(friend.id)}`);

    expect(reconcileUsers(temp.db, ["friend@example.com"], 88)).toEqual({
      created: 0,
      removed: 0,
      restored: 1,
    });
    const back = requireUser(temp.db, friend.id);
    expect(back.removedAt).toBeNull();
    // A returning user mints a new credential; the old one does not come back.
    expect(back.hasGitPassword).toBe(false);
  });

  it("is a no-op when nothing changed", () => {
    reconcileUsers(temp.db, ["friend@example.com"]);
    expect(reconcileUsers(temp.db, ["FRIEND@example.com"])).toEqual({
      created: 0,
      removed: 0,
      restored: 0,
    });
  });

  it("never duplicates nor removes the admin", () => {
    reconcileUsers(temp.db, ["ADMIN@example.com"]);
    reconcileUsers(temp.db, []);
    const admin = getAdminUser(temp.db);
    expect(admin.removedAt).toBeNull();
    expect(temp.db.get("SELECT COUNT(*) AS n FROM users")).toEqual({ n: 1 });
  });
});

describe("ensureMemberRow", () => {
  it("creates a missing member with defaults and returns an existing one unchanged", () => {
    const created = ensureMemberRow(temp.db, "New@Example.com", 5);
    expect(created.email).toBe("new@example.com");
    expect(created.permissions).toEqual(defaultPermissions());
    expect(ensureMemberRow(temp.db, "new@example.com").id).toBe(created.id);
  });
});

describe("updateUser", () => {
  beforeEach(() => {
    bootstrapAdmin(temp.db, log, "admin@example.com");
    reconcileUsers(temp.db, ["friend@example.com"]);
  });

  it("merges permissions key by key and sets or clears the cap", () => {
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    const updated = updateUser(temp.db, friend.id, {
      permissions: { modify_others: true, git: false },
      storageCapBytes: 3 * GB,
    });
    expect(updated.permissions).toEqual({
      ...defaultPermissions(),
      modify_others: true,
      git: false,
    });
    expect(updated.storageCapBytes).toBe(3 * GB);

    const cleared = updateUser(temp.db, friend.id, { storageCapBytes: null });
    expect(cleared.storageCapBytes).toBeNull();
    expect(cleared.permissions.modify_others).toBe(true);
  });

  it("refuses to edit the admin row and unknown users", () => {
    const admin = getAdminUser(temp.db);
    expect(() => updateUser(temp.db, admin.id, { permissions: { git: false } })).toThrow(
      /admin account cannot be edited/,
    );
    expect(() => updateUser(temp.db, 9999, {})).toThrow(/does not exist/);
  });

  it("reads a corrupt or partial stored permission set as defaults, never more", () => {
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    temp.db.run(
      `UPDATE users SET permissions = '{"view_others_private": "yes", "bogus": true}' WHERE id = ?`,
      friend.id,
    );
    expect(requireUser(temp.db, friend.id).permissions).toEqual(defaultPermissions());
  });

  it("gives the admin every permission whatever its row stores", () => {
    expect(getAdminUser(temp.db).permissions).toEqual(allPermissions());
  });
});

describe("revokeGitPassword and touchLastSeen", () => {
  it("deletes the password but keeps the username", () => {
    const admin = bootstrapAdmin(temp.db, log, "admin@example.com");
    setGitPassword(admin.id);
    const revoked = revokeGitPassword(temp.db, admin.id);
    expect(revoked.hasGitPassword).toBe(false);
    expect(revoked.gitRotatedAt).toBeNull();
    expect(revoked.gitUsername).toBe(`user${String(admin.id)}`);
    expect(() => revokeGitPassword(temp.db, 9999)).toThrow(/does not exist/);
  });

  it("writes last_seen_at at most once a minute", () => {
    const admin = getAdminUser(temp.db);
    touchLastSeen(temp.db, admin, 1_000);
    expect(getAdminUser(temp.db).lastSeenAt).toBe(1_000);
    touchLastSeen(temp.db, getAdminUser(temp.db), 1_000 + LAST_SEEN_RESOLUTION_MS - 1);
    expect(getAdminUser(temp.db).lastSeenAt).toBe(1_000);
    touchLastSeen(temp.db, getAdminUser(temp.db), 1_000 + LAST_SEEN_RESOLUTION_MS);
    expect(getAdminUser(temp.db).lastSeenAt).toBe(1_000 + LAST_SEEN_RESOLUTION_MS);
  });
});

describe("adoptRepos", () => {
  it("moves every repo to the admin and clears each override", () => {
    const admin = bootstrapAdmin(temp.db, log, "admin@example.com");
    reconcileUsers(temp.db, ["friend@example.com"]);
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    const forgeId = seedForge(temp.db);
    const accountId = temp.db.run(
      "INSERT INTO accounts (forge_id, username, is_default, owner_user_id, created_at, updated_at) VALUES (?, 'f', 1, ?, 1, 1)",
      forgeId,
      friend.id,
    ).lastInsertRowid;
    const repoId = addRepo("friend/one", friend.id, 1);
    temp.db.run("UPDATE repos SET account_override_id = ? WHERE id = ?", accountId, repoId);
    addRepo("friend/two", friend.id, 1);
    const adminRepo = addRepo("admin/own", admin.id, 1);

    expect(adoptRepos(temp.db, friend.id, 99)).toBe(2);
    expect(
      temp.db.all("SELECT id, owner_user_id, account_override_id FROM repos ORDER BY id"),
    ).toEqual([
      { id: repoId, owner_user_id: admin.id, account_override_id: null },
      { id: repoId + 1, owner_user_id: admin.id, account_override_id: null },
      { id: adminRepo, owner_user_id: admin.id, account_override_id: null },
    ]);
    expect(adoptRepos(temp.db, friend.id)).toBe(0);
    expect(() => adoptRepos(temp.db, admin.id)).toThrow(/already owns/);
    expect(() => adoptRepos(temp.db, 9999)).toThrow(/does not exist/);
  });
});

describe("storage usage and caps", () => {
  beforeEach(() => {
    bootstrapAdmin(temp.db, log, "admin@example.com");
    reconcileUsers(temp.db, ["friend@example.com", "idle@example.com"]);
  });

  it("sums the disk usage of owned repos against the global default cap", () => {
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    addRepo("f/a", friend.id, 2 * GB);
    addRepo("f/b", friend.id, null);
    addRepo("f/c", friend.id, GB);

    expect(defaultStorageCapBytes(temp.db)).toBe(5 * GB);
    expect(userStorage(temp.db, friend)).toEqual({
      usedBytes: 3 * GB,
      capBytes: 5 * GB,
      overCap: false,
    });

    putScopeSettings(temp.db, "global", null, { default_user_storage_cap_gb: 3 });
    expect(userStorage(temp.db, friend)).toEqual({
      usedBytes: 3 * GB,
      capBytes: 3 * GB,
      // At the cap counts as reached.
      overCap: true,
    });
    expect(isAtOrOverCap(temp.db, friend)).toBe(true);

    const raised = updateUser(temp.db, friend.id, { storageCapBytes: 10 * GB });
    expect(userStorage(temp.db, raised).overCap).toBe(false);
  });

  it("never caps the admin", () => {
    const admin = getAdminUser(temp.db);
    addRepo("a/huge", admin.id, 100 * GB);
    expect(userStorage(temp.db, admin)).toEqual({
      usedBytes: 100 * GB,
      capBytes: null,
      overCap: false,
    });
  });

  it("lists every user with usage and repo counts in one go", () => {
    const friend = findUserByEmail(temp.db, "friend@example.com")!;
    addRepo("f/a", friend.id, 7);
    addRepo("f/b", friend.id, 3);
    const rows = listUserRows(temp.db);
    expect(rows.map((row) => row.email)).toEqual([
      "admin@example.com",
      "friend@example.com",
      "idle@example.com",
    ]);
    expect(rows[0]).toMatchObject({ isAdmin: true, capBytes: null, overCap: false, repoCount: 0 });
    expect(rows[1]).toMatchObject({
      usedBytes: 10,
      repoCount: 2,
      capBytes: 5 * GB,
      storageCapBytes: null,
      hasGitPassword: false,
    });
    expect(rows[2]).toMatchObject({ usedBytes: 0, repoCount: 0 });
  });
});
