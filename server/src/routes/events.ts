import type { AmberEvent } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { getUser } from "../domain/users.ts";
import { requireRequestUser } from "../security/authz.ts";
import { mayReceiveEvent } from "../security/eventAudience.ts";

/**
 * Proxies and load balancers drop an idle stream; a comment line every 25s
 * keeps it open and costs nothing. Comments are ignored by EventSource.
 */
export const SSE_HEARTBEAT_MS = 25_000;

export interface EventRoutesOptions {
  /** Overridden in tests so the heartbeat can be observed quickly. */
  heartbeatMs?: number;
}

/**
 * SSE frame. Only the three wire fields are serialized, never whatever else
 * travels with an event on the server (EventMeta never reaches this point,
 * and nothing added to AmberEvent later rides along by accident).
 */
function frame(event: AmberEvent): string {
  const wire = { type: event.type, at: event.at, payload: event.payload };
  return `event: ${event.type}\ndata: ${JSON.stringify(wire)}\n\n`;
}

/**
 * /api/events SSE stream backed by the EventBus.
 *
 * Every event is filtered per stream at SEND time (security/eventAudience.ts)
 * against the user's row as it is now, not as it was when the stream opened.
 * A stream whose user has been removed is closed on the next event or
 * heartbeat, and the heartbeat re-applies the membership rule for non-admins,
 * since an open stream makes no requests that would.
 */
export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (app, options) => {
  const { events, db, policy } = app.amber;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const log = app.log.child({ mod: "events" });

  app.get("/events", { config: { authz: "user" } }, (request, reply) => {
    const userId = requireRequestUser(request).id;
    // Fastify must not try to serialize or finish this response.
    reply.hijack();

    const { raw } = reply;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tells nginx and friends not to buffer the stream.
      "x-accel-buffering": "no",
    });
    raw.write(": connected\n\n");

    const write = (chunk: string): void => {
      if (!raw.writableEnded) {
        raw.write(chunk);
      }
    };

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    // Assigned below; cleanup only ever runs after that.
    const timers: { heartbeat?: NodeJS.Timeout } = {};

    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (timers.heartbeat !== undefined) {
        clearInterval(timers.heartbeat);
      }
      unsubscribe();
      log.debug({ subscribers: events.subscriberCount }, "sse client disconnected");
    };

    /** End the stream from our side: the user no longer has access. */
    const shut = (reason: string): void => {
      if (closed) {
        return;
      }
      log.info({ userId, reason }, "closing an event stream");
      cleanup();
      if (!raw.writableEnded) {
        raw.end();
      }
    };

    /** The user as they are now, or null when they lost access. */
    const current = () => {
      const user = getUser(db, userId);
      return user === undefined || user.removedAt !== null ? null : user;
    };

    unsubscribe = events.subscribe((event, meta) => {
      if (closed) {
        return;
      }
      const user = current();
      if (user === null) {
        shut("user removed");
        return;
      }
      try {
        if (mayReceiveEvent(db, user, event, meta)) {
          write(frame(event));
        }
      } catch (error) {
        // Fail closed: an event that cannot be checked is not sent.
        log.warn({ err: error, type: event.type }, "could not check an event's audience");
      }
    });

    const heartbeat = setInterval(() => {
      const user = current();
      if (user === null) {
        shut("user removed");
        return;
      }
      if (!user.isAdmin) {
        void policy
          .membership(user.email)
          .then((decision) => {
            if (decision !== "allow") {
              shut(`membership ${decision}`);
            }
          })
          .catch(() => {
            shut("membership check failed");
          });
      }
      write(": heartbeat\n\n");
    }, heartbeatMs);
    timers.heartbeat = heartbeat;
    // A pending heartbeat must never hold the process open on shutdown.
    heartbeat.unref();

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    raw.on("close", cleanup);
    raw.on("error", cleanup);
  });
};
