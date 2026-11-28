import type { Status } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { countGoneRepos, countRepos, totalDiskUsageBytes } from "../domain/repos.ts";
import { requireRequestUser } from "../security/authz.ts";

/**
 * /api/status totals, queue depth, and breaker state.
 *
 * insecureMode is the important field: the web UI renders it as a permanent
 * undismissable banner, so it is reported straight from the config rather than
 * inferred from anything the request could influence.
 *
 * Scheduler figures read zero until the sync engine attaches a handle, which
 * keeps this route honest instead of guessing.
 *
 * The repository totals count only what the caller can view, in SQL. The
 * queue figures and the breaker are instance-wide and say nothing about any
 * one repository.
 */
export const statusRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, version, scheduler } = app.amber;

  app.get("/status", { config: { authz: "user" } }, (request): Status => {
    const user = requireRequestUser(request);
    const queue = scheduler?.status() ?? { queueDepth: 0, activeSyncs: 0, breakerOpen: false };
    return {
      version,
      insecureMode: config.insecureMode,
      queueDepth: queue.queueDepth,
      activeSyncs: queue.activeSyncs,
      totalRepos: countRepos(db, user),
      goneRepos: countGoneRepos(db, user),
      totalDiskUsageBytes: totalDiskUsageBytes(db, user),
      breakerOpen: queue.breakerOpen,
    };
  });
};
