import { z } from "zod";
import {
  accountSchema,
  accountSyncSchema,
  forgeSchema,
  pageSchema,
  repoSchema,
  settingExplanationSchema,
  syncRunSchema,
  type SettingKey,
  type SettingScope,
  type SettingSource,
} from "@amber/shared";

/**
 * Web-side view of the API surface.
 *
 * Everything the two sides share now lives in shared/src/apiTypes.ts and is
 * imported here; this file holds only the client-only helpers (derived display
 * state, format lists, scope refs) plus thin aliases that keep call sites
 * reading naturally.
 */

// ---------------------------------------------------------------------------
// Repo list rows
// ---------------------------------------------------------------------------

/**
 * The repos table shows a mode column and a last-sync outcome icon. Neither is
 * a column on `repos`: clone_mode is a layered setting and the outcome belongs
 * to the newest sync_run, so `GET /api/repos` denormalizes them onto each row.
 *
 * They stay optional on the shared schema because only the listing populates
 * them, which is why the UI still falls back to "-" for the mode and to an
 * inferred outcome when it is rendering a row from some other endpoint.
 */
export const repoRowSchema = repoSchema;
export type RepoRow = z.infer<typeof repoRowSchema>;

export const repoPageSchema = pageSchema(repoRowSchema);
export type RepoPage = z.infer<typeof repoPageSchema>;

export const syncRunPageSchema = pageSchema(syncRunSchema);
export type SyncRunPage = z.infer<typeof syncRunPageSchema>;

/**
 * Outcome shown in the list when the server does not supply `lastOutcome`.
 * A repo that has never run reports "pending".
 */
export type DerivedOutcome = "success" | "error" | "canceled" | "pending";

export function deriveOutcome(row: {
  lastOutcome?: string;
  lastSyncAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}): DerivedOutcome {
  if (row.lastOutcome === "success" || row.lastOutcome === "error") return row.lastOutcome;
  if (row.lastOutcome === "canceled") return "canceled";
  if (row.lastSyncAt === null) return "pending";
  if (row.lastError !== null && row.lastError !== "") return "error";
  if (row.lastSuccessAt !== null && row.lastSuccessAt >= row.lastSyncAt) return "success";
  return "error";
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Forges and accounts answer with bare arrays; account syncs answer with a
 * `rows` envelope. The asymmetry is the server's, pinned in shared rather than
 * papered over here.
 */
export const forgeListSchema = z.array(forgeSchema);
export const accountListSchema = z.array(accountSchema);

// ---------------------------------------------------------------------------
// Account syncs
// ---------------------------------------------------------------------------

export const accountSyncRowSchema = accountSyncSchema;
export type AccountSyncRow = z.infer<typeof accountSyncRowSchema>;

/** Starred discovery is GitHub-only for now; the UI blocks it elsewhere. */
export const STARRED_SUPPORTED_FORGE_KINDS = ["github"] as const;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The overrides STORED at one scope, sparse. Not the resolved values: the
 * "inherited vs set here" distinction the settings UI is built on is
 * impossible against resolved values, because a value equal to the default
 * reads identically to an inherited one.
 */
export type SettingsOverrides = Partial<Record<SettingKey, unknown>>;

export type { SettingSource };

export interface SettingExplanation {
  value: unknown;
  source: SettingSource;
  sourceId: number | null;
}
export type EffectiveSettings = Partial<Record<SettingKey, SettingExplanation>>;

export { settingExplanationSchema };

/** Which scope a settings editor is pointed at. */
export interface SettingsScopeRef {
  scopeType: SettingScope;
  scopeId: number | null;
}

// ---------------------------------------------------------------------------
// Export and folder download
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ["zip", "tar.gz", "7z"] as const;
export type ExportFormatValue = (typeof EXPORT_FORMATS)[number];

export const EXPORT_KINDS = ["source", "gitdir"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export type { TreeEntry, TreePage } from "@amber/shared";
