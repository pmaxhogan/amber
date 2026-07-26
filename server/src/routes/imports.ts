import {
  importRequestSchema,
  type ImportCommitResponse,
  type ImportPreviewResponse,
} from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { commitImport, previewImport } from "../domain/importer.ts";
import { parseBody } from "./validate.ts";

/** /api/import/preview and /api/import. */
export const importRoutes: FastifyPluginAsync = async (app) => {
  const { db, events } = app.amber;

  app.post("/import/preview", (request): ImportPreviewResponse => {
    const { text } = parseBody(importRequestSchema, request);
    return previewImport(db, text);
  });

  app.post("/import", (request): ImportCommitResponse => {
    const { text } = parseBody(importRequestSchema, request);
    const result = commitImport(db, text);
    for (const line of result.results) {
      if (line.action === "created" && line.repoId !== undefined) {
        events.publish("repo.created", { id: line.repoId });
      }
    }
    return result;
  });
};
