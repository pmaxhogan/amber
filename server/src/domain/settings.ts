import {
  defaultSettings,
  isSettingKey,
  parseSettingsPatch,
  parseSettingValue,
  SETTING_KEYS,
  settingsRegistry,
  type ResolvedSettings,
  type SettingKey,
  type SettingScope,
  type SettingsExplanation,
} from "@amber/shared";
import type { Db } from "../db/db.ts";
import { invalid, notFound } from "./errors.ts";

/**
 * Resolution order, narrowest first: repo -> effective account (the override,
 * or the forge default; skipped when force_anonymous) -> forge -> global ->
 * registry default.
 */

type ScopeValues = Map<SettingKey, unknown>;

interface Layer {
  scope: SettingScope;
  scopeId: number | null;
  values: ScopeValues;
}

/**
 * Read one scope's stored overrides. Rows whose key is no longer in the
 * registry, or whose value no longer validates, are skipped rather than
 * throwing: a stale row must not break resolution for every other key.
 */
function loadScopeValues(db: Db, scope: SettingScope, scopeId: number | null): ScopeValues {
  const rows =
    scopeId === null
      ? db.all<{ key: string; value: string }>(
          "SELECT key, value FROM settings WHERE scope_type = ? AND scope_id IS NULL",
          scope,
        )
      : db.all<{ key: string; value: string }>(
          "SELECT key, value FROM settings WHERE scope_type = ? AND scope_id = ?",
          scope,
          scopeId,
        );

  const values: ScopeValues = new Map();
  for (const row of rows) {
    if (!isSettingKey(row.key)) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.value);
    } catch {
      continue;
    }
    const parsed = parseSettingValue(row.key, decoded);
    if (parsed.ok) {
      values.set(row.key, parsed.value);
    }
  }
  return values;
}

interface RepoScopeRow {
  id: number;
  forge_id: number;
  account_override_id: number | null;
  force_anonymous: number;
}

/**
 * The account whose settings apply to this repo: the explicit override, or the
 * forge's default account. force_anonymous means the repo is fetched without
 * credentials, so no account layer participates at all.
 */
function effectiveAccountId(db: Db, repo: RepoScopeRow): number | null {
  if (repo.force_anonymous === 1) {
    return null;
  }
  if (repo.account_override_id !== null) {
    return repo.account_override_id;
  }
  const row = db.get<{ id: number }>(
    "SELECT id FROM accounts WHERE forge_id = ? AND is_default = 1",
    repo.forge_id,
  );
  return row?.id ?? null;
}

/** Narrowest first. The first layer holding a key wins it. */
function layersForRepo(db: Db, repoId: number): Layer[] {
  const repo = db.get<RepoScopeRow>(
    "SELECT id, forge_id, account_override_id, force_anonymous FROM repos WHERE id = ?",
    repoId,
  );
  if (repo === undefined) {
    throw notFound("Repository", repoId);
  }

  const layers: Layer[] = [
    { scope: "repo", scopeId: repo.id, values: loadScopeValues(db, "repo", repo.id) },
  ];

  const accountId = effectiveAccountId(db, repo);
  if (accountId !== null) {
    layers.push({
      scope: "account",
      scopeId: accountId,
      values: loadScopeValues(db, "account", accountId),
    });
  }

  layers.push({
    scope: "forge",
    scopeId: repo.forge_id,
    values: loadScopeValues(db, "forge", repo.forge_id),
  });
  layers.push({ scope: "global", scopeId: null, values: loadScopeValues(db, "global", null) });

  return layers;
}

function explainFromLayers(layers: readonly Layer[]): SettingsExplanation {
  const defaults = defaultSettings();
  const out: Record<string, unknown> = {};

  for (const key of SETTING_KEYS) {
    let resolved: { value: unknown; source: SettingScope | "default"; sourceId: number | null } = {
      value: defaults[key],
      source: "default",
      sourceId: null,
    };
    for (const layer of layers) {
      // A key that is not storable at this scope can never win it, even if a
      // row somehow exists.
      if (!settingsRegistry[key].scopes.includes(layer.scope)) {
        continue;
      }
      if (layer.values.has(key)) {
        resolved = { value: layer.values.get(key), source: layer.scope, sourceId: layer.scopeId };
        break;
      }
    }
    out[key] = resolved;
  }

  return out as SettingsExplanation;
}

