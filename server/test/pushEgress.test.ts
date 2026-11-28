import { request } from "node:https";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleLogger } from "../src/logging.ts";
import {
  createPushNotifier,
  listPushDevices,
  PUSH_ERRORS,
  savePushSubscription,
  type PushSender,
} from "../src/notify/push.ts";
import { pinnedHttpsAgent, type VettedTarget } from "../src/security/egress.ts";
import { fakeDns, PUBLIC_V4, usePublicDns } from "./helpers/egress.ts";
import { createTempApp, createTempDb, type TempApp, type TempDb } from "./helpers.ts";
import { adminOf } from "./helpers/users.ts";

/**
 * Web push endpoints are user-supplied URLs Amber POSTs to, so they get the
 * restricted-forge egress rule: refused at subscribe time, re-vetted and
 * pinned at every send, and a failure records a fixed category, never what
 * the far end answered.
 */

const log = createConsoleLogger("silent");
const keys = { p256dh: "BPubKey", auth: "authsecret" };

describe("push send", () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createTempDb();
  });

  afterEach(() => {
    temp.close();
  });

  function subscribe(endpoint: string): void {
    savePushSubscription(temp.db, {
      userId: adminOf(temp.db).id,
      endpoint,
      ...keys,
      userAgent: "ua",
    });
  }

  it("hands the sender the validated addresses to pin to", async () => {
    subscribe("https://push.example.com/abc");
    const pins: VettedTarget[] = [];
    const send: PushSender = (_subscription, _payload, _vapid, pin) => {
      pins.push(pin);
      return Promise.resolve();
    };
    const notifier = createPushNotifier({
      db: temp.db,
      log,
      publicOrigin: "https://amber.example.com",
      send,
      resolveHost: fakeDns({ "push.example.com": [PUBLIC_V4] }),
    });
    await expect(
      notifier.send({ title: "t", body: "b", url: "/", tag: "x" }, [adminOf(temp.db).id]),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    expect(pins).toEqual([
      { protocol: "https", host: "push.example.com", port: 443, addresses: [PUBLIC_V4] },
    ]);
  });

  it("refuses at send time an endpoint that rebound to a private address", async () => {
    subscribe("https://push.example.com/abc");
    let calls = 0;
    const send: PushSender = () => {
      calls += 1;
      return Promise.resolve();
    };
    const notifier = createPushNotifier({
      db: temp.db,
      log,
      publicOrigin: "https://amber.example.com",
      send,
      resolveHost: fakeDns({ "push.example.com": ["10.0.0.8"] }),
    });
    await expect(
      notifier.send({ title: "t", body: "b", url: "/", tag: "x" }, [adminOf(temp.db).id]),
    ).resolves.toEqual({ sent: 0, failed: 1 });
    expect(calls).toBe(0);
    const device = listPushDevices(temp.db, adminOf(temp.db).id)[0];
    expect(device?.lastError).toBe(PUSH_ERRORS.refused);
    expect(device?.lastError).not.toContain("10.0.0.8");
  });

  it.each([
    [
      "an HTTP refusal",
      Object.assign(new Error("Received unexpected response code"), {
        statusCode: 401,
        body: "internal admin panel says hello",
      }),
      "rejected",
    ],
    ["a timeout", new Error("Socket timeout"), "timeout"],
    ["a connection failure", new Error("connect ECONNREFUSED 93.184.215.14:443"), "unreachable"],
  ] as const)("records only a fixed category for %s", async (_label, failure, category) => {
    subscribe("https://push.example.com/abc");
    const notifier = createPushNotifier({
      db: temp.db,
      log,
      publicOrigin: "https://amber.example.com",
      send: () => Promise.reject(failure),
      resolveHost: fakeDns({}, [PUBLIC_V4]),
    });
    await notifier.send({ title: "t", body: "b", url: "/", tag: "x" }, [adminOf(temp.db).id]);
    const stored = listPushDevices(temp.db, adminOf(temp.db).id)[0]?.lastError;
    expect(stored).toBe(PUSH_ERRORS[category]);
    expect(stored).not.toMatch(/401|hello|ECONNREFUSED|93\.184/);
  });
});

describe("POST /api/push/subscriptions", () => {
  let temp: TempApp;
  const sent: string[] = [];

  usePublicDns(
    fakeDns(
      {
        "metadata.example.com": ["169.254.169.254"],
        "mixed.example.com": [PUBLIC_V4, "127.0.0.1"],
      },
      [PUBLIC_V4],
    ),
  );

  beforeEach(async () => {
    sent.length = 0;
    temp = await createTempApp(
      {},
      {
        pushSender: (subscription) => {
          sent.push(subscription.endpoint);
          return Promise.resolve();
        },
      },
    );
  });

  afterEach(async () => {
    await temp.close();
  });

  async function subscribe(endpoint: string) {
    return temp.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      payload: { endpoint, keys },
    });
  }

  it("accepts an endpoint on a public host", async () => {
    expect((await subscribe("https://fcm.googleapis.com/fcm/send/abc")).statusCode).toBe(204);
  });

  it.each([
    ["a host that resolves to cloud metadata", "https://metadata.example.com/x", "not_public"],
    ["a mixed answer", "https://mixed.example.com/x", "not_public"],
    ["a non-standard port", "https://push.example.com:8443/x", "port"],
    ["an IP literal", "https://127.0.0.1/x", "ip_literal"],
    ["an integer IP", "https://2130706433/x", "ip_literal"],
    ["a single label", "https://intranet/x", "invalid_host"],
  ])("refuses %s, saving nothing and naming no address", async (_label, endpoint, reason) => {
    const response = await subscribe(endpoint);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "host_not_allowed", details: { reason } });
    expect(response.body).not.toMatch(/169\.254|127\.0\.0\.1/);
    expect(temp.db.all("SELECT id FROM push_subscriptions")).toEqual([]);
  });

  it("never lets the test notification reach a refused endpoint, or report what it said", async () => {
    // Planted directly, as if it had passed the check before rebinding.
    savePushSubscription(temp.db, {
      userId: adminOf(temp.db).id,
      endpoint: "https://metadata.example.com/latest",
      ...keys,
      userAgent: "ua",
    });
    const response = await temp.app.inject({ method: "POST", url: "/api/push/test" });
    expect(response.json()).toEqual({ sent: 0, failed: 1 });
    expect(sent).toEqual([]);
    const devices = await temp.app.inject({ method: "GET", url: "/api/push" });
    expect(devices.json()).toMatchObject({ devices: [{ lastError: PUSH_ERRORS.refused }] });
    expect(devices.body).not.toContain("169.254");
  });
});

describe("pinnedHttpsAgent", () => {
  let server: Server | undefined;
  let sockets: Socket[];

  beforeEach(() => {
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
    server = undefined;
  });

  it("connects a name that resolves nowhere to the pinned address", async () => {
    // A bare TCP server: the TLS handshake will fail, but the connection
    // arriving at all proves the agent used the pin.
    const connected = new Promise<void>((resolve) => {
      server = createServer((socket) => {
        sockets.push(socket);
        resolve();
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server?.address() as AddressInfo).port;
    const agent = pinnedHttpsAgent({
      protocol: "https",
      host: "pinned.invalid",
      port,
      addresses: ["127.0.0.1"],
    });
    const failed = new Promise<void>((resolve) => {
      const outgoing = request(`https://pinned.invalid:${String(port)}/`, { agent });
      outgoing.on("error", () => {
        resolve();
      });
      outgoing.end();
    });
    await connected;
    await failed;
    agent.destroy();
  });
});
