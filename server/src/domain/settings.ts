import type { ResolvedSettings, SettingScope, SettingsExplanation } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { notImplemented } from "../notImplemented.ts";

/**
 * Resolution order, narrowest first: repo -> effective account (the override,
 * or the forge default; skipped when force_anonymous) -> forge -> global ->
 * registry default.
 */
export function resolveSettings(_db: Db, _repoId: number): ResolvedSettings {
  return notImplemented("resolveSettings");
}

/** Same resolution, but reporting which scope supplied each value. */
export function explainSettings(_db: Db, _repoId: number): SettingsExplanation {
  return notImplemented("explainSettings");
}

export function getScopeSettings(
  _db: Db,
  _scope: SettingScope,
  _scopeId: number | null,
): Partial<ResolvedSettings> {
  return notImplemented("getScopeSettings");
}

export function putScopeSettings(
  _db: Db,
  _scope: SettingScope,
  _scopeId: number | null,
  _patch: Partial<ResolvedSettings>,
): Partial<ResolvedSettings> {
  return notImplemented("putScopeSettings");
}

/** Global settings with no repo context, for the scheduler's own knobs. */
export function resolveGlobalSettings(_db: Db): ResolvedSettings {
  return notImplemented("resolveGlobalSettings");
}
