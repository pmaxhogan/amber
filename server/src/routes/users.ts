import {
  idParamsSchema,
  updateUserSchema,
  type AdoptReposResponse,
  type UserListResponse,
  type UserRefreshResponse,
  type UserRow,
} from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import {
  adoptRepos,
  listUserRows,
  revokeGitPassword,
  updateUser,
  userRow,
} from "../domain/users.ts";
import { parseBody, parseParams } from "./validate.ts";

/**
 * /api/users: user management. Admin only and not delegable: no permission
 * grants any of it, so nobody but the admin can widen their own access.
 *
 * Users are never created or deleted here. The Cloudflare Access policy is
 * the only list of who may get in; these routes edit what an existing user
 * may do, and re-read the policy on demand.
 */
export const userRoutes: FastifyPluginAsync = async (app) => {
  const { db, policy } = app.amber;
  const log = app.amber.log.child({ mod: "users" });
  const admin = { config: { authz: "admin" as const } };

  app.get("/users", admin, (): UserListResponse => ({ rows: listUserRows(db) }));

  // Registered before /users/:id so the static segment wins the match.
  app.post("/users/refresh", admin, async (): Promise<UserRefreshResponse> => {
    const outcome = await policy.refresh();
    return {
      ok: outcome.ok,
      error: outcome.error,
      policy: policy.status(),
      changes: outcome.changes,
    };
  });

  app.patch("/users/:id", admin, (request): UserRow => {
    const { id } = parseParams(idParamsSchema, request);
    const patch = parseBody(updateUserSchema, request);
    const user = updateUser(db, id, patch);
    log.info(
      {
        userId: id,
        permissions: patch.permissions === undefined ? undefined : Object.keys(patch.permissions),
        storageCap: patch.storageCapBytes !== undefined,
      },
      "user updated",
    );
    return userRow(db, user);
  });

  app.post("/users/:id/adopt-repos", admin, (request): AdoptReposResponse => {
    const { id } = parseParams(idParamsSchema, request);
    const adopted = adoptRepos(db, id);
    log.info({ fromUserId: id, adopted }, "admin adopted a user's repositories");
    return { userId: id, adopted };
  });

  app.post("/users/:id/revoke-git", admin, (request): UserRow => {
    const { id } = parseParams(idParamsSchema, request);
    const user = revokeGitPassword(db, id);
    log.info({ userId: id }, "git password revoked by the admin");
    return userRow(db, user);
  });
};
