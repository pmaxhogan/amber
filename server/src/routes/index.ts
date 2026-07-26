import type { FastifyPluginAsync } from "fastify";
import { accountRoutes } from "./accounts.ts";
import { accountSyncRoutes } from "./accountSyncs.ts";
import { eventRoutes } from "./events.ts";
import { exportRoutes } from "./exports.ts";
import { forgeRoutes } from "./forges.ts";
import { gitRemoteConfigRoutes } from "./gitRemoteConfig.ts";
import { importRoutes } from "./imports.ts";
import { repoRoutes } from "./repos.ts";
import { settingsRoutes } from "./settings.ts";
import { statusRoutes } from "./status.ts";
import { toApiError } from "./validate.ts";

/** Everything under /api. Each plugin is thin and calls into domain/*. */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  /**
   * One translation point from thrown errors to the shared ApiError shape.
   * Scoped to /api, so the git remote keeps its own plain text responses.
   */
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toApiError(error);
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled route error");
    } else {
      request.log.debug({ err: error, status }, "request rejected");
    }
    void reply.code(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: "not_found",
      message: `No API route matches ${request.method} ${request.url}.`,
    });
  });

  await app.register(forgeRoutes);
  await app.register(accountRoutes);
  await app.register(repoRoutes);
  await app.register(importRoutes);
  await app.register(settingsRoutes);
  await app.register(accountSyncRoutes);
  await app.register(gitRemoteConfigRoutes);
  await app.register(exportRoutes);
  await app.register(statusRoutes);
  await app.register(eventRoutes, {});
};
