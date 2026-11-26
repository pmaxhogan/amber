import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bitbucketProvider } from "../../src/providers/bitbucket.ts";
import { giteaProvider } from "../../src/providers/gitea.ts";
import { githubProvider } from "../../src/providers/github.ts";
import { gitlabProvider } from "../../src/providers/gitlab.ts";
import type { AccountSyncProvider, ForkLookup } from "../../src/providers/types.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

let http: MockHttp;

beforeEach(() => {
  http = mockHttp();
});

afterEach(async () => {
  await http.close();
});

function lookup(provider: AccountSyncProvider, ctx: ReturnType<typeof context>, path: string) {
  if (provider.getForkParent === undefined) {
    throw new Error(`${provider.kind} must implement getForkParent`);
  }
  return provider.getForkParent(ctx, path);
}

describe("github fork knowledge", () => {
  const API = "https://api.github.com";
  const ctx = (): ReturnType<typeof context> => context({ fetch: http.fetch });

  it("maps the fork flag from a listing but never invents a parent", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/users/octocat/repos"), method: "GET" })
      .reply(
        200,
        [
          { full_name: "octocat/forked", fork: true },
          { full_name: "octocat/original", fork: false },
          { full_name: "octocat/silent" },
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(githubProvider.listRepos(ctx()));

    expect(repos.map((repo) => [repo.path, repo.isFork, repo.forkParent])).toEqual([
      ["octocat/forked", true, null],
      ["octocat/original", false, null],
      ["octocat/silent", null, null],
    ]);
  });

  it("reads the parent from the single repository endpoint, normalized", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/linux", method: "GET" })
      .reply(
        200,
        { full_name: "me/linux", fork: true, parent: { full_name: "/Torvalds/linux.git" } },
        {
          headers: JSON_HEADERS,
        },
      );

    expect(await lookup(githubProvider, ctx(), "me/linux")).toEqual({
      status: "fork",
      parent: "Torvalds/linux",
    });
  });

  it("says not_fork only when the forge says fork is false", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/own", method: "GET" })
      .reply(200, { full_name: "me/own", fork: false }, { headers: JSON_HEADERS });
    http
      .pool(API)
      .intercept({ path: "/repos/me/vague", method: "GET" })
      .reply(200, { full_name: "me/vague" }, { headers: JSON_HEADERS });

    expect(await lookup(githubProvider, ctx(), "me/own")).toEqual({ status: "not_fork" });
    expect(await lookup(githubProvider, ctx(), "me/vague")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
  });

  it("treats a fork without a visible parent as unknown, not as a fork or a non-fork", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/odd", method: "GET" })
      .reply(200, { fork: true }, { headers: JSON_HEADERS });

    expect(await lookup(githubProvider, ctx(), "me/odd")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
  });

  it.each([404, 403, 500])("answers unknown, never not_fork, for HTTP %i", async (status) => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/gone", method: "GET" })
      .reply(status, { message: "nope" }, { headers: JSON_HEADERS });

    expect(await lookup(githubProvider, ctx(), "me/gone")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
  });

  it("flags rate limiting so the resolver can back off", async () => {
    http
      .pool(API)
      .intercept({ path: "/repos/me/limited", method: "GET" })
      .reply(
        403,
        { message: "API rate limit exceeded" },
        {
          headers: { ...JSON_HEADERS, "x-ratelimit-remaining": "0" },
        },
      );
    http
      .pool(API)
      .intercept({ path: "/repos/me/limited2", method: "GET" })
      .reply(429, { message: "slow down" }, { headers: JSON_HEADERS });

    expect(await lookup(githubProvider, ctx(), "me/limited")).toEqual({
      status: "unknown",
      rateLimited: true,
    });
    expect(await lookup(githubProvider, ctx(), "me/limited2")).toEqual({
      status: "unknown",
      rateLimited: true,
    });
  });

  it("answers unknown when the network fails, and for a path that is not owner/name", async () => {
    http.agent
      .get(API)
      .intercept({ path: "/repos/me/net", method: "GET" })
      .replyWithError(new Error("boom"));

    expect(await lookup(githubProvider, ctx(), "me/net")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
    expect(await lookup(githubProvider, ctx(), "justone")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
  });

  it("sends the credential as a bearer header and encodes the path", async () => {
    let seenAuth: unknown;
    http
      .pool(API)
      .intercept({ path: "/repos/me/a%20b", method: "GET" })
      .reply(
        200,
        (opts) => {
          seenAuth = (opts.headers as Record<string, string>).authorization;
          return { fork: false };
        },
        { headers: JSON_HEADERS },
      );

    await lookup(githubProvider, context({ fetch: http.fetch, token: "tok" }), "me/a b");

    expect(seenAuth).toBe("Bearer tok");
  });
});

describe("gitlab fork knowledge", () => {
  const API = "https://gitlab.com";

  it("takes forked_from_project from a listing only when it is there, and else stays silent", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/api/v4/users/me/projects"), method: "GET" })
      .reply(
        200,
        [
          {
            path_with_namespace: "me/forked",
            forked_from_project: { path_with_namespace: "up/stream" },
          },
          { path_with_namespace: "me/plain" },
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(
      gitlabProvider.listRepos(context({ baseUrl: API, username: "me", fetch: http.fetch })),
    );

    expect(repos.map((repo) => [repo.isFork, repo.forkParent])).toEqual([
      [true, "up/stream"],
      [null, null],
    ]);
  });

  it("reads the single project, with the path encoded into the id slot", async () => {
    http
      .pool(API)
      .intercept({ path: "/api/v4/projects/grp%2Fsub%2Fproj", method: "GET" })
      .reply(
        200,
        {
          path_with_namespace: "grp/sub/proj",
          forked_from_project: { path_with_namespace: "a/b" },
        },
        { headers: JSON_HEADERS },
      );
    http
      .pool(API)
      .intercept({ path: "/api/v4/projects/me%2Fplain", method: "GET" })
      .reply(200, { path_with_namespace: "me/plain" }, { headers: JSON_HEADERS });
    http
      .pool(API)
      .intercept({ path: "/api/v4/projects/me%2Fmissing", method: "GET" })
      .reply(404, {}, { headers: JSON_HEADERS });
    http
      .pool(API)
      .intercept({ path: "/api/v4/projects/me%2Flimited", method: "GET" })
      .reply(429, {}, { headers: JSON_HEADERS });
    const ctx = context({ baseUrl: API, username: "me", fetch: http.fetch });

    expect(await lookup(gitlabProvider, ctx, "grp/sub/proj")).toEqual({
      status: "fork",
      parent: "a/b",
    });
    expect(await lookup(gitlabProvider, ctx, "me/plain")).toEqual({ status: "not_fork" });
    expect(await lookup(gitlabProvider, ctx, "me/missing")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
    expect(await lookup(gitlabProvider, ctx, "me/limited")).toEqual({
      status: "unknown",
      rateLimited: true,
    });
  });
});

describe("gitea fork knowledge", () => {
  const ORIGIN = "https://gitea.example.com";
  const ctx = (): ReturnType<typeof context> =>
    context({ baseUrl: ORIGIN, username: "me", fetch: http.fetch });

  it("maps fork and parent from a listing", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path.startsWith("/api/v1/users/me/repos"), method: "GET" })
      .reply(
        200,
        [
          { full_name: "me/forked", fork: true, parent: { full_name: "up/stream" } },
          { full_name: "me/blind", fork: true, parent: null },
          { full_name: "me/plain", fork: false },
          { full_name: "me/old" },
        ],
        { headers: JSON_HEADERS },
      );

    const repos = await collect(giteaProvider.listRepos(ctx()));

    expect(repos.map((repo) => [repo.isFork, repo.forkParent])).toEqual([
      [true, "up/stream"],
      [true, null],
      [false, null],
      [null, null],
    ]);
  });

  it("reads the single repository, and keeps failures unknown", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: "/api/v1/repos/me/forked", method: "GET" })
      .reply(200, { fork: true, parent: { full_name: "up/stream" } }, { headers: JSON_HEADERS });
    http
      .pool(ORIGIN)
      .intercept({ path: "/api/v1/repos/me/plain", method: "GET" })
      .reply(200, { fork: false }, { headers: JSON_HEADERS });
    http
      .pool(ORIGIN)
      .intercept({ path: "/api/v1/repos/me/gone", method: "GET" })
      .reply(404, {}, { headers: JSON_HEADERS });

    expect(await lookup(giteaProvider, ctx(), "me/forked")).toEqual({
      status: "fork",
      parent: "up/stream",
    });
    expect(await lookup(giteaProvider, ctx(), "me/plain")).toEqual({ status: "not_fork" });
    expect(await lookup(giteaProvider, ctx(), "me/gone")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
    expect(await lookup(giteaProvider, ctx(), "one")).toEqual({
      status: "unknown",
      rateLimited: false,
    });
  });
});

