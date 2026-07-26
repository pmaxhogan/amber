import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubProvider } from "../../src/providers/github.ts";
import { ProviderError } from "../../src/providers/http.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

const API = "https://api.github.com";

let http: MockHttp;

function repo(fullName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: fullName,
    private: false,
    default_branch: "main",
    archived: false,
    description: null,
    ...extra,
  };
}

function ghContext(overrides: Parameters<typeof context>[0] = {}) {
  return context({ fetch: http.fetch, ...overrides });
}

/** listStarred is optional on the interface; GitHub is the one provider with it. */
function starredOf(ctx: ReturnType<typeof ghContext>) {
  const list = githubProvider.listStarred;
  if (list === undefined) {
    throw new Error("the GitHub provider must implement listStarred");
  }
  return collect(list(ctx));
}

function interceptUser(login = "octocat"): void {
  http
    .pool(API)
    .intercept({ path: (path) => path === "/user", method: "GET" })
    .reply(200, { login }, { headers: JSON_HEADERS });
}

beforeEach(() => {
  http = mockHttp();
});

afterEach(async () => {
  await http.close();
});

describe("githubProvider.listRepos", () => {
  it("follows the Link header across pages and maps every field", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(
        200,
        [
          repo("octocat/one"),
          repo("octocat/two", { default_branch: "trunk", description: "second" }),
        ],
        {
          headers: {
            ...JSON_HEADERS,
            link: `<${API}/user/583231/repos?per_page=100&page=2>; rel="next", <${API}/user/583231/repos?per_page=100&page=9>; rel="last"`,
          },
        },
      );
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/user/583231/repos"), method: "GET" })
      .reply(200, [repo("octocat/three", { archived: true })], { headers: JSON_HEADERS });

    const repos = await collect(githubProvider.listRepos(ghContext()));

    expect(repos.map((item) => item.path)).toEqual(["octocat/one", "octocat/two", "octocat/three"]);
    expect(repos[1]).toEqual({
      path: "octocat/two",
      defaultBranch: "trunk",
      isPrivate: false,
      archived: false,
      description: "second",
    });
    expect(repos[2]?.archived).toBe(true);
    http.agent.assertNoPendingInterceptors();
  });

  it("uses the authenticated listing when the token belongs to the account", async () => {
    interceptUser("octocat");
    let seenPath = "";
    http
      .pool(API)
      .intercept({
        path: (path) => {
          if (!path.startsWith("/user/repos")) {
            return false;
          }
          seenPath = path;
          return true;
        },
        method: "GET",
      })
      .reply(200, [repo("octocat/private-one", { private: true })], { headers: JSON_HEADERS });

    const repos = await collect(
      githubProvider.listRepos(ghContext({ token: "ghp_x", visibility: "private" })),
    );

    expect(seenPath).toContain("affiliation=owner");
    expect(seenPath).toContain("visibility=private");
    expect(seenPath).toContain("per_page=100");
    // type= alongside visibility or affiliation is a documented 422.
    expect(seenPath).not.toContain("type=");
    expect(repos.map((item) => item.path)).toEqual(["octocat/private-one"]);
    expect(repos[0]?.isPrivate).toBe(true);
  });

  it("falls back to the public listing when the token belongs to someone else", async () => {
    interceptUser("someone-else");
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(200, [repo("octocat/one")], { headers: JSON_HEADERS });

    const repos = await collect(githubProvider.listRepos(ghContext({ token: "ghp_x" })));
    expect(repos.map((item) => item.path)).toEqual(["octocat/one"]);
    http.agent.assertNoPendingInterceptors();
  });

  it("refuses a private listing without a credential for that account, before any request", async () => {
    await expect(
      collect(githubProvider.listRepos(ghContext({ visibility: "private" }))),
    ).rejects.toMatchObject({
      name: "ProviderError",
      kind: "auth",
      message: expect.stringContaining("needs a stored credential"),
    });
  });

  it("filters visibility client side as well as in the query", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(
        200,
        [
          repo("octocat/public-one"),
          repo("octocat/secret", { private: true }),
          repo("octocat/internal-one", { visibility: "internal" }),
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(githubProvider.listRepos(ghContext({ visibility: "public" })));
    expect(repos.map((item) => item.path)).toEqual(["octocat/public-one"]);
  });

  it("treats a missing default_branch on the minimal repository schema as null", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(200, [{ full_name: "octocat/empty", private: false }], { headers: JSON_HEADERS });

    const repos = await collect(githubProvider.listRepos(ghContext()));
    expect(repos[0]).toEqual({
      path: "octocat/empty",
      defaultBranch: null,
      isPrivate: false,
      archived: false,
      description: null,
    });
  });

  it("surfaces a 429 with its Retry-After", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(
        429,
        { message: "rate limited" },
        { headers: { ...JSON_HEADERS, "retry-after": "60" } },
      );

    const failure = await collect(githubProvider.listRepos(ghContext())).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 60_000 });
  });

  it("reads a 403 with an exhausted quota as a rate limit, not a permission problem", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(
        403,
        { message: "API rate limit exceeded" },
        {
          headers: {
            ...JSON_HEADERS,
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
          },
        },
      );

    const failure = (await collect(githubProvider.listRepos(ghContext())).catch(
      (error: unknown) => error,
    )) as ProviderError;
    expect(failure.kind).toBe("rate_limited");
    expect(failure.retryAfterMs ?? 0).toBeGreaterThan(60_000);
  });

  it("maps 401 to auth and 404 to not found", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path === "/user", method: "GET" })
      .reply(401, { message: "Bad credentials" }, { headers: JSON_HEADERS });

    await expect(
      collect(githubProvider.listRepos(ghContext({ token: "bad" }))),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });

    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/ghost/repos"), method: "GET" })
      .reply(404, { message: "Not Found" }, { headers: JSON_HEADERS });

    await expect(
      collect(githubProvider.listRepos(ghContext({ username: "ghost" }))),
    ).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("user ghost") });
  });

  it("rejects a malformed listing", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(200, { message: "not a list" }, { headers: JSON_HEADERS });

    await expect(collect(githubProvider.listRepos(ghContext()))).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("rejects a repository without a full_name", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(200, [{ private: false }], { headers: JSON_HEADERS });

    await expect(collect(githubProvider.listRepos(ghContext()))).rejects.toMatchObject({
      kind: "invalid_response",
      message: expect.stringContaining("full_name"),
    });
  });

  it("refuses a pagination link that points at another origin", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(200, [repo("octocat/one")], {
        headers: {
          ...JSON_HEADERS,
          link: '<https://evil.example.com/user/repos?page=2>; rel="next"',
        },
      });

    await expect(collect(githubProvider.listRepos(ghContext()))).rejects.toMatchObject({
      kind: "invalid_response",
      message: expect.stringContaining("different origin"),
    });
  });

  it("targets the /api/v3 base on GitHub Enterprise Server", async () => {
    const enterprise = "https://git.corp.example";
    http
      .pool(enterprise)
      .intercept({ path: (path) => path.startsWith("/api/v3/users/octocat/repos"), method: "GET" })
      .reply(200, [repo("octocat/one")], { headers: JSON_HEADERS });

    const repos = await collect(githubProvider.listRepos(ghContext({ baseUrl: enterprise })));
    expect(repos).toHaveLength(1);
    http.agent.assertNoPendingInterceptors();
  });
});

