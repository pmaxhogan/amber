import { z } from "zod";
import {
  accountSchema,
  accountSyncListResponseSchema,
  accountSyncSchema,
  amberEventSchema,
  apiErrorSchema,
  bulkRepoResponseSchema,
  effectiveSettingsResponseSchema,
  forgeSchema,
  gitRemoteConfigSchema,
  gitRemoteSecretSchema,
  healthSchema,
  importCommitResponseSchema,
  importPreviewResponseSchema,
  scopeSettingsResponseSchema,
  statusSchema,
  treePageSchema,
  type Account,
  type BulkRepoResponse,
  type UpsertAccountSyncInput,
  type AmberEvent,
  type BulkRepoAction,
  type CreateAccount,
  type CreateForge,
  type Forge,
  type ForgeKind,
  type GitRemoteConfig,
  type GitRemoteSecret,
  type Health,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type RepoListQuery,
  type SettingKey,
  type SettingScope,
  type Status,
  type UpdateAccount,
  type UpdateRepo,
} from "@amber/shared";
import {
  accountListSchema,
  accountSyncRowSchema,
  forgeListSchema,
  repoPageSchema,
  repoRowSchema,
  syncRunPageSchema,
  type AccountSyncRow,
  type EffectiveSettings,
  type ExportFormatValue,
  type ExportKind,
  type RepoPage,
  type RepoRow,
  type SettingsOverrides,
  type SettingsScopeRef,
  type SyncRunPage,
  type TreePage,
} from "./types.ts";

/**
 * Typed client for the amber REST API.
 *
 * Every failure - transport, HTTP status, or a response that does not match its
 * schema - surfaces as an ApiClientError carrying a stable machine-readable
 * `problem` code plus a human-facing `message`, so call sites never have to
 * care which layer broke.
 */

export const NETWORK_PROBLEM = "network_error";
export const INVALID_RESPONSE_PROBLEM = "invalid_response";
export const ABORTED_PROBLEM = "aborted";

export class ApiClientError extends Error {
  readonly problem: string;
  readonly status: number | null;
  readonly details: Record<string, unknown> | null;

  constructor(problem: string, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.problem = problem;
    this.status = status;
    this.details =
      details !== null && typeof details === "object" ? (details as Record<string, unknown>) : null;
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    if (this.problem === NETWORK_PROBLEM) return true;
    if (this.status === null) return false;
    return this.status >= 500 || this.status === 429;
  }
}

const HTTP_MESSAGES: Record<number, string> = {
  400: "The request was rejected as invalid.",
  401: "Not signed in. Reload the page to authenticate again.",
  403: "That action is not permitted.",
  404: "Not found. It may have been deleted already.",
  409: "That conflicts with something that already exists.",
  429: "Rate limited. Wait a moment and try again.",
  500: "The server hit an unexpected error.",
  502: "The server is unreachable.",
  503: "The server is not ready yet.",
};

function httpMessage(status: number, statusText: string): string {
  const known = HTTP_MESSAGES[status];
  if (known !== undefined) return known;
  return statusText === "" ? `Request failed with status ${status}` : statusText;
}

