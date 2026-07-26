import type { AccountSyncVisibility, ForgeKind } from "@amber/shared";

/**
 * Forge API clients used by account sync. They only ever read: enumerate the
 * repositories an account owns (or stars), and answer whether one specific
 * repository is still reachable.
 */

/** One repository as returned by a forge API during account sync. */
export interface DiscoveredRepo {
  /** Normalized path, matching repos.path: no leading slash, no trailing .git. */
  path: string;
  /** Null for an empty repository that has no commits yet. */
  defaultBranch: string | null;
  isPrivate: boolean;
  archived: boolean;
  /** Carried for logging and future use; the repos table has no column for it. */
  description: string | null;
}

/**
 * The subset of fetch the providers use. Injectable so tests can hand in an
 * undici MockAgent-bound fetch instead of mutating the global dispatcher.
 */
export type ProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveryContext {
  /**
   * Origin of the forge as stored on the forge row, e.g. "https://github.com"
   * or "https://gitea.example.com:3000". No trailing slash. Each provider
   * derives its own API base from this, so self-hosted instances work.
   */
  baseUrl: string;
  /** The account username on that forge. */
  username: string;
  /** Decrypted just in time; null means anonymous. Never logged, never in a URL. */
  token: string | null;
  /** Honored for source 'owned'. Starred listings always take everything. */
  visibility: AccountSyncVisibility;
  /** Defaults to globalThis.fetch. */
  fetch?: ProviderFetch;
}

/**
 * Result of re-checking one repository upstream. Only "accessible" is a
 * confirmed signal; "unknown" covers every ambiguous outcome (403, 5xx,
 * network error, timeout) and must never trigger a removal.
 */
export type RepoAccess = "accessible" | "missing" | "unknown";

export interface AccountSyncProvider {
  readonly kind: ForgeKind;
  /**
   * Every repository the account owns, honoring visibility. Paginated under the
   * hood: the iterable yields as pages arrive rather than buffering everything.
   */
  listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo>;
  /**
   * Every repository the account currently stars. Optional: only GitHub
   * implements it, and account-sync creation rejects starred syncs elsewhere.
   * Starred repositories belong to arbitrary owners, so each yielded path is
   * that repository's own full path.
   */
  listStarred?(context: DiscoveryContext): AsyncIterable<DiscoveredRepo>;
  /**
   * Whether `path` is still reachable with this context's credentials. Used
   * before a starred sync removes a repository: only a definite "accessible"
   * proves the star was dropped deliberately rather than the repo vanishing.
   */
  checkRepoAccess?(context: DiscoveryContext, path: string): Promise<RepoAccess>;
}
