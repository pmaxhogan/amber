import type { Status } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { countRepos, totalDiskUsageBytes } from "../domain/repos.ts";

/**
 * /api/status totals, queue depth, and breaker state.
 *
 * insecureMode is the important field: the web UI renders it as a permanent
 * undismissable banner, so it is reported straight from the config rather than
 * inferred from anything the request could influence.
 *
 * Scheduler figures read zero until the sync engine attaches a handle, which
 * keeps this route honest instead of guessing.
 */
export const statusRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, version, scheduler } = app.amber;

  app.get("/status", (): Status => {
    const queue = scheduler?.status() ?? { queueDepth: 0, activeSyncs: 0, breakerOpen: false };
    return {
      version,
      insecureMode: config.insecureMode,
      queueDepth: queue.queueDepth,
      activeSyncs: queue.activeSyncs,
      totalRepos: countRepos(db),
      totalDiskUsageBytes: totalDiskUsageBytes(db),
      breakerOpen: queue.breakerOpen,
    };
  });
};
