import {
  getJson,
  matchesVisibility,
  normalizeRepoPath,
  pagesByLink,
  ProviderError,
} from "./http.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext, RepoAccess } from "./types.ts";

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
 * - 404 vs 403: https://docs.github.com/en/rest/overview/troubleshooting-the-rest-api?apiVersion=2022-11-28
 *   GitHub answers 404 rather than 403 for private repositories you cannot see,
 *   so a 404 never proves a repository is gone.
 */

/** Pinned rather than tracking the newest version, which drops fields we read. */
const API_VERSION = "2022-11-28";
const USER_AGENT = "amber-git-backup";
const PER_PAGE = "100";

interface GitHubRepo {
  full_name?: unknown;
  private?: unknown;
  visibility?: unknown;
  default_branch?: unknown;
  archived?: unknown;
  description?: unknown;
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

async function isSelf(context: DiscoveryContext): Promise<boolean> {
  const login = await tokenLogin(context);
  return login !== null && login.toLowerCase() === context.username.toLowerCase();
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
    // visibility 'internal' (Enterprise) is private for our purposes.
    isPrivate:
      raw.private === true || raw.visibility === "private" || raw.visibility === "internal",
    archived: raw.archived === true,
    description: typeof raw.description === "string" ? raw.description : null,
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

export const githubProvider: AccountSyncProvider = {
  kind: "github",

  async *listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
    const base = apiBase(context.baseUrl);
    const self = await isSelf(context);

    if (!self && context.visibility === "private") {
      throw new ProviderError(
        `Listing private repositories for ${context.username} needs a stored credential belonging to that account`,
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
      : listUrl(base, `/users/${encodeURIComponent(context.username)}/repos`, {
          per_page: PER_PAGE,
          type: "owner",
          sort: "full_name",
        });

    yield* walk(context, url, `user ${context.username}`);
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
};
