import { existsSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.ts";
import { DEFAULT_UPLOAD_PACK_TIMEOUT_MS, spawnGit } from "../gitSpawn.ts";
import { findRepoBySlug, repoDirFor, type LocatedRepo } from "../repoLocator.ts";
import { safeEqualString, verifyGitPassword } from "../security/gitPassword.ts";
import { readGitRemoteState } from "./config.ts";
import { AuthThrottle } from "./throttle.ts";

/**
 * Smart HTTP v2, read only. git-receive-pack is never spawned anywhere in the
 * codebase, so pushes are impossible by construction rather than by check: the
 * only service name this module will act on is the upload side, and it is
 * compared against a literal allow list before any process is created.
 *
 * Anything else under /git/ falls through to a 403 handler that never inspects
 * what was asked for, which is why the push service name does not appear here
 * at all.
 */

/** The one and only service Amber will ever run for a client. */
const UPLOAD_PACK = "git-upload-pack";

const REQUEST_CONTENT_TYPE = `application/x-${UPLOAD_PACK}-request`;
const ADVERTISEMENT_CONTENT_TYPE = `application/x-${UPLOAD_PACK}-advertisement`;
const RESULT_CONTENT_TYPE = `application/x-${UPLOAD_PACK}-result`;

const READ_ONLY_MESSAGE =
  "This Amber remote is read-only. Only fetch and clone are served; writing is not supported.\n";

/** Advertisement framing is bounded; a clone body is not, and is streamed. */
const MAX_ADVERTISEMENT_BYTES = 32 * 1024 * 1024;

/** pkt-line: 4 hex length bytes covering the header plus the payload. */
export function pktLine(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const length = (body.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length, "ascii"), body]);
}

const FLUSH_PKT = Buffer.from("0000", "ascii");

/**
 * The service announcement smart HTTP requires in front of the advertisement.
 * upload-pack itself does not emit it under protocol v2, so the HTTP layer
 * always supplies it, exactly as git's own http-backend does.
 */
export function serviceAnnouncement(): Buffer {
  return Buffer.concat([pktLine(`# service=${UPLOAD_PACK}\n`), FLUSH_PKT]);
}

/**
 * Only `version=<n>` and `version=<n>:...` shapes are forwarded, so a header
 * cannot smuggle arbitrary environment content into the child process.
 */
export function sanitizeGitProtocol(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
    return undefined;
  }
  return /^version=[0-9]+(:[A-Za-z0-9_.:=-]*)?$/.test(raw) ? raw : undefined;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

