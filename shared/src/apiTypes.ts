import "./zodSetup.ts";
import { z } from "zod";
import {
  cloneModeSchema,
  settingScopeSchema,
  type ResolvedSettings,
  type SettingsExplanation,
} from "./settingsRegistry.ts";

/**
 * Core wire shapes shared by the Fastify routes and the Vue client. Server
 * handlers validate inbound payloads with these; the client infers its types
 * from them so the two cannot drift.
 */

export const idSchema = z.number().int().positive();
export const epochMsSchema = z.number().int().nonnegative();

/** `:id` route params arrive as strings, so they are coerced. */
export const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export type IdParams = z.infer<typeof idParamsSchema>;

/**
 * A query string flag. z.coerce.boolean() treats "false" as true, which is the
 * wrong answer for `?files=false`, so the accepted spellings are explicit.
 */
export const queryFlagSchema = z
  .union([z.boolean(), z.string()])
  .transform((raw) => (typeof raw === "boolean" ? raw : raw.trim().toLowerCase()))
  .pipe(z.union([z.boolean(), z.enum(["1", "0", "true", "false", "yes", "no", ""])]))
  .transform((raw) =>
    typeof raw === "boolean" ? raw : raw === "1" || raw === "true" || raw === "yes",
  );

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

/**
 * How the repo row came to exist. Account sync only ever auto-removes rows it
 * created itself, so a manually imported repo that a later account sync links
 * to keeps origin 'manual'.
 */
export const repoOriginSchema = z.enum(["manual", "account_sync"]);
export type RepoOrigin = z.infer<typeof repoOriginSchema>;

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
  origin: repoOriginSchema,
  state: repoStateSchema,
  nextSyncAt: epochMsSchema.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSyncAt: epochMsSchema.nullable(),
  lastSuccessAt: epochMsSchema.nullable(),
  /**
   * The last time the repository was confirmed to exist upstream: a successful
   * fetch or an appearance in an account-sync listing. Stops advancing when a
   * repository disappears.
   */
  lastSeenAt: epochMsSchema.nullable(),
  /**
   * When a repository that had synced at least once was judged gone upstream:
   * its fetches answered "not found" or "access denied" for GONE_CONFIRM_MS
   * on end, or GitHub said it was taken down. Null while it is reachable; a
   * later success clears it.
   */
  goneAt: epochMsSchema.nullable(),
  /**
   * The repository this one was forked from, as a path on the same forge
   * (`torvalds/linux`). Null when it is not a fork, and also while amber has
   * not asked the forge yet. Defaulted so a response from before the column
   * existed still parses.
   */
  forkParent: z.string().nullable().default(null),
  lastError: z.string().nullable(),
  diskUsageBytes: z.number().int().nonnegative().nullable(),
  defaultBranch: z.string().nullable(),
  lastFetchHead: z.string().nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,

  /**
   * Denormalized read-only extras. `clone_mode` and `sync_enabled` are layered
   * settings and the outcome pair belongs to the newest sync_runs row, so none
   * of them are columns on `repos`. The listing endpoint resolves them for the
   * whole page at once and attaches them here, because the repos table renders
   * a mode column and an outcome icon per row and would otherwise need one
   * request per row.
   *
   * Optional because only `GET /api/repos` populates them: the single-repo
   * reads return the row as stored.
   */
  cloneMode: cloneModeSchema.optional(),
  syncEnabled: z.boolean().optional(),
  lastOutcome: syncOutcomeSchema.optional(),
  lastErrorKind: syncErrorKindSchema.optional(),
  /**
   * The id of the repo row backing up `forkParent`, when amber tracks it on
   * the same forge; null when it does not. Lets the "Fork of" cell open the
   * upstream's own backup instead of the forge.
   */
  forkParentRepoId: idSchema.nullable().optional(),
});
export type Repo = z.infer<typeof repoSchema>;

/** The extras `GET /api/repos` adds on top of the stored row. */
export interface RepoListExtras {
  cloneMode: z.infer<typeof cloneModeSchema>;
  syncEnabled: boolean;
  lastOutcome?: SyncOutcome;
  lastErrorKind?: SyncErrorKind;
  forkParentRepoId?: number | null;
}

