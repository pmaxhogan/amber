import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expectArray,
  getJson,
  matchesVisibility,
  normalizeRepoPath,
  pagesByLink,
  parseLinkHeader,
  ProviderError,
  retryAfterMsFromHeaders,
} from "../../src/providers/http.ts";
import { collect, context, JSON_HEADERS, mockHttp, type MockHttp } from "./support.ts";

const ORIGIN = "https://forge.example.com";

let http: MockHttp;

beforeEach(() => {
  http = mockHttp();
});

afterEach(async () => {
  await http.close();
});

describe("parseLinkHeader", () => {
  it("reads the GitHub form", () => {
    const links = parseLinkHeader(
      '<https://api.github.com/repositories/1/issues?page=2>; rel="prev", <https://api.github.com/repositories/1/issues?page=4>; rel="next"',
    );
    expect(links.next).toBe("https://api.github.com/repositories/1/issues?page=4");
    expect(links.prev).toBe("https://api.github.com/repositories/1/issues?page=2");
  });

  it("reads the Gitea form, which has no space after the comma", () => {
    const links = parseLinkHeader(
      '<https://gitea.com/api/v1/users/gitea/repos?limit=1&page=2>; rel="next",<https://gitea.com/api/v1/users/gitea/repos?limit=1&page=54>; rel="last"',
    );
    expect(links.next).toBe("https://gitea.com/api/v1/users/gitea/repos?limit=1&page=2");
    expect(links.last).toContain("page=54");
  });

  it("survives an empty, absent or malformed header", () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader("")).toEqual({});
    expect(parseLinkHeader("garbage")).toEqual({});
    expect(parseLinkHeader("<https://x/y>")).toEqual({});
  });
});

describe("retryAfterMsFromHeaders", () => {
  const at = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("reads delta seconds", () => {
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "30" }), at)).toBe(30_000);
  });

  it("reads an HTTP date", () => {
    const later = new Date(at + 45_000).toUTCString();
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": later }), at)).toBe(45_000);
  });

  it("falls back to the GitHub and GitLab reset epochs", () => {
    expect(
      retryAfterMsFromHeaders(new Headers({ "x-ratelimit-reset": String(at / 1000 + 60) }), at),
    ).toBe(60_000);
    expect(
      retryAfterMsFromHeaders(new Headers({ "ratelimit-reset": String(at / 1000 + 90) }), at),
    ).toBe(90_000);
  });

  it("never returns a negative wait, and gives up when there is nothing to read", () => {
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "-5" }), at)).toBe(0);
    expect(retryAfterMsFromHeaders(new Headers(), at)).toBeNull();
  });
});

describe("normalizeRepoPath and matchesVisibility", () => {
  it("strips the decorations repos.path never carries", () => {
    expect(normalizeRepoPath("/nodejs/node.git")).toBe("nodejs/node");
    expect(normalizeRepoPath("group/sub/project/")).toBe("group/sub/project");
    expect(normalizeRepoPath("  owner/name  ")).toBe("owner/name");
  });

  it("filters by visibility uniformly", () => {
    expect(matchesVisibility(false, "public")).toBe(true);
    expect(matchesVisibility(true, "public")).toBe(false);
    expect(matchesVisibility(true, "private")).toBe(true);
    expect(matchesVisibility(false, "private")).toBe(false);
    expect(matchesVisibility(true, "all")).toBe(true);
    expect(matchesVisibility(false, "all")).toBe(true);
  });
});

describe("expectArray", () => {
  it("passes lists through and rejects anything else", () => {
    expect(expectArray<number>([1, 2], "x")).toEqual([1, 2]);
    expect(() => expectArray({}, "the listing")).toThrow(ProviderError);
  });
});

describe("getJson", () => {
  it("follows a same origin redirect", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: "/a", method: "GET" })
      .reply(302, "", { headers: { location: `${ORIGIN}/b` } });
    http
      .pool(ORIGIN)
      .intercept({ path: "/b", method: "GET" })
      .reply(200, { ok: true }, { headers: JSON_HEADERS });

    const response = await getJson<{ ok: boolean }>(
      context({ fetch: http.fetch }),
      `${ORIGIN}/a`,
      {},
    );
    expect(response.data.ok).toBe(true);
  });

  it("refuses a redirect that leaves the origin, so a credential cannot follow it", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: "/a", method: "GET" })
      .reply(302, "", { headers: { location: "https://evil.example.com/a" } });

    await expect(getJson(context({ fetch: http.fetch }), `${ORIGIN}/a`, {})).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("reports a redirect without a location", async () => {
    http.pool(ORIGIN).intercept({ path: "/a", method: "GET" }).reply(302, "");
    await expect(getJson(context({ fetch: http.fetch }), `${ORIGIN}/a`, {})).rejects.toMatchObject({
      kind: "invalid_response",
      status: 302,
    });
  });

  it("classifies a network failure", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: "/a", method: "GET" })
      .replyWithError(new Error("ECONNREFUSED"));

    await expect(getJson(context({ fetch: http.fetch }), `${ORIGIN}/a`, {})).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining(ORIGIN),
    });
  });

  it("classifies a timeout", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: "/slow", method: "GET" })
      .reply(200, { ok: true }, { headers: JSON_HEADERS })
      .delay(200);

    await expect(
      getJson(context({ fetch: http.fetch }), `${ORIGIN}/slow`, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("classifies a non-JSON body", async () => {
    http.pool(ORIGIN).intercept({ path: "/a", method: "GET" }).reply(200, "<html>nope</html>");
    await expect(getJson(context({ fetch: http.fetch }), `${ORIGIN}/a`, {})).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("reads a plain 403 as an auth failure", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: "/a", method: "GET" })
      .reply(403, { message: "Forbidden" }, { headers: JSON_HEADERS });
    await expect(getJson(context({ fetch: http.fetch }), `${ORIGIN}/a`, {})).rejects.toMatchObject({
      kind: "auth",
      status: 403,
    });
  });

  it("reads a 500 as a server failure", async () => {
    http.pool(ORIGIN).intercept({ path: "/a", method: "GET" }).reply(500, "boom");
    await expect(getJson(context({ fetch: http.fetch }), `${ORIGIN}/a`, {})).rejects.toMatchObject({
      kind: "server",
      status: 500,
    });
  });
});

describe("pagesByLink", () => {
  it("stops when the next link is gone, not when a page looks short", async () => {
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path.startsWith("/list"), method: "GET" })
      .reply(200, [1], {
        headers: { ...JSON_HEADERS, link: `<${ORIGIN}/list?page=2>; rel="next"` },
      });
    http
      .pool(ORIGIN)
      .intercept({ path: (path) => path.includes("page=2"), method: "GET" })
      .reply(200, [2, 3], { headers: JSON_HEADERS });

    const pages = await collect(
      pagesByLink<number>(context({ fetch: http.fetch }), `${ORIGIN}/list?per_page=100`),
    );
    expect(pages).toEqual([[1], [2, 3]]);
    http.agent.assertNoPendingInterceptors();
  });
});
