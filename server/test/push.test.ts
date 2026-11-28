import type { AmberEvent, PushPayload } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  createPushNotifier,
  deletePushSubscription,
  ensureVapidKeys,
  goneNotification,
  KV_VAPID_PRIVATE,
  listPushDevices,
  PUSH_ERRORS,
  savePushSubscription,
  vapidSubject,
  type PushSender,
  type StoredSubscription,
} from "../src/notify/push.ts";
import { createRepo } from "../src/domain/repos.ts";
import { createTempApp, createTempDb, seedForge, type TempApp, type TempDb } from "./helpers.ts";
import { adminOf } from "./helpers/users.ts";
import { usePublicDns } from "./helpers/egress.ts";

// Push endpoints are vetted by the egress guard; every name is public here.
usePublicDns();

const log = createConsoleLogger("silent");

interface Sent {
  endpoint: string;
  payload: PushPayload;
  subject: string;
  publicKey: string;
}

function recorder(fail: Record<string, unknown> = {}): { sent: Sent[]; send: PushSender } {
  const sent: Sent[] = [];
  return {
    sent,
    send: (subscription: StoredSubscription, payload, vapid) => {
      const failure = fail[subscription.endpoint];
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      sent.push({
        endpoint: subscription.endpoint,
        payload: JSON.parse(payload) as PushPayload,
        subject: vapid.subject,
        publicKey: vapid.publicKey,
      });
      return Promise.resolve();
    },
  };
}

function subscribe(db: Db, name: string): string {
  const endpoint = `https://push.example/${name}`;
  savePushSubscription(db, {
    userId: adminOf(db).id,
    endpoint,
    p256dh: `key-${name}`,
    auth: `auth-${name}`,
    userAgent: name,
  });
  return endpoint;
}

/** A repo.gone event for a real repo row (created on first use), owned by the admin. */
function gone(db: Db, path: string, host = "github.com"): AmberEvent {
  const forgeId = seedForge(db, host);
  const existing = db.get<{ id: number }>(
    "SELECT id FROM repos WHERE forge_id = ? AND path = ?",
    forgeId,
    path,
  );
  const repoId = existing?.id ?? createRepo(db, { forgeId, path, ownerUserId: adminOf(db).id }).id;
  return { type: "repo.gone", at: 1, payload: { repoId, path, host } };
}

describe("vapid", () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = createTempDb();
  });
  afterEach(() => {
    temp.close();
  });

  it("generates a key pair once and returns the same one afterwards", () => {
    const first = ensureVapidKeys(temp.db);
    const second = ensureVapidKeys(temp.db);

    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(second).toEqual(first);
    expect(
      temp.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", KV_VAPID_PRIVATE)?.value,
    ).toBe(first.privateKey);
  });

  it("uses an https origin as the contact and a placeholder for anything else", () => {
    expect(vapidSubject("https://amber.example.com")).toBe("https://amber.example.com");
    expect(vapidSubject("http://localhost:8080")).toBe("mailto:amber@example.invalid");
    expect(vapidSubject("not a url")).toBe("mailto:amber@example.invalid");
  });
});

describe("goneNotification", () => {
  it("names a single repository", () => {
    expect(goneNotification([{ host: "github.com", path: "a/b" }])).toEqual({
      title: "A repository is gone upstream",
      body: "github.com/a/b can no longer be fetched. Amber is keeping its backup.",
      url: "/removed",
      tag: "amber-gone",
    });
  });

  it("says so when the one repository was taken down by a DMCA notice", () => {
    expect(
      goneNotification([{ host: "github.com", path: "a/b", reason: "dmca_takedown" }]),
    ).toEqual({
      title: "A repository was taken down",
      body: "github.com/a/b was removed by a DMCA takedown. Amber is keeping its backup.",
      url: "/removed",
      tag: "amber-gone",
    });
  });

  it("names up to three and counts the rest", () => {
    const repos = ["a", "b", "c", "d", "e"].map((name) => ({
      host: "h.example",
      path: `o/${name}`,
    }));
    const three = goneNotification(repos.slice(0, 3));
    expect(three.title).toBe("3 repositories are gone upstream");
    expect(three.body).toBe(
      "h.example/o/a, h.example/o/b, h.example/o/c. Amber is keeping their backups.",
    );
    expect(goneNotification(repos).body).toContain("h.example/o/c and 2 more.");
  });
});

