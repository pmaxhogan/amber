import {
  createAccountSchema,
  idParamsSchema,
  updateAccountSchema,
  type Account,
} from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  requireAccount,
  setDefaultAccount,
  updateAccount,
} from "../domain/accounts.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

const listQuerySchema = z.object({
  forgeId: z.coerce.number().int().positive().optional(),
});

/**
 * /api/accounts CRUD plus the write-only secret and default promotion.
 *
 * Every response here is an Account, which carries `hasSecret: boolean` and
 * never the secret, encrypted or otherwise. The domain layer selects the
 * credential column as a presence flag, so there is no object in this file
 * that could leak one even by accident.
 *
 * There is no forgeId on the update contract either: credentials cannot follow
 * an account to a different host.
 *
 * Authorization: creating, editing and promoting an account needs
 * `import_private`, since an account exists to fetch with. Reading and
 * deleting only need an accepted identity at this layer: which accounts a
 * caller may see or delete (their own; everyone's for manage_forges and the
 * admin) is an ownership check made per object in the enforcement wave.
 */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.amber;
  const key = config.secretKey;

  app.get("/accounts", { config: { authz: "user" } }, (request): Account[] => {
    const { forgeId } = parseQuery(listQuerySchema, request);
    return listAccounts(db, forgeId);
  });

  app.get("/accounts/:id", { config: { authz: "user" } }, (request): Account => {
    const { id } = parseParams(idParamsSchema, request);
    return requireAccount(db, id);
  });

  app.post("/accounts", { config: { authz: "import_private" } }, (request, reply): Account => {
    const account = createAccount(db, key, parseBody(createAccountSchema, request));
    void reply.code(201);
    return account;
  });

  app.patch("/accounts/:id", { config: { authz: "import_private" } }, (request): Account => {
    const { id } = parseParams(idParamsSchema, request);
    return updateAccount(db, key, id, parseBody(updateAccountSchema, request));
  });

  app.post("/accounts/:id/default", { config: { authz: "import_private" } }, (request): Account => {
    const { id } = parseParams(idParamsSchema, request);
    return setDefaultAccount(db, id);
  });

  app.delete("/accounts/:id", { config: { authz: "user" } }, (request, reply): null => {
    const { id } = parseParams(idParamsSchema, request);
    deleteAccount(db, id);
    void reply.code(204);
    return null;
  });
};
