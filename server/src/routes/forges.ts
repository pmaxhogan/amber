import { createForgeSchema, idParamsSchema, updateForgeSchema, type Forge } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { deleteForge, findForge, listForges, updateForge, upsertForge } from "../domain/forges.ts";
import { parseBody, parseParams } from "./validate.ts";

/**
 * /api/forges CRUD, kind detection on create.
 *
 * There is deliberately no way to change protocol, host, or port: PATCH
 * accepts `kind` and nothing else. Pointing backups at a different host means
 * creating a new forge, which starts with no credentials attached.
 */
export const forgeRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.amber;

  app.get("/forges", (): Forge[] => listForges(db));

  app.post("/forges", (request, reply): Forge => {
    const input = parseBody(createForgeSchema, request);
    const existed = findForge(db, input.protocol, input.host, input.port) !== undefined;
    const forge = upsertForge(db, input);
    void reply.code(existed ? 200 : 201);
    return forge;
  });

  app.patch("/forges/:id", (request): Forge => {
    const { id } = parseParams(idParamsSchema, request);
    return updateForge(db, id, parseBody(updateForgeSchema, request));
  });

  app.delete("/forges/:id", (request, reply): null => {
    const { id } = parseParams(idParamsSchema, request);
    deleteForge(db, id);
    void reply.code(204);
    return null;
  });
};
