import type { IncomingMessage, ServerResponse } from "node:http";
import type { Health } from "@amber/shared";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import type { Logger } from "pino";
import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import { EventBus } from "./events.ts";
import { gitRemotePlugin } from "./gitremote/routes.ts";
import { apiRoutes } from "./routes/index.ts";
import { cfAccessPlugin, type CfAccessKeyGetter } from "./security/cfAccess.ts";
import { APP_VERSION } from "./version.ts";

/**
 * The slice of the sync scheduler the API needs. Declared structurally rather
 * than imported from sync/ so the two modules stay independent; the Scheduler
 * class satisfies it. Absent until the sync engine is wired in, in which case
 * /api/status reports an idle queue and "sync now" falls back to persisting
 * next_sync_at, which the scheduler picks up on its next wake.
 */
export interface SchedulerHandle {
  status(): { queueDepth: number; activeSyncs: number; breakerOpen: boolean };
  enqueueNow(repoId: number): void;
}

/** Everything a route plugin needs. Decorated onto the Fastify instance. */
export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  events: EventBus;
  version: string;
  scheduler?: SchedulerHandle;
}

export interface BuildAppDeps {
  config: Config;
  log: Logger;
  db: Db;
  events?: EventBus;
  version?: string;
  scheduler?: SchedulerHandle;
  /** Test seam for the CF Access JWKS. Omitted in production. */
  cfAccessGetKey?: CfAccessKeyGetter;
}

declare module "fastify" {
  interface FastifyInstance {
    amber: AppContext;
  }
}

/** The Fastify instance shape once the pino logger instance is attached. */
export type AmberApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export const INSECURE_BANNER =
  "INSECURE_ALLOW_PUBLIC_ACCESS is set: authentication is disabled and the server " +
  "is bound to 127.0.0.1 only. Never expose this port.";

/**
 * Build the Fastify instance. Exported separately from index.ts so tests can
 * drive it with app.inject() without binding a port.
 */
export async function buildApp(deps: BuildAppDeps): Promise<AmberApp> {
  const ctx: AppContext = {
    config: deps.config,
    log: deps.log,
    db: deps.db,
    events: deps.events ?? new EventBus(),
    version: deps.version ?? APP_VERSION,
    ...(deps.scheduler === undefined ? {} : { scheduler: deps.scheduler }),
  };

  const app = Fastify({
    loggerInstance: deps.log,
    trustProxy: true,
  });

  app.decorate("amber", ctx);

  if (ctx.config.insecureMode) {
    deps.log.warn(INSECURE_BANNER);
  }

  // Unauthenticated by design: the docker healthcheck uses it.
  app.get("/healthz", (): Health => ({ ok: true, version: ctx.version }));

  // No-op in insecure mode; otherwise guards everything except /healthz and /git/*.
  await app.register(cfAccessPlugin, {
    config: ctx.config,
    ...(deps.cfAccessGetKey === undefined ? {} : { getKey: deps.cfAccessGetKey }),
  });

  await app.register(apiRoutes, { prefix: "/api" });
  await app.register(gitRemotePlugin, { ctx });

  return app;
}