describe("push notifier", () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = createTempDb();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    temp.close();
  });

  function notifier(send: PushSender, batchWindowMs = 30_000) {
    return createPushNotifier({
      db: temp.db,
      log,
      publicOrigin: "https://amber.example.com",
      send,
      batchWindowMs,
      now: () => 1_000,
    });
  }

  it("sends to every subscribed browser and records the delivery", async () => {
    const a = subscribe(temp.db, "a");
    const b = subscribe(temp.db, "b");
    const { sent, send } = recorder();
    const push = notifier(send);

    const result = await push.send({ title: "t", body: "b", url: "/removed", tag: "x" }, [
      adminOf(temp.db).id,
    ]);

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(sent.map((s) => s.endpoint).sort()).toEqual([a, b]);
    expect(sent[0]).toMatchObject({
      subject: "https://amber.example.com",
      publicKey: push.publicKey(),
      payload: { title: "t", url: "/removed" },
    });
    expect(
      listPushDevices(temp.db, adminOf(temp.db).id).every((d) => d.lastSuccessAt === 1_000),
    ).toBe(true);
  });

  it("does nothing, and generates no keys, when nobody is subscribed", async () => {
    const { sent, send } = recorder();
    expect(
      await notifier(send).send({ title: "t", body: "b", url: "/", tag: "x" }, [
        adminOf(temp.db).id,
      ]),
    ).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(sent).toEqual([]);
    expect(temp.db.all("SELECT key FROM kv WHERE key LIKE 'push.%'")).toEqual([]);
  });

  it("drops a subscription the push service says is gone, and keeps one that merely failed", async () => {
    const expired = subscribe(temp.db, "expired");
    const flaky = subscribe(temp.db, "flaky");
    subscribe(temp.db, "fine");
    const { send } = recorder({
      [expired]: Object.assign(new Error("Received unexpected response code"), { statusCode: 410 }),
      [flaky]: Object.assign(new Error("push service is on fire"), { statusCode: 503 }),
    });

    const result = await notifier(send).send({ title: "t", body: "b", url: "/", tag: "x" }, [
      adminOf(temp.db).id,
    ]);

    expect(result).toEqual({ sent: 1, failed: 2 });
    const devices = listPushDevices(temp.db, adminOf(temp.db).id);
    expect(devices.map((d) => d.userAgent)).toEqual(["flaky", "fine"]);
    // A fixed category: never the status line or body the push service sent.
    expect(devices[0]?.lastError).toBe(PUSH_ERRORS.rejected);
    expect(devices[0]?.lastError).not.toMatch(/503|fire/);
    expect(devices[1]?.lastError).toBeNull();
  });

  it("records a failure that has no HTTP status at all", async () => {
    const offline = subscribe(temp.db, "offline");
    const { send } = recorder({ [offline]: new Error("getaddrinfo ENOTFOUND") });

    await notifier(send).send({ title: "t", body: "b", url: "/", tag: "x" }, [adminOf(temp.db).id]);

    expect(listPushDevices(temp.db, adminOf(temp.db).id)[0]?.lastError).toBe(
      PUSH_ERRORS.unreachable,
    );
  });

  it("batches repositories that go gone close together into one notification", async () => {
    subscribe(temp.db, "a");
    const { sent, send } = recorder();
    const push = notifier(send);

    push.handleEvent(gone(temp.db, "o/one"));
    push.handleEvent(gone(temp.db, "o/two"));
    push.handleEvent({ type: "sync.finished", at: 1, payload: { repoId: 1, outcome: "error" } });
    push.handleEvent({ type: "repo.gone", at: 1, payload: { repoId: 3 } });
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    await push.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.title).toBe("2 repositories are gone upstream");
    expect(sent[0]?.payload.body).toContain("github.com/o/one, github.com/o/two");

    push.handleEvent(gone(temp.db, "o/three"));
    await vi.advanceTimersByTimeAsync(30_000);
    await push.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload.title).toBe("A repository is gone upstream");
  });

  it("sends what is still batched when it closes", async () => {
    subscribe(temp.db, "a");
    const { sent, send } = recorder();
    const push = notifier(send);

    push.handleEvent(gone(temp.db, "o/one"));
    await push.close();

    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });

  it("re-subscribing the same endpoint refreshes its keys instead of duplicating", () => {
    const endpoint = subscribe(temp.db, "a");
    savePushSubscription(temp.db, {
      userId: adminOf(temp.db).id,
      endpoint,
      p256dh: "new",
      auth: "new",
      userAgent: "a2",
    });

    expect(listPushDevices(temp.db, adminOf(temp.db).id)).toHaveLength(1);
    expect(listPushDevices(temp.db, adminOf(temp.db).id)[0]).toMatchObject({
      service: "push.example",
      userAgent: "a2",
    });
    expect(deletePushSubscription(temp.db, endpoint, adminOf(temp.db).id)).toBe(true);
    expect(deletePushSubscription(temp.db, endpoint, adminOf(temp.db).id)).toBe(false);
  });
});

