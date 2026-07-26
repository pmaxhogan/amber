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

/** Everything under /api. Each plugin is thin and calls into domain/*. */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  await app.register(forgeRoutes);
  await app.register(accountRoutes);
  await app.register(repoRoutes);
  await app.register(importRoutes);
  await app.register(settingsRoutes);
  await app.register(accountSyncRoutes);
  await app.register(gitRemoteConfigRoutes);
  await app.register(exportRoutes);
  await app.register(statusRoutes);
  await app.register(eventRoutes);
};
