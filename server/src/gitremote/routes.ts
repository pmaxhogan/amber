import { existsSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Repo } from "@amber/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.ts";
import { DEFAULT_UPLOAD_PACK_TIMEOUT_MS, spawnGit } from "../gitSpawn.ts";
import { getRepoBySlug } from "../domain/repos.ts";
import type { User } from "../domain/users.ts";
import { repoDirFor } from "../repoDir.ts";
import { canView, loadRepoAccessFacts } from "../security/authz.ts";
import { authenticateGitRequest, dummyGitPasswordHash, type GitAuthDeps } from "./auth.ts";
import { AuthThrottle } from "./throttle.ts";

export { parseBasicAuth, type BasicCredentials } from "./auth.ts";

/**
 * Smart HTTP v2, read only. Pushes are impossible by construction rather than
 * by check: the write side of the git protocol is not named anywhere in this
 * codebase, so there is no code path that could spawn it. The only service this
 * module will act on is the upload side, matched against a literal allow list
 * before any process is created.
 *
 * Everything else under /git/ falls through to a handler that authenticates
 * like every other /git request and then answers 403 without inspecting what
 * was asked for, so no block list has to name the write service either.
 *
 * /git is the one surface outside Cloudflare Access. Who may read what is
 * decided per user: auth.ts authenticates (kill switch, throttle, credential,
 * permission, membership), then canView decides each repository, and a
 * repository the caller cannot view is answered exactly like an unknown slug.
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

function noCache(reply: FastifyReply): void {
  reply.header("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
  reply.header("pragma", "no-cache");
  reply.header("cache-control", "no-cache, max-age=0, must-revalidate");
}

/**
 * Every refusal body is fixed text. The 401 in particular is byte for byte
 * the same for a wrong password, an unknown user, a removed user, a missing
 * permission and a non-member, so none of them can be told apart.
 */
const NOT_FOUND_BODY = "Not found.\n";
const REPO_NOT_FOUND_BODY = "Repository not found.\n";
const UNAUTHORIZED_BODY = "Authentication required.\n";
const THROTTLED_BODY = "Too many failed authentication attempts.\n";
/**
 * Git prints a text/plain error body to the user as "remote: ...", so this is
 * what someone sees when the access policy cannot be read and Amber fails
 * closed rather than guessing.
 */
export const POLICY_UNAVAILABLE_BODY =
  "Amber cannot confirm your access right now. Try again in a minute.\n";

function unauthorized(reply: FastifyReply): void {
  reply
    .code(401)
    .header("www-authenticate", 'Basic realm="Amber", charset="UTF-8"')
    .type("text/plain; charset=utf-8")
    .send(UNAUTHORIZED_BODY);
}

export interface GitRemotePluginOptions {
  ctx: AppContext;
  /** Test seams; production uses the defaults. */
  throttle?: AuthThrottle;
  verifyPassword?: GitAuthDeps["verifyPassword"];
}

export const gitRemotePlugin: FastifyPluginAsync<GitRemotePluginOptions> = async (app, options) => {
  const { ctx } = options;
  const log = ctx.log.child({ mod: "gitremote" });
  const throttle = options.throttle ?? new AuthThrottle();
  const authDeps: GitAuthDeps = {
    db: ctx.db,
    policy: ctx.policy,
    throttle,
    ...(options.verifyPassword === undefined ? {} : { verifyPassword: options.verifyPassword }),
  };
  // Built now rather than on the first unknown username, which would
  // otherwise pay one extra derivation and stand out by its timing.
  dummyGitPasswordHash();

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
   * Guard order matters, and lives in auth.ts: kill switch, throttle, Basic,
   * credential, permission, membership. Authentication comes before the slug
   * lookup so an anonymous caller cannot probe which repositories exist.
   * Answers the request itself and returns null on any refusal.
   */
  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const ip = request.ip;
    const result = await authenticateGitRequest(authDeps, {
      authorization: request.headers.authorization,
      ip,
    });
    if (result.ok) {
      return result.user;
    }
    switch (result.status) {
      case 404:
        reply.code(404).type("text/plain; charset=utf-8").send(NOT_FOUND_BODY);
        break;
      case 429:
        log.warn({ ip }, "git remote auth throttled");
        reply
          .code(429)
          .header("retry-after", String(result.retryAfterSeconds))
          .type("text/plain; charset=utf-8")
          .send(THROTTLED_BODY);
        break;
      case 503:
        log.warn({ ip, userId: result.userId }, "git remote refused: access policy unavailable");
        reply
          .code(503)
          .header("retry-after", "30")
          .type("text/plain; charset=utf-8")
          .send(POLICY_UNAVAILABLE_BODY);
        break;
      case 401:
        if (result.reason !== "no_credentials") {
          // The reason and the user id only: never the username, the
          // password, or the Authorization header.
          log.warn(
            { ip, reason: result.reason, userId: result.userId },
            "git remote authentication failed",
          );
        }
        unauthorized(reply);
        break;
    }
    return null;
  }

  /**
   * Resolve the slug to a row the caller may see, then to a directory built
   * from the row. A repository the caller cannot view gets exactly the answer
   * an unknown slug gets, and is decided before anything else about the row
   * (such as whether it has been backed up yet) can show through.
   */
  function locate(user: User, slug: string, reply: FastifyReply): Repo | null {
    const repo = getRepoBySlug(ctx.db, slug);
    const facts = repo === undefined ? undefined : loadRepoAccessFacts(ctx.db, repo.id);
    if (repo === undefined || facts === undefined || !canView(user, facts)) {
      reply.code(404).type("text/plain; charset=utf-8").send(REPO_NOT_FOUND_BODY);
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
      const user = await authorize(request, reply);
      if (user === null) {
        return reply;
      }
      const repo = locate(user, request.params.slug, reply);
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
    const user = await authorize(request, reply);
    if (user === null) {
      return reply;
    }
    const repo = locate(user, request.params.slug, reply);
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
   * Catch all for every other path and method in the /git namespace. It
   * deliberately never looks at what was requested: there is no write service
   * to name, only an explanation that this remote does not accept one. It
   * authenticates like every other /git request, so the explanation is only
   * ever given to someone holding a working credential.
   */
  const namespaceFallback = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    // Drain anything the client streamed at us so the socket closes cleanly.
    if (request.body instanceof Readable) {
      request.body.resume();
    }
    const user = await authorize(request, reply);
    if (user === null) {
      return reply;
    }
    return reply.code(403).type("text/plain; charset=utf-8").send(READ_ONLY_MESSAGE);
  };

  // "/git/*" does not match the bare path, and the Cloudflare bypass covers
  // both, so registering only the wildcard left "/git" to Fastify's default
  // JSON 404 while every other path in the namespace answered in plain text.
  app.all("/git", namespaceFallback);
  app.all("/git/*", namespaceFallback);
};
