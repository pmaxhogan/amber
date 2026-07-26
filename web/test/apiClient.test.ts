import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  INVALID_RESPONSE_PROBLEM,
  NETWORK_PROBLEM,
  buildQuery,
  createApiClient,
  normalizeError,
  parseEventData,
} from "../src/api/client.ts";
import { makeStatus } from "./helpers/stubApi.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return createApiClient({ fetchImpl });
}

describe("buildQuery", () => {
  it("drops null, undefined, and empty values", () => {
    expect(buildQuery({ page: 1, q: "", forgeId: null, state: undefined })).toBe("?page=1");
  });

  it("returns an empty string when nothing survives", () => {
    expect(buildQuery({ q: "", forgeId: null })).toBe("");
  });

  it("stringifies booleans and numbers", () => {
    expect(buildQuery({ files: true, perPage: 200 })).toBe("?files=true&perPage=200");
  });
});

describe("error normalization", () => {
  it("keeps the server problem code and message from a conforming error body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "forge_immutable",
          message: "Host cannot be changed",
          details: { field: "host" },
        },
        400,
      ),
    );
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    const error = await api.listForges().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);
    const typed = error as ApiClientError;
    expect(typed.problem).toBe("forge_immutable");
    expect(typed.message).toBe("Host cannot be changed");
    expect(typed.status).toBe(400);
    expect(typed.details).toEqual({ field: "host" });
  });

  it("falls back to a status-derived problem when the body is not an api error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>gateway</html>", { status: 502 }));
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    const error = (await api.status().catch((cause: unknown) => cause)) as ApiClientError;

    expect(error.problem).toBe("http_502");
    expect(error.message).toBe("The server is unreachable.");
    expect(error.retryable).toBe(true);
  });

  it("normalizes a transport failure into a retryable network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    const error = (await api.status().catch((cause: unknown) => cause)) as ApiClientError;

    expect(error.problem).toBe(NETWORK_PROBLEM);
    expect(error.message).toContain("Could not reach the server");
    expect(error.retryable).toBe(true);
  });

  it("reports a response that does not match its schema as an invalid response", async () => {
    // A 200 with the wrong shape is a contract break, not a transport problem,
    // and must not be mistaken for one.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: 7 }));
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    const error = (await api.status().catch((cause: unknown) => cause)) as ApiClientError;

    expect(error.problem).toBe(INVALID_RESPONSE_PROBLEM);
    expect(error.retryable).toBe(false);
  });

  it("treats an abort as its own problem rather than a network failure", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(normalizeError(aborted).problem).toBe("aborted");
  });

  it("passes an ApiClientError through untouched", () => {
    const original = new ApiClientError("custom", "already normalized", 418);
    expect(normalizeError(original)).toBe(original);
  });

  it("marks 4xx other than 429 as not retryable", () => {
    expect(new ApiClientError("http_404", "gone", 404).retryable).toBe(false);
    expect(new ApiClientError("http_429", "slow down", 429).retryable).toBe(true);
  });
});

describe("requests", () => {
  it("parses a valid response against its schema", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(makeStatus({ totalRepos: 12 })));
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    const status = await api.status();

    expect(status.totalRepos).toBe(12);
  });

  it("sends credentials so the access cookie rides along", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(makeStatus()));
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    await api.status();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  it("serializes a JSON body and sets the content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        action: "pause",
        requested: 3,
        affected: 3,
        ids: [1, 2, 3],
        missing: [],
      }),
    );
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    await api.bulkRepos([1, 2, 3], "pause");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/repos/bulk");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      ids: [1, 2, 3],
      action: "pause",
      files: false,
    });
  });

  it("builds the settings path without an id at global scope", async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ scopeType: "global", scopeId: null, values: { clone_mode: "mirror" } }),
    );
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    await api.getSettings({ scopeType: "global", scopeId: null });
    await api.getSettings({ scopeType: "forge", scopeId: 4 });

    const calls = fetchImpl.mock.calls as unknown as string[][];
    expect(calls[0]?.[0]).toBe("/api/settings/global");
    expect(calls[1]?.[0]).toBe("/api/settings/forge/4");
  });

  it("does not require a body for endpoints that return nothing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = clientWith(fetchImpl as unknown as typeof fetch);

    await expect(api.syncRepo(9)).resolves.toBeUndefined();
  });
});

describe("parseEventData", () => {
  it("parses a well-formed event frame", () => {
    const event = parseEventData(
      JSON.stringify({ type: "sync.started", at: 1700000000000, payload: { repoId: 3 } }),
    );
    expect(event?.type).toBe("sync.started");
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(parseEventData("{not json")).toBeNull();
  });

  it("returns null for an unknown event type", () => {
    expect(parseEventData(JSON.stringify({ type: "nope", at: 1, payload: {} }))).toBeNull();
  });
});
