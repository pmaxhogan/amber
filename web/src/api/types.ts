import { z } from "zod";
import {
  accountSchema,
  accountSyncSchema,
  cloneModeSchema,
  forgeSchema,
  pageSchema,
  repoSchema,
  settingScopeSchema,
  syncOutcomeSchema,
  syncErrorKindSchema,
  syncRunSchema,
  upsertAccountSyncSchema,
  type SettingKey,
  type SettingScope,
} from "@amber/shared";

/**
 * Wire shapes the web app needs that shared/src/apiTypes.ts does not (yet)
 * declare. Everything here is additive on top of a shared schema so the later
 * integration pass can fold any of it back into shared without a rewrite.
 *
 * Each block notes the assumption it encodes; those assumptions are the
 * API-contract questions reported alongside this work.
 */

// ---------------------------------------------------------------------------
// Repo list rows
// ---------------------------------------------------------------------------

/**
 * The repos table shows a "mode" column and a last-sync outcome icon. Neither
 * lives on `repos` in the data model: clone_mode is a layered setting and the
 * outcome belongs to the newest sync_run. Resolving either per row would be one
 * request per row, so the list endpoint is assumed to denormalize them.
 *
 * They are optional so the UI degrades to "-" (mode) and an inferred outcome
 * (from lastSuccessAt / lastError) rather than failing to parse.
 */
export const repoRowSchema = repoSchema.extend({
  cloneMode: cloneModeSchema.optional(),
  syncEnabled: z.boolean().optional(),
  lastOutcome: syncOutcomeSchema.optional(),
  lastErrorKind: syncErrorKindSchema.optional(),
});
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
 * ARCHITECTURE.md documents server-side pagination for /api/repos only, so the
 * other collections are read as bare arrays. A strict parse here is deliberate:
 * if the server envelopes them the integration pass fails loudly instead of
 * silently accepting either shape.
 */
export const forgeListSchema = z.array(forgeSchema);
export const accountListSchema = z.array(accountSchema);

// ---------------------------------------------------------------------------
// Account syncs
// ---------------------------------------------------------------------------

/**
 * `source` is in the data model (account_syncs.source, 'owned' | 'starred')
 * but missing from the shared accountSyncSchema. This is the one field the web
 * app genuinely cannot work without: the Account Sync page is specified to pick
 * between owned and starred discovery.
 */
export const accountSyncSourceSchema = z.enum(["owned", "starred"]);
export type AccountSyncSource = z.infer<typeof accountSyncSourceSchema>;

export const accountSyncRowSchema = accountSyncSchema.extend({
  source: accountSyncSourceSchema.default("owned"),
});
export type AccountSyncRow = z.infer<typeof accountSyncRowSchema>;

export const accountSyncListSchema = z.array(accountSyncRowSchema);

export const upsertAccountSyncBodySchema = upsertAccountSyncSchema.extend({
  source: accountSyncSourceSchema.default("owned"),
});
export type UpsertAccountSyncBody = z.input<typeof upsertAccountSyncBodySchema>;

/** Starred discovery is GitHub-only for now; the UI blocks it elsewhere. */
export const STARRED_SUPPORTED_FORGE_KINDS = ["github"] as const;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * GET /api/settings/:scopeType/:scopeId? is read as the overrides STORED at
 * that scope, sparse - not the resolved values. The specified UI ("inherited
 * vs set" plus a clear-override control) is impossible with resolved values,
 * because a value equal to the default is indistinguishable from an inherited
 * one.
 */
export const settingsOverridesSchema = z.record(z.string(), z.unknown());
export type SettingsOverrides = Partial<Record<SettingKey, unknown>>;

export const settingSourceSchema = z.union([settingScopeSchema, z.literal("default")]);
export type SettingSource = z.infer<typeof settingSourceSchema>;

export const settingExplanationSchema = z.object({
  value: z.unknown(),
  source: settingSourceSchema,
  sourceId: z.number().int().nullable().default(null),
});

/** Shape of GET /api/repos/:id/effective-settings, keyed by setting key. */
export const effectiveSettingsSchema = z.record(z.string(), settingExplanationSchema);

export interface SettingExplanation {
  value: unknown;
  source: SettingSource;
  sourceId: number | null;
}
export type EffectiveSettings = Partial<Record<SettingKey, SettingExplanation>>;

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

/**
 * GET /api/repos/:id/tree returns a paged file manifest. Only the path is
 * load-bearing for the folder download; size drives the progress bar when the
 * server supplies it.
 */
export const treeEntrySchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative().nullable().default(null),
  type: z.enum(["blob", "tree"]).default("blob"),
  mode: z.string().optional(),
});
export type TreeEntry = z.infer<typeof treeEntrySchema>;

export const treePageSchema = pageSchema(treeEntrySchema);
export type TreePage = z.infer<typeof treePageSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * AmberEvent.payload is `Record<string, unknown>` in the contract. These are
 * the payload fields the UI reads; every one is optional and a payload that
 * does not match is ignored rather than thrown on, so an unexpected shape
 * degrades to a stale row instead of a broken page.
 */
export const eventPayloadSchema = z.object({
  repoId: z.number().int().positive().optional(),
  repo: repoRowSchema.partial().optional(),
  accountSyncId: z.number().int().positive().optional(),
  outcome: syncOutcomeSchema.optional(),
  activeSyncs: z.number().int().nonnegative().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  breakerOpen: z.boolean().optional(),
});
export type EventPayload = z.infer<typeof eventPayloadSchema>;
