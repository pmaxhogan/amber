import { describe, expect, it } from "vitest";
import {
  accessPolicyEditUrl,
  forgeSchema,
  gitRemoteCredentialSchema,
  gitRemoteMeSchema,
  meSchema,
  repoListQuerySchema,
  updateUserSchema,
} from "../src/apiTypes.ts";
import {
  allPermissions,
  defaultPermissions,
  fillPermissionDefaults,
  isPermissionKey,
  PERMISSION_KEYS,
  PERMISSIONS,
  permissionsPatchSchema,
  permissionsSchema,
} from "../src/permissions.ts";

describe("the permission table", () => {
  it("is exactly the eleven keys of the spec, with their new-user defaults", () => {
    expect(
      Object.fromEntries(PERMISSIONS.map((entry) => [entry.key, entry.defaultForNewUser])),
    ).toEqual({
      view_others_public: true,
      view_others_private: false,
      import: true,
      import_private: false,
      modify_others: false,
      browse: true,
      export: true,
      git: true,
      view_removed: false,
      manage_forges: false,
      manage_settings: false,
    });
    expect(PERMISSION_KEYS).toHaveLength(11);
  });

  it("labels and describes every key in ASCII", () => {
    for (const entry of PERMISSIONS) {
      expect(entry.label.length, entry.key).toBeGreaterThan(0);
      expect(entry.description.length, entry.key).toBeGreaterThan(0);
      expect(`${entry.label} ${entry.description}`, entry.key).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("builds defaults, the admin's full set, and a key check", () => {
    expect(Object.values(allPermissions()).every(Boolean)).toBe(true);
    expect(defaultPermissions()).not.toBe(defaultPermissions());
    expect(isPermissionKey("git")).toBe(true);
    expect(isPermissionKey("admin")).toBe(false);
  });
});

describe("permission schemas", () => {
  it("demands a complete object and refuses unknown keys", () => {
    expect(permissionsSchema.safeParse(defaultPermissions()).success).toBe(true);
    const { git: _git, ...missing } = defaultPermissions();
    expect(permissionsSchema.safeParse(missing).success).toBe(false);
    expect(permissionsSchema.safeParse({ ...defaultPermissions(), root: true }).success).toBe(
      false,
    );
  });

  it("takes a partial patch, strictly", () => {
    expect(permissionsPatchSchema.parse({ git: false })).toEqual({ git: false });
    expect(permissionsPatchSchema.safeParse({ root: true }).success).toBe(false);
    expect(permissionsPatchSchema.safeParse({ git: "false" }).success).toBe(false);
  });

  it("fills a stored object, never reading anything but true as granted", () => {
    expect(fillPermissionDefaults(null)).toEqual(defaultPermissions());
    expect(fillPermissionDefaults([true])).toEqual(defaultPermissions());
    expect(
      fillPermissionDefaults({
        view_others_private: "true",
        git: false,
        manage_forges: 1,
        x: true,
      }),
    ).toEqual({ ...defaultPermissions(), git: false });
    expect(fillPermissionDefaults({ manage_forges: true }).manage_forges).toBe(true);
  });
});

describe("multi-user contracts", () => {
  it("keeps the user PATCH strict so isAdmin or email cannot sneak in", () => {
    expect(updateUserSchema.safeParse({ permissions: { git: true } }).success).toBe(true);
    expect(updateUserSchema.safeParse({ storageCapBytes: null }).success).toBe(true);
    expect(updateUserSchema.safeParse({ isAdmin: true }).success).toBe(false);
    expect(updateUserSchema.safeParse({ email: "x@example.com" }).success).toBe(false);
  });

  it("parses /api/me with a null policy for non-admins", () => {
    expect(
      meSchema.parse({
        id: 2,
        email: "friend@example.com",
        isAdmin: false,
        permissions: defaultPermissions(),
        storage: { usedBytes: 0, capBytes: 10, overCap: false },
        policy: null,
      }).policy,
    ).toBeNull();
  });

  it("still parses a forge from before allowPrivateNetwork existed", () => {
    expect(
      forgeSchema.parse({
        id: 1,
        protocol: "https",
        host: "github.com",
        port: null,
        kind: "github",
        createdAt: 1,
        updatedAt: 1,
      }).allowPrivateNetwork,
    ).toBeUndefined();
  });

  it("reads the new repo list filters as flags", () => {
    expect(
      repoListQuerySchema.parse({ mine: "true", ownerRemoved: "0", ownerId: "3" }),
    ).toMatchObject({
      mine: true,
      ownerRemoved: false,
      ownerId: 3,
    });
  });

  it("only lets the rotate response carry a password", () => {
    const state = {
      enabled: true,
      username: null,
      hasPassword: false,
      rotatedAt: null,
      cloneUrlTemplate: null,
    };
    expect(gitRemoteMeSchema.parse(state)).toEqual(state);
    expect("password" in gitRemoteMeSchema.parse({ ...state, password: "x" })).toBe(false);
    expect(
      gitRemoteCredentialSchema.safeParse({ ...state, username: "abcdefghij", password: "p" })
        .success,
    ).toBe(true);
  });

  it("builds the policy editor link from the two ids", () => {
    expect(accessPolicyEditUrl("acct", "pol")).toBe(
      "https://dash.cloudflare.com/acct/one/access-controls/policies/pol/edit",
    );
  });
});
