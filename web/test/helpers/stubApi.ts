import { vi } from "vitest";
import type { Account, Forge, GitRemoteConfig, Status, SyncRun } from "@amber/shared";
import type { ApiClient } from "../../src/api/client.ts";
import type { AccountSyncRow, RepoRow } from "../../src/api/types.ts";

/** A fully stubbed ApiClient. Every method resolves to an empty-ish value. */
export function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = {
    baseUrl: "",
    request: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true, version: "test" }),
    status: vi.fn().mockResolvedValue(makeStatus()),
    listForges: vi.fn().mockResolvedValue([]),
    createForge: vi.fn(),
    updateForge: vi.fn(),
    deleteForge: vi.fn().mockResolvedValue(undefined),
    listAccounts: vi.fn().mockResolvedValue([]),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    setDefaultAccount: vi.fn(),
    previewImport: vi.fn(),
    commitImport: vi.fn(),
    listRepos: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, perPage: 50 }),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    deleteRepo: vi.fn().mockResolvedValue(undefined),
    syncRepo: vi.fn().mockResolvedValue(undefined),
    listRuns: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, perPage: 20 }),
    bulkRepos: vi.fn().mockResolvedValue({ affected: 0 }),
    getSettings: vi.fn().mockResolvedValue({}),
    putSettings: vi.fn().mockResolvedValue({}),
    getEffectiveSettings: vi.fn().mockResolvedValue({}),
    listAccountSyncs: vi.fn().mockResolvedValue([]),
    createAccountSync: vi.fn(),
    updateAccountSync: vi.fn(),
    deleteAccountSync: vi.fn().mockResolvedValue(undefined),
    runAccountSync: vi.fn().mockResolvedValue(undefined),
    getGitRemote: vi.fn().mockResolvedValue(makeGitRemote()),
    enableGitRemote: vi.fn(),
    rotateGitRemote: vi.fn(),
    disableGitRemote: vi.fn(),
    setGitRemoteUsername: vi.fn(),
    exportUrl: vi.fn().mockReturnValue("/api/repos/1/export/source.zip"),
    downloadExport: vi.fn(),
    listTree: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, perPage: 200 }),
    getBlob: vi.fn(),
    eventsUrl: vi.fn().mockReturnValue("/api/events"),
  };
  return { ...base, ...overrides } as unknown as ApiClient;
}

export function makeStatus(overrides: Partial<Status> = {}): Status {
  return {
    version: "0.1.0-test",
    insecureMode: false,
    queueDepth: 0,
    activeSyncs: 0,
    totalRepos: 0,
    totalDiskUsageBytes: 0,
    breakerOpen: false,
    ...overrides,
  };
}

export function makeForge(overrides: Partial<Forge> = {}): Forge {
  return {
    id: 1,
    protocol: "https",
    host: "github.com",
    port: null,
    kind: "github",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    forgeId: 1,
    username: "pmaxhogan",
    hasSecret: true,
    isDefault: true,
    lastUsedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: 1,
    forgeId: 1,
    path: "nodejs/node",
    displayName: "node",
    slug: "nodejs-node-a1b2c3d4",
    shortId: "a1b2c3d4",
    accountOverrideId: null,
    forceAnonymous: false,
    managedByAccountSyncId: null,
    state: "active",
    nextSyncAt: 1_700_000_600_000,
    consecutiveFailures: 0,
    lastSyncAt: 1_700_000_000_000,
    lastSuccessAt: 1_700_000_000_000,
    lastError: null,
    diskUsageBytes: 1_048_576,
    defaultBranch: "main",
    lastFetchHead: "abc1234",
    createdAt: 1_690_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 1,
    repoId: 1,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_004_000,
    outcome: "success",
    error: null,
    errorKind: null,
    bytesFetched: 2048,
    durationMs: 4000,
    refsChanged: 3,
    paranoidArchived: 0,
    ...overrides,
  };
}

export function makeAccountSync(overrides: Partial<AccountSyncRow> = {}): AccountSyncRow {
  return {
    id: 1,
    accountId: 1,
    source: "owned",
    visibility: "all",
    enabled: true,
    intervalMinutes: 360,
    nextRunAt: 1_700_000_600_000,
    lastRunAt: 1_700_000_000_000,
    lastError: null,
    reposDiscovered: 12,
    createdAt: 1_690_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeGitRemote(overrides: Partial<GitRemoteConfig> = {}): GitRemoteConfig {
  return {
    enabled: false,
    username: "amber",
    cloneUrlTemplate: "https://amber:PASSWORD@amber.example.com/git/{slug}.git",
    rotatedAt: null,
    ...overrides,
  };
}
