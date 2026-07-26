import {
  getJson,
  matchesVisibility,
  normalizeRepoPath,
  pagesByLink,
  ProviderError,
} from "./http.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

/**
 * GitLab REST v4 client (gitlab.com and self-hosted, base <origin>/api/v4).
 * Verified against the live docs on 2026-07-26:
 * - Projects: https://docs.gitlab.com/api/projects/
 *   `GET /users/:user_id/projects` takes "the ID or username of the user" and
 *   "returns only projects in the user's personal namespace"; requests without
 *   authentication return only public projects. `GET /projects?membership=true`
 *   is the broader "everything the authenticated user is a member of" listing,
 *   which is what we use once the token is confirmed to be the account's own.
 * - Pagination: https://docs.gitlab.com/api/rest/
 *   Keyset pagination needs pagination=keyset plus order_by and sort, and hands
 *   back the next page only as a Link header with rel="next"; the docs say to
 *   use those links instead of generating URLs. Offset pagination tops out at
 *   50,000 projects and drops x-total past 10,000 records, so keyset is the
 *   right default for a backup tool. order_by=id is the supported keyset order
 *   for projects, and it works on both endpoints.
 * - Auth: https://docs.gitlab.com/api/rest/authentication/
 *   PRIVATE-TOKEN is the recommended header for personal access tokens; the
 *   read_api scope is what listing projects needs (read_repository is git only).
 * - Visibility: public | internal | private, filterable with ?visibility=.
 * - Rate limits: https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/
 *   429 with RateLimit-Reset as a Unix timestamp, and the docs warn that the
 *   Projects and Users APIs answer 429 WITHOUT informational headers, so amber
 *   must not depend on Retry-After being there.
 */

const PER_PAGE = "100";

interface GitLabProject {
  path_with_namespace?: unknown;
  default_branch?: unknown;
  visibility?: unknown;
  archived?: unknown;
  description?: unknown;
  empty_repo?: unknown;
}

function apiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v4`;
}

function headers(context: DiscoveryContext): Record<string, string> {
  const base: Record<string, string> = { accept: "application/json" };
  if (context.token !== null) {
    base["private-token"] = context.token;
  }
  return base;
}

function toDiscovered(raw: GitLabProject): DiscoveredRepo {
  if (typeof raw.path_with_namespace !== "string" || raw.path_with_namespace.trim() === "") {
    throw new ProviderError("GitLab returned a project without a path_with_namespace", {
      kind: "invalid_response",
    });
  }
  const emptyRepo = raw.empty_repo === true;
  return {
    path: normalizeRepoPath(raw.path_with_namespace),
    defaultBranch:
      !emptyRepo && typeof raw.default_branch === "string" && raw.default_branch !== ""
        ? raw.default_branch
        : null,
    // internal means "any signed in user", which is not public: treat as private.
    isPrivate: raw.visibility === "private" || raw.visibility === "internal",
    // Absent from the reduced field set an anonymous listing returns.
    archived: raw.archived === true,
    description:
      typeof raw.description === "string" && raw.description !== "" ? raw.description : null,
  };
}

async function tokenUsername(context: DiscoveryContext): Promise<string | null> {
  if (context.token === null) {
    return null;
  }
  const response = await getJson<{ username?: unknown }>(
    context,
    `${apiBase(context.baseUrl)}/user`,
    { headers: headers(context), notFoundHint: "the authenticated user" },
  );
  return typeof response.data.username === "string" ? response.data.username : null;
}

export const gitlabProvider: AccountSyncProvider = {
  kind: "gitlab",

  async *listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
    if (context.token === null && context.visibility === "private") {
      throw new ProviderError(
        `Listing private projects for ${context.username} needs a stored credential`,
        { kind: "auth" },
      );
    }

    const base = apiBase(context.baseUrl);
    const login = await tokenUsername(context);
    const self = login !== null && login.toLowerCase() === context.username.toLowerCase();

    const url = new URL(
      self ? `${base}/projects` : `${base}/users/${encodeURIComponent(context.username)}/projects`,
    );
    if (self) {
      url.searchParams.set("membership", "true");
    }
    url.searchParams.set("per_page", PER_PAGE);
    // Keyset pagination requires all three of these together.
    url.searchParams.set("pagination", "keyset");
    url.searchParams.set("order_by", "id");
    url.searchParams.set("sort", "asc");
    if (context.visibility !== "all") {
      url.searchParams.set("visibility", context.visibility);
    }

    for await (const page of pagesByLink<GitLabProject>(context, url.toString(), {
      headers: headers(context),
      notFoundHint: `user ${context.username}`,
      what: "the project list",
    })) {
      for (const raw of page) {
        const repo = toDiscovered(raw);
        if (matchesVisibility(repo.isPrivate, context.visibility)) {
          yield repo;
        }
      }
    }
  },
};
