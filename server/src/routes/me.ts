import type { Me } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { userStorage } from "../domain/users.ts";
import { requireRequestUser } from "../security/authz.ts";

/**
 * GET /api/me: who the caller is and what they may do, which the web app
 * reads once to decide what to show. The access policy's health is the
 * admin's business only, so `policy` is null for everyone else.
 */
export const meRoutes: FastifyPluginAsync = async (app) => {
  const { db, policy } = app.amber;

  app.get("/me", { config: { authz: "user" } }, (request): Me => {
    const user = requireRequestUser(request);
    return {
      id: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      permissions: user.permissions,
      storage: userStorage(db, user),
      policy: user.isAdmin ? policy.status() : null,
    };
  });
};