/** The fewest not-found or access-denied fetches in a row a gone repository needs. */
export const GONE_AFTER_FAILURES = 2;
/**
 * How long those answers have to keep coming before the repository is gone.
 *
 * A count alone is not enough: the retry after a first failure comes a minute
 * or two later, so two in a row only ever proved two minutes. Forges hide
 * public repositories for hours and then bring them back (measured on GitHub,
 * 2026-11: 1.2h and 2.2h), and a repository that is back by the next look was
 * never removed.
 */
export const GONE_CONFIRM_MS = 6 * 60 * 60 * 1000;
/** The failure kinds that mean "the repository is not there for us any more". */
export const GONE_ERROR_KINDS = ["not_found", "auth"] as const;

/** Why a repository is gone: what the forge answered, or a takedown it named. */
export const GONE_REASONS = ["dmca_takedown", ...GONE_ERROR_KINDS] as const;
export type GoneReason = (typeof GONE_REASONS)[number];

export interface TakedownNotice {
  /** The notice GitHub published for the takedown, when its answer linked one. */
  noticeUrl: string | null;
}

const DMCA_TAKEDOWN = /repository unavailable due to dmca takedown/i;
/** GitHub publishes every notice in github/dmca; nothing else is worth linking. */
const DMCA_NOTICE_URL = /https:\/\/github\.com\/github\/dmca\/[^\s"'<>]+/;

/**
 * Whether a failed fetch says GitHub disabled the repository over a DMCA
 * takedown, read from what git printed (`repos.last_error`, `sync_runs.error`).
 *
 * GitHub only: it is the one forge that answers a fetch this way, and the
 * words are the forge's to choose, so another forge saying them proves
 * nothing. Null for every other forge kind and every other error.
 */
export function dmcaTakedown(
  forgeKind: string | null | undefined,
  error: string | null | undefined,
): TakedownNotice | null {
  if (forgeKind !== "github" || typeof error !== "string" || !DMCA_TAKEDOWN.test(error)) {
    return null;
  }
  const url = DMCA_NOTICE_URL.exec(error)?.[0].replace(/[.,;:)]+$/, "");
  return { noticeUrl: url ?? null };
}

export const REPO_SORT_FIELDS = [
  "display_name",
  "path",
  "last_sync_at",
  "last_success_at",
  "last_seen_at",
  "gone_at",
  "fork_parent",
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
  /** true: only repositories that went gone upstream. false: only the rest. */
  gone: queryFlagSchema.optional(),
});
export type RepoListQuery = z.infer<typeof repoListQuerySchema>;

export const updateRepoSchema = z.object({
  state: repoStateSchema.optional(),
  accountOverrideId: idSchema.nullable().optional(),
  forceAnonymous: z.boolean().optional(),
  /**
   * Renames stay on the same host: forgeId is deliberately absent, because a
   * repo must never be re-pointed at a forge whose credentials it would then
   * inherit.
   */
  path: z.string().min(1).optional(),
});
export type UpdateRepo = z.infer<typeof updateRepoSchema>;

/** `DELETE /api/repos/:id?files=true` also removes the backup directory. */
export const deleteRepoQuerySchema = z.object({
  files: queryFlagSchema.default(false),
});
export type DeleteRepoQuery = z.infer<typeof deleteRepoQuerySchema>;

export const bulkRepoActionSchema = z.enum(["pause", "resume", "sync", "delete"]);
export type BulkRepoAction = z.infer<typeof bulkRepoActionSchema>;

export const bulkRepoRequestSchema = z.object({
  ids: z.array(idSchema).min(1),
  action: bulkRepoActionSchema,
  /** Only meaningful for the delete action. */
  files: z.boolean().default(false),
});
export type BulkRepoRequest = z.infer<typeof bulkRepoRequestSchema>;