export function parseBasicAuth(header: unknown): BasicCredentials | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (match === null) {
    return null;
  }
  const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function noCache(reply: FastifyReply): void {
  reply.header("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
  reply.header("pragma", "no-cache");
  reply.header("cache-control", "no-cache, max-age=0, must-revalidate");
}

function unauthorized(reply: FastifyReply): void {
  reply
    .code(401)
    .header("www-authenticate", 'Basic realm="Amber", charset="UTF-8"')
    .type("text/plain; charset=utf-8")
    .send("Authentication required.\n");
}

export const gitRemotePlugin: FastifyPluginAsync<{ ctx: AppContext }> = async (app, options) => {
  const { ctx } = options;
  const log = ctx.log.child({ mod: "gitremote" });
  const throttle = new AuthThrottle();

  // Pass the request body through untouched: upload-pack negotiation is piped
  // straight into the child's stdin and is never buffered in memory or on disk.
  app.addContentTypeParser(REQUEST_CONTENT_TYPE, (_request, payload, done) => {
    done(null, payload);
  });
  // Same treatment for every other content type, so a write attempt reaches the
  // read-only explanation below instead of a confusing 415. Encapsulated to
  // this plugin, so it does not affect the JSON API.
  app.addContentTypeParser("*", (_request, payload, done) => {
    done(null, payload);
  });

  /**
   * Guard order matters. Disabled comes first so a disabled instance never
   * prompts for a password, and authentication comes before the slug lookup so
   * an anonymous caller cannot probe which repositories exist.
   */
  function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
    const state = readGitRemoteState(ctx.db);
    if (!state.enabled || state.passwordHash === null) {
      reply.code(404).type("text/plain; charset=utf-8").send("Not found.\n");
      return false;
    }

    const ip = request.ip;
    if (!throttle.allow(ip)) {
      const retryAfter = throttle.retryAfterSeconds(ip);
      log.warn({ ip }, "git remote auth throttled");
      reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .type("text/plain; charset=utf-8")
        .send("Too many failed authentication attempts.\n");
      return false;
    }

    const credentials = parseBasicAuth(request.headers.authorization);
    if (credentials === null) {
      unauthorized(reply);
      return false;
    }

    const userOk = safeEqualString(credentials.username, state.username);
    const passwordOk = verifyGitPassword(credentials.password, state.passwordHash);
    if (!userOk || !passwordOk) {
      throttle.recordFailure(ip);
      log.warn({ ip }, "git remote authentication failed");
      unauthorized(reply);
      return false;
    }

    throttle.recordSuccess(ip);
    return true;
  }

  /** Resolve the slug to a row, then to a directory built from the row. */
  function locate(slug: string, reply: FastifyReply): LocatedRepo | null {
    const repo = findRepoBySlug(ctx.db, slug);
    if (repo === undefined) {
      reply.code(404).type("text/plain; charset=utf-8").send("Repository not found.\n");
      return null;
    }
    if (!existsSync(repoDirFor(ctx.config, repo))) {
      // The row exists but the first sync has not produced a directory yet.
      reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("Repository has not been backed up yet.\n");
      return null;
    }
    return repo;
  }

  app.get<{ Params: { slug: string }; Querystring: { service?: string } }>(
    "/git/:slug/info/refs",
    async (request, reply) => {
      if (!authorize(request, reply)) {
        return reply;
      }
      const repo = locate(request.params.slug, reply);
      if (repo === null) {
        return reply;
      }
      // Allow list, not a block list: any other service, including the write
      // side, is refused without ever being named.
      if (request.query.service !== UPLOAD_PACK) {
        return reply.code(403).type("text/plain; charset=utf-8").send(READ_ONLY_MESSAGE);
      }

      const dir = repoDirFor(ctx.config, repo);
      const gitProtocol = sanitizeGitProtocol(request.headers["git-protocol"]);
      const child = spawnGit(["upload-pack", "--stateless-rpc", "--advertise-refs", dir], {
        env: gitProtocol === undefined ? {} : { GIT_PROTOCOL: gitProtocol },
        timeoutMs: DEFAULT_UPLOAD_PACK_TIMEOUT_MS,
      });

      const advertisement = await new Promise<Buffer | null>((resolve) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_ADVERTISEMENT_BYTES) {
            child.kill("SIGKILL");
            return;
          }
          chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 8192) {
            stderr += chunk.toString("utf8");
          }
        });
        child.on("error", (error: Error) => {
          log.error({ err: error, repoId: repo.id }, "failed to start upload-pack");
          resolve(null);
        });
        child.on("close", (code: number | null) => {
          if (code !== 0 || bytes > MAX_ADVERTISEMENT_BYTES) {
            log.error(
              { code, repoId: repo.id, stderr: stderr.trim() },
              "upload-pack advertisement failed",
            );
            resolve(null);
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      });

      if (advertisement === null) {
        return reply
          .code(500)
          .type("text/plain; charset=utf-8")
          .send("Failed to read the repository.\n");
      }

      noCache(reply);
      return reply
        .code(200)
        .type(ADVERTISEMENT_CONTENT_TYPE)
        .send(Buffer.concat([serviceAnnouncement(), advertisement]));
    },
  );

  app.post<{ Params: { slug: string } }>(`/git/:slug/${UPLOAD_PACK}`, async (request, reply) => {
    if (!authorize(request, reply)) {
      return reply;
    }
    const repo = locate(request.params.slug, reply);
    if (repo === null) {
      return reply;
    }

    const dir = repoDirFor(ctx.config, repo);
    const gitProtocol = sanitizeGitProtocol(request.headers["git-protocol"]);
    const child = spawnGit(["upload-pack", "--stateless-rpc", dir], {
      env: gitProtocol === undefined ? {} : { GIT_PROTOCOL: gitProtocol },
      timeoutMs: DEFAULT_UPLOAD_PACK_TIMEOUT_MS,
    });

    const out = new PassThrough();
    let finished = false;
    child.on("close", (code: number | null) => {
      finished = true;
      if (code !== 0) {
        log.warn({ code, repoId: repo.id }, "upload-pack exited non-zero");
      }
    });
    child.on("error", (error: Error) => {
      finished = true;
      log.error({ err: error, repoId: repo.id }, "upload-pack failed to start");
      out.destroy(error);
    });
    /**
     * Only the response socket closing early means the client went away. The
     * request stream also emits "close" on a perfectly normal completed body,
     * so keying off that would kill upload-pack on every single request.
     */
    reply.raw.on("close", () => {
      if (finished || reply.raw.writableFinished) {
        return;
      }
      log.debug({ repoId: repo.id }, "client disconnected, killing upload-pack");
      child.kill("SIGKILL");
    });

    // The body arrives as the untouched stream from the content type parser.
    const body = request.body as NodeJS.ReadableStream | undefined;
    const source = body ?? request.raw;
    const encoding = String(request.headers["content-encoding"] ?? "").toLowerCase();
    if (encoding === "gzip" || encoding === "x-gzip") {
      const gunzip = createGunzip();
      gunzip.on("error", (error: Error) => {
        log.warn({ err: error, repoId: repo.id }, "malformed gzip upload-pack body");
        child.kill("SIGKILL");
      });
      source.pipe(gunzip).pipe(child.stdin);
    } else {
      source.pipe(child.stdin);
    }
    // A client that vanishes mid negotiation must not take the process down.
    child.stdin.on("error", () => undefined);

    child.stdout.pipe(out);
    child.stderr.on("data", (chunk: Buffer) => {
      log.debug({ repoId: repo.id, stderr: chunk.toString("utf8").trim() }, "upload-pack stderr");
    });

    noCache(reply);
    return reply.code(200).type(RESULT_CONTENT_TYPE).send(out);
  });

  /**
   * Catch all for every other path and method under /git/. It deliberately
   * never looks at what was requested: there is no write service to name, only
   * an explanation that this remote does not accept one.
   */
  app.all("/git/*", async (request, reply) => {
    const state = readGitRemoteState(ctx.db);
    if (!state.enabled || state.passwordHash === null) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Not found.\n");
    }
    // Drain anything the client streamed at us so the socket closes cleanly.
    if (request.body instanceof Readable) {
      request.body.resume();
    }
    return reply.code(403).type("text/plain; charset=utf-8").send(READ_ONLY_MESSAGE);
  });
};
