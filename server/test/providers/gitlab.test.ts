import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitlabProvider } from "../../src/providers/gitlab.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

const ORIGIN = "https://gitlab.com";

let http: MockHttp;

function project(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path_with_namespace: path,
    default_branch: "main",
    visibility: "public",
    archived: false,
    description: null,
    ...extra,
  };
}

function glContext(overrides: Parameters<typeof context>[0] = {}) {
  return context({ baseUrl: ORIGIN, username: "tanuki", fetch: http.fetch, ...overrides });
}

beforeEach(() => {
  http = mockHttp();
});

afterEach(async () => {
  await http.close();
});

describe("gitlabProvider.listRepos", () => {
  it("uses keyset pagination and follows the Link header to the end", async () => {
    let firstPath = "";
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => {
          if (!path.startsWith("/api/v4/users/tanuki/projects")) {
            return false;
          }
          firstPath = path;
          return true;
        },
        method: "GET",
      })
      .reply(200, [project("tanuki/one"), project("tanuki/two")], {
        headers: {
          ...JSON_HEADERS,
          link: `<${ORIGIN}/api/v4/users/tanuki/projects?pagination=keyset&per_page=100&order_by=id&sort=asc&id_after=42>; rel="next"`,
        },
      });
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.includes("id_after=42"),
        method: "GET",
      })
      .reply(200, [project("tanuki/three")], { headers: JSON_HEADERS });

    const repos = await collect(gitlabProvider.listRepos(glContext()));

    expect(firstPath).toContain("pagination=keyset");
    expect(firstPath).toContain("order_by=id");
    expect(firstPath).toContain("sort=asc");
    expect(firstPath).toContain("per_page=100");
    expect(repos.map((item) => item.path)).toEqual(["tanuki/one", "tanuki/two", "tanuki/three"]);
    http.agent.assertNoPendingInterceptors();
  });

  it("switches to the membership listing when the token is the account's own", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path === "/api/v4/user", method: "GET" })
      .reply(200, { username: "tanuki" }, { headers: JSON_HEADERS });
    let listPath = "";
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => {
          if (!path.startsWith("/api/v4/projects")) {
            return false;
          }
          listPath = path;
          return true;
        },
        method: "GET",
      })
      .reply(200, [project("tanuki/secret", { visibility: "private" })], { headers: JSON_HEADERS });

    const repos = await collect(
      gitlabProvider.listRepos(glContext({ token: "glpat-x", visibility: "private" })),
    );

    expect(listPath).toContain("membership=true");
    expect(listPath).toContain("visibility=private");
    expect(repos.map((item) => item.path)).toEqual(["tanuki/secret"]);
    expect(repos[0]?.isPrivate).toBe(true);
  });

  it("sends the token in the PRIVATE-TOKEN header", async () => {
    let auth: string | undefined;
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path === "/api/v4/user",
        method: "GET",
      })
      .reply(200, { username: "someone-else" }, { headers: JSON_HEADERS });
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
        headers: (headers: Record<string, string>) => {
          auth = headers["private-token"];
          return true;
        },
      })
      .reply(200, [], { headers: JSON_HEADERS });

    await collect(gitlabProvider.listRepos(glContext({ token: "glpat-secret" })));
    expect(auth).toBe("glpat-secret");
  });

  it("treats internal projects as private and filters client side", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
      })
      .reply(
        200,
        [
          project("tanuki/open"),
          project("tanuki/inner", { visibility: "internal" }),
          project("tanuki/closed", { visibility: "private" }),
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(gitlabProvider.listRepos(glContext({ visibility: "public" })));
    expect(repos.map((item) => item.path)).toEqual(["tanuki/open"]);
  });

  it("reports an empty project as having no default branch", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
      })
      .reply(200, [project("tanuki/empty", { empty_repo: true, default_branch: "main" })], {
        headers: JSON_HEADERS,
      });

    const repos = await collect(gitlabProvider.listRepos(glContext()));
    expect(repos[0]?.defaultBranch).toBeNull();
  });

  it("refuses a private listing without a credential", async () => {
    await expect(
      collect(gitlabProvider.listRepos(glContext({ visibility: "private" }))),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("surfaces a 429 even when GitLab omits the informational headers", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
      })
      .reply(429, { message: "Too many requests" }, { headers: JSON_HEADERS });

    await expect(collect(gitlabProvider.listRepos(glContext()))).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: null,
    });
  });

  it("surfaces a 429 with RateLimit-Reset as a wait", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
      })
      .reply(
        429,
        { message: "Too many requests" },
        {
          headers: {
            ...JSON_HEADERS,
            "ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30),
          },
        },
      );

    const failure = (await collect(gitlabProvider.listRepos(glContext())).catch(
      (error: unknown) => error,
    )) as { retryAfterMs: number | null };
    expect(failure.retryAfterMs ?? 0).toBeGreaterThan(20_000);
  });

  it("rejects a malformed listing", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
      })
      .reply(200, { values: [] }, { headers: JSON_HEADERS });

    await expect(collect(gitlabProvider.listRepos(glContext()))).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("works against a self-hosted instance on a custom port", async () => {
    const selfHosted = "https://git.example.com:8443";
    http
      .pool(selfHosted)
      .intercept({
        path: (path) => path.startsWith("/api/v4/users/tanuki/projects"),
        method: "GET",
      })
      .reply(200, [project("tanuki/one")], { headers: JSON_HEADERS });

    const repos = await collect(gitlabProvider.listRepos(glContext({ baseUrl: selfHosted })));
    expect(repos).toHaveLength(1);
    http.agent.assertNoPendingInterceptors();
  });
});
