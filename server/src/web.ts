import { existsSync } from "node:fs";
import { join, sep } from "node:path";
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

/**
 * The policy the app's own document is served with.
 *
 * The app renders what is inside backed-up repositories, which is hostile
 * input, so this is the last line behind the escaping and the sandboxed
 * markdown frame: script only from our own files, no plugins, no base tag, and
 * nobody may frame us. Notes on the looser parts:
 *
 * - style-src needs 'unsafe-inline': PrimeVue's styled mode injects style
 *   elements at runtime. Inline style cannot run script.
 * - The two cloudflareinsights.com sources are Cloudflare Web Analytics, which
 *   the edge injects into pages when a zone turns it on. The reference
 *   deployment sits behind Cloudflare, which already terminates TLS for every
 *   byte of the app, so allowing its beacon grants it nothing it lacks.
 * - img-src allows blob: and data: for the app's own icons and previews.
 *   Repository images come from /api on this origin.
 * - A srcdoc frame inherits this policy and then adds a stricter one of its
 *   own (see the markdown frame in the web app).
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

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
    /**
     * Only /assets is fingerprinted. The service worker, the manifest and the
     * icons keep their names across deploys, so they must be revalidated: a
     * service worker pinned for a year could never be fixed.
     */
    setHeaders: (response, filePath) => {
      // index.html is sent by the fallback below, which sets no-store itself.
      if (!filePath.includes(`${sep}assets${sep}`) && !filePath.endsWith("index.html")) {
        void response.header("cache-control", "no-cache");
      }
    },
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
      .header("content-security-policy", APP_CONTENT_SECURITY_POLICY)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "same-origin")
      .sendFile("index.html", { cacheControl: false });
  });

  log.info({ root }, "serving the built frontend");
};
