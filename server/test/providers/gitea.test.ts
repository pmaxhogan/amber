import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { giteaProvider } from "../../src/providers/gitea.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

const ORIGIN = "https://gitea.example.com:3000";

let http: MockHttp;

function repo(fullName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: fullName,
    private: false,
    default_branch: "main",
    archived: false,
    description: "",
    empty: false,
    ...extra,
  };
}

function giteaContext(overrides: Parameters<typeof context>[0] = {}) {
  return context({ baseUrl: ORIGIN, username: "maintainer", fetch: http.fetch, ...overrides });
}

beforeEach(() => {
  http = mockHttp();
});

afterEach(async () => {
  await http.close();
});

describe("giteaProvider.listRepos", () => {
  it("follows the Link header, which Gitea sends without a space after the comma", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/users/maintainer/repos"),
        method: "GET",
      })
      .reply(200, [repo("maintainer/one"), repo("maintainer/two")], {
        headers: {
          ...JSON_HEADERS,
          "x-total-count": "3",
          link: `<${ORIGIN}/api/v1/users/maintainer/repos?limit=50&page=2>; rel="next",<${ORIGIN}/api/v1/users/maintainer/repos?limit=50&page=2>; rel="last"`,
        },
      });
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path.includes("page=2"), method: "GET" })
      .reply(200, [repo("maintainer/three")], {
        headers: { ...JSON_HEADERS, "x-total-count": "3" },
      });

    const repos = await collect(giteaProvider.listRepos(giteaContext()));
    expect(repos.map((item) => item.path)).toEqual([
      "maintainer/one",
      "maintainer/two",
      "maintainer/three",
    ]);
    http.agent.assertNoPendingInterceptors();
  });

  it("falls back to X-Total-Count paging when an old instance omits the Link header", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) =>
          path.startsWith("/api/v1/users/maintainer/repos") && path.includes("page=1"),
        method: "GET",
      })
      .reply(200, [repo("maintainer/one")], { headers: { ...JSON_HEADERS, "x-total-count": "2" } });
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path.includes("page=2"), method: "GET" })
      .reply(200, [repo("maintainer/two")], { headers: { ...JSON_HEADERS, "x-total-count": "2" } });

    const repos = await collect(giteaProvider.listRepos(giteaContext()));
    expect(repos.map((item) => item.path)).toEqual(["maintainer/one", "maintainer/two"]);
    http.agent.assertNoPendingInterceptors();
  });

  it("uses the owner listing and the token scheme when the token is the account's own", async () => {
    let auth: string | undefined;
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path === "/api/v1/user", method: "GET" })
      .reply(200, { login: "maintainer" }, { headers: JSON_HEADERS });
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/user/repos"),
        method: "GET",
        headers: (headers: Record<string, string>) => {
          auth = headers.authorization;
          return true;
        },
      })
      .reply(200, [repo("maintainer/secret", { private: true })], { headers: JSON_HEADERS });

    const repos = await collect(giteaProvider.listRepos(giteaContext({ token: "gta_x" })));

    expect(auth).toBe("token gta_x");
    expect(repos.map((item) => item.path)).toEqual(["maintainer/secret"]);
    expect(repos[0]?.isPrivate).toBe(true);
  });

  it("filters visibility client side, since Gitea has no visibility parameter", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/users/maintainer/repos"),
        method: "GET",
      })
      .reply(
        200,
        [
          repo("maintainer/open"),
          repo("maintainer/closed", { private: true }),
          repo("maintainer/inner", { internal: true }),
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(giteaProvider.listRepos(giteaContext({ visibility: "public" })));
    expect(repos.map((item) => item.path)).toEqual(["maintainer/open"]);
  });

  it("reports an empty repository as having no default branch and no description", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/users/maintainer/repos"),
        method: "GET",
      })
      .reply(200, [repo("maintainer/blank", { empty: true })], { headers: JSON_HEADERS });

    const repos = await collect(giteaProvider.listRepos(giteaContext()));
    expect(repos[0]).toEqual({
      path: "maintainer/blank",
      defaultBranch: null,
      isPrivate: false,
      archived: false,
      description: null,
    });
  });

  it("refuses a private listing without a credential", async () => {
    await expect(
      collect(giteaProvider.listRepos(giteaContext({ visibility: "private" }))),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("surfaces a proxy 429 with its Retry-After", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/users/maintainer/repos"),
        method: "GET",
      })
      .reply(429, "too many requests", { headers: { "retry-after": "12" } });

    await expect(collect(giteaProvider.listRepos(giteaContext()))).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 12_000,
    });
  });

  it("rejects a malformed listing and a repository without a full_name", async () => {
    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/users/maintainer/repos"),
        method: "GET",
      })
      .reply(200, { ok: true }, { headers: JSON_HEADERS });
    await expect(collect(giteaProvider.listRepos(giteaContext()))).rejects.toMatchObject({
      kind: "invalid_response",
    });

    http
      .pool(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/api/v1/users/maintainer/repos"),
        method: "GET",
      })
      .reply(200, [{ private: true }], { headers: JSON_HEADERS });
    await expect(collect(giteaProvider.listRepos(giteaContext()))).rejects.toMatchObject({
      message: expect.stringContaining("full_name"),
    });
  });

  it("maps 404 for an unknown user", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path.startsWith("/api/v1/users/ghost/repos"), method: "GET" })
      .reply(404, { message: "user does not exist" }, { headers: JSON_HEADERS });

    await expect(
      collect(giteaProvider.listRepos(giteaContext({ username: "ghost" }))),
    ).rejects.toMatchObject({
      kind: "not_found",
      message: expect.stringContaining("user ghost"),
    });
  });
});
