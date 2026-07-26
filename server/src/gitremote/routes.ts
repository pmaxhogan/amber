import type { FastifyPluginAsync } from "fastify";
import type { AppContext } from "../app.ts";

/**
 * Smart HTTP v2, read only. Registered only when the git remote is enabled in
 * kv. git-receive-pack is never spawned anywhere in the codebase, so pushes are
 * impossible by construction rather than by check.
 */
export const gitRemotePlugin: FastifyPluginAsync<{ ctx: AppContext }> = async () => {
  // TODO: GET /git/:slug/info/refs and POST /git/:slug/git-upload-pack.
};
