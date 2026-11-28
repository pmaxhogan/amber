import {
  encodeRepoPath,
  expectArray,
  forkLookupFailure,
  visibilityOnFailure,
  getJson,
  matchesVisibility,
  normalizeRepoPath,
  pagesByLink,
  parentPathOrNull,
  ProviderError,
} from "./http.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
  ForkLookup,
  OwnerLookup,
  RepoAccess,
  RepoInfo,
} from "./types.ts";

/**
 * GitHub REST client. Endpoints and behaviour verified against the live docs on
 * 2026-07-26:
 * - Repositories: https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28
 *   `GET /user/repos` takes visibility (all|public|private) and affiliation;
 *   sending `type` alongside either is a 422, so we never send `type` there.
 *   `GET /users/{username}/repos` is documented as "public repositories" and can
 *   never return private ones, with or without a token.
 * - Starring: https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28
 * - Authenticated user: https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28
 * - Pagination: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28
 *   per_page over 100 is silently clamped, so the only correct stop condition is
 *   the absence of a rel="next" link, and the link must be followed verbatim
 *   (GitHub rewrites /users/:login/repos into /user/:id/repos).
 * - Rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28
 *   Both primary and secondary limits surface as 403 or 429; retry-after and
 *   x-ratelimit-remaining/x-ratelimit-reset are what separate them from a plain
 *   permission failure. providers/http.ts encodes that classification.
 * - Headers: https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api?apiVersion=2022-11-28
 *   A User-Agent is mandatory (missing one is rejected with 403), Accept should
 *   be application/vnd.github+json, and tokens go in Authorization: Bearer.
 * - Search: https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28
 *   `GET /search/repositories` answers with an object, `{ total_count, items }`,
 *   not a bare array, and has its own rate limit (10 requests a minute
 *   anonymously, 30 with a token; confirmed against the live API 2026-11-23).
 *   per_page tops out at 100, so a trending listing is exactly one request.
 * - 404 vs 403: https://docs.github.com/en/rest/overview/troubleshooting-the-rest-api?apiVersion=2022-11-28
 *   GitHub answers 404 rather than 403 for private repositories you cannot see,
 *   so a 404 never proves a repository is gone.
 */

/** Pinned rather than tracking the newest version, which drops fields we read. */
const API_VERSION = "2022-11-28";
const USER_AGENT = "amber-git-backup";
const PER_PAGE = "100";
const MAX_SEARCH_PER_PAGE = 100;

interface GitHubRepo {
  full_name?: unknown;
  private?: unknown;
  visibility?: unknown;
  default_branch?: unknown;
  archived?: unknown;
  description?: unknown;
  fork?: unknown;
  parent?: { full_name?: unknown } | null;
  size?: unknown;
  stargazers_count?: unknown;
}

/**
 * The visibility field, fail closed: public only when `private` is literally
 * false and `visibility`, where present, says "public". Enterprise's
 * "internal" is private for our purposes. Anything else is null (unknown).
 */
export function githubVisibility(raw: Pick<GitHubRepo, "private" | "visibility">): boolean | null {
  if (raw.private === false && (raw.visibility === undefined || raw.visibility === "public")) {
    return false;
  }
  if (raw.private === true || raw.visibility === "private" || raw.visibility === "internal") {
    return true;
  }
  return null;
}

/** GitHub documents `size` in kilobytes; 0 is what a new repo reports before it is measured. */
function githubSizeBytes(raw: Pick<GitHubRepo, "size">): number | null {
  return typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size > 0
    ? Math.round(raw.size * 1024)
    : null;
}

/**
 * `stargazers_count` is the star count on every repository response (GitHub's
 * starring docs: "watchers, watchers_count, and stargazers_count correspond to
 * the number of users that have starred a repository"). Anything that is not
 * a non-negative safe integer is "not reported", so a malformed body can never
 * overwrite a known count.
 */
