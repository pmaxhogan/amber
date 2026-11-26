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
  /**
   * Whether the listing says this repository is a fork. Null when the listing
   * does not carry the flag at all, which is not the same as "not a fork".
   */
  isFork: boolean | null;
  /**
   * Normalized path of the upstream on the same forge, only when the listing
   * itself names it. GitHub and GitLab list endpoints never do.
   */
  forkParent: string | null;
}

/**
 * Answer to "is this repository a fork, and of what". Only "fork" and
 * "not_fork" are confirmed; every failure is "unknown" so a 404 or a flaky
 * network can never be recorded as "not a fork".
 */
export type ForkLookup =
  | { status: "fork"; parent: string }
  | { status: "not_fork" }
  | { status: "unknown"; rateLimited: boolean };

/**
 * Whether a user or organization still exists on the forge. Only "exists" and
 * "missing" are answers; every failure is "unknown".
 */
export type OwnerLookup =
  { status: "exists" } | { status: "missing" } | { status: "unknown"; rateLimited: boolean };

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
   * Every repository a named user or organization owns, honoring visibility,
   * seen through this context's credentials (which may belong to someone else
   * entirely, or be absent). Optional: only GitHub implements it, and
   * namespace-sync creation rejects other kinds.
   */
  listNamespaceRepos?(context: DiscoveryContext, namespace: string): AsyncIterable<DiscoveredRepo>;
  /**
   * The `limit` most-starred repositories created at or after `since`, most
   * starred first. This is what "trending" means here: young repositories that
   * collected stars fast. Optional: only GitHub implements it. The caller
   * supplies `since` because a provider has no clock of its own.
   */
  listTrending?(
    context: DiscoveryContext,
    options: { since: Date; limit: number },
  ): AsyncIterable<DiscoveredRepo>;
  /**
   * Whether `path` is still reachable with this context's credentials. Used
   * before a starred sync removes a repository: only a definite "accessible"
   * proves the star was dropped deliberately rather than the repo vanishing.
   */
  checkRepoAccess?(context: DiscoveryContext, path: string): Promise<RepoAccess>;
  /**
   * Ask the forge about one repository's upstream. Optional: needed because
   * some listings (GitHub, GitLab) say nothing about the parent. One GET, never
   * throws on a forge failure.
   */
  getForkParent?(context: DiscoveryContext, path: string): Promise<ForkLookup>;
  /**
   * Ask the forge whether the user or organization `owner` still exists. One
   * GET, never throws on a forge failure. Used to tell "this repository was
   * removed" from "its whole account was".
   */
  checkOwner?(context: DiscoveryContext, owner: string): Promise<OwnerLookup>;
}
