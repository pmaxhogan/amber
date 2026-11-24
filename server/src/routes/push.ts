import {
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  type PushConfig,
  type PushSendResult,
} from "@amber/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deletePushSubscription, listPushDevices, savePushSubscription } from "../notify/push.ts";

/**
 * /api/push: the browser side of web push. A browser reads the public key,
 * subscribes with its own push service, and hands the subscription here.
 *
 * The endpoint a browser supplies is a URL amber will later POST to, so it is
 * https only (shared schema) and never echoed back: responses name the push
 * service host and nothing more.
 */
export const pushRoutes: FastifyPluginAsync = async (app) => {
  const { db, push } = app.amber;

  app.get("/push", (): PushConfig => ({
    publicKey: push.publicKey(),
    devices: listPushDevices(db),
  }));

  app.post("/push/subscriptions", (request, reply) => {
    const body = pushSubscribeSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", message: z.prettifyError(body.error) });
    }
    const userAgent = request.headers["user-agent"];
    savePushSubscription(db, {
      endpoint: body.data.endpoint,
      p256dh: body.data.keys.p256dh,
      auth: body.data.keys.auth,
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : null,
    });
    return reply.code(204).send();
  });

  // The endpoint travels in the body, not the path: it is a long URL and a
  // capability, and neither belongs in an access log.
  app.post("/push/unsubscribe", (request, reply) => {
    const body = pushUnsubscribeSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", message: z.prettifyError(body.error) });
    }
    // Unsubscribing something already gone is the state the caller wanted.
    deletePushSubscription(db, body.data.endpoint);
    return reply.code(204).send();
  });

  app.post("/push/test", (): Promise<PushSendResult> =>
    push.send({
      title: "Amber notifications are on",
      body: "This is what you will get when a repository goes gone upstream.",
      url: "/removed",
      tag: "amber-test",
    }),
  );
};
