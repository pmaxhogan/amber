import { z } from "zod";

/**
 * The scopes a setting can be stored at. Resolution order is narrowest-first:
 * repo -> effective account -> forge -> global -> registry default.
 */
export const SETTING_SCOPES = ["global", "forge", "account", "repo"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export const settingScopeSchema = z.enum(SETTING_SCOPES);

/** Every scope, narrowest last. Used by settings that are overridable anywhere. */
export const ALL_SCOPES: readonly SettingScope[] = SETTING_SCOPES;
/** Settings that only make sense process-wide. */
export const GLOBAL_ONLY: readonly SettingScope[] = ["global"];

export const CLONE_MODES = ["bare", "full", "shallow", "mirror"] as const;
export type CloneMode = (typeof CLONE_MODES)[number];
export const cloneModeSchema = z.enum(CLONE_MODES);

/** How the web UI should render a setting. */
export type SettingControl = "toggle" | "number" | "select";

export interface SettingUi {
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly control: SettingControl;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
}

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly default: z.infer<S>;
  readonly scopes: readonly SettingScope[];
  readonly ui: SettingUi;
}

function defineSetting<S extends z.ZodType>(def: SettingDefinition<S>): SettingDefinition<S> {
  return def;
}

const positiveInt = z.number().int().min(1);

/**
 * The single source of truth for layered settings. Adding a key here is all that
 * is required for it to become storable at its allowed scopes, validated by the
 * API, and rendered in the settings UI.
 */
export const settingsRegistry = {
  clone_mode: defineSetting({
    schema: cloneModeSchema,
    default: "bare",
    scopes: ALL_SCOPES,
    ui: {
      label: "Clone mode",
      description:
        "How the backup is stored. Bare keeps branches and tags without a working tree, mirror keeps every ref the forge advertises, shallow truncates history, full also checks out a working tree.",
      group: "Backup",
      control: "select",
      options: [
        { value: "bare", label: "Bare (branches and tags)" },
        { value: "mirror", label: "Mirror (every ref)" },
        { value: "shallow", label: "Shallow (truncated history)" },
        { value: "full", label: "Full (with working tree)" },
      ],
    },
  }),
  shallow_depth: defineSetting({
    schema: positiveInt,
    default: 1,
    scopes: ALL_SCOPES,
    ui: {
      label: "Shallow depth",
      description: "Number of commits to keep when clone mode is shallow.",
      group: "Backup",
      control: "number",
      min: 1,
      unit: "commits",
    },
  }),
  sync_interval_minutes: defineSetting({
    schema: positiveInt,
    default: 180,
    scopes: ALL_SCOPES,
    ui: {
      label: "Sync interval",
      description: "How long to wait between syncs of a repository.",
      group: "Schedule",
      control: "number",
      min: 1,
      unit: "minutes",
    },
  }),
  sync_enabled: defineSetting({
    schema: z.boolean(),
    default: true,
    scopes: ALL_SCOPES,
    ui: {
      label: "Sync enabled",
      description: "Turn scheduled syncing on or off. Manual syncs still work when off.",
      group: "Schedule",
      control: "toggle",
    },
  }),
  lfs_enabled: defineSetting({
    schema: z.boolean(),
    default: true,
    scopes: ALL_SCOPES,
    ui: {
      label: "Git LFS",
      description: "Fetch Git LFS objects alongside the repository history.",
      group: "Backup",
      control: "toggle",
    },
  }),
  paranoid: defineSetting({
    schema: z.boolean(),
    default: false,
    scopes: ALL_SCOPES,
    ui: {
      label: "Paranoid mode",
      description:
        "Never lose history. Disables pruning and garbage collection and archives every ref tip that upstream rewrites or deletes. Uses more disk.",
      group: "Backup",
      control: "toggle",
    },
  }),
  max_concurrent_syncs: defineSetting({
    schema: positiveInt,
    default: 8,
    scopes: GLOBAL_ONLY,
    ui: {
      label: "Max concurrent syncs",
      description: "Upper bound on repositories syncing at the same time across all forges.",
      group: "Performance",
      control: "number",
      min: 1,
      unit: "workers",
    },
  }),
  max_concurrent_per_forge: defineSetting({
    schema: positiveInt,
    default: 4,
    scopes: GLOBAL_ONLY,
    ui: {
      label: "Max concurrent syncs per forge",
      description: "Upper bound on repositories syncing at the same time from a single forge.",
      group: "Performance",
      control: "number",
      min: 1,
      unit: "workers",
    },
  }),
} as const;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingKey = keyof SettingsRegistry;

/** The fully merged, typed settings object returned by resolveSettings(). */
export type ResolvedSettings = {
  [K in SettingKey]: z.infer<SettingsRegistry[K]["schema"]>;
};

/** Which scope supplied each resolved value, for the settings explain view. */
export type SettingsExplanation = {
  [K in SettingKey]: {
    value: ResolvedSettings[K];
    source: SettingScope | "default";
    sourceId: number | null;
  };
};

export const SETTING_KEYS = Object.keys(settingsRegistry) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(settingsRegistry, key);
}

export function isScopeAllowed(key: SettingKey, scope: SettingScope): boolean {
  return settingsRegistry[key].scopes.includes(scope);
}

/** Keys that may be stored at the given scope, in registry order. */
export function settingKeysForScope(scope: SettingScope): SettingKey[] {
  return SETTING_KEYS.filter((key) => isScopeAllowed(key, scope));
}

/** A fresh object holding every registry default. */
export function defaultSettings(): ResolvedSettings {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    out[key] = settingsRegistry[key].default;
  }
  return out as ResolvedSettings;
}

export type SettingParseResult<K extends SettingKey = SettingKey> =
  { ok: true; value: ResolvedSettings[K] } | { ok: false; error: string };

/** Validate one raw value against the registry schema for `key`. */
export function parseSettingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): SettingParseResult<K> {
  const result = settingsRegistry[key].schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data as ResolvedSettings[K] };
  }
  const first = result.error.issues[0];
  return { ok: false, error: first ? first.message : "Invalid value" };
}

/**
 * Validate a settings patch for a scope. Unknown keys and keys not allowed at
 * that scope are reported rather than silently dropped.
 */
export function parseSettingsPatch(
  scope: SettingScope,
  patch: Record<string, unknown>,
): { ok: true; value: Partial<ResolvedSettings> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!isSettingKey(key)) {
      errors[key] = "Unknown setting";
      continue;
    }
    if (!isScopeAllowed(key, scope)) {
      errors[key] = `Setting cannot be set at the ${scope} scope`;
      continue;
    }
    if (raw === null) {
      // null clears an override at this scope; the resolver falls through.
      value[key] = null;
      continue;
    }
    const parsed = parseSettingValue(key, raw);
    if (parsed.ok) {
      value[key] = parsed.value;
    } else {
      errors[key] = parsed.error;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as Partial<ResolvedSettings> };
}