export const bulkRepoResponseSchema = z.object({
  action: bulkRepoActionSchema,
  requested: z.number().int().nonnegative(),
  affected: z.number().int().nonnegative(),
  ids: z.array(idSchema),
  /** Requested ids that no longer exist. A stale multi-select is not an error. */
  missing: z.array(idSchema),
});
export type BulkRepoResponse = z.infer<typeof bulkRepoResponseSchema>;

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
  /**
   * Set by the server. 'namespace' means the line names a user or organization
   * (`https://github.com/nodejs`) and imports as a namespace sync that pulls in
   * every repository it owns, now and later. Absent on a client-side parse.
   */
  target: z.enum(["repo", "namespace"]).optional(),
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
  /** Set instead of repoId when the line imported as a namespace sync. */
  accountSyncId: idSchema.optional(),
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

/**
 * What GET and PUT /api/settings/:scopeType/:scopeId? return.
 *
 * `values` is SPARSE: only the keys actually stored at this scope, never the
 * resolved set. The distinction is load-bearing for the settings UI, which has
 * to tell "set here to the same value as the default" apart from "inherited" -
 * impossible if the server answered with resolved values.
 *
 * PUT takes the same shape of patch, where a null value CLEARS the override at
 * this scope and lets resolution fall back to the next layer.
 *
 * Declared as a strict object rather than a record so that a client parsing it
 * cannot quietly mistake the envelope keys for setting keys.
 */
export const scopeSettingsResponseSchema = z.object({
  scopeType: settingScopeSchema,
  scopeId: z.number().int().positive().nullable(),
  values: z.record(z.string(), z.unknown()),
});

export interface ScopeSettingsResponse {
  scopeType: SettingsScopeParams["scopeType"];
  scopeId: number | null;
  /** Only the keys stored at this scope; absent keys fall through on resolve. */
  values: Partial<ResolvedSettings>;
}

export const settingSourceSchema = z.union([settingScopeSchema, z.literal("default")]);
export type SettingSource = z.infer<typeof settingSourceSchema>;

/** One entry of the explain view: the winning value and the scope that won it. */
export const settingExplanationSchema = z.object({
  value: z.unknown(),
  source: settingSourceSchema,
  sourceId: z.number().int().positive().nullable(),
});

/** What GET /api/repos/:id/effective-settings returns. */
export const effectiveSettingsResponseSchema = z.object({
  repoId: idSchema,
  settings: z.record(z.string(), z.unknown()),
  explanation: z.record(z.string(), settingExplanationSchema),
});

export interface EffectiveSettingsResponse {
  repoId: number;
  settings: ResolvedSettings;
  /** Which scope supplied each value, for the settings explain view. */
  explanation: SettingsExplanation;
}

// ---------------------------------------------------------------------------
// Account sync
// ---------------------------------------------------------------------------

export const accountSyncVisibilitySchema = z.enum(["all", "public", "private"]);
export type AccountSyncVisibility = z.infer<typeof accountSyncVisibilitySchema>;

/**
 * 'owned' backs up the repositories the account itself owns; 'starred' backs up
 * whatever that account currently stars (GitHub only for now). An account may
 * have one of each.
 *
 * 'namespace' backs up every repository a named user or organization owns on
 * the forge (GitHub only for now), whoever that is. It belongs to the forge
 * rather than to an account: the account is optional, and when absent the run
 * uses the forge's default account, or goes anonymous when there is none. One
 * namespace sync per (forge, namespace), compared case-insensitively.
 *
 * 'trending' adds the `topN` most-starred repositories created on the forge in
 * the last `windowDays` days (GitHub only for now), every run. It belongs to
 * the forge and never to an account: it always runs with the forge default
 * account, or anonymously. Nothing it added is ever removed. One per (forge,
 * windowDays), so a 3-day sync for what is blowing up right now can sit next
 * to a 365-day one for the year's biggest.
 */
export const accountSyncSourceSchema = z.enum(["owned", "starred", "namespace", "trending"]);
export type AccountSyncSource = z.infer<typeof accountSyncSourceSchema>;

/** Forge kinds whose provider can enumerate an arbitrary user or organization. */
export const NAMESPACE_SYNC_FORGE_KINDS = ["github"] as const;

