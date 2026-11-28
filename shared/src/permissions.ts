import "./zodSetup.ts";
import { z } from "zod";

/**
 * The single definition of what a non-admin user may do. The server enforces
 * these keys and the Users page renders them from the same list, so a key, its
 * wording and its default for a new user exist in exactly one place.
 *
 * The admin is not described by this table: the admin holds every permission
 * whatever is stored, and the admin row cannot be edited.
 */

export interface PermissionDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** What a user the access policy just admitted starts with. */
  readonly defaultForNewUser: boolean;
}

function definePermissions<const T extends readonly PermissionDefinition[]>(list: T): T {
  return list;
}

export const PERMISSIONS = definePermissions([
  {
    key: "view_others_public",
    label: "See others' public repositories",
    description: "See repositories other people own that are public on their forge.",
    defaultForNewUser: true,
  },
  {
    key: "view_others_private",
    label: "See others' private repositories",
    description:
      "See repositories other people own that are private, or whose visibility is not known yet.",
    defaultForNewUser: false,
  },
  {
    key: "import",
    label: "Import",
    description: "Import repositories, and create owned, starred and namespace syncs.",
    defaultForNewUser: true,
  },
  {
    key: "import_private",
    label: "Use forge accounts",
    description:
      "Own forge accounts (personal access tokens) and fetch with them. Without it every repository this user owns is fetched anonymously.",
    defaultForNewUser: false,
  },
  {
    key: "modify_others",
    label: "Modify others' repositories",
    description: "Change settings of, pause, sync and delete repositories they can see.",
    defaultForNewUser: false,
  },
  {
    key: "browse",
    label: "Browse files",
    description: "Use the file browser on repositories they can see.",
    defaultForNewUser: true,
  },
  {
    key: "export",
    label: "Export",
    description: "Download archives of repositories they can see.",
    defaultForNewUser: true,
  },
  {
    key: "git",
    label: "Git remote",
    description: "Hold a personal git credential and clone repositories they can see.",
    defaultForNewUser: true,
  },
  {
    key: "view_removed",
    label: "Removed page",
    description: "See the Removed page, still limited to repositories they can see.",
    defaultForNewUser: false,
  },
  {
    key: "manage_forges",
    label: "Manage forges",
    description:
      "Create, edit and delete forges and forge settings, and see and delete other users' accounts (never their secrets).",
    defaultForNewUser: false,
  },
  {
    key: "manage_settings",
    label: "Manage settings",
    description:
      "Edit global settings, the default storage cap and trending syncs, and turn the git remote on or off.",
    defaultForNewUser: false,
  },
] as const);

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((entry) => entry.key) as readonly PermissionKey[];

export const permissionKeySchema = z.enum(
  PERMISSION_KEYS as unknown as [PermissionKey, ...PermissionKey[]],
);

/** Every key present, every value a boolean. */
export type Permissions = Record<PermissionKey, boolean>;

function shape<T extends z.ZodType>(value: T): Record<PermissionKey, T> {
  const out: Partial<Record<PermissionKey, T>> = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = value;
  }
  return out as Record<PermissionKey, T>;
}

/** A complete permissions object, as the API returns it. Unknown keys are refused. */
export const permissionsSchema = z.strictObject(shape(z.boolean()));

/**
 * A partial update, as PATCH /api/users/:id takes it. Strict, so a misspelled
 * key is a 400 rather than an edit that silently did nothing.
 */
export const permissionsPatchSchema = z.strictObject(shape(z.boolean().optional()));

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

/** What a newly admitted user gets. */
export function defaultPermissions(): Permissions {
  const out: Partial<Permissions> = {};
  for (const entry of PERMISSIONS) {
    out[entry.key] = entry.defaultForNewUser;
  }
  return out as Permissions;
}

/** The admin's effective set: everything. */
export function allPermissions(): Permissions {
  const out: Partial<Permissions> = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = true;
  }
  return out as Permissions;
}

/**
 * Read a stored or partial permissions object into a complete one. Unknown
 * keys are dropped and a value that is not exactly `true` or `false` falls
 * back to the default, so a key added after a row was written takes its
 * default rather than reading as granted.
 */
export function fillPermissionDefaults(raw: unknown): Permissions {
  const out = defaultPermissions();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  const record = raw as Record<string, unknown>;
  for (const key of PERMISSION_KEYS) {
    const value = record[key];
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
