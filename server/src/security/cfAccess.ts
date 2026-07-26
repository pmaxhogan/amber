import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Config } from "../config.ts";

/**
 * The key resolver jose hands each verification. Production builds one with
 * createRemoteJWKSet against the team domain; tests inject a local JWKS built
 * from a generated keypair so no network is involved.
 */
export type CfAccessKeyGetter = JWTVerifyGetKey;

export interface CfAccessOptions {
  config: Config;
  /** Paths that skip authentication entirely. */
  publicPrefixes?: readonly string[];
  /** Test seam. Omitted in production, where the remote JWKS is used. */
  getKey?: CfAccessKeyGetter;
}

export const DEFAULT_PUBLIC_PREFIXES = ["/healthz", "/git/"] as const;

/** Cloudflare signs with RS256; pinning it prevents algorithm confusion. */
const ALLOWED_ALGORITHMS = ["RS256"] as const;

/** exp/nbf tolerance, matching the doc's "small skew". */
export const CLOCK_TOLERANCE_SECONDS = 30;

export const CF_ACCESS_HEADER = "cf-access-jwt-assertion";
export const CF_ACCESS_COOKIE = "CF_Authorization";

/** Attached to the request once a token verifies, for downstream handlers. */
export interface CfAccessIdentity {
  email: string;
  subject: string | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    cfAccess?: CfAccessIdentity;
  }
}

/**
 * The pathname a request is routed on, with the query string and any fragment
 * removed. Public-prefix matching uses this rather than the raw url so a query
 * string can never smuggle a public path into an authenticated route.
 */
export function requestPathname(url: string): string {
  const queryIndex = url.search(/[?#]/);
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  return path === "" ? "/" : path;
}

/**
 * A path is public when it equals a prefix exactly, or when the prefix ends in
 * "/" and the path starts with it. "/healthz" therefore matches "/healthz" but
 * not "/healthzz"; "/git/" matches "/git/repo.git" but not bare "/git".
 * Matching is case sensitive, so "/GIT/x" stays authenticated.
 */
export function isPublicPath(pathname: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (pathname === prefix) {
      return true;
    }
    if (prefix.endsWith("/")) {
      if (pathname.startsWith(prefix)) {
        return true;
      }
      continue;
    }
    // A prefix without a trailing slash also matches its own directory form.
    if (pathname === `${prefix}/`) {
      return true;
    }
  }
  return false;
}

/** Pull the assertion from the header first, then the cookie. */
export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers[CF_ACCESS_HEADER];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === "string" && headerValue.trim() !== "") {
    return headerValue.trim();
  }

  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== "string") {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== CF_ACCESS_COOKIE) {
      continue;
    }
    const value = part.slice(eq + 1).trim();
    if (value !== "") {
      return value;
    }
  }
  return null;
}

/** The email claim, normalized for a case-insensitive allow list comparison. */
function emailClaim(payload: JWTPayload): string | null {
  const email = payload["email"];
  if (typeof email !== "string") {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

class CfAccessDenied extends Error {
  readonly reason: string;

  // Not a constructor parameter property: node's strip-only TypeScript mode
  // rejects those, and `npm run dev` runs this file directly.
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "CfAccessDenied";
  }
}

/**
 * Verifies the Cloudflare Access JWT with jose (createRemoteJWKSet against the
 * team domain cdn-cgi certs endpoint) on every route except /healthz and
 * /git/*, then checks the email claim against the allow list. Fails closed.
 *
 * In insecure mode the hook is not installed at all; the server is bound to
 * loopback and reports insecureMode in /api/status.
 *
 * Wrapped in fastify-plugin so the onRequest hook applies to the whole server
 * rather than only this plugin's encapsulated scope, which would leave every
 * sibling route silently unguarded.
 */
const plugin: FastifyPluginAsync<CfAccessOptions> = async (
  app: FastifyInstance,
  options: CfAccessOptions,
) => {
  const { config } = options;
  const log = app.log.child({ mod: "cfAccess" });

  if (config.insecureMode) {
    // Deliberately no hook at all: there is nothing to short circuit later.
    log.warn("authentication is disabled (insecure mode); no Cloudflare Access hook installed");
    return;
  }

  if (config.cfAccess === null) {
    // loadConfig already refuses this combination, so reaching here means a
    // caller assembled a Config by hand. Fail closed rather than serve open.
    throw new Error(
      "Cloudflare Access is not configured and insecure mode is off. Refusing to serve " +
        "unauthenticated requests.",
    );
  }

  const { teamDomain, aud, allowedEmails } = config.cfAccess;
  const issuer = `https://${teamDomain}`;
  const allowList = new Set(allowedEmails.map((email) => email.toLowerCase()));
  const publicPrefixes = options.publicPrefixes ?? DEFAULT_PUBLIC_PREFIXES;

  // Built once: createRemoteJWKSet owns the JWKS cache and the kid-miss
  // refresh cooldown, both of which are lost if it is rebuilt per request.
  const getKey: CfAccessKeyGetter =
    options.getKey ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  app.addHook("onRequest", async (request, reply) => {
    const pathname = requestPathname(request.url);
    if (isPublicPath(pathname, publicPrefixes)) {
      return;
    }

    try {
      const token = extractToken(request);
      if (token === null) {
        throw new CfAccessDenied("no Cloudflare Access token on the request");
      }

      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience: aud,
        algorithms: [...ALLOWED_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });

      const email = emailClaim(payload);
      if (email === null) {
        throw new CfAccessDenied("token carries no email claim");
      }
      if (!allowList.has(email)) {
        throw new CfAccessDenied("email is not in CF_ACCESS_ALLOWED_EMAILS");
      }

      request.cfAccess = { email, subject: payload.sub };
    } catch (error) {
      const reason =
        error instanceof CfAccessDenied
          ? error.reason
          : `token verification failed: ${error instanceof Error ? error.name : "unknown error"}`;
      // The token is never logged: it is a bearer credential.
      log.warn({ pathname, method: request.method, reason }, "rejected unauthenticated request");
      await reply.code(401).send({
        error: "unauthorized",
        message: "Valid Cloudflare Access authentication is required.",
      });
      // Explicit: an async hook that has answered must not fall through to the
      // handler. Fastify checks reply.sent, but the SSE route hijacks its reply
      // and that lifecycle should not depend on a framework detail.
      return reply;
    }
  });
};

export const cfAccessPlugin = fp(plugin, {
  name: "amber-cf-access",
  fastify: "5.x",
});