export function supportsNamespaceSyncKind(kind: string): boolean {
  return (NAMESPACE_SYNC_FORGE_KINDS as readonly string[]).includes(kind);
}

/** Forge kinds whose provider can list what is trending. */
export const TRENDING_SYNC_FORGE_KINDS = ["github"] as const;

export function supportsTrendingSyncKind(kind: string): boolean {
  return (TRENDING_SYNC_FORGE_KINDS as readonly string[]).includes(kind);
}

/** A trending sync looks at repositories created within this many days. */
export const TRENDING_WINDOW_DAYS_DEFAULT = 3;
export const TRENDING_WINDOW_DAYS_MAX = 3650;
/** One search page: more would need pagination against a 10/min anonymous limit. */
export const TRENDING_TOP_N_MAX = 100;
export const TRENDING_TOP_N_DEFAULT = 25;
/** A trending sync runs daily unless told otherwise. */
export const TRENDING_INTERVAL_MINUTES_DEFAULT = 1440;

export const trendingTopNSchema = z.number().int().min(1).max(TRENDING_TOP_N_MAX);
export const trendingWindowDaysSchema = z.number().int().min(1).max(TRENDING_WINDOW_DAYS_MAX);

/**
 * A user or organization login. Deliberately looser than GitHub's own rule
 * (alphanumerics and single hyphens, 39 chars) so other forges fit later, but
 * tight enough that it can never smuggle a slash, a dot-dot or whitespace into
 * an API path.
 */
export const NAMESPACE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?$/;

export const namespaceSchema = z
  .string()
  .trim()
  .regex(NAMESPACE_RE, "Use a user or organization name, like nodejs");

/**
 * Accept what people actually paste into a namespace field: a bare name, or a
 * profile URL with or without a scheme, `@`, or trailing slash. Returns null
 * when the input does not reduce to exactly one valid name.
 */
export function parseNamespaceInput(raw: string): string | null {
  let value = raw.trim().replace(/^@/, "");
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  value = value.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const segments = value.split("/").filter((segment) => segment !== "");
  // "host/name" keeps the name; a bare "name" is the name itself.
  const candidate =
    segments.length === 2 && segments[0]?.includes(".") === true
      ? segments[1]
      : segments.length === 1
        ? segments[0]
        : undefined;
  return candidate !== undefined && NAMESPACE_RE.test(candidate) ? candidate : null;
}