describe("bitbucket fork knowledge", () => {
  const API = "https://api.bitbucket.org";
  const ctx = (): ReturnType<typeof context> =>
    context({ baseUrl: "https://bitbucket.org", username: "ws", fetch: http.fetch });

  it("maps parent from a listing when present", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/ws"), method: "GET" })
      .reply(
        200,
        {
          values: [
            { full_name: "ws/forked", parent: { full_name: "up/stream" } },
            { full_name: "ws/plain" },
          ],
        },
        { headers: JSON_HEADERS },
      );

    const repos = await collect(bitbucketProvider.listRepos(ctx()));

    expect(repos.map((repo) => [repo.isFork, repo.forkParent])).toEqual([
      [true, "up/stream"],
      [null, null],
    ]);
  });

  it("reads the single repository", async () => {
    http
      .pool(API)
      .intercept({ path: "/2.0/repositories/ws/forked", method: "GET" })
      .reply(
        200,
        { full_name: "ws/forked", parent: { full_name: "up/stream" } },
        { headers: JSON_HEADERS },
      );
    http
      .pool(API)
      .intercept({ path: "/2.0/repositories/ws/plain", method: "GET" })
      .reply(200, { full_name: "ws/plain" }, { headers: JSON_HEADERS });
    http
      .pool(API)
      .intercept({ path: "/2.0/repositories/ws/gone", method: "GET" })
      .reply(404, {}, { headers: JSON_HEADERS });

    const answers: ForkLookup[] = [
      await lookup(bitbucketProvider, ctx(), "ws/forked"),
      await lookup(bitbucketProvider, ctx(), "ws/plain"),
      await lookup(bitbucketProvider, ctx(), "ws/gone"),
      await lookup(bitbucketProvider, ctx(), "ws/a/b"),
    ];

    expect(answers).toEqual([
      { status: "fork", parent: "up/stream" },
      { status: "not_fork" },
      { status: "unknown", rateLimited: false },
      { status: "unknown", rateLimited: false },
    ]);
  });
});
