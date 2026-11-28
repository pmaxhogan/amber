import {
  importRequestSchema,
  type ImportCommitResponse,
  type ImportPreviewResponse,
} from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { commitImport, previewImport } from "../domain/importer.ts";
import { requireRequestUser } from "../security/authz.ts";
import { parseBody } from "./validate.ts";

/**
 * /api/import/preview and /api/import. Both act for the caller: the importer
 * owns everything an import creates, and every check (accounts, hosts, caps,
 * repositories Amber already has) is made against them.
 */
export const importRoutes: FastifyPluginAsync = async (app) => {
  const { db, events } = app.amber;

  app.post("/import/preview", { config: { authz: "import" } }, (request): ImportPreviewResponse => {
    const { text } = parseBody(importRequestSchema, request);
    return previewImport(db, requireRequestUser(request), text);
  });

  app.post(
    "/import",
    { config: { authz: "import" } },
    async (request): Promise<ImportCommitResponse> => {
      const { text } = parseBody(importRequestSchema, request);
      const result = await commitImport(db, requireRequestUser(request), text);
      for (const line of result.results) {
        if (line.action === "created" && line.repoId !== undefined) {
          events.publish("repo.created", { repoId: line.repoId });
        }
      }
      return result;
    },
  );
};
