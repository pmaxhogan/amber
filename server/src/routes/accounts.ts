import {
  createAccountSchema,
  idParamsSchema,
  updateAccountSchema,
  type Account,
} from "@amber/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  setDefaultAccount,
  updateAccount,
} from "../domain/accounts.ts";
import { forbidden, notFound } from "../domain/errors.ts";
import { getUser, type User } from "../domain/users.ts";
import type { Db } from "../db/db.ts";
import { hasPermission, requireRequestUser } from "../security/authz.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

const listQuerySchema = z.object({
  forgeId: z.coerce.number().int().positive().optional(),
});

/** manage_forges (and the admin) see and delete other users' accounts, never their secrets. */
function seesAllAccounts(user: User): boolean {
  return hasPermission(user, "manage_forges");
}

/**
 * The account as `user` may see it. Another user's account, for a caller who
 * may not see it, answers exactly like an account that does not exist.
 * Callers who see everyone's get `ownerEmail` too.
 */
function accountFor(db: Db, user: User, id: number): Account {
  const account = getAccount(db, id);
  if (account === undefined) {
    throw notFound("Account", id);
  }
  if (account.ownerUserId === user.id) {
    return account;
  }
  if (!seesAllAccounts(user)) {
    throw notFound("Account", id);
  }
  return withOwnerEmail(db, account);
}

function withOwnerEmail(db: Db, account: Account): Account {
  const owner = account.ownerUserId === undefined ? undefined : getUser(db, account.ownerUserId);
  return owner === undefined ? account : { ...account, ownerEmail: owner.email };
}

/**
 * Edit and promote act on the caller's OWN accounts only, the admin
 * included: an account exists to fetch the owner's repositories, so nobody
 * else gets to change which token that is.
 */
function ownAccount(db: Db, request: FastifyRequest, id: number): Account {
  const user = requireRequestUser(request);
  const account = accountFor(db, user, id);
  if (account.ownerUserId !== user.id) {
    throw forbidden("Only the account's owner can change it.", { requires: "owner" });
  }
  return account;
}

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
 * Authorization (docs/ARCHITECTURE.md "Credentials are per user"):
 * - list and read: your own accounts; manage_forges and the admin see
 *   everyone's, with `ownerEmail`.
 * - create, edit, set default: `import_private` (coarse), and only ever on
 *   your own accounts. A created account belongs to its creator.
 * - delete: your own, or anyone's with manage_forges.
 */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.amber;
  const key = config.secretKey;

  app.get("/accounts", { config: { authz: "user" } }, (request): Account[] => {
    const user = requireRequestUser(request);
    const { forgeId } = parseQuery(listQuerySchema, request);
    if (seesAllAccounts(user)) {
      return listAccounts(db, forgeId === undefined ? {} : { forgeId }).map((account) =>
        withOwnerEmail(db, account),
      );
    }
    return listAccounts(db, {
      ownerUserId: user.id,
      ...(forgeId === undefined ? {} : { forgeId }),
    });
  });

  app.get("/accounts/:id", { config: { authz: "user" } }, (request): Account => {
    const { id } = parseParams(idParamsSchema, request);
    return accountFor(db, requireRequestUser(request), id);
  });

  app.post("/accounts", { config: { authz: "import_private" } }, (request, reply): Account => {
    const user = requireRequestUser(request);
    const account = createAccount(db, key, parseBody(createAccountSchema, request), user.id);
    void reply.code(201);
    return account;
  });

  app.patch("/accounts/:id", { config: { authz: "import_private" } }, (request): Account => {
    const { id } = parseParams(idParamsSchema, request);
    ownAccount(db, request, id);
    return updateAccount(db, key, id, parseBody(updateAccountSchema, request));
  });

  app.post("/accounts/:id/default", { config: { authz: "import_private" } }, (request): Account => {
    const { id } = parseParams(idParamsSchema, request);
    ownAccount(db, request, id);
    return setDefaultAccount(db, id);
  });

  app.delete("/accounts/:id", { config: { authz: "user" } }, (request, reply): null => {
    const { id } = parseParams(idParamsSchema, request);
    // Visible means own, or manage_forges; both may delete.
    accountFor(db, requireRequestUser(request), id);
    deleteAccount(db, id);
    void reply.code(204);
    return null;
  });
};
