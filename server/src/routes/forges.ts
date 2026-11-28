import { createForgeSchema, idParamsSchema, updateForgeSchema, type Forge } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import {
  assertForgeAllowed,
  assertMaySetPrivateNetwork,
  deleteForge,
  findForge,
  listForges,
  updateForge,
  upsertForge,
} from "../domain/forges.ts";
import { requireRequestUser } from "../security/authz.ts";
import { parseBody, parseParams } from "./validate.ts";

/**
 * /api/forges CRUD, kind detection on create.
 *
 * There is deliberately no way to change protocol, host, or port: PATCH
 * accepts `kind` and `allowPrivateNetwork` and nothing else. Pointing backups
 * at a different host means creating a new forge, which starts with no
 * credentials attached.
 *
 * Creating, editing and deleting need `manage_forges` (coarse). Only the
 * admin may create a forge with `allowPrivateNetwork` or change it: a
 * manage_forges user can only make RESTRICTED forges, and a new one passes
 * the egress seam (assertForgeAllowed) before its row exists.
 */
export const forgeRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.amber;

  app.get("/forges", { config: { authz: "user" } }, (): Forge[] => listForges(db));

  app.post("/forges", { config: { authz: "manage_forges" } }, async (request, reply) => {
    const user = requireRequestUser(request);
    const input = parseBody(createForgeSchema, request);
    assertMaySetPrivateNetwork(user, input.allowPrivateNetwork);
    const existing = findForge(db, input.protocol, input.host, input.port);
    if (existing !== undefined) {
      void reply.code(200);
      return existing;
    }
    // Outside any transaction: the egress wave resolves DNS here.
    await assertForgeAllowed(
      { protocol: input.protocol, host: input.host, port: input.port },
      user,
      { allowPrivateNetwork: input.allowPrivateNetwork === true },
    );
    const forge = upsertForge(db, input);
    void reply.code(201);
    return forge;
  });

  app.patch("/forges/:id", { config: { authz: "manage_forges" } }, (request): Forge => {
    const { id } = parseParams(idParamsSchema, request);
    const patch = parseBody(updateForgeSchema, request);
    assertMaySetPrivateNetwork(requireRequestUser(request), patch.allowPrivateNetwork);
    // Turning the flag OFF is a restriction, but it is still the admin's flag.
    if (patch.allowPrivateNetwork === false) {
      assertMaySetPrivateNetwork(requireRequestUser(request), true);
    }
    return updateForge(db, id, patch);
  });

  app.delete("/forges/:id", { config: { authz: "manage_forges" } }, (request, reply): null => {
    const { id } = parseParams(idParamsSchema, request);
    deleteForge(db, id);
    void reply.code(204);
    return null;
  });
};
