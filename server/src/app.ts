import type { IncomingMessage, ServerResponse } from "node:http";
import type { Health } from "@amber/shared";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import type { Logger } from "pino";
import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import { EventBus } from "./events.ts";
import { bootstrapAdmin } from "./domain/users.ts";
import { createPushNotifier, type PushNotifier, type PushSender } from "./notify/push.ts";
import { gitRemotePlugin } from "./gitremote/routes.ts";
import { apiRoutes } from "./routes/index.ts";
import { AccessPolicy, type PolicyFetch, type PolicySource } from "./security/accessPolicy.ts";
import {
  assertRouteDeclaresAuthz,
  enforceRouteAuthz,
  isApiPath,
  type AuthzRequirement,
} from "./security/authz.ts";
import { cfAccessPlugin, requestPathname, type CfAccessKeyGetter } from "./security/cfAccess.ts";
import { identityPlugin } from "./security/identity.ts";
import { APP_VERSION } from "./version.ts";
import { webPlugin } from "./web.ts";

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
  push: PushNotifier;
  /**
   * The Access policy reader and THE MEMBERSHIP RULE. The git remote calls
   * `policy.membership(email)` for every non-admin identity, exactly as the
   * web identity hook does.
   */
  policy: AccessPolicy;
  /** The clock identity and the policy read. Date.now outside tests. */
  now: () => number;
  /** Every route as registered, for the authz table test. */
  routes: RegisteredRoute[];
}

export interface RegisteredRoute {
  method: string;
  url: string;
  authz: AuthzRequirement | undefined;
}

export interface BuildAppDeps {
  config: Config;
  log: Logger;
  db: Db;
  events?: EventBus;
  version?: string;
  scheduler?: SchedulerHandle;
  /** Test seam: replaces the HTTP call to the browser push service. */
  pushSender?: PushSender;
  /** Test seam for the CF Access JWKS. Omitted in production. */
  cfAccessGetKey?: CfAccessKeyGetter;
  /** Test seam: answers the Cloudflare policy read without the network. */
  accessPolicyFetch?: PolicyFetch;
  /** Test seam: the clock the membership rule and last_seen_at run on. */
  now?: () => number;
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
  const events = deps.events ?? new EventBus();
  const now = deps.now ?? Date.now;
  const { config } = deps;

  if (config.adminEmailSource === "legacy") {
    deps.log.warn(
      "CF_ACCESS_ALLOWED_EMAILS is deprecated: its first entry is the admin and every other " +
        "entry is ignored. Set AMBER_ADMIN_EMAIL and list users in the Access policy instead.",
    );
  }
  // Fills in the address migration 010 could not know. Before anything can
  // answer a request, so the admin is recognised from the first one.
  bootstrapAdmin(deps.db, deps.log.child({ mod: "users" }), config.adminEmail, now());

  const policySource: PolicySource | null = config.insecureMode
    ? config.insecureUserEmails.length > 0
      ? { kind: "static", emails: config.insecureUserEmails }
      : null
    : config.accessPolicy === null
      ? null
      : { kind: "cloudflare", ...config.accessPolicy };
  const policy = new AccessPolicy({
    db: deps.db,
    log: deps.log,
    source: policySource,
    now,
    ...(deps.accessPolicyFetch === undefined ? {} : { fetch: deps.accessPolicyFetch }),
  });

  const push = createPushNotifier({
    db: deps.db,
    log: deps.log,
    publicOrigin: deps.config.publicOrigin,
    ...(deps.pushSender === undefined ? {} : { send: deps.pushSender }),
  });
  const ctx: AppContext = {
    config: deps.config,
    log: deps.log,
    db: deps.db,
    events,
    push,
    policy,
    now,
    routes: [],
    version: deps.version ?? APP_VERSION,
    ...(deps.scheduler === undefined ? {} : { scheduler: deps.scheduler }),
  };

  const app = Fastify({
    loggerInstance: deps.log,
    trustProxy: true,
  });

  app.decorate("amber", ctx);

  // At the root and before any plugin, so it sees every route wherever it is
  // registered. An /api route without an authz declaration aborts the boot.
  app.addHook("onRoute", (route) => {
    assertRouteDeclaresAuthz(route);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      ctx.routes.push({ method: String(method), url: route.url, authz: route.config?.authz });
    }
  });

  policy.start();
  app.addHook("onClose", async () => {
    policy.stop();
  });

  // The sync engine only knows the bus; the notifier listens there for gone
  // repositories, so neither imports the other.
  const stopPush = events.tap((event, meta) => {
    push.handleEvent(event, meta);
  });
  app.addHook("onClose", async () => {
    stopPush();
    await push.close();
  });

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
  // Right after the token check: turns a verified email into request.user, or
  // refuses it. Installed in insecure mode too, where there is no token.
  await app.register(identityPlugin, { config: ctx.config, db: ctx.db, policy, now });
  /**
   * The coarse authorization check for every /api request. At the root, by
   * PATH, for the same reason the boot check is: an /api route registered
   * outside the apiRoutes plugin must not slip past enforcement while looking
   * declared in the route table. Runs after identity, so request.user is set.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (!isApiPath(requestPathname(request.url))) {
      return undefined;
    }
    return enforceRouteAuthz(request, reply);
  });

  await app.register(apiRoutes, { prefix: "/api" });
  await app.register(gitRemotePlugin, { ctx });
  // Last, so its catch-all fallback cannot shadow a real route.
  await app.register(webPlugin, { config: ctx.config });

  return app;
}