export const accountSyncSchema = z.object({
  id: idSchema,
  forgeId: idSchema,
  /**
   * Always set for 'owned' and 'starred'. For 'namespace', null means "the
   * forge's default account at run time, or anonymous". Always null for
   * 'trending', which means the same thing.
   */
  accountId: idSchema.nullable(),
  source: accountSyncSourceSchema,
  /** The user or organization a 'namespace' sync enumerates; null otherwise. */
  namespace: z.string().nullable(),
  /** How many repositories a 'trending' sync takes per run; null otherwise. */
  topN: z.number().int().nullable(),
  /** How many days back a 'trending' sync looks at creation dates; null otherwise. */
  windowDays: z.number().int().nullable(),
  /** Meaningful for 'owned' and 'namespace' only. */
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

/**
 * GET /api/account-syncs answers with a `rows` envelope rather than the bare
 * array /api/forges and /api/accounts use. Kept as-is and pinned here so both
 * sides agree, rather than churning a working route for symmetry.
 */
export const accountSyncListResponseSchema = z.object({
  rows: z.array(accountSyncSchema),
});
export type AccountSyncListResponse = z.infer<typeof accountSyncListResponseSchema>;

/**
 * Create payload. Named "upsert" for historical reasons: creating a second sync
 * with the same identity is a conflict, not an update.
 *
 * 'owned' and 'starred' need `accountId`. 'namespace' needs `namespace` plus
 * either `accountId` (whose forge it then runs on) or `forgeId` (run with the
 * forge default account); naming both is allowed when they agree, which the
 * route checks because only it can see the account's forge. 'trending' needs
 * `forgeId` and takes `topN` and `windowDays`; it has no account, namespace or visibility, and
 * its interval defaults to a day rather than six hours.
 */
export const upsertAccountSyncSchema = z
  .object({
    accountId: idSchema.optional(),
    forgeId: idSchema.optional(),
    source: accountSyncSourceSchema.default("owned"),
    namespace: namespaceSchema.optional(),
    /** Trending syncs only; defaults to TRENDING_TOP_N_DEFAULT there. */
    topN: trendingTopNSchema.optional(),
    /** Trending syncs only; defaults to TRENDING_WINDOW_DAYS_DEFAULT there. */
    windowDays: trendingWindowDaysSchema.optional(),
    /** Rejected on starred and trending syncs by the routes rather than silently dropped. */
    visibility: accountSyncVisibilitySchema.default("all"),
    enabled: z.boolean().default(true),
    /** Defaults to 360, or to a day for a trending sync (applied by the route). */
    intervalMinutes: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source !== "trending" && value.topN !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["topN"],
        message: "topN applies to trending syncs only",
      });
    }
    if (value.source !== "trending" && value.windowDays !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message: "windowDays applies to trending syncs only",
      });
    }
    if (value.source === "trending") {
      if (value.forgeId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["forgeId"],
          message: "a trending sync needs a forgeId",
        });
      }
      if (value.accountId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["accountId"],
          message: "a trending sync runs with the forge default account; omit accountId",
        });
      }
      if (value.namespace !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["namespace"],
          message: "namespace applies to namespace syncs only",
        });
      }
      return;
    }
    if (value.source === "namespace") {
      if (value.namespace === undefined) {
        ctx.addIssue({ code: "custom", path: ["namespace"], message: "namespace is required" });
      }
      if (value.accountId === undefined && value.forgeId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["forgeId"],
          message: "a namespace sync needs a forgeId or an accountId",
        });
      }
      return;
    }
    if (value.namespace !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["namespace"],
        message: "namespace applies to namespace syncs only",
      });
    }
    if (value.accountId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["accountId"],
        message: `a ${value.source} sync needs an accountId`,
      });
    }
    if (value.forgeId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["forgeId"],
        message: `a ${value.source} sync runs on its account's forge; omit forgeId`,
      });
    }
  });
export type UpsertAccountSync = z.infer<typeof upsertAccountSyncSchema>;
/**
 * What a CALLER passes. Every defaulted field is optional here, unlike the
 * inferred output type where the defaults have already been applied.
 */
export type UpsertAccountSyncInput = z.input<typeof upsertAccountSyncSchema>;

/**
 * accountId, forgeId, source, namespace and windowDays are immutable: change any of them
 * by deleting and recreating.
 */
export const updateAccountSyncSchema = z.object({
  visibility: accountSyncVisibilitySchema.optional(),
  /** Trending syncs only. */
  topN: trendingTopNSchema.optional(),
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).optional(),
});
export type UpdateAccountSync = z.infer<typeof updateAccountSyncSchema>;

/** What one discovery run did. `removed` and `retained` stay 0 for owned syncs. */
export const accountSyncRunResultSchema = z.object({
  accountSync: accountSyncSchema,
  discovered: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  linked: z.number().int().nonnegative(),
  /** Present upstream but gone from the listing; never deleted, only counted. */
  vanished: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type AccountSyncRunResult = z.infer<typeof accountSyncRunResultSchema>;

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

/**
 * PATCH /api/git-remote body. Only the username is editable; the password is
 * never user-supplied, so there is deliberately no field for one. Renaming
 * works whether the remote is enabled or disabled, so the new name is already
 * in place the next time it is turned on.
 */
export const updateGitRemoteSchema = z.object({
  username: z.string().trim().min(1).max(64),
});
export type UpdateGitRemote = z.infer<typeof updateGitRemoteSchema>;

export const statusSchema = z.object({
  version: z.string(),
  insecureMode: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
  activeSyncs: z.number().int().nonnegative(),
  totalRepos: z.number().int().nonnegative(),
  /** Repositories currently judged gone upstream. */
  goneRepos: z.number().int().nonnegative(),
  totalDiskUsageBytes: z.number().int().nonnegative(),
  breakerOpen: z.boolean(),
});
export type Status = z.infer<typeof statusSchema>;

// ---------------------------------------------------------------------------
// Web push
// ---------------------------------------------------------------------------

/** What `PushSubscription.toJSON()` gives a browser, minus expirationTime. */
export const pushSubscribeSchema = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((value) => value.startsWith("https://"), "a push endpoint is always https"),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});
export type PushSubscribe = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) });
export type PushUnsubscribe = z.infer<typeof pushUnsubscribeSchema>;

