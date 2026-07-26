import type { DiscoveryContext, ProviderFetch } from "./types.ts";

/**
 * Shared HTTP plumbing for the forge API clients: typed errors, redirect and
 * origin containment, Link header parsing, and rate limit signalling.
 *
 * Security posture (docs/ARCHITECTURE.md, "Security model"): a provider client
 * never follows a redirect to another origin, never puts a credential in a URL,
 * and never lets a server-supplied pagination link walk off the forge origin.
 */

export type ProviderErrorKind =
  | "auth"
  | "not_found"
  | "rate_limited"
  | "network"
  | "timeout"
  | "invalid_response"
  | "server"
  | "other";

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  /** Milliseconds to wait before retrying, when the forge told us. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      kind: ProviderErrorKind;
      status?: number | null;
      retryAfterMs?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Hard ceiling so a forge that keeps handing out next links cannot loop forever. */
export const MAX_PAGES = 1000;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

export function resolveFetch(context: DiscoveryContext): ProviderFetch {
  return context.fetch ?? ((url, init) => globalThis.fetch(url, init));
}

/**
 * RFC 8288 Link header, reduced to the rel -> URL map the forges actually use:
 * `<https://api.example/x?page=2>; rel="next", <...>; rel="last"`.
 */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const links: Record<string, string> = {};
  if (header === null || header === undefined || header.trim() === "") {
    return links;
  }
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (match === null) {
      continue;
    }
    const url = match[1];
    const params = match[2];
    if (url === undefined || params === undefined) {
      continue;
    }
    const rel = /rel\s*=\s*"?([^";]+)"?/.exec(params);
    const relValue = rel?.[1];
    if (relValue !== undefined) {
      links[relValue.trim()] = url.trim();
    }
  }
  return links;
}

/**
 * Retry-After is either delta-seconds or an HTTP date (RFC 9110 section 10.2.3).
 * Forges also expose a reset epoch in their own headers, which we fall back to.
 */
export function retryAfterMsFromHeaders(headers: Headers, now: number = Date.now()): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.round(seconds * 1000));
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - now);
    }
  }
  // GitHub and Gitea: x-ratelimit-reset. GitLab: ratelimit-reset. Both epoch seconds.
  for (const name of ["x-ratelimit-reset", "ratelimit-reset"]) {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") {
      continue;
    }
    const epochSeconds = Number(raw);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, epochSeconds * 1000 - now);
    }
  }
  return null;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * A pagination link must stay on the origin we started from. A forge that hands
 * out a cross-origin next link is either broken or hostile; either way we stop.
 */
export function assertSameOrigin(nextUrl: string, originUrl: string): void {
  if (!sameOrigin(nextUrl, originUrl)) {
    throw new ProviderError(
      `Refusing to follow a pagination link to a different origin than ${new URL(originUrl).origin}`,
      { kind: "invalid_response" },
    );
  }
}

export interface ProviderResponse<T> {
  data: T;
  headers: Headers;
  status: number;
  url: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Message fragment used when the forge answers 404, e.g. "user octocat". */
  notFoundHint?: string;
  /** Extra classification hook for provider-specific rate limit encodings. */
  classify?: (status: number, headers: Headers, body: string) => ProviderErrorKind | undefined;
}

function classifyStatus(status: number, headers: Headers, body: string): ProviderErrorKind {
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    // GitHub answers 403 for both "forbidden" and "rate limited"; the remaining
    // counter (or an explicit retry-after) is what separates them.
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === "0" || headers.get("retry-after") !== null) {
      return "rate_limited";
    }
    if (/rate limit/i.test(body)) {
      return "rate_limited";
    }
    return "auth";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "server";
  }
  return "other";
}

function describe(status: number, kind: ProviderErrorKind, url: string, hint?: string): string {
  const where = hint === undefined ? new URL(url).pathname : hint;
  switch (kind) {
    case "auth":
      return `Forge rejected the credentials for ${where} (HTTP ${String(status)})`;
    case "not_found":
      return `Forge has no ${where} (HTTP 404)`;
    case "rate_limited":
      return `Forge rate limited the request for ${where} (HTTP ${String(status)})`;
    case "server":
      return `Forge failed while serving ${where} (HTTP ${String(status)})`;
    default:
      return `Unexpected HTTP ${String(status)} from the forge for ${where}`;
  }
}