export function githubStars(raw: Pick<GitHubRepo, "stargazers_count">): number | null {
  const value = raw.stargazers_count;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function githubFork(raw: GitHubRepo): ForkLookup {
  if (raw.fork === true) {
    const parent = parentPathOrNull(raw.parent?.full_name);
    return parent === null ? { status: "unknown", rateLimited: false } : { status: "fork", parent };
  }
  return raw.fork === false ? { status: "not_fork" } : { status: "unknown", rateLimited: false };
}

async function githubRepoInfo(context: DiscoveryContext, path: string): Promise<RepoInfo> {
  const encoded = encodeRepoPath(path);
  if (encoded.split("/").length < 2) {
    return {
      fork: { status: "unknown", rateLimited: false },
      isPrivate: null,
      sizeBytes: null,
      stars: null,
    };
  }
  try {
    const response = await getJson<GitHubRepo>(
      context,
      `${apiBase(context.baseUrl)}/repos/${encoded}`,
      { headers: headers(context), notFoundHint: path },
    );
    return {
      fork: githubFork(response.data),
      // A 200 that does not say "public" is an answer: not public.
      isPrivate: githubVisibility(response.data) ?? true,
      sizeBytes: githubSizeBytes(response.data),
      stars: githubStars(response.data),
    };
  } catch (cause) {
    return {
      fork: forkLookupFailure(cause),
      isPrivate: visibilityOnFailure(cause),
      sizeBytes: null,
      stars: null,
    };
  }
}

/** Cached per run: one GET /user answers "is this the account's own token". */
const loginCache = new WeakMap<DiscoveryContext, Promise<string | null>>();

function apiBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    return "https://api.github.com";
  }
  // GitHub Enterprise Server serves the same API under /api/v3.
  return `${baseUrl.replace(/\/+$/, "")}/api/v3`;
}

function headers(context: DiscoveryContext): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": USER_AGENT,
  };
  if (context.token !== null) {
    base.authorization = `Bearer ${context.token}`;
  }
  return base;
}

async function tokenLogin(context: DiscoveryContext): Promise<string | null> {
  if (context.token === null) {
    return null;
  }
  const cached = loginCache.get(context);
  if (cached !== undefined) {
    return cached;
  }
  const pending = getJson<{ login?: unknown }>(context, `${apiBase(context.baseUrl)}/user`, {
    headers: headers(context),
    notFoundHint: "the authenticated user",
  }).then((response) => (typeof response.data.login === "string" ? response.data.login : null));
  loginCache.set(context, pending);
  return pending;
}

/** Whether the token belongs to `login` (the account's own username by default). */
async function isSelf(
  context: DiscoveryContext,
  login: string = context.username,
): Promise<boolean> {
  const tokenOwner = await tokenLogin(context);
  return tokenOwner !== null && tokenOwner.toLowerCase() === login.toLowerCase();
}

function toDiscovered(raw: GitHubRepo): DiscoveredRepo {
  if (typeof raw.full_name !== "string" || raw.full_name.trim() === "") {
    throw new ProviderError("GitHub returned a repository without a full_name", {
      kind: "invalid_response",
    });
  }
  return {
    path: normalizeRepoPath(raw.full_name),
    // Absent on the minimal-repository schema /users/{username}/repos returns.
    defaultBranch: typeof raw.default_branch === "string" ? raw.default_branch : null,
    // Anything short of a confirmed "public" is private (githubVisibility).
    isPrivate: githubVisibility(raw) !== false,
    archived: raw.archived === true,
    description: typeof raw.description === "string" ? raw.description : null,
    // List endpoints say `fork` but never `parent`; only GET /repos/{o}/{r} names it.
    isFork: typeof raw.fork === "boolean" ? raw.fork : null,
    forkParent: null,
  };
}

function listUrl(base: string, path: string, params: Record<string, string>): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function* walk(
  context: DiscoveryContext,
  url: string,
  hint: string,
): AsyncIterable<DiscoveredRepo> {
  for await (const page of pagesByLink<GitHubRepo>(context, url, {
    headers: headers(context),
    notFoundHint: hint,
    what: "the repository list",
  })) {
    for (const raw of page) {
      const repo = toDiscovered(raw);
      if (matchesVisibility(repo.isPrivate, context.visibility)) {
        yield repo;
      }
    }
  }
}

/**
 * What a user owns. Only that user's own token reaches /user/repos and with it
 * the private repositories; anyone else gets the public listing.
 */
async function* userRepos(context: DiscoveryContext, login: string): AsyncIterable<DiscoveredRepo> {
  const base = apiBase(context.baseUrl);
  const self = await isSelf(context, login);

  if (!self && context.visibility === "private") {
    throw new ProviderError(
      `Listing private repositories for ${login} needs a stored credential belonging to that account`,
      { kind: "auth" },
    );
  }

  const url = self
    ? // affiliation=owner keeps the backup to what the account actually owns.
      listUrl(base, "/user/repos", {
        per_page: PER_PAGE,
        affiliation: "owner",
        visibility: context.visibility,
        sort: "full_name",
      })
    : listUrl(base, `/users/${encodeURIComponent(login)}/repos`, {
        per_page: PER_PAGE,
        type: "owner",
        sort: "full_name",
      });

  yield* walk(context, url, `user ${login}`);
}

/**
 * What an organization owns. /orgs/{org}/repos with type=all returns the
 * private repositories too, whenever the token can see them (a fine-grained
 * PAT whose resource owner is the organization, or a classic token of a
 * member); without one it is the public list, so asking for private only is
 * refused up front rather than answered with a silent empty list.
 */
