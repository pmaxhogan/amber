import {
  SETTING_SCOPES,
  settingsRegistry,
  type SettingKey,
  type SettingScope,
} from "@amber/shared";
import type { SettingSource, SettingsOverrides } from "../api/types.ts";

/**
 * Client-side settings inheritance.
 *
 * The API exposes an explain endpoint for repo scope only
 * (GET /api/repos/:id/effective-settings). The settings editor also has to show
 * "inherited from X" while editing forge and account scope, so the same
 * narrowest-wins walk is reproduced here over the stored overrides of each
 * broader scope. Resolution order matches ARCHITECTURE.md:
 * repo -> account -> forge -> global -> registry default.
 */

export type ScopeOverrides = Partial<Record<SettingScope, SettingsOverrides>>;

/** Broadest last. The reverse of the narrowest-wins resolution order. */
const NARROWEST_FIRST: readonly SettingScope[] = ["repo", "account", "forge", "global"];

export interface InheritedValue {
  value: unknown;
  source: SettingSource;
}

function hasOverride(overrides: SettingsOverrides | undefined, key: SettingKey): boolean {
  if (overrides === undefined) return false;
  const value = overrides[key];
  return value !== undefined && value !== null;
}

/**
 * What `key` would resolve to at `scope` if `scope` itself set nothing.
 * Only scopes strictly broader than `scope` are consulted.
 */
export function inheritedValue(
  key: SettingKey,
  scope: SettingScope,
  chain: ScopeOverrides,
): InheritedValue {
  const start = NARROWEST_FIRST.indexOf(scope);
  const candidates = start === -1 ? NARROWEST_FIRST : NARROWEST_FIRST.slice(start + 1);
  for (const candidate of candidates) {
    const overrides = chain[candidate];
    if (hasOverride(overrides, key)) {
      return { value: overrides?.[key], source: candidate };
    }
  }
  return { value: settingsRegistry[key].default, source: "default" };
}

export interface FieldState extends InheritedValue {
  key: SettingKey;
  /** True when this scope stores its own value for the key. */
  isSet: boolean;
  /** The stored override at this scope, or the inherited value when unset. */
  effective: unknown;
}

export function fieldState(
  key: SettingKey,
  scope: SettingScope,
  chain: ScopeOverrides,
): FieldState {
  const own = chain[scope];
  const inherited = inheritedValue(key, scope, chain);
  const isSet = hasOverride(own, key);
  return {
    key,
    isSet,
    effective: isSet ? own?.[key] : inherited.value,
    value: inherited.value,
    source: inherited.source,
  };
}

/** Registry keys grouped by their UI group, in registry order. */
export function groupedKeys(keys: readonly SettingKey[]): { group: string; keys: SettingKey[] }[] {
  const groups: { group: string; keys: SettingKey[] }[] = [];
  for (const key of keys) {
    const group = settingsRegistry[key].ui.group;
    const existing = groups.find((entry) => entry.group === group);
    if (existing === undefined) {
      groups.push({ group, keys: [key] });
    } else {
      existing.keys.push(key);
    }
  }
  return groups;
}

export function isSettingScope(value: string): value is SettingScope {
  return (SETTING_SCOPES as readonly string[]).includes(value);
}