/**
 * One GET returning JSON. Redirects are followed only within the same origin,
 * at most MAX_REDIRECTS deep. Errors always come back as ProviderError so the
 * caller can classify without touching HTTP details.
 */
export async function getJson<T>(
  context: DiscoveryContext,
  url: string,
  options: RequestOptions = {},
): Promise<ProviderResponse<T>> {
  const doFetch = resolveFetch(context);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let currentUrl = url;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await doFetch(currentUrl, {
        method: "GET",
        headers: options.headers ?? {},
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
      throw new ProviderError(
        isTimeout
          ? `Timed out after ${String(timeoutMs)}ms requesting ${new URL(currentUrl).pathname}`
          : `Could not reach the forge at ${new URL(currentUrl).origin}`,
        { kind: isTimeout ? "timeout" : "network", cause },
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new ProviderError(`Forge sent HTTP ${String(response.status)} without a location`, {
          kind: "invalid_response",
          status: response.status,
        });
      }
      const target = new URL(location, currentUrl).toString();
      // Following a redirect off-origin would hand the credential to another host.
      assertSameOrigin(target, currentUrl);
      currentUrl = target;
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const kind =
        options.classify?.(response.status, response.headers, body) ??
        classifyStatus(response.status, response.headers, body);
      throw new ProviderError(describe(response.status, kind, currentUrl, options.notFoundHint), {
        kind,
        status: response.status,
        retryAfterMs: kind === "rate_limited" ? retryAfterMsFromHeaders(response.headers) : null,
      });
    }

    let data: T;
    try {
      data = (await response.json()) as T;
    } catch (cause) {
      throw new ProviderError(
        `Forge returned a non-JSON body for ${new URL(currentUrl).pathname}`,
        {
          kind: "invalid_response",
          status: response.status,
          cause,
        },
      );
    }

    return { data, headers: response.headers, status: response.status, url: currentUrl };
  }

  throw new ProviderError(`Forge redirected more than ${String(MAX_REDIRECTS)} times`, {
    kind: "invalid_response",
  });
}

/**
 * Walk an RFC 8288 paginated listing, yielding one page at a time.
 *
 * Both GitHub and Gitea silently clamp an over-large per_page/limit while still
 * paginating, so "fewer items than I asked for" is NOT a valid stop condition.
 * The only correct one is the absence of rel="next", and the next URL must be
 * followed verbatim: GitHub rewrites /users/:login/repos into /user/:id/repos.
 * https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 */
export async function* pagesByLink<T>(
  context: DiscoveryContext,
  firstUrl: string,
  options: RequestOptions & { what?: string } = {},
): AsyncIterable<T[]> {
  let url: string = firstUrl;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await getJson<unknown>(context, url, options);
    yield expectArray<T>(response.data, options.what ?? "the listing");

    const next: string | undefined = parseLinkHeader(response.headers.get("link")).next;
    if (next === undefined) {
      return;
    }
    assertSameOrigin(next, firstUrl);
    url = next;
  }
  throw new ProviderError(
    `Forge kept paginating past ${String(MAX_PAGES)} pages for ${new URL(firstUrl).pathname}`,
    { kind: "invalid_response" },
  );
}

/** Guard for the "the forge answered 200 with something unexpected" case. */
export function expectArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) {
    throw new ProviderError(`Forge returned ${what} as ${typeof value} instead of a list`, {
      kind: "invalid_response",
    });
  }
  return value as T[];
}

/** Normalize a repo path the way repos.path is stored: no slashes around it, no .git. */
export function normalizeRepoPath(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

/** Visibility filtering is applied client side for every forge, so the contract
 * holds identically whether or not the API can filter server side. */
export function matchesVisibility(isPrivate: boolean, visibility: string): boolean {
  if (visibility === "public") {
    return !isPrivate;
  }
  if (visibility === "private") {
    return isPrivate;
  }
  return true;
}