/** One subscribed browser. The endpoint itself is a capability and stays server side. */
export const pushDeviceSchema = z.object({
  id: idSchema,
  /** The push service host, e.g. fcm.googleapis.com or web.push.apple.com. */
  service: z.string(),
  userAgent: z.string().nullable(),
  createdAt: epochMsSchema,
  lastSuccessAt: epochMsSchema.nullable(),
  lastError: z.string().nullable(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

export const pushConfigSchema = z.object({
  /** VAPID public key, base64url: the applicationServerKey for subscribe(). */
  publicKey: z.string().min(1),
  devices: z.array(pushDeviceSchema),
});
export type PushConfig = z.infer<typeof pushConfigSchema>;

export const pushSendResultSchema = z.object({
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type PushSendResult = z.infer<typeof pushSendResultSchema>;

/** What the service worker receives and shows. */
export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  /** Where a click on the notification lands, as an in-app path. */
  url: z.string(),
  tag: z.string(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

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
  "repo.gone",
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

/**
 * The pinned SSE payload contract.
 *
 * The envelope stays an open record so a publisher may attach extra diagnostic
 * fields without breaking a client, but these keys are guaranteed present for
 * their event type and the server is tested against them. Every repo-scoped
 * event names its subject `repoId` - never `id` - so one client-side parse
 * covers all of them.
 */
export const eventPayloadSchemas = {
  "sync.started": z.object({ repoId: idSchema }),
  "sync.finished": z.object({ repoId: idSchema, outcome: syncOutcomeSchema }),
  "repo.created": z.object({ repoId: idSchema }),
  "repo.updated": z.object({ repoId: idSchema }),
  "repo.deleted": z.object({ repoId: idSchema }),
  "repo.gone": z.object({ repoId: idSchema }),
  "account_sync.finished": z.object({ accountSyncId: idSchema }),
  "status.changed": z.object({
    activeSyncs: z.number().int().nonnegative(),
    queueDepth: z.number().int().nonnegative(),
    breakerOpen: z.boolean(),
  }),
} as const satisfies Record<AmberEventType, z.ZodType>;

/**
 * Every field any pinned payload may carry, all optional. Clients that handle
 * several event types in one place parse against this and read the keys that
 * apply to the type they matched.
 */
export const eventPayloadSchema = z.object({
  repoId: idSchema.optional(),
  accountSyncId: idSchema.optional(),
  outcome: syncOutcomeSchema.optional(),
  activeSyncs: z.number().int().nonnegative().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  breakerOpen: z.boolean().optional(),
});
export type EventPayload = z.infer<typeof eventPayloadSchema>;

export const exportFormatSchema = z.enum(["zip", "tar.gz", "7z"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

// ---------------------------------------------------------------------------
// File manifest
// ---------------------------------------------------------------------------

/**
 * One file in the manifest `GET /api/repos/:id/tree` returns. Only blobs are
 * listed - the folder download recreates directories from the paths - so there
 * is no entry type to discriminate on. `oid` is the blob id the matching
 * `/blob` request resolves to.
 */
export const treeEntrySchema = z.object({
  path: z.string().min(1),
  mode: z.string(),
  size: z.number().int().nonnegative(),
  oid: z.string().min(1),
});
export type TreeEntry = z.infer<typeof treeEntrySchema>;

/** Paged manifest. `ref` is the resolved commit the manifest was taken at. */
export const treePageSchema = pageSchema(treeEntrySchema).extend({
  ref: z.string().min(1),
});
export type TreePage = z.infer<typeof treePageSchema>;