async function* orgRepos(context: DiscoveryContext, org: string): AsyncIterable<DiscoveredRepo> {
  if (context.token === null && context.visibility === "private") {
    throw new ProviderError(`Listing private repositories of ${org} needs a stored credential`, {
      kind: "auth",
    });
  }
  const url = listUrl(apiBase(context.baseUrl), `/orgs/${encodeURIComponent(org)}/repos`, {
    per_page: PER_PAGE,
    type: "all",
    sort: "full_name",
  });
  yield* walk(context, url, `organization ${org}`);
}

export const githubProvider: AccountSyncProvider = {
  kind: "github",

  listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
    return userRepos(context, context.username);
  },

  async *listStarred(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
    const base = apiBase(context.baseUrl);
    const self = await isSelf(context);
    // Stars are public, so the anonymous listing is complete for public repos;
    // only the account's own token can also see privately starred repositories.
    const url = self
      ? listUrl(base, "/user/starred", { per_page: PER_PAGE })
      : listUrl(base, `/users/${encodeURIComponent(context.username)}/starred`, {
          per_page: PER_PAGE,
        });

    yield* walk(context, url, `the stars of ${context.username}`);
  },

  async *listNamespaceRepos(
    context: DiscoveryContext,
    namespace: string,
  ): AsyncIterable<DiscoveredRepo> {
    // Users and organizations share one login namespace on GitHub, and
    // GET /users/{name} answers for both, saying which in `type`.
    const owner = await getJson<{ login?: unknown; type?: unknown }>(
      context,
      `${apiBase(context.baseUrl)}/users/${encodeURIComponent(namespace)}`,
      { headers: headers(context), notFoundHint: `user or organization named ${namespace}` },
    );
    // Prefer GitHub's own spelling so URLs and messages match the real login.
    const login = typeof owner.data.login === "string" ? owner.data.login : namespace;
    if (owner.data.type === "Organization") {
      yield* orgRepos(context, login);
    } else {
      yield* userRepos(context, login);
    }
  },

  async *listTrending(
    context: DiscoveryContext,
    options: { since: Date; limit: number },
  ): AsyncIterable<DiscoveredRepo> {
    // The query github-trending-daily runs: whatever was created in the
    // window, most starred first. A bare date is day-granular, so `>=` takes
    // the whole of the first day (the reference uses `>` and loses it).
    const since = options.since.toISOString().slice(0, 10);
    const limit = Math.max(1, Math.min(MAX_SEARCH_PER_PAGE, Math.trunc(options.limit)));
    const url = listUrl(apiBase(context.baseUrl), "/search/repositories", {
      q: `created:>=${since}`,
      sort: "stars",
      order: "desc",
      per_page: String(limit),
    });
    const response = await getJson<{ items?: unknown }>(context, url, {
      headers: headers(context),
      notFoundHint: "the repository search",
    });
    const items = expectArray<GitHubRepo>(response.data.items, "the search results");
    for (const raw of items.slice(0, limit)) {
      yield toDiscovered(raw);
    }
  },

  async checkRepoAccess(context: DiscoveryContext, path: string): Promise<RepoAccess> {
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.length < 2) {
      return "unknown";
    }
    const url = `${apiBase(context.baseUrl)}/repos/${segments
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;

    try {
      await getJson<unknown>(context, url, { headers: headers(context), notFoundHint: path });
      return "accessible";
    } catch (cause) {
      if (cause instanceof ProviderError && cause.kind === "not_found") {
        // Deleted, made private, or simply invisible to this token: all three
        // are reasons to keep the backup, so the caller treats them alike.
        return "missing";
      }
      return "unknown";
    }
  },

  async getForkParent(context: DiscoveryContext, path: string): Promise<ForkLookup> {
    return (await githubRepoInfo(context, path)).fork;
  },

  getRepoInfo: githubRepoInfo,

  async checkOwner(context: DiscoveryContext, owner: string): Promise<OwnerLookup> {
    const name = owner.trim();
    if (name === "" || name.includes("/")) {
      return { status: "unknown", rateLimited: false };
    }
    try {
      // One endpoint answers for users and organizations alike.
      await getJson<unknown>(
        context,
        `${apiBase(context.baseUrl)}/users/${encodeURIComponent(name)}`,
        { headers: headers(context), notFoundHint: name },
      );
      return { status: "exists" };
    } catch (cause) {
      if (cause instanceof ProviderError && cause.kind === "not_found") {
        // A deleted account and a suspended one both answer 404.
        return { status: "missing" };
      }
      return forkLookupFailure(cause);
    }
  },
};
