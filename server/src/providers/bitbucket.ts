import {
  assertSameOrigin,
  expectArray,
  getJson,
  MAX_PAGES,
  matchesVisibility,
  normalizeRepoPath,
  ProviderError,
} from "./http.ts";
import type { AccountSyncProvider, DiscoveredRepo, DiscoveryContext } from "./types.ts";

/**
 * Bitbucket Cloud REST 2.0 client. Verified against the live OpenAPI spec
 * (https://api.bitbucket.org/swagger.json) and the docs on 2026-07-26:
 * - Listing: `GET /2.0/repositories/{workspace}` is the supported endpoint;
 *   the cross-workspace `GET /2.0/repositories?role=member` is GONE (it answers
 *   410 "CHANGE-2770 - Functionality has been deprecated"). For a credential
 *   whose username is an Atlassian email there is no workspace slug to use, so
 *   we fan out over `GET /2.0/user/workspaces` instead, which is the documented
 *   workspace-scoped replacement.
 *   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/
 * - Auth: https://developer.atlassian.com/cloud/bitbucket/rest/intro/
 *   "App passwords are deprecated. Use API tokens." An API token authenticates
 *   with Basic auth where the username is the Atlassian account email and the
 *   password is the token, so amber sends Basic <account username>:<secret> and
 *   the stored username must be that email. Bearer is for OAuth tokens only.
 * - Pagination: the paged wrapper is {values, next, page, pagelen, size} where
 *   only `values` and `next` are guaranteed, `next` is an absolute URL, and the
 *   docs insist it is "an opaque location that is not to be constructed by
 *   clients". pagelen maxes out at 100.
 * - Rate limits: https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/
 *   60 requests/hour anonymous. The docs never mention 429 or Retry-After, and
 *   X-Ratelimit-Reset is seconds remaining rather than an epoch, so amber falls
 *   back to its own backoff rather than trusting the headers.
 * - Bitbucket Data Center / Server speaks a completely different API
 *   (/rest/api/1.0) and is not supported here.
 */

const PER_PAGE = "100";

interface BitbucketRepo {
  full_name?: unknown;
  is_private?: unknown;
  mainbranch?: { name?: unknown } | null;
  description?: unknown;
}

interface BitbucketPage {
  values?: unknown;
  next?: unknown;
}

interface BitbucketWorkspaceMembership {
  workspace?: { slug?: unknown } | null;
}

function apiBase(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  if (host !== "bitbucket.org" && host !== "www.bitbucket.org" && host !== "api.bitbucket.org") {
    throw new ProviderError(
      `Account sync only supports Bitbucket Cloud; ${host} looks like Bitbucket Data Center, which speaks a different API`,
      { kind: "other" },
    );
  }
  return "https://api.bitbucket.org/2.0";
}

function headers(context: DiscoveryContext): Record<string, string> {
  const base: Record<string, string> = { accept: "application/json" };
  if (context.token !== null) {
    const basic = Buffer.from(`${context.username}:${context.token}`, "utf8").toString("base64");
    base.authorization = `Basic ${basic}`;
  }
  return base;
}

function toDiscovered(raw: BitbucketRepo): DiscoveredRepo {
  if (typeof raw.full_name !== "string" || raw.full_name.trim() === "") {
    throw new ProviderError("Bitbucket returned a repository without a full_name", {
      kind: "invalid_response",
    });
  }
  const branch = raw.mainbranch?.name;
  return {
    path: normalizeRepoPath(raw.full_name),
    // mainbranch is absent on an empty repository: Bitbucket has no empty flag.
    defaultBranch: typeof branch === "string" && branch !== "" ? branch : null,
    isPrivate: raw.is_private === true,
    // Bitbucket Cloud has no archived concept.
    archived: false,
    description:
      typeof raw.description === "string" && raw.description !== "" ? raw.description : null,
  };
}

/** Follow the opaque `next` URL until it stops coming, never rebuilding it. */
async function* pagedValues<T>(
  context: DiscoveryContext,
  firstUrl: string,
  hint: string,
): AsyncIterable<T[]> {
  let url: string = firstUrl;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await getJson<BitbucketPage>(context, url, {
      headers: headers(context),
      notFoundHint: hint,
    });
    yield expectArray<T>(response.data.values ?? [], "the listing");

    const next: unknown = response.data.next;
    if (typeof next !== "string" || next === "") {
      return;
    }
    assertSameOrigin(next, firstUrl);
    url = next;
  }
  throw new ProviderError(`Bitbucket kept paginating past ${String(MAX_PAGES)} pages`, {
    kind: "invalid_response",
  });
}

async function resolveWorkspaces(context: DiscoveryContext, base: string): Promise<string[]> {
  // A plain slug is a workspace; an email only makes sense as an API token
  // login, so the workspaces have to be looked up.
  if (!context.username.includes("@")) {
    return [context.username];
  }
  if (context.token === null) {
    throw new ProviderError(
      `Set the Bitbucket account username to a workspace slug (or store an API token) - ${context.username} cannot be listed anonymously`,
      { kind: "auth" },
    );
  }

  const slugs: string[] = [];
  for await (const page of pagedValues<BitbucketWorkspaceMembership>(
    context,
    `${base}/user/workspaces?pagelen=${PER_PAGE}`,
    "the accessible workspaces",
  )) {
    for (const membership of page) {
      const slug = membership.workspace?.slug;
      if (typeof slug === "string" && slug !== "") {
        slugs.push(slug);
      }
    }
  }
  if (slugs.length === 0) {
    throw new ProviderError(`No Bitbucket workspaces are visible to ${context.username}`, {
      kind: "not_found",
    });
  }
  return slugs;
}

export const bitbucketProvider: AccountSyncProvider = {
  kind: "bitbucket",

  async *listRepos(context: DiscoveryContext): AsyncIterable<DiscoveredRepo> {
    if (context.token === null && context.visibility === "private") {
      throw new ProviderError(
        `Listing private repositories for ${context.username} needs a stored credential`,
        { kind: "auth" },
      );
    }

    const base = apiBase(context.baseUrl);
    const seen = new Set<string>();

    for (const workspace of await resolveWorkspaces(context, base)) {
      const url = new URL(`${base}/repositories/${encodeURIComponent(workspace)}`);
      url.searchParams.set("pagelen", PER_PAGE);
      // Newest first keeps the interesting repositories at the front of a run
      // that a rate limit might cut short.
      url.searchParams.set("sort", "-updated_on");

      for await (const page of pagedValues<BitbucketRepo>(
        context,
        url.toString(),
        `workspace ${workspace}`,
      )) {
        for (const raw of page) {
          const repo = toDiscovered(raw);
          if (seen.has(repo.path) || !matchesVisibility(repo.isPrivate, context.visibility)) {
            continue;
          }
          seen.add(repo.path);
          yield repo;
        }
      }
    }
  },
};
