import { existsSync } from "node:fs";
import {
  browseCommitQuerySchema,
  browseCommitsQuerySchema,
  browseContentsQuerySchema,
  browseRawQuerySchema,
  browseRefsQuerySchema,
  browseResolveQuerySchema,
  type Repo,
} from "@amber/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyInlineImage } from "../browse/blobKind.ts";
import { badPath, findEntry, normalizeBrowsePath, readContents } from "../browse/contents.ts";
import {
  BrowseError,
  notFound,
  openBlobStream,
  requireCommit,
  type GitCtx,
} from "../browse/gitRun.ts";
import { listCommits, readCommit } from "../browse/history.ts";
import { listRefs, resolveRevision } from "../browse/refs.ts";
import { getRepoFor } from "../domain/repos.ts";
import { repoDirFor } from "../repoDir.ts";
import { sanitizeFilenamePart } from "./exports.ts";

/**
 * /api/repos/:id/browse/* - the read-only repository browser.
 *
 * The contract (queries, answers, caps) is pinned in shared/src/browseTypes.ts.
 * The repository behind it is hostile input: see browse/ for how it is read.
 */

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Headers on every `raw` response. The CSP is the point: a file opened
 * directly in a tab is served from the app's own origin, and `sandbox` gives
 * it an opaque one with no script, so a hostile SVG or HTML file cannot act as
 * the app.
 */
const RAW_SAFETY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "cross-origin-resource-policy": "same-origin",
} as const;