describe("githubProvider.listStarred", () => {
  it("paginates the authenticated stars and keeps each repository's own owner", async () => {
    interceptUser("octocat");
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/user/starred"), method: "GET" })
      .reply(200, [repo("nodejs/node"), repo("sindresorhus/ky", { private: true })], {
        headers: {
          ...JSON_HEADERS,
          link: `<${API}/user/starred?per_page=100&page=2>; rel="next"`,
        },
      });
    http
      .pool(API)
      .intercept({
        path: (path) => path.startsWith("/user/starred") && path.includes("page=2"),
        method: "GET",
      })
      .reply(200, [repo("vuejs/core")], { headers: JSON_HEADERS });

    const starred = await starredOf(ghContext({ token: "ghp_x" }));

    expect(starred.map((item) => item.path)).toEqual([
      "nodejs/node",
      "sindresorhus/ky",
      "vuejs/core",
    ]);
    http.agent.assertNoPendingInterceptors();
  });

  it("uses the public stars listing when there is no token", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/starred"), method: "GET" })
      .reply(200, [repo("nodejs/node")], { headers: JSON_HEADERS });

    const starred = await starredOf(ghContext());
    expect(starred.map((item) => item.path)).toEqual(["nodejs/node"]);
    http.agent.assertNoPendingInterceptors();
  });
});

describe("githubProvider.checkRepoAccess", () => {
  it("confirms a repository that answers 200", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/nodejs/node", method: "GET" })
      .reply(200, { full_name: "nodejs/node" }, { headers: JSON_HEADERS });

    await expect(githubProvider.checkRepoAccess?.(ghContext(), "nodejs/node")).resolves.toBe(
      "accessible",
    );
  });

  it("reports 404 as missing, because GitHub hides private repositories that way", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/gone/repo", method: "GET" })
      .reply(404, { message: "Not Found" }, { headers: JSON_HEADERS });

    await expect(githubProvider.checkRepoAccess?.(ghContext(), "gone/repo")).resolves.toBe(
      "missing",
    );
  });

  it("reports anything ambiguous as unknown", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/flaky/repo", method: "GET" })
      .reply(503, { message: "unavailable" }, { headers: JSON_HEADERS });
    await expect(githubProvider.checkRepoAccess?.(ghContext(), "flaky/repo")).resolves.toBe(
      "unknown",
    );

    http
      .pool(API)
      .intercept({ path: "/repos/offline/repo", method: "GET" })
      .replyWithError(new Error("socket hang up"));
    await expect(githubProvider.checkRepoAccess?.(ghContext(), "offline/repo")).resolves.toBe(
      "unknown",
    );

    await expect(githubProvider.checkRepoAccess?.(ghContext(), "nonsense")).resolves.toBe(
      "unknown",
    );
  });
});
