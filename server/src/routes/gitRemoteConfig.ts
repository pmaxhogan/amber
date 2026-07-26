import { updateGitRemoteSchema, type GitRemoteConfig, type GitRemoteSecret } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import {
  disableGitRemote,
  enableGitRemote,
  GitRemoteDisabledError,
  readGitRemoteState,
  rotateGitRemotePassword,
  setGitRemoteUsername,
  toGitRemoteConfig,
} from "../gitremote/config.ts";
import { parseBody } from "./validate.ts";

/**
 * /api/git-remote enable, disable, and rotate.
 *
 * The plaintext password exists in exactly one place in the system: the body of
 * the enable and rotate responses. It is never logged, never stored, and never
 * returned by GET.
 */
export const gitRemoteConfigRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.amber;
  const log = ctx.log.child({ mod: "gitremote" });

  const view = (): GitRemoteConfig =>
    toGitRemoteConfig(readGitRemoteState(ctx.db), ctx.config.publicOrigin);

  app.get("/git-remote", (): GitRemoteConfig => view());

  /**
   * Renames the basic-auth user. Works enabled or disabled, and never touches
   * the password: existing clones keep working only if their stored URL is
   * updated too, which is why the response carries the fresh clone template.
   */
  app.patch("/git-remote", (request): GitRemoteConfig => {
    const { username } = parseBody(updateGitRemoteSchema, request);
    const state = setGitRemoteUsername(ctx.db, username);
    log.info({ enabled: state.enabled }, "git remote username changed");
    return toGitRemoteConfig(state, ctx.config.publicOrigin);
  });

  app.post("/git-remote/enable", (): GitRemoteSecret => {
    const { state, password } = enableGitRemote(ctx.db);
    log.info("git remote enabled and a new password minted");
    return { ...toGitRemoteConfig(state, ctx.config.publicOrigin), password };
  });

  app.post("/git-remote/rotate", (_request, reply): GitRemoteSecret | void => {
    try {
      const { state, password } = rotateGitRemotePassword(ctx.db);
      log.info("git remote password rotated");
      return { ...toGitRemoteConfig(state, ctx.config.publicOrigin), password };
    } catch (error) {
      if (error instanceof GitRemoteDisabledError) {
        reply.code(409).send({ error: "git_remote_disabled", message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/git-remote/disable", (): GitRemoteConfig => {
    const state = disableGitRemote(ctx.db);
    log.info("git remote disabled and its password destroyed");
    return toGitRemoteConfig(state, ctx.config.publicOrigin);
  });
};
