import { existsSync } from "node:fs";
import { basename } from "node:path";
import { exportFormatSchema, MAX_PER_PAGE, type ExportFormat } from "@amber/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  ARCHIVE_EXTENSIONS,
  ExportError,
  findTreeEntry,
  listTree,
  resolveRef,
  streamBlob,
  streamGitDirArchive,
  streamSourceArchive,
  type ArchiveHandle,
  type TreeEntry,
} from "../export/archive.ts";
import { findRepoById, repoDirFor, type LocatedRepo } from "../repoLocator.ts";

/** /api/repos/:id/export source and gitdir archives, tree, and blob. */

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

const artifactParamsSchema = paramsSchema.extend({ artifact: z.string().min(1) });

const refQuerySchema = z.object({ ref: z.string().min(1).max(255).optional() });

const treeQuerySchema = refQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(MAX_PER_PAGE),
});

const blobQuerySchema = refQuerySchema.extend({ path: z.string().min(1).max(4096) });

export interface TreePage {
  ref: string;
  rows: TreeEntry[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Content-Disposition carries a display name and a ref, both of which are user
 * controlled. Anything outside this set could inject a header line or escape
 * the quoted string, so it is dropped rather than escaped.
 */
export function sanitizeFilenamePart(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64);
}

/** "source.tar.gz" -> { kind: "source", format: "tar.gz" } */
export function parseArtifact(
  artifact: string,
): { kind: "source" | "gitdir"; format: ExportFormat } | null {
  const dot = artifact.indexOf(".");
  if (dot < 0) {
    return null;
  }
  const kind = artifact.slice(0, dot);
  if (kind !== "source" && kind !== "gitdir") {
    return null;
  }
  const format = exportFormatSchema.safeParse(artifact.slice(dot + 1));
  if (!format.success) {
    return null;
  }
  return { kind, format: format.data };
}

export const exportRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.amber;
  const log = ctx.log.child({ mod: "export" });

  /** Resolve the row, then the directory from the row, never from the URL. */
  function locate(rawId: unknown, reply: FastifyReply): { repo: LocatedRepo; dir: string } | null {
    const parsed = paramsSchema.safeParse({ id: rawId });
    if (!parsed.success) {
      reply.code(400).send({ error: "bad_request", message: "Invalid repository id" });
      return null;
    }
    const repo = findRepoById(ctx.db, parsed.data.id);
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

  function fail(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof ExportError) {
      return reply.code(error.statusCode).send({ error: "export_failed", message: error.message });
    }
    log.error({ err: error }, "export failed");
    return reply.code(500).send({ error: "export_failed", message: "Failed to build the export." });
  }

  function sendArchive(reply: FastifyReply, handle: ArchiveHandle, filename: string): FastifyReply {
    reply.raw.on("close", () => {
      void handle.cleanup();
    });
    handle.stream.on("error", (error: Error) => {
      log.error({ err: error }, "archive stream failed");
      void handle.cleanup();
      reply.raw.destroy();
    });
    return reply
      .type(handle.contentType)
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("cache-control", "no-store")
      .send(handle.stream);
  }

  app.get("/repos/:id/export/:artifact", async (request, reply) => {
    const params = artifactParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid export request" });
    }
    const artifact = parseArtifact(params.data.artifact);
    if (artifact === null) {
      return reply.code(404).send({
        error: "not_found",
        message: "Unknown export. Use source or gitdir with zip, tar.gz or 7z.",
      });
    }
    const query = refQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid ref" });
    }
    const located = locate(params.data.id, reply);
    if (located === null) {
      return reply;
    }

    const extension = ARCHIVE_EXTENSIONS[artifact.format];
    const name = sanitizeFilenamePart(located.repo.displayName) || "repository";

    try {
      if (artifact.kind === "gitdir") {
        const handle = await streamGitDirArchive(located.dir, artifact.format);
        return sendArchive(reply, handle, `${name}-gitdir.${extension}`);
      }
      const ref = await resolveRef(located.dir, query.data.ref, located.repo.defaultBranch);
      const prefix = `${name}-${sanitizeFilenamePart(ref.label) || ref.oid.slice(0, 8)}`;
      const handle = await streamSourceArchive(located.dir, ref.oid, artifact.format, prefix);
      return sendArchive(reply, handle, `${prefix}.${extension}`);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/repos/:id/tree", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = treeQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid tree request" });
    }
    const located = locate(params.data.id, reply);
    if (located === null) {
      return reply;
    }
    try {
      const ref = await resolveRef(located.dir, query.data.ref, located.repo.defaultBranch);
      const all = await listTree(located.dir, ref.oid);
      const start = (query.data.page - 1) * query.data.perPage;
      const body: TreePage = {
        ref: ref.oid,
        rows: all.slice(start, start + query.data.perPage),
        total: all.length,
        page: query.data.page,
        perPage: query.data.perPage,
      };
      return reply.send(body);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/repos/:id/blob", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = blobQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid blob request" });
    }
    const located = locate(params.data.id, reply);
    if (located === null) {
      return reply;
    }
    try {
      const ref = await resolveRef(located.dir, query.data.ref, located.repo.defaultBranch);
      const entry = await findTreeEntry(located.dir, ref.oid, query.data.path);
      if (entry === null) {
        // Identical answer for "not in the tree" and "not an acceptable path",
        // so probing cannot distinguish a rejected traversal from a miss.
        return reply.code(404).send({ error: "not_found", message: "No such file at that ref." });
      }
      const filename = sanitizeFilenamePart(basename(entry.path)) || "file";
      return reply
        .type("application/octet-stream")
        .header("content-disposition", `attachment; filename="${filename}"`)
        .header("content-length", String(entry.size))
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(streamBlob(located.dir, entry.oid));
    } catch (error) {
      return fail(reply, error);
    }
  });
};
