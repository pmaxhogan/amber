import type { GitRemoteCredential, GitRemoteMe } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { requireUser, revokeGitPassword } from "../domain/users.ts";
import { setGitRemoteEnabled } from "../gitremote/config.ts";
import { mintGitCredential, toGitRemoteMe } from "../gitremote/credentials.ts";
import { requireRequestUser } from "../security/authz.ts";

/**
 * /api/git-remote: the CALLER'S own git credential, plus the instance-wide
 * kill switch.
 *
 * - GET, rotate and revoke act on the caller's own row only and need `git`.
 *   There is no path parameter, so no request can name someone else's
 *   credential; the admin revokes other people's with
 *   POST /api/users/:id/revoke-git.
 * - enable and disable flip the kill switch and need `manage_settings`.
 *
 * The plaintext password exists in exactly one place in the system: the body
 * of the rotate response. It is never logged, never stored, and never
 * returned by GET.
 */
export const gitRemoteConfigRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.amber;
  const log = ctx.log.child({ mod: "gitremote" });

  /** Re-read so the answer reflects the write the handler just made. */
  const me = (userId: number): GitRemoteMe =>
    toGitRemoteMe(ctx.db, requireUser(ctx.db, userId), ctx.config.publicOrigin);

  app.get("/git-remote", { config: { authz: "git" } }, (request): GitRemoteMe => {
    return me(requireRequestUser(request).id);
  });

  app.post("/git-remote/rotate", { config: { authz: "git" } }, (request): GitRemoteCredential => {
    const user = requireRequestUser(request);
    const minted = mintGitCredential(ctx.db, user.id, { now: ctx.now() });
    // The user id only: neither the username nor the secret goes to the log.
    log.info({ userId: user.id, first: user.gitUsername === null }, "git credential minted");
    return { ...me(user.id), username: minted.username, password: minted.password };
  });

  app.post("/git-remote/revoke", { config: { authz: "git" } }, (request): GitRemoteMe => {
    const user = requireRequestUser(request);
    revokeGitPassword(ctx.db, user.id, ctx.now());
    log.info({ userId: user.id }, "git credential revoked by its owner");
    return me(user.id);
  });

  app.post(
    "/git-remote/enable",
    { config: { authz: "manage_settings" } },
    (request): GitRemoteMe => {
      const user = requireRequestUser(request);
      setGitRemoteEnabled(ctx.db, true, ctx.now());
      log.info({ userId: user.id }, "git remote enabled");
      return me(user.id);
    },
  );

  app.post(
    "/git-remote/disable",
    { config: { authz: "manage_settings" } },
    (request): GitRemoteMe => {
      const user = requireRequestUser(request);
      setGitRemoteEnabled(ctx.db, false, ctx.now());
      log.info({ userId: user.id }, "git remote disabled");
      return me(user.id);
    },
  );
};