/** Turn anything thrown by fetch or a schema into an ApiClientError. */
export function normalizeError(cause: unknown): ApiClientError {
  if (cause instanceof ApiClientError) return cause;
  if (cause instanceof z.ZodError) {
    const first = cause.issues[0];
    const where = first === undefined ? "" : ` at ${first.path.join(".") || "root"}`;
    return new ApiClientError(
      INVALID_RESPONSE_PROBLEM,
      `The server sent a response amber could not read${where}.`,
    );
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return new ApiClientError(ABORTED_PROBLEM, "The request was canceled.");
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    return new ApiClientError(ABORTED_PROBLEM, "The request was canceled.");
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ApiClientError(
    NETWORK_PROBLEM,
    message === "" ? "Could not reach the server." : `Could not reach the server. ${message}`,
  );
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Prefix for every path. Empty in the app; tests may point it elsewhere. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  function url(path: string): string {
    return `${baseUrl}${path}`;
  }

  async function raw(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url(path), { credentials: "same-origin", ...init });
    } catch (cause) {
      throw normalizeError(cause);
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    return response;
  }

  async function errorFromResponse(response: Response): Promise<ApiClientError> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      return new ApiClientError(
        parsed.data.error,
        parsed.data.message,
        response.status,
        parsed.data.details,
      );
    }
    return new ApiClientError(
      `http_${response.status}`,
      httpMessage(response.status, response.statusText),
      response.status,
    );
  }

  async function request<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const response = await raw(path, { method, headers, body, signal: opts.signal });

    if (opts.schema === undefined) {
      // Callers that pass no schema do not read the body (204 or ignored).
      await response.text().catch(() => "");
      return undefined as T;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw normalizeError(cause);
    }
    const parsed = opts.schema.safeParse(payload);
    if (!parsed.success) {
      throw normalizeError(parsed.error);
    }
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // Health and status
  // -------------------------------------------------------------------------

  const health = (signal?: AbortSignal): Promise<Health> =>
    request("/healthz", { schema: healthSchema, signal });

  const status = (signal?: AbortSignal): Promise<Status> =>
    request("/api/status", { schema: statusSchema, signal });

  // -------------------------------------------------------------------------
  // Forges
  // -------------------------------------------------------------------------

  const listForges = (signal?: AbortSignal): Promise<Forge[]> =>
    request("/api/forges", { schema: forgeListSchema, signal });

  const createForge = (input: CreateForge): Promise<Forge> =>
    request("/api/forges", { method: "POST", body: input, schema: forgeSchema });

  /** Only `kind` is mutable; host, port, and protocol are immutable by design. */
  const updateForge = (id: number, kind: ForgeKind): Promise<Forge> =>
    request(`/api/forges/${id}`, { method: "PATCH", body: { kind }, schema: forgeSchema });

  const deleteForge = (id: number): Promise<void> =>
    request(`/api/forges/${id}`, { method: "DELETE" });

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  const listAccounts = (forgeId?: number, signal?: AbortSignal): Promise<Account[]> =>
    request(`/api/accounts${buildQuery({ forgeId })}`, { schema: accountListSchema, signal });

  const createAccount = (input: CreateAccount): Promise<Account> =>
    request("/api/accounts", { method: "POST", body: input, schema: accountSchema });

  const updateAccount = (id: number, input: UpdateAccount): Promise<Account> =>
    request(`/api/accounts/${id}`, { method: "PATCH", body: input, schema: accountSchema });

  const deleteAccount = (id: number): Promise<void> =>
    request(`/api/accounts/${id}`, { method: "DELETE" });

  const setDefaultAccount = (id: number): Promise<Account> =>
    request(`/api/accounts/${id}/default`, { method: "POST", schema: accountSchema });

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  const previewImport = (text: string, signal?: AbortSignal): Promise<ImportPreviewResponse> =>
    request("/api/import/preview", {
      method: "POST",
      body: { text },
      schema: importPreviewResponseSchema,
      signal,
    });

  const commitImport = (text: string): Promise<ImportCommitResponse> =>
    request("/api/import", { method: "POST", body: { text }, schema: importCommitResponseSchema });

  // -------------------------------------------------------------------------
  // Repos
  // -------------------------------------------------------------------------

  const listRepos = (query: Partial<RepoListQuery>, signal?: AbortSignal): Promise<RepoPage> =>
    request(`/api/repos${buildQuery({ ...query })}`, { schema: repoPageSchema, signal });

  const getRepo = (id: number, signal?: AbortSignal): Promise<RepoRow> =>
    request(`/api/repos/${id}`, { schema: repoRowSchema, signal });

  const updateRepo = (id: number, input: UpdateRepo): Promise<RepoRow> =>
    request(`/api/repos/${id}`, { method: "PATCH", body: input, schema: repoRowSchema });

  const deleteRepo = (id: number, files = false): Promise<void> =>
    request(`/api/repos/${id}${buildQuery({ files })}`, { method: "DELETE" });

  const syncRepo = (id: number): Promise<void> =>
    request(`/api/repos/${id}/sync`, { method: "POST" });

  const listRuns = (
    id: number,
    page = 1,
    perPage = 20,
    signal?: AbortSignal,
  ): Promise<SyncRunPage> =>
    request(`/api/repos/${id}/runs${buildQuery({ page, perPage })}`, {
      schema: syncRunPageSchema,
      signal,
    });

  const bulkRepos = (
    ids: number[],
    action: BulkRepoAction,
    files = false,
  ): Promise<BulkRepoResponse> =>
    request("/api/repos/bulk", {
      method: "POST",
      body: { ids, action, files },
      schema: bulkRepoResponseSchema,
    });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function settingsPath(scope: SettingsScopeRef): string {
    return scope.scopeId === null
      ? `/api/settings/${scope.scopeType}`
      : `/api/settings/${scope.scopeType}/${scope.scopeId}`;
  }

  /**
   * Both settings calls answer with a {scopeType, scopeId, values} envelope
   * whose `values` holds only the overrides stored AT that scope. Unwrapping
   * here keeps every call site working in override maps.
   */
  const getSettings = (scope: SettingsScopeRef, signal?: AbortSignal): Promise<SettingsOverrides> =>
    request(settingsPath(scope), { schema: scopeSettingsResponseSchema, signal }).then(
      (body) => body.values as SettingsOverrides,
    );

  /** A null value clears the override for that key at this scope. */
  const putSettings = (
    scope: SettingsScopeRef,
    patch: Partial<Record<SettingKey, unknown>>,
  ): Promise<SettingsOverrides> =>
    request(settingsPath(scope), {
      method: "PUT",
      body: patch,
      schema: scopeSettingsResponseSchema,
    }).then((body) => body.values as SettingsOverrides);

  /** The explain view wants only the per-key breakdown, not the merged values. */
  const getEffectiveSettings = (repoId: number, signal?: AbortSignal): Promise<EffectiveSettings> =>
    request(`/api/repos/${repoId}/effective-settings`, {
      schema: effectiveSettingsResponseSchema,
      signal,
    }).then((body) => body.explanation as EffectiveSettings);

  // -------------------------------------------------------------------------
  // Account syncs
  // -------------------------------------------------------------------------

  const listAccountSyncs = (signal?: AbortSignal): Promise<AccountSyncRow[]> =>
    request("/api/account-syncs", { schema: accountSyncListResponseSchema, signal }).then(
      (body) => body.rows,
    );

  const createAccountSync = (input: UpsertAccountSyncInput): Promise<AccountSyncRow> =>
    request("/api/account-syncs", { method: "POST", body: input, schema: accountSyncRowSchema });

  const updateAccountSync = (
    id: number,
    input: Partial<UpsertAccountSyncInput>,
  ): Promise<AccountSyncRow> =>
    request(`/api/account-syncs/${id}`, {
      method: "PATCH",
      body: input,
      schema: accountSyncSchema,
    });

  const deleteAccountSync = (id: number): Promise<void> =>
    request(`/api/account-syncs/${id}`, { method: "DELETE" });

  const runAccountSync = (id: number): Promise<void> =>
    request(`/api/account-syncs/${id}/run`, { method: "POST" });

  // -------------------------------------------------------------------------
  // Git remote
  // -------------------------------------------------------------------------

  const getGitRemote = (signal?: AbortSignal): Promise<GitRemoteConfig> =>
    request("/api/git-remote", { schema: gitRemoteConfigSchema, signal });

  /** Returns the plaintext password. It is never retrievable again. */
  const enableGitRemote = (): Promise<GitRemoteSecret> =>
    request("/api/git-remote/enable", { method: "POST", schema: gitRemoteSecretSchema });

  const rotateGitRemote = (): Promise<GitRemoteSecret> =>
    request("/api/git-remote/rotate", { method: "POST", schema: gitRemoteSecretSchema });

  const disableGitRemote = (): Promise<GitRemoteConfig> =>
    request("/api/git-remote/disable", { method: "POST", schema: gitRemoteConfigSchema });

  const setGitRemoteUsername = (username: string): Promise<GitRemoteConfig> =>
    request("/api/git-remote", {
      method: "PATCH",
      body: { username },
      schema: gitRemoteConfigSchema,
    });

  // -------------------------------------------------------------------------
  // Export and file streaming
  // -------------------------------------------------------------------------

  function exportUrl(repoId: number, kind: ExportKind, format: ExportFormatValue): string {
    return url(`/api/repos/${repoId}/export/${kind}.${format}`);
  }

  /** Authed download: fetch to a blob so the CF Access cookie is carried. */
  async function downloadExport(
    repoId: number,
    kind: ExportKind,
    format: ExportFormatValue,
  ): Promise<Blob> {
    const response = await raw(`/api/repos/${repoId}/export/${kind}.${format}`, { method: "GET" });
    try {
      return await response.blob();
    } catch (cause) {
      throw normalizeError(cause);
    }
  }

  const listTree = (
    repoId: number,
    params: { ref?: string; page?: number; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<TreePage> =>
    request(`/api/repos/${repoId}/tree${buildQuery({ ...params })}`, {
      schema: treePageSchema,
      signal,
    });

  async function getBlob(
    repoId: number,
    path: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const response = await raw(`/api/repos/${repoId}/blob${buildQuery({ ref, path })}`, {
      method: "GET",
      signal,
    });
    try {
      return await response.blob();
    } catch (cause) {
      throw normalizeError(cause);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const eventsUrl = (): string => url("/api/events");

  return {
    baseUrl,
    request,
    health,
    status,
    listForges,
    createForge,
    updateForge,
    deleteForge,
    listAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    setDefaultAccount,
    previewImport,
    commitImport,
    listRepos,
    getRepo,
    updateRepo,
    deleteRepo,
    syncRepo,
    listRuns,
    bulkRepos,
    getSettings,
    putSettings,
    getEffectiveSettings,
    listAccountSyncs,
    createAccountSync,
    updateAccountSync,
    deleteAccountSync,
    runAccountSync,
    getGitRemote,
    enableGitRemote,
    rotateGitRemote,
    disableGitRemote,
    setGitRemoteUsername,
    exportUrl,
    downloadExport,
    listTree,
    getBlob,
    eventsUrl,
  };
}

/** Parse one SSE data frame into an AmberEvent, or null when unreadable. */
export function parseEventData(data: string): AmberEvent | null {
  try {
    const parsed = amberEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const api = createApiClient();

/** Scope labels used wherever a settings source is explained to the user. */
export const SCOPE_LABELS: Record<SettingScope | "default", string> = {
  repo: "this repository",
  account: "the account",
  forge: "the forge",
  global: "global settings",
  default: "the built-in default",
};