export const browseRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.amber;
  const log = ctx.log.child({ mod: "browse" });

  /** Resolve the row, then the directory from the row, never from the URL. */
  function locate(
    request: FastifyRequest,
    rawId: unknown,
    reply: FastifyReply,
  ): { repo: Repo; dir: string } | null {
    const parsed = paramsSchema.safeParse({ id: rawId });
    if (!parsed.success) {
      reply.code(400).send({ error: "bad_request", message: "Invalid repository id" });
      return null;
    }
    // One path for missing and invisible: a repo the caller cannot view gets
    // exactly the answer a repo that does not exist gets.
    const user = request.user;
    const repo = user === undefined ? undefined : getRepoFor(ctx.db, parsed.data.id, user);
    if (repo === undefined) {
      reply.code(404).send({ error: "not_found", message: "Repository not found" });
      return null;
    }
    const dir = repoDirFor(ctx.config, repo);
    if (!existsSync(dir)) {
      reply.code(409).send({
        error: "not_backed_up",
        message: "This repository has not been backed up yet.",
      });
      return null;
    }
    return { repo, dir };
  }

  function bad(reply: FastifyReply, message: string): FastifyReply {
    return reply.code(400).send({ error: "bad_request", message });
  }

  function fail(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof BrowseError) {
      if (error.statusCode === 499) {
        // The client is gone; there is nobody to answer.
        return reply;
      }
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    log.error({ err: error }, "browse failed");
    return reply
      .code(500)
      .send({ error: "browse_failed", message: "Failed to read the repository." });
  }

  /** A git context whose children die when the client disconnects. */
  function gitContext(dir: string, reply: FastifyReply): GitCtx {
    const controller = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) {
        controller.abort();
      }
    });
    return { dir, signal: controller.signal, log };
  }

  /** Params, then the repo row, shared by every endpoint. */
  function open(request: FastifyRequest, reply: FastifyReply): { repo: Repo; git: GitCtx } | null {
    const located = locate(request, (request.params as { id?: unknown }).id, reply);
    if (located === null) {
      return null;
    }
    return { repo: located.repo, git: gitContext(located.dir, reply) };
  }

  app.get("/repos/:id/browse/refs", { config: { authz: "browse" } }, async (request, reply) => {
    const query = browseRefsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return bad(reply, "Invalid refs request");
    }
    const opened = open(request, reply);
    if (opened === null) {
      return reply;
    }
    try {
      return await listRefs(opened.git, query.data, opened.repo.defaultBranch);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/repos/:id/browse/resolve", { config: { authz: "browse" } }, async (request, reply) => {
    const query = browseResolveQuerySchema.safeParse(request.query);
    if (!query.success) {
      return bad(reply, "Invalid revision");
    }
    const opened = open(request, reply);
    if (opened === null) {
      return reply;
    }
    try {
      const resolved = await resolveRevision(opened.git, query.data.rev, opened.repo.defaultBranch);
      if (resolved === null) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "No branch, tag or commit matches that." });
      }
      return resolved;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/repos/:id/browse/contents", { config: { authz: "browse" } }, async (request, reply) => {
    const query = browseContentsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return bad(reply, "Invalid contents request");
    }
    const path = normalizeBrowsePath(query.data.path);
    if (path === null) {
      return bad(reply, badPath().message);
    }
    const opened = open(request, reply);
    if (opened === null) {
      return reply;
    }
    try {
      await requireCommit(opened.git, query.data.rev);
      return await readContents(opened.git, query.data.rev, path);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    "/repos/:id/browse/raw",
    {
      config: { authz: "browse" },
      // On the way in, so a 400 or 404 below carries them too.
      onRequest: async (_request, reply) => {
        for (const [name, value] of Object.entries(RAW_SAFETY_HEADERS)) {
          void reply.header(name, value);
        }
        void reply.header("cache-control", "no-store");
      },
    },
    async (request, reply) => {
      const query = browseRawQuerySchema.safeParse(request.query);
      if (!query.success) {
        return bad(reply, "Invalid raw request");
      }
      const path = normalizeBrowsePath(query.data.path);
      if (path === null || path === "") {
        return bad(reply, badPath().message);
      }
      const opened = open(request, reply);
      if (opened === null) {
        return reply;
      }
      try {
        await requireCommit(opened.git, query.data.rev);
        const entry = await findEntry(opened.git, query.data.rev, path);
        if (entry === null || (entry.type !== "blob" && entry.type !== "symlink")) {
          throw notFound("No such file at that commit.");
        }
        const size = entry.size ?? 0;

        // Served as an image only when the bytes really are one, and then only
        // with the type the extension names. Anything else downloads.
        const imageType =
          query.data.inline === "1"
            ? await verifyInlineImage(opened.git, { oid: entry.oid, size }, path)
            : null;
        const filename = sanitizeFilenamePart(path.slice(path.lastIndexOf("/") + 1)) || "file";

        const stream = openBlobStream(opened.git, entry.oid);
        return reply
          .header("content-type", imageType ?? "application/octet-stream")
          .header(
            "content-disposition",
            imageType === null ? `attachment; filename="${filename}"` : "inline",
          )
          .header("content-length", String(size))
          .header("cache-control", "private, max-age=86400, immutable")
          .send(stream);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get("/repos/:id/browse/commits", { config: { authz: "browse" } }, async (request, reply) => {
    const query = browseCommitsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return bad(reply, "Invalid commits request");
    }
    const path = normalizeBrowsePath(query.data.path ?? "");
    if (path === null) {
      return bad(reply, badPath().message);
    }
    const opened = open(request, reply);
    if (opened === null) {
      return reply;
    }
    try {
      await requireCommit(opened.git, query.data.rev);
      return await listCommits(opened.git, query.data.rev, path, query.data.limit, query.data.skip);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/repos/:id/browse/commit", { config: { authz: "browse" } }, async (request, reply) => {
    const query = browseCommitQuerySchema.safeParse(request.query);
    if (!query.success) {
      return bad(reply, "Invalid commit request");
    }
    const opened = open(request, reply);
    if (opened === null) {
      return reply;
    }
    try {
      await requireCommit(opened.git, query.data.rev);
      return await readCommit(opened.git, query.data.rev);
    } catch (error) {
      return fail(reply, error);
    }
  });
};
