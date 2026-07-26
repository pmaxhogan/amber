import {
  assertSameOrigin,
  expectArray,
  getJson,
  MAX_PAGES,
  matchesVisibility,
  normalizeRepoPath,
  parseLinkHeader,
  ProviderError,
} from "./http.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

/**
 * Gitea REST client (gitea.com and self-hosted). Verified against the live
 * swagger (basePath /api/v1, version 1.27) and the docs on 2026-07-26:
 * - Endpoints: `GET /api/v1/user/repos` ("the repos that the authenticated user
 *   owns") and `GET /api/v1/users/{username}/repos`, both taking only page and
 *   limit. https://gitea.com/swagger.v1.json
 * - Auth: https://docs.gitea.com/development/api-usage - "API tokens must be
 *   prepended with 'token' followed by a space". Current releases also accept
 *   Bearer, but `token` is the compatible spelling.
 * - Pagination: page is 1-based and limit is capped per instance
 *   (MAX_RESPONSE_ITEMS, 50 by default), so a short page proves nothing. Gitea
 *   sends a Link header with rel="next" plus X-Total-Count; we follow the link
 *   and fall back to the count when an older instance omits the header.
 * - Visibility: there is no visibility parameter. The listing returns whatever
 *   the caller may see, so amber filters client side.
 * - Rate limiting: Gitea documents none and sends no rate limit headers, but a
 *   reverse proxy in front of a self-hosted instance may answer 429, which
 *   providers/http.ts classifies generically.
 */

const PER_PAGE = 50;

interface GiteaRepo {
  full_name?: unknown;
  private?: unknown;
  internal?: unknown;
  default_branch?: unknown;
  archived?: unknown;
  description?: unknown;
  empty?: unknown;
}

function apiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1`;
}

function headers(context: DiscoveryContext): Record<string, string> {
  const base: Record<string, string> = { accept: "application/json" };
  if (context.token !== null) {
    base.authorization = `token ${context.token}`;
  }
  return base;
}

function toDiscovered(raw: GiteaRepo): DiscoveredRepo {
  if (typeof raw.full_name !== "string" || raw.full_name.trim() === "") {
    throw new ProviderError("Gitea returned a repository without a full_name", {
      kind: "invalid_response",
    });
  }
  // Gitea is the one forge that says so outright when a repo has no commits.
  const emptyRepo = raw.empty === true;
  return {
    path: normalizeRepoPath(raw.full_name),
    defaultBranch:
      !emptyRepo && typeof raw.default_branch === "string" && raw.default_branch !== ""
        ? raw.default_branch
        : null,
    isPrivate: raw.private === true || raw.internal === true,
    archived: raw.archived === true,
    description:
      typeof raw.description === "string" && raw.description !== "" ? raw.description : null,
  };
}

async function tokenUsername(context: DiscoveryContext): Promise<string | null> {
  if (context.token === null) {
    return null;
  }
  const response = await getJson<{ login?: unknown; username?: unknown }>(
    context,
    `${apiBase(context.baseUrl)}/user`,
    { headers: headers(context), notFoundHint: "the authenticated user" },
  );
  if (typeof response.data.login === "string") {
    return response.data.login;
  }
  return typeof response.data.username === "string" ? response.data.username : null;
}

export const giteaProvider: AccountSyncProvider = {
  kind: "gitea",

  async *listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
    if (context.token === null && context.visibility === "private") {
      throw new ProviderError(
        `Listing private repositories for ${context.username} needs a stored credential`,
        { kind: "auth" },
      );
    }

    const base = apiBase(context.baseUrl);
    const login = await tokenUsername(context);
    const self = login !== null && login.toLowerCase() === context.username.toLowerCase();

    const first = new URL(
      self ? `${base}/user/repos` : `${base}/users/${encodeURIComponent(context.username)}/repos`,
    );
    first.searchParams.set("page", "1");
    first.searchParams.set("limit", String(PER_PAGE));

    let url = first.toString();
    let collected = 0;
    let total: number | null = null;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await getJson<unknown>(context, url, {
        headers: headers(context),
        notFoundHint: `user ${context.username}`,
      });
      const rows = expectArray<GiteaRepo>(response.data, "the repository list");
      collected += rows.length;

      for (const raw of rows) {
        const repo = toDiscovered(raw);
        if (matchesVisibility(repo.isPrivate, context.visibility)) {
          yield repo;
        }
      }

      if (total === null) {
        const header = response.headers.get("x-total-count");
        const parsed = header === null ? Number.NaN : Number(header);
        total = Number.isFinite(parsed) ? parsed : null;
      }

      if (rows.length === 0) {
        return;
      }

      const next = parseLinkHeader(response.headers.get("link")).next;
      if (next !== undefined) {
        assertSameOrigin(next, first.toString());
        url = next;
        continue;
      }
      if (total === null || collected >= total) {
        return;
      }
      const manual = new URL(first.toString());
      manual.searchParams.set("page", String(page + 1));
      url = manual.toString();
    }

    throw new ProviderError(`Gitea kept paginating past ${String(MAX_PAGES)} pages`, {
      kind: "invalid_response",
    });
  },
};
