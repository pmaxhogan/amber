import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";
import type { Config } from "./config.ts";
import { isPublicPath } from "./security/cfAccess.ts";

/**
 * Serves the built single page app.
 *
 * Registered AFTER the Cloudflare Access plugin, so the UI sits behind the
 * same SSO gate as the API. Only /healthz and /git/* are exempt, and neither
 * is served from here.
 *
 * Absent in development, where Vite serves the app on its own port and proxies
 * /api across, and absent in the test suite, which never builds the frontend.
 * A missing directory is therefore normal and logged at info rather than
 * treated as a misconfiguration.
 */

export interface WebPluginOptions {
  config: Config;
}

/**
 * Paths the SPA fallback must never answer for.
 *
 * The boundary is a path separator, not a character count, which is the whole
 * reason this borrows isPublicPath rather than testing prefixes by hand:
 * "/git-remote" is a page in the app, while "/git" and "/git/<slug>.git" are
 * the read-only remote. A naive startsWith("/git") swallows the page.
 */
const SERVER_PREFIXES = ["/healthz", "/api", "/git"] as const;

function isServerPath(url: string): boolean {
  const pathname = url.split("?")[0] ?? url;
  return isPublicPath(pathname, SERVER_PREFIXES);
}

export const webPlugin: FastifyPluginAsync<WebPluginOptions> = async (app, options) => {
  const root = options.config.webDistDir;
  const log = app.log.child({ mod: "web" });

  if (!existsSync(join(root, "index.html"))) {
    log.info({ root }, "no built frontend found; serving the API only");
    return;
  }

  await app.register(fastifyStatic, {
    root,
    // Vite fingerprints every asset it emits, so they are safe to cache hard.
    // index.html is not fingerprinted and is served by the fallback below.
    maxAge: "1y",
    immutable: true,
    index: false,
    // The fallback handles anything that is not a real file.
    wildcard: false,
  });

  /**
   * Client-side routing: a deep link like /settings is a real page to the
   * router and a missing file to the filesystem, so unmatched GETs get
   * index.html. An unmatched /api path stays a 404, because answering an API
   * call with HTML turns a typo into an unreadable parse error.
   */
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || isServerPath(request.url)) {
      return reply.code(404).send({ error: "not_found", message: "Not found" });
    }
    /**
     * cacheControl: false, or the plugin's one-year immutable header applies
     * here too. index.html carries no fingerprint, so caching it that way
     * pins every browser to the deploy it first saw.
     */
    return reply
      .header("cache-control", "no-store")
      .sendFile("index.html", { cacheControl: false });
  });

  log.info({ root }, "serving the built frontend");
};
