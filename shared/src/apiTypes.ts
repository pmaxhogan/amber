import { z } from "zod";
import { settingScopeSchema } from "./settingsRegistry.ts";

/**
 * Core wire shapes shared by the Fastify routes and the Vue client. Server
 * handlers validate inbound payloads with these; the client infers its types
 * from them so the two cannot drift.
 */

export const idSchema = z.number().int().positive();
export const epochMsSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const MAX_PER_PAGE = 200;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const sortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/** Envelope for every paged list response. */
export function pageSchema<T extends z.ZodType>(row: T) {
  return z.object({
    rows: z.array(row),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    perPage: z.number().int().min(1),
  });
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  perPage: number;
}

// ---------------------------------------------------------------------------
// Forges
// ---------------------------------------------------------------------------

export const FORGE_KINDS = ["github", "gitlab", "bitbucket", "gitea", "generic"] as const;
export const forgeKindSchema = z.enum(FORGE_KINDS);
export type ForgeKind = z.infer<typeof forgeKindSchema>;

export const forgeProtocolSchema = z.enum(["https", "http"]);
export type ForgeProtocol = z.infer<typeof forgeProtocolSchema>;

export const forgeSchema = z.object({
  id: idSchema,
  protocol: forgeProtocolSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable(),
  kind: forgeKindSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type Forge = z.infer<typeof forgeSchema>;

export const createForgeSchema = z.object({
  protocol: forgeProtocolSchema.default("https"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  kind: forgeKindSchema.optional(),
});
export type CreateForge = z.infer<typeof createForgeSchema>;

export const updateForgeSchema = z.object({
  kind: forgeKindSchema.optional(),
});
export type UpdateForge = z.infer<typeof updateForgeSchema>;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Secrets are write-only: responses carry hasSecret, never the secret itself. */
export const accountSchema = z.object({
  id: idSchema,
  forgeId: idSchema,
  username: z.string().min(1),
  hasSecret: z.boolean(),
  isDefault: z.boolean(),
  lastUsedAt: epochMsSchema.nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type Account = z.infer<typeof accountSchema>;

export const createAccountSchema = z.object({
  forgeId: idSchema,
  username: z.string().min(1),
  secret: z.string().min(1).nullable().default(null),
  isDefault: z.boolean().default(false),
});
export type CreateAccount = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  username: z.string().min(1).optional(),
  /** null clears the stored secret; omit to leave it untouched. */
  secret: z.string().min(1).nullable().optional(),
});
export type UpdateAccount = z.infer<typeof updateAccountSchema>;

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export const repoStateSchema = z.enum(["active", "paused"]);
export type RepoState = z.infer<typeof repoStateSchema>;

export const syncOutcomeSchema = z.enum(["success", "error", "canceled"]);
export type SyncOutcome = z.infer<typeof syncOutcomeSchema>;

export const SYNC_ERROR_KINDS = [
  "auth",
  "not_found",
  "rate_limited",
  "network",
  "timeout",
  "disk",
  "git",
  "other",
] as const;
export const syncErrorKindSchema = z.enum(SYNC_ERROR_KINDS);
export type SyncErrorKind = z.infer<typeof syncErrorKindSchema>;

export const repoSchema = z.object({
  id: idSchema,
  forgeId: idSchema,
  path: z.string().min(1),
  displayName: z.string().min(1),
  slug: z.string().min(1),
  shortId: z.string().min(1),
  accountOverrideId: idSchema.nullable(),
  forceAnonymous: z.boolean(),
  managedByAccountSyncId: idSchema.nullable(),
  state: repoStateSchema,
  nextSyncAt: epochMsSchema.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSyncAt: epochMsSchema.nullable(),
  lastSuccessAt: epochMsSchema.nullable(),
  lastError: z.string().nullable(),
  diskUsageBytes: z.number().int().nonnegative().nullable(),
  defaultBranch: z.string().nullable(),
  lastFetchHead: z.string().nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type Repo = z.infer<typeof repoSchema>;

export const REPO_SORT_FIELDS = [
  "display_name",
  "path",
  "last_sync_at",
  "last_success_at",
  "disk_usage_bytes",
  "next_sync_at",
  "created_at",
] as const;
export const repoSortFieldSchema = z.enum(REPO_SORT_FIELDS);
export type RepoSortField = z.infer<typeof repoSortFieldSchema>;

export const repoListQuerySchema = paginationQuerySchema.extend({
  sort: repoSortFieldSchema.default("display_name"),
  dir: sortDirectionSchema.default("asc"),
  q: z.string().trim().optional(),
  forgeId: z.coerce.number().int().positive().optional(),
  state: repoStateSchema.optional(),
  outcome: syncOutcomeSchema.optional(),
});
export type RepoListQuery = z.infer<typeof repoListQuerySchema>;

export const updateRepoSchema = z.object({
  state: repoStateSchema.optional(),
  accountOverrideId: idSchema.nullable().optional(),
  forceAnonymous: z.boolean().optional(),
});
export type UpdateRepo = z.infer<typeof updateRepoSchema>;

export const bulkRepoActionSchema = z.enum(["pause", "resume", "sync", "delete"]);
export type BulkRepoAction = z.infer<typeof bulkRepoActionSchema>;

export const bulkRepoRequestSchema = z.object({
  ids: z.array(idSchema).min(1),
  action: bulkRepoActionSchema,
  /** Only meaningful for the delete action. */
  files: z.boolean().default(false),
});
export type BulkRepoRequest = z.infer<typeof bulkRepoRequestSchema>;

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

export const syncRunSchema = z.object({
  id: idSchema,
  repoId: idSchema,
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema.nullable(),
  outcome: syncOutcomeSchema,
  error: z.string().nullable(),
  errorKind: syncErrorKindSchema.nullable(),
  bytesFetched: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  refsChanged: z.number().int().nonnegative().nullable(),
  paranoidArchived: z.number().int().nonnegative().nullable(),
});
export type SyncRun = z.infer<typeof syncRunSchema>;

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const importRequestSchema = z.object({
  text: z.string(),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export const importLineStatusSchema = z.enum(["ok", "warning", "error"]);

export const parsedRepoUrlSchema = z.object({
  protocol: forgeProtocolSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable(),
  path: z.string().min(1),
  username: z.string().nullable(),
  displayName: z.string().min(1),
  canonicalUrl: z.string().min(1),
});

export const importLineResultSchema = z.object({
  line: z.string(),
  lineNumber: z.number().int().min(1),
  status: importLineStatusSchema,
  parsed: parsedRepoUrlSchema.optional(),
  message: z.string().optional(),
});

export const importPreviewResponseSchema = z.object({
  results: z.array(importLineResultSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  }),
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

export const importCommitResultSchema = importLineResultSchema.extend({
  action: z.enum(["created", "updated", "failed"]),
  repoId: idSchema.optional(),
});

export const importCommitResponseSchema = z.object({
  results: z.array(importCommitResultSchema),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsScopeParamsSchema = z.object({
  scopeType: settingScopeSchema,
  scopeId: z.coerce.number().int().positive().optional(),
});
export type SettingsScopeParams = z.infer<typeof settingsScopeParamsSchema>;

/** Values are validated per key against the registry, not here. */
export const settingsPatchSchema = z.record(z.string(), z.unknown());
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// ---------------------------------------------------------------------------
// Account sync
// ---------------------------------------------------------------------------

export const accountSyncVisibilitySchema = z.enum(["all", "public", "private"]);
export type AccountSyncVisibility = z.infer<typeof accountSyncVisibilitySchema>;

export const accountSyncSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  visibility: accountSyncVisibilitySchema,
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1),
  nextRunAt: epochMsSchema.nullable(),
  lastRunAt: epochMsSchema.nullable(),
  lastError: z.string().nullable(),
  reposDiscovered: z.number().int().nonnegative().nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type AccountSync = z.infer<typeof accountSyncSchema>;

export const upsertAccountSyncSchema = z.object({
  accountId: idSchema,
  visibility: accountSyncVisibilitySchema.default("all"),
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).default(360),
});
export type UpsertAccountSync = z.infer<typeof upsertAccountSyncSchema>;

// ---------------------------------------------------------------------------
// Git remote and status
// ---------------------------------------------------------------------------

export const gitRemoteConfigSchema = z.object({
  enabled: z.boolean(),
  username: z.string().min(1),
  cloneUrlTemplate: z.string(),
  rotatedAt: epochMsSchema.nullable(),
});
export type GitRemoteConfig = z.infer<typeof gitRemoteConfigSchema>;

/** Returned exactly once, on enable and on rotate. */
export const gitRemoteSecretSchema = gitRemoteConfigSchema.extend({
  password: z.string().min(1),
});
export type GitRemoteSecret = z.infer<typeof gitRemoteSecretSchema>;

export const statusSchema = z.object({
  version: z.string(),
  insecureMode: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
  activeSyncs: z.number().int().nonnegative(),
  totalRepos: z.number().int().nonnegative(),
  totalDiskUsageBytes: z.number().int().nonnegative(),
  breakerOpen: z.boolean(),
});
export type Status = z.infer<typeof statusSchema>;

export const healthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

// ---------------------------------------------------------------------------
// Errors and events
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const AMBER_EVENT_TYPES = [
  "sync.started",
  "sync.finished",
  "repo.created",
  "repo.updated",
  "repo.deleted",
  "account_sync.finished",
  "status.changed",
] as const;
export const amberEventTypeSchema = z.enum(AMBER_EVENT_TYPES);
export type AmberEventType = z.infer<typeof amberEventTypeSchema>;

export const amberEventSchema = z.object({
  type: amberEventTypeSchema,
  at: epochMsSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type AmberEvent = z.infer<typeof amberEventSchema>;

export const exportFormatSchema = z.enum(["zip", "tar.gz", "7z"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