describe("/api/push", () => {
  let temp: TempApp;
  let sent: Sent[];

  beforeEach(async () => {
    const rec = recorder();
    sent = rec.sent;
    temp = await createTempApp({}, { pushSender: rec.send });
  });
  afterEach(async () => {
    await temp.close();
  });

  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: "BPubKey", auth: "authsecret" },
  };

  it("hands out the public key and never an endpoint", async () => {
    await temp.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      payload: subscription,
      headers: { "user-agent": "TestBrowser/1.0" },
    });

    const response = await temp.app.inject({ method: "GET", url: "/api/push" });
    const body = response.json<{ publicKey: string; devices: Record<string, unknown>[] }>();

    expect(response.statusCode).toBe(200);
    expect(body.publicKey).toBe(ensureVapidKeys(temp.db).publicKey);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({
      service: "fcm.googleapis.com",
      userAgent: "TestBrowser/1.0",
      lastSuccessAt: null,
    });
    expect(response.body).not.toContain("abc123");
    expect(response.body).not.toContain("authsecret");
    expect(response.body).not.toContain(ensureVapidKeys(temp.db).privateKey);
  });

  it("subscribes idempotently, sends a test, and unsubscribes", async () => {
    for (let round = 0; round < 2; round += 1) {
      const saved = await temp.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        payload: subscription,
      });
      expect(saved.statusCode).toBe(204);
    }
    expect(listPushDevices(temp.db, adminOf(temp.db).id)).toHaveLength(1);

    const test = await temp.app.inject({ method: "POST", url: "/api/push/test" });
    expect(test.json()).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toMatchObject({
      endpoint: subscription.endpoint,
      payload: { title: "Amber notifications are on", url: "/removed" },
    });

    for (let round = 0; round < 2; round += 1) {
      const removed = await temp.app.inject({
        method: "POST",
        url: "/api/push/unsubscribe",
        payload: { endpoint: subscription.endpoint },
      });
      expect(removed.statusCode).toBe(204);
    }
    expect(listPushDevices(temp.db, adminOf(temp.db).id)).toEqual([]);
    expect((await temp.app.inject({ method: "POST", url: "/api/push/test" })).json()).toEqual({
      sent: 0,
      failed: 0,
    });
  });

  it("refuses an endpoint that is not https, and malformed bodies", async () => {
    const bad = [
      { ...subscription, endpoint: "http://169.254.169.254/latest/meta-data" },
      { ...subscription, endpoint: "file:///etc/passwd" },
      { ...subscription, endpoint: "not a url" },
      { endpoint: subscription.endpoint },
      { endpoint: subscription.endpoint, keys: { p256dh: "", auth: "x" } },
    ];
    for (const payload of bad) {
      const response = await temp.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(listPushDevices(temp.db, adminOf(temp.db).id)).toEqual([]);
    expect(
      (await temp.app.inject({ method: "POST", url: "/api/push/unsubscribe", payload: {} }))
        .statusCode,
    ).toBe(400);
  });

  it("notifies when the bus reports a gone repository, without counting as a client", async () => {
    await temp.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      payload: subscription,
    });
    expect(temp.events.subscriberCount).toBe(0);

    const imported = await temp.app.inject({
      method: "POST",
      url: "/api/import",
      payload: { text: "https://github.com/o/vanished" },
    });
    const repoId = imported.json<{ results: { repoId: number }[] }>().results[0]?.repoId;
    temp.events.publish("repo.gone", { repoId, path: "o/vanished", host: "github.com" });
    await temp.app.amber.push.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.body).toContain("github.com/o/vanished");
  });
});

describe("GET /api/repos?gone and /api/status", () => {
  let temp: TempApp;
  beforeEach(async () => {
    temp = await createTempApp();
  });
  afterEach(async () => {
    await temp.close();
  });

  it("filters and sorts by gone, and counts it in status", async () => {
    await temp.app.inject({
      method: "POST",
      url: "/api/import",
      payload: {
        text: "https://github.com/o/alive\nhttps://github.com/o/older\nhttps://github.com/o/newer",
      },
    });
    temp.db.run("UPDATE repos SET gone_at = 100 WHERE path = 'o/older'");
    temp.db.run("UPDATE repos SET gone_at = 200 WHERE path = 'o/newer'");

    const paths = async (query: string): Promise<string[]> =>
      (await temp.app.inject({ method: "GET", url: `/api/repos?${query}` }))
        .json<{ rows: { path: string; goneAt: number | null }[] }>()
        .rows.map((row) => row.path);

    expect(await paths("gone=true&sort=gone_at&dir=desc")).toEqual(["o/newer", "o/older"]);
    expect(await paths("gone=true&sort=gone_at&dir=asc")).toEqual(["o/older", "o/newer"]);
    expect(await paths("gone=false")).toEqual(["o/alive"]);
    expect(await paths("sort=path")).toHaveLength(3);

    const status = (await temp.app.inject({ method: "GET", url: "/api/status" })).json<{
      goneRepos: number;
      totalRepos: number;
    }>();
    expect(status).toMatchObject({ goneRepos: 2, totalRepos: 3 });
  });
});
