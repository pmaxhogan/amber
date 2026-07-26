import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bitbucketProvider } from "../../src/providers/bitbucket.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

const API = "https://api.bitbucket.org";

let http: MockHttp;

function repo(fullName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: fullName,
    is_private: false,
    mainbranch: { type: "branch", name: "master" },
    description: "",
    ...extra,
  };
}

function bbContext(overrides: Parameters<typeof context>[0] = {}) {
  return context({
    baseUrl: "https://bitbucket.org",
    username: "acme",
    fetch: http.fetch,
    ...overrides,
  });
}

beforeEach(() => {
  http = mockHttp();
});

afterEach(async () => {
  await http.close();
});

describe("bitbucketProvider.listRepos", () => {
  it("follows the opaque next link until it stops coming", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(
        200,
        {
          values: [repo("acme/one"), repo("acme/two", { mainbranch: { name: "develop" } })],
          next: `${API}/2.0/repositories/acme?pagelen=100&page=2&ctx=opaque`,
        },
        { headers: JSON_HEADERS },
      );
    http
      .pool(API)
      .intercept({ path: (path) => path.includes("ctx=opaque"), method: "GET" })
      .reply(200, { values: [repo("acme/three")] }, { headers: JSON_HEADERS });

    const repos = await collect(bitbucketProvider.listRepos(bbContext()));

    expect(repos.map((item) => item.path)).toEqual(["acme/one", "acme/two", "acme/three"]);
    expect(repos[1]?.defaultBranch).toBe("develop");
    http.agent.assertNoPendingInterceptors();
  });

  it("authenticates with Basic auth built from the account username and the API token", async () => {
    let auth: string | undefined;
    http
      .pool(API)
      .intercept({
        path: (path) => path.startsWith("/2.0/repositories/acme"),
        method: "GET",
        headers: (headers: Record<string, string>) => {
          auth = headers.authorization;
          return true;
        },
      })
      .reply(200, { values: [repo("acme/one", { is_private: true })] }, { headers: JSON_HEADERS });

    const repos = await collect(bitbucketProvider.listRepos(bbContext({ token: "api-token" })));

    expect(auth).toBe(`Basic ${Buffer.from("acme:api-token", "utf8").toString("base64")}`);
    expect(repos[0]?.isPrivate).toBe(true);
  });

  it("fans out over the accessible workspaces when the username is an Atlassian email", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/user/workspaces"), method: "GET" })
      .reply(
        200,
        {
          values: [{ workspace: { slug: "acme" } }, { workspace: { slug: "side-project" } }],
        },
        { headers: JSON_HEADERS },
      );
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(200, { values: [repo("acme/one")] }, { headers: JSON_HEADERS });
    http
      .pool(API)
      .intercept({
        path: (path) => path.startsWith("/2.0/repositories/side-project"),
        method: "GET",
      })
      .reply(200, { values: [repo("side-project/two")] }, { headers: JSON_HEADERS });

    const repos = await collect(
      bitbucketProvider.listRepos(bbContext({ username: "max@example.com", token: "api-token" })),
    );

    expect(repos.map((item) => item.path)).toEqual(["acme/one", "side-project/two"]);
    http.agent.assertNoPendingInterceptors();
  });

  it("explains that an email username cannot be listed anonymously", async () => {
    await expect(
      collect(bitbucketProvider.listRepos(bbContext({ username: "max@example.com" }))),
    ).rejects.toMatchObject({
      kind: "auth",
      message: expect.stringContaining("workspace slug"),
    });
  });

  it("filters visibility client side", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(
        200,
        { values: [repo("acme/open"), repo("acme/closed", { is_private: true })] },
        { headers: JSON_HEADERS },
      );

    const repos = await collect(bitbucketProvider.listRepos(bbContext({ visibility: "public" })));
    expect(repos.map((item) => item.path)).toEqual(["acme/open"]);
  });

  it("reports an empty repository, which has no mainbranch, as having no default branch", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(
        200,
        { values: [repo("acme/blank", { mainbranch: null })] },
        { headers: JSON_HEADERS },
      );

    const repos = await collect(bitbucketProvider.listRepos(bbContext()));
    expect(repos[0]?.defaultBranch).toBeNull();
  });

  it("refuses a private listing without a credential", async () => {
    await expect(
      collect(bitbucketProvider.listRepos(bbContext({ visibility: "private" }))),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("surfaces a 429 with its Retry-After", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(
        429,
        { error: { message: "slow down" } },
        {
          headers: { ...JSON_HEADERS, "retry-after": "45" },
        },
      );

    await expect(collect(bitbucketProvider.listRepos(bbContext()))).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 45_000,
    });
  });

  it("surfaces the 410 the removed cross-workspace listing would answer with", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(
        410,
        { error: { message: "CHANGE-2770 - Functionality has been deprecated" } },
        {
          headers: JSON_HEADERS,
        },
      );

    await expect(collect(bitbucketProvider.listRepos(bbContext()))).rejects.toMatchObject({
      kind: "other",
      status: 410,
    });
  });

  it("rejects a malformed page", async () => {
    http
      .pool(API)
      .intercept({ path: (path) => path.startsWith("/2.0/repositories/acme"), method: "GET" })
      .reply(200, { values: "nope" }, { headers: JSON_HEADERS });

    await expect(collect(bitbucketProvider.listRepos(bbContext()))).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("refuses Bitbucket Data Center, which speaks a different API", async () => {
    await expect(
      collect(
        bitbucketProvider.listRepos(bbContext({ baseUrl: "https://bitbucket.corp.example" })),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Bitbucket Cloud"),
    });
  });
});
