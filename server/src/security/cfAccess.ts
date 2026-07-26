import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Config } from "../config.ts";

export interface CfAccessOptions {
  config: Config;
  /** Paths that skip authentication entirely. */
  publicPrefixes?: readonly string[];
}

export const DEFAULT_PUBLIC_PREFIXES = ["/healthz", "/git/"] as const;

/**
 * Verifies the Cloudflare Access JWT with jose (createRemoteJWKSet against the
 * team domain cdn-cgi certs endpoint) on every route except /healthz and
 * /git/*, then checks the email claim against the allow list. Fails closed.
 *
 * In insecure mode the hook is not installed at all; the server is bound to
 * loopback and reports insecureMode in /api/status.
 */
export const cfAccessPlugin: FastifyPluginAsync<CfAccessOptions> = async (
  _app: FastifyInstance,
  _options: CfAccessOptions,
) => {
  // TODO: install the onRequest hook that verifies the JWT.
};