function settingsFromExplanation(explanation: SettingsExplanation): ResolvedSettings {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    out[key] = explanation[key].value;
  }
  return out as ResolvedSettings;
}

export function resolveSettings(db: Db, repoId: number): ResolvedSettings {
  return settingsFromExplanation(explainFromLayers(layersForRepo(db, repoId)));
}

/** Same resolution, but reporting which scope supplied each value. */
export function explainSettings(db: Db, repoId: number): SettingsExplanation {
  return explainFromLayers(layersForRepo(db, repoId));
}

/** Global settings with no repo context, for the scheduler's own knobs. */
export function resolveGlobalSettings(db: Db): ResolvedSettings {
  return settingsFromExplanation(
    explainFromLayers([
      { scope: "global", scopeId: null, values: loadScopeValues(db, "global", null) },
    ]),
  );
}

/**
 * A scope id must name a row that exists, otherwise the settings are written
 * where nothing will ever read them. Global takes no id.
 */
function assertScopeTarget(db: Db, scope: SettingScope, scopeId: number | null): void {
  if (scope === "global") {
    if (scopeId !== null) {
      throw invalid("Global settings take no scope id.");
    }
    return;
  }
  if (scopeId === null) {
    throw invalid(`The ${scope} scope needs a scope id.`);
  }

  const table = { forge: "forges", account: "accounts", repo: "repos" }[scope];
  const label = { forge: "Forge", account: "Account", repo: "Repository" }[scope];
  const row = db.get<{ id: number }>(`SELECT id FROM ${table} WHERE id = ?`, scopeId);
  if (row === undefined) {
    throw notFound(label, scopeId);
  }
}

export function getScopeSettings(
  db: Db,
  scope: SettingScope,
  scopeId: number | null,
): Partial<ResolvedSettings> {
  assertScopeTarget(db, scope, scopeId);
  const values = loadScopeValues(db, scope, scopeId);
  const out: Record<string, unknown> = {};
  for (const [key, value] of values) {
    // Keys not storable at this scope are hidden even if a row lingers.
    if (settingsRegistry[key].scopes.includes(scope)) {
      out[key] = value;
    }
  }
  return out as Partial<ResolvedSettings>;
}

/**
 * Write a settings patch at one scope. Unknown keys and keys not allowed at
 * the scope are rejected as a whole rather than silently dropped, so a typo in
 * the UI cannot look like it saved. A null value clears the override at this
 * scope and lets resolution fall through to the next layer.
 *
 * The patch is typed as raw input because `null` (clear) is not expressible in
 * Partial<ResolvedSettings>; validation happens here against the registry.
 */
export function putScopeSettings(
  db: Db,
  scope: SettingScope,
  scopeId: number | null,
  patch: Record<string, unknown>,
): Partial<ResolvedSettings> {
  assertScopeTarget(db, scope, scopeId);

  const parsed = parseSettingsPatch(scope, patch);
  if (!parsed.ok) {
    throw invalid("Some settings could not be saved.", { settings: parsed.errors });
  }

  return db.tx(() => {
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed.value)) {
      if (value === null || value === undefined) {
        if (scopeId === null) {
          db.run(
            "DELETE FROM settings WHERE scope_type = ? AND scope_id IS NULL AND key = ?",
            scope,
            key,
          );
        } else {
          db.run(
            "DELETE FROM settings WHERE scope_type = ? AND scope_id = ? AND key = ?",
            scope,
            scopeId,
            key,
          );
        }
        continue;
      }

      const encoded = JSON.stringify(value);
      const existing =
        scopeId === null
          ? db.get<{ rowid: number }>(
              "SELECT rowid FROM settings WHERE scope_type = ? AND scope_id IS NULL AND key = ?",
              scope,
              key,
            )
          : db.get<{ rowid: number }>(
              "SELECT rowid FROM settings WHERE scope_type = ? AND scope_id = ? AND key = ?",
              scope,
              scopeId,
              key,
            );

      if (existing === undefined) {
        db.run(
          `INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          scope,
          scopeId,
          key,
          encoded,
          now,
          now,
        );
      } else {
        db.run(
          "UPDATE settings SET value = ?, updated_at = ? WHERE rowid = ?",
          encoded,
          now,
          existing.rowid,
        );
      }
    }
    return getScopeSettings(db, scope, scopeId);
  });
}
