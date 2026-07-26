import type { AmberEvent } from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";

/**
 * Proxies and load balancers drop an idle stream; a comment line every 25s
 * keeps it open and costs nothing. Comments are ignored by EventSource.
 */
export const SSE_HEARTBEAT_MS = 25_000;

export interface EventRoutesOptions {
  /** Overridden in tests so the heartbeat can be observed quickly. */
  heartbeatMs?: number;
}

/** SSE frame. The event name lets the client dispatch without parsing first. */
function frame(event: AmberEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** /api/events SSE stream backed by the EventBus. */
export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (app, options) => {
  const { events } = app.amber;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const log = app.log.child({ mod: "events" });

  app.get("/events", (request, reply) => {
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

    const unsubscribe = events.subscribe((event) => {
      write(frame(event));
    });

    const heartbeat = setInterval(() => {
      write(": heartbeat\n\n");
    }, heartbeatMs);
    // A pending heartbeat must never hold the process open on shutdown.
    heartbeat.unref();

    let closed = false;
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      log.debug({ subscribers: events.subscriberCount }, "sse client disconnected");
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    raw.on("close", cleanup);
    raw.on("error", cleanup);
  });
};
