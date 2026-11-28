import {
  assertSameOrigin,
  encodeRepoPath,
  expectArray,
  forkLookupFailure,
  visibilityOnFailure,
  getJson,
  MAX_PAGES,
  matchesVisibility,
  normalizeRepoPath,
  parentPathOrNull,
  parseLinkHeader,
  ProviderError,
} from "./http.ts";
import type {
  AccountSyncProvider,
  DiscoveredRepo,
  DiscoveryContext,
  ForkLookup,
  OwnerLookup,
  RepoInfo,
} from "./types.ts";

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
  fork?: unknown;
  parent?: { full_name?: unknown } | null;
}

/**
 * The visibility fields, fail closed: public only when `private` is literally
 * false and `internal` (visible to any signed-in user) is not true. Anything
 * else is null (unknown).
 */
export function giteaVisibility(raw: Pick<GiteaRepo, "private" | "internal">): boolean | null {
  if (raw.private === true || raw.internal === true) {
    return true;
  }
  if (raw.private === false) {
    return false;
  }
  return null;
}

function giteaFork(raw: GiteaRepo): ForkLookup {
  if (raw.fork === true) {
    const parent = parentPathOrNull(raw.parent?.full_name);
    return parent === null ? { status: "unknown", rateLimited: false } : { status: "fork", parent };
  }
  return raw.fork === false ? { status: "not_fork" } : { status: "unknown", rateLimited: false };
}

/**
 * Size is left unknown on purpose: the unit of Gitea's `size` has not been
 * verified against its documentation, and a wrong unit would refuse clones
 * that fit. Unknown means the cap gate lets the first clone proceed.
 */
async function giteaRepoInfo(context: DiscoveryContext, path: string): Promise<RepoInfo> {
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
    const response = await getJson<GiteaRepo>(
      context,
      `${apiBase(context.baseUrl)}/repos/${encoded}`,
      { headers: headers(context), notFoundHint: path },
    );
    return {
      fork: giteaFork(response.data),
      // A 200 that does not say "public" is an answer: not public.
      isPrivate: giteaVisibility(response.data) ?? true,
      sizeBytes: null,
      stars: null,
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
    isPrivate: giteaVisibility(raw) !== false,
    archived: raw.archived === true,
    description:
      typeof raw.description === "string" && raw.description !== "" ? raw.description : null,
    isFork: typeof raw.fork === "boolean" ? raw.fork : null,
    // Swagger: parent is a full Repository, set for forks. A fork whose upstream
    // we cannot see comes back without it, which stays "unknown" upstream.
    forkParent: raw.fork === true ? parentPathOrNull(raw.parent?.full_name) : null,
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

  async getForkParent(context: DiscoveryContext, path: string): Promise<ForkLookup> {
    return (await giteaRepoInfo(context, path)).fork;
  },

  getRepoInfo: giteaRepoInfo,

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
