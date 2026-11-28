import type { AmberEventType, PushPayload } from "@amber/shared";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.ts";
import { createRepo } from "../../src/domain/repos.ts";
import { updateUser, type User } from "../../src/domain/users.ts";
import { insertAccountSync } from "../../src/providers/discovery.ts";
import { eventRoutes } from "../../src/routes/events.ts";
import { INSECURE_USER_HEADER } from "../../src/security/identity.ts";
import type { PushSender, StoredSubscription } from "../../src/notify/push.ts";
import { createTempApp, seedForge, type TempApp } from "../helpers.ts";
import { asUser } from "../helpers/accessFixtures.ts";
import { adminOf, makeUser } from "../helpers/users.ts";

/**
 * Live surfaces (the SSE stream, web push, /api/status) are filtered by what
 * the caller can view, and the SSE and push decisions are made at SEND time,
 * so a permission change or a visibility flip applies to a stream that is
 * already open. These tests drive the real routes with real identities.
 *
 * Absence is proven with a sentinel: a status.changed event reaches every
 * stream, delivery is in publish order, so once the sentinel has arrived
 * anything published before it that was going to arrive already has.
 */

const EMAILS = {
  alice: "alice@example.com",
  bob: "bob@example.com",
  nothing: "nothing@example.com",
  viewPrivate: "viewprivate@example.com",
  gone: "gone@example.com",
} as const;

type Who = "admin" | "alice" | "bob" | "nothing" | "viewPrivate";
const ALL: readonly Who[] = ["admin", "alice", "bob", "nothing", "viewPrivate"];

/** Who can see alice's repos: [private repo, public repo]. */
const SEES: Record<Who, { private: boolean; public: boolean }> = {
  admin: { private: true, public: true },
  alice: { private: true, public: true },
  bob: { private: false, public: true },
  nothing: { private: false, public: false },
  viewPrivate: { private: true, public: true },
};

function headersFor(who: Who): Record<string, string> {
  return who === "admin" ? {} : asUser(EMAILS[who]);
}

interface Frame {
  type: string;
  at: number;
  payload: Record<string, unknown>;
  raw: string;
}

class Sse {
  buffer = "";
  ended = false;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #controller: AbortController;
  #sentinels = 0;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController) {
    this.#reader = reader;
    this.#controller = controller;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.#reader.read();
        if (done) {
          break;
        }
        this.buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // An abort or a reset ends the stream the same way a clean close does.
    }
    this.ended = true;
  }

  async until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the stream. Saw: ${JSON.stringify(this.buffer)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  frames(): Frame[] {
    return this.buffer
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => {
        const data = block.split("\n").find((line) => line.startsWith("data: "))!;
        const wire = JSON.parse(data.slice(6)) as Omit<Frame, "raw">;
        return { ...wire, raw: block };
      });
  }

  /** What arrived about repos, as `type:repoId`, sentinels excluded. */
  seen(): string[] {
    return this.frames()
      .filter((frame) => frame.payload["sentinel"] === undefined)
      .map(
        (frame) =>
          `${frame.type}:${String(frame.payload["repoId"] ?? frame.payload["accountSyncId"])}`,
      );
  }

  /** Waits until everything published before this call has been delivered or dropped. */
  async settle(events: TempApp["events"]): Promise<void> {
    this.#sentinels += 1;
    const sentinel = `s${String(this.#sentinels)}-${String(Math.random())}`;
    events.publish("status.changed", { sentinel });
    await this.until(() => this.buffer.includes(sentinel));
  }

  async cancel(): Promise<void> {
    this.#controller.abort();
    await this.#reader.cancel().catch(() => undefined);
  }
}

let temp: TempApp;
let origin: string;
let streams: Sse[] = [];
let alice: User;
let bob: User;
let nothing: User;
let removed: User;
let forgeId: number;
let counter = 0;

async function openStream(who: Who | string, base = origin, path = "/api/events"): Promise<Sse> {
  const controller = new AbortController();
  const headers =
    who in EMAILS || who === "admin" ? headersFor(who as Who) : { [INSECURE_USER_HEADER]: who };
  const response = await fetch(`${base}${path}`, {
    headers: { accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const sse = new Sse(response.body!.getReader(), controller);
  streams.push(sse);
  await sse.until(() => sse.buffer.includes(": connected"));
  return sse;
}

/** A repo owned by `owner`, public or private as asked. */
function repoOf(owner: User, isPrivate: boolean, db: Db = temp.db): number {
  counter += 1;
  const repo = createRepo(db, {
    forgeId,
    path: `${owner.email.split("@")[0]!}/${isPrivate ? "priv" : "pub"}-${String(counter)}`,
    ownerUserId: owner.id,
  });
  db.run("UPDATE repos SET is_private = ? WHERE id = ?", isPrivate ? 1 : 0, repo.id);
  return repo.id;
}

function setPrivate(repoId: number, isPrivate: boolean): void {
  temp.db.run("UPDATE repos SET is_private = ? WHERE id = ?", isPrivate ? 1 : 0, repoId);
}

function grant(user: User, permissions: Record<string, boolean>): void {
  updateUser(temp.db, user.id, { permissions });
}

async function boot(pushSender?: PushSender): Promise<void> {
  temp = await createTempApp(
    { INSECURE_USER_EMAILS: Object.values(EMAILS).join(",") },
    pushSender === undefined ? {} : { pushSender },
  );
  alice = makeUser(temp.db, EMAILS.alice);
  bob = makeUser(temp.db, EMAILS.bob);
  nothing = makeUser(temp.db, EMAILS.nothing, {}, { nothing: true });
  makeUser(temp.db, EMAILS.viewPrivate, { view_others_private: true });
  removed = makeUser(temp.db, EMAILS.gone, {}, { removed: true });
  forgeId = seedForge(temp.db);
  await temp.app.listen({ port: 0, host: "127.0.0.1" });
  origin = `http://127.0.0.1:${String((temp.app.server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  for (const stream of streams) {
    await stream.cancel();
  }
  streams = [];
  await temp.close();
});

describe("SSE: per-stream audience, decided at send time", () => {
  beforeEach(boot.bind(null, undefined));

  const REPO_EVENTS = [
    "sync.started",
    "sync.finished",
    "repo.created",
    "repo.updated",
    "repo.gone",
  ] as const satisfies readonly AmberEventType[];

  it.each(ALL)("%s receives repo events only for the repos they can view", async (who) => {
    const privateId = repoOf(alice, true);
    const publicId = repoOf(alice, false);
    const stream = await openStream(who);

    for (const type of REPO_EVENTS) {
      temp.events.publish(type, { repoId: privateId });
      temp.events.publish(type, { repoId: publicId });
    }
    await stream.settle(temp.events);

    const expected = REPO_EVENTS.flatMap((type) => [
      ...(SEES[who].private ? [`${type}:${String(privateId)}`] : []),
      ...(SEES[who].public ? [`${type}:${String(publicId)}`] : []),
    ]);
    expect(stream.seen()).toEqual(expected);
  });

  it.each(["sync.started", "repo.updated"] as const)(
    "drops a %s with no repo id or about a repo that does not exist",
    async (type) => {
      const stream = await openStream("admin");
      temp.events.publish(type, {});
      temp.events.publish(type, { repoId: "7" });
      temp.events.publish(type, { repoId: 987_654 });
      await stream.settle(temp.events);
      expect(stream.seen()).toEqual([]);
    },
  );

  it("follows an is_private flip on a stream that is already open", async () => {
    const repoId = repoOf(alice, true);
    const stream = await openStream("bob");

    temp.events.publish("repo.updated", { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([]);

    setPrivate(repoId, false);
    temp.events.publish("repo.updated", { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([`repo.updated:${String(repoId)}`]);

    setPrivate(repoId, true);
    temp.events.publish("sync.finished", { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([`repo.updated:${String(repoId)}`]);
  });

  it("follows a permission change on a stream that is already open", async () => {
    const repoId = repoOf(alice, true);
    const stream = await openStream("bob");

    grant(bob, { view_others_private: true });
    temp.events.publish("repo.updated", { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([`repo.updated:${String(repoId)}`]);

    grant(bob, { view_others_private: false, view_others_public: false });
    setPrivate(repoId, false);
    temp.events.publish("sync.started", { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([`repo.updated:${String(repoId)}`]);
  });

  it("follows an owner change on a stream that is already open", async () => {
    const repoId = repoOf(alice, true);
    const stream = await openStream("bob");

    temp.db.run("UPDATE repos SET owner_user_id = ? WHERE id = ?", bob.id, repoId);
    temp.events.publish("repo.updated", { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([`repo.updated:${String(repoId)}`]);
  });

  it.each(ALL)("%s receives status.changed", async (who) => {
    const stream = await openStream(who);
    temp.events.publish("status.changed", { queueDepth: 3, activeSyncs: 1, breakerOpen: false });
    await stream.settle(temp.events);
    const status = stream.frames().filter((frame) => frame.payload["sentinel"] === undefined);
    expect(status.map((frame) => frame.type)).toEqual(["status.changed"]);
    expect(status[0]?.payload).toMatchObject({ queueDepth: 3 });
  });

  it.each(ALL)("%s receives an event type nobody classified: nobody does", async (who) => {
    const repoId = repoOf(alice, false);
    const stream = await openStream(who);
    temp.events.publish("repo.something_new" as AmberEventType, { repoId });
    await stream.settle(temp.events);
    expect(stream.seen()).toEqual([]);
    expect(stream.buffer).not.toContain("repo.something_new");
  });

  it("sends only type, at and payload on the wire", async () => {
    const repoId = repoOf(alice, false);
    const stream = await openStream("alice");
    temp.events.publish("repo.updated", { repoId }, { audience: [alice.id], capReachedUserId: 1 });
    await stream.settle(temp.events);
    const frame = stream.frames().find((candidate) => candidate.type === "repo.updated")!;
    expect(
      Object.keys(JSON.parse(frame.raw.split("\n")[1]!.slice(6)) as Record<string, unknown>).sort(),
    ).toEqual(["at", "payload", "type"]);
    expect(frame.raw).not.toContain("audience");
    expect(frame.raw).not.toContain("capReachedUserId");
  });
});

describe("SSE: repo.deleted goes to the audience computed before the row went", () => {
  beforeEach(boot.bind(null, undefined));

  const AUDIENCE = {
    private: ["admin", "alice", "viewPrivate"],
    public: ["admin", "alice", "bob", "viewPrivate"],
  } as const;

  async function openAll(): Promise<Record<Who, Sse>> {
    const opened = {} as Record<Who, Sse>;
    for (const who of ALL) {
      opened[who] = await openStream(who);
    }
    return opened;
  }

  async function settleAll(all: Record<Who, Sse>): Promise<void> {
    for (const who of ALL) {
      await all[who].settle(temp.events);
    }
  }

  it.each(["private", "public"] as const)(
    "DELETE /api/repos/:id on a %s repo reaches exactly the people who could view it",
    async (kind) => {
      const repoId = repoOf(alice, kind === "private");
      const all = await openAll();

      const response = await fetch(`${origin}/api/repos/${String(repoId)}`, {
        method: "DELETE",
        headers: asUser(EMAILS.alice),
      });
      expect(response.status).toBe(204);
      await settleAll(all);

      for (const who of ALL) {
        const got = all[who].seen();
        expect(got, who).toEqual(
          (AUDIENCE[kind] as readonly string[]).includes(who)
            ? [`repo.deleted:${String(repoId)}`]
            : [],
        );
        expect(all[who].buffer, who).not.toContain("audience");
      }
    },
  );

  it("POST /api/repos/bulk delete reaches each repo's audience, not the union", async () => {
    const privateId = repoOf(alice, true);
    const publicId = repoOf(alice, false);
    const all = await openAll();

    const response = await fetch(`${origin}/api/repos/bulk`, {
      method: "POST",
      headers: { ...asUser(EMAILS.alice), "content-type": "application/json" },
      body: JSON.stringify({ ids: [privateId, publicId], action: "delete" }),
    });
    expect(response.status).toBe(200);
    await settleAll(all);

    const priv = `repo.deleted:${String(privateId)}`;
    const pub = `repo.deleted:${String(publicId)}`;
    expect(all.admin.seen()).toEqual([priv, pub]);
    expect(all.alice.seen()).toEqual([priv, pub]);
    expect(all.viewPrivate.seen()).toEqual([priv, pub]);
    expect(all.bob.seen()).toEqual([pub]);
    expect(all.nothing.seen()).toEqual([]);
    for (const who of ALL) {
      expect(all[who].buffer, who).not.toContain("audience");
    }
  });

  it("delivers a published repo.deleted only to the user ids in its audience", async () => {
    const all = await openAll();
    temp.events.publish("repo.deleted", { repoId: 1 }, { audience: [bob.id, nothing.id] });
    temp.events.publish("repo.deleted", { repoId: 2 });
    temp.events.publish("repo.deleted", { repoId: 3 }, { audience: [] });
    await settleAll(all);

    expect(all.bob.seen()).toEqual(["repo.deleted:1"]);
    expect(all.nothing.seen()).toEqual(["repo.deleted:1"]);
    // Not even the admin sees a delete that carried no audience for them.
    expect(all.admin.seen()).toEqual([]);
    expect(all.alice.seen()).toEqual([]);
    expect(all.viewPrivate.seen()).toEqual([]);
  });
});

describe("SSE: account_sync.finished", () => {
  beforeEach(boot.bind(null, undefined));

  function syncOf(owner: User): number {
    return insertAccountSync(temp.db, {
      forgeId,
      accountId: null,
      source: "namespace",
      namespace: `ns-${String((counter += 1))}`,
      visibility: "all",
      enabled: false,
      intervalMinutes: 60,
      ownerUserId: owner.id,
    }).id;
  }

  it("reaches the sync's owner and the admin, nobody else", async () => {
    const aliceSync = syncOf(alice);
    const adminSync = syncOf(adminOf(temp.db));
    const opened = {} as Record<Who, Sse>;
    for (const who of ALL) {
      opened[who] = await openStream(who);
    }

    temp.events.publish("account_sync.finished", { accountSyncId: aliceSync });
    temp.events.publish("account_sync.finished", { accountSyncId: adminSync });
    for (const who of ALL) {
      await opened[who].settle(temp.events);
    }

    const a = `account_sync.finished:${String(aliceSync)}`;
    const m = `account_sync.finished:${String(adminSync)}`;
    expect(opened.admin.seen()).toEqual([a, m]);
    expect(opened.alice.seen()).toEqual([a]);
    expect(opened.bob.seen()).toEqual([]);
    expect(opened.nothing.seen()).toEqual([]);
    expect(opened.viewPrivate.seen()).toEqual([]);
  });

  it("only the admin gets one with no sync id or a sync that does not exist", async () => {
    const admin = await openStream("admin");
    const aliceStream = await openStream("alice");
    temp.events.publish("account_sync.finished", {});
    temp.events.publish("account_sync.finished", { accountSyncId: 987_654 });
    await admin.settle(temp.events);
    await aliceStream.settle(temp.events);
    expect(admin.seen()).toEqual([
      "account_sync.finished:undefined",
      "account_sync.finished:987654",
    ]);
    expect(aliceStream.seen()).toEqual([]);
  });
});

describe("SSE: a user who is removed loses the stream", () => {
  beforeEach(boot.bind(null, undefined));

  it("refuses to open a stream for a removed user", async () => {
    const response = await fetch(`${origin}/api/events`, {
      headers: asUser(EMAILS.gone),
    });
    await response.body?.cancel();
    expect(response.status).toBe(403);
    expect(removed.removedAt).not.toBeNull();
  });

  it("closes an open stream on the next published event, without leaking it", async () => {
    const repoId = repoOf(alice, false);
    const stream = await openStream("alice");
    const other = await openStream("bob");

    temp.db.run("UPDATE users SET removed_at = ? WHERE id = ?", Date.now(), alice.id);
    temp.events.publish("repo.updated", { repoId });
    await stream.until(() => stream.ended);

    expect(stream.seen()).toEqual([]);
    // Others on the same bus are unaffected.
    await other.settle(temp.events);
    expect(other.seen()).toEqual([`repo.updated:${String(repoId)}`]);
    expect(other.ended).toBe(false);
  });

  it("closes on a heartbeat when nothing is published, and keeps an unremoved stream open", async () => {
    // The route plugin is mounted a second time with a fast heartbeat, as
    // events.test.ts does, so the interval can be observed in milliseconds.
    // It has to be registered before listen, hence an app of its own.
    const fast = await createTempApp({ INSECURE_USER_EMAILS: Object.values(EMAILS).join(",") });
    try {
      await fast.app.register(eventRoutes, { heartbeatMs: 20, prefix: "/fast" });
      await fast.app.listen({ port: 0, host: "127.0.0.1" });
      const base = `http://127.0.0.1:${String((fast.app.server.address() as AddressInfo).port)}`;
      const doomed = await openStream("alice", base, "/fast/events");
      const kept = await openStream("bob", base, "/fast/events");

      await kept.until(() => kept.buffer.includes(": heartbeat"));
      fast.db.run("UPDATE users SET removed_at = ? WHERE email = ?", Date.now(), EMAILS.alice);
      await doomed.until(() => doomed.ended);

      expect(kept.ended).toBe(false);
    } finally {
      for (const stream of streams) {
        await stream.cancel();
      }
      streams = [];
      await fast.close();
    }
  });
});

describe("push: subscriptions belong to the subscribing user", () => {
  let sent: { endpoint: string; payload: PushPayload }[];
  const sender: PushSender = (subscription: StoredSubscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as PushPayload });
    return Promise.resolve();
  };

  beforeEach(async () => {
    sent = [];
    await boot(sender);
  });

  const endpointOf = (name: string): string => `https://push.example.com/${name}`;

  async function subscribe(who: Who, name: string, agent = name): Promise<void> {
    const response = await temp.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { ...headersFor(who), "user-agent": agent },
      payload: { endpoint: endpointOf(name), keys: { p256dh: `p-${name}`, auth: `a-${name}` } },
    });
    expect(response.statusCode).toBe(204);
  }

  async function devicesOf(who: Who): Promise<string[]> {
    const response = await temp.app.inject({
      method: "GET",
      url: "/api/push",
      headers: headersFor(who),
    });
    return response
      .json<{ devices: { userAgent: string }[] }>()
      .devices.map((device) => device.userAgent)
      .sort();
  }

  const ownerOf = (name: string): number | undefined =>
    temp.db.get<{ user_id: number }>(
      "SELECT user_id FROM push_subscriptions WHERE endpoint = ?",
      endpointOf(name),
    )?.user_id;

  it("lists only the caller's own devices", async () => {
    await subscribe("alice", "a1");
    await subscribe("alice", "a2");
    await subscribe("bob", "b1");

    expect(await devicesOf("alice")).toEqual(["a1", "a2"]);
    expect(await devicesOf("bob")).toEqual(["b1"]);
    expect(await devicesOf("admin")).toEqual([]);
    expect(await devicesOf("nothing")).toEqual([]);
  });

  it("moves an endpoint to whoever subscribes it last", async () => {
    await subscribe("alice", "shared", "alice's browser");
    expect(ownerOf("shared")).toBe(alice.id);

    await subscribe("bob", "shared", "bob's browser");

    expect(ownerOf("shared")).toBe(bob.id);
    expect(temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")?.n).toBe(1);
    expect(await devicesOf("alice")).toEqual([]);
    expect(await devicesOf("bob")).toEqual(["bob's browser"]);
  });

  it("lets nobody unsubscribe someone else's endpoint", async () => {
    await subscribe("alice", "a1");

    const attempt = await temp.app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      headers: headersFor("bob"),
      payload: { endpoint: endpointOf("a1") },
    });
    expect(attempt.statusCode).toBe(204);
    expect(ownerOf("a1")).toBe(alice.id);
    expect(await devicesOf("alice")).toEqual(["a1"]);

    // Not even the admin deletes another user's device through the user route.
    await temp.app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      payload: { endpoint: endpointOf("a1") },
    });
    expect(ownerOf("a1")).toBe(alice.id);

    await temp.app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      headers: headersFor("alice"),
      payload: { endpoint: endpointOf("a1") },
    });
    expect(ownerOf("a1")).toBeUndefined();
  });

  it("sends the test notification only to the caller's devices", async () => {
    await subscribe("alice", "a1");
    await subscribe("alice", "a2");
    await subscribe("bob", "b1");

    const result = await temp.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: headersFor("alice"),
    });
    expect(result.json()).toEqual({ sent: 2, failed: 0 });
    expect(sent.map((entry) => entry.endpoint).sort()).toEqual([
      endpointOf("a1"),
      endpointOf("a2"),
    ]);

    sent.length = 0;
    const none = await temp.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: headersFor("nothing"),
    });
    expect(none.json()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  const GONE_RECIPIENTS = {
    private: ["admin", "alice", "viewPrivate"],
    public: ["admin", "alice", "bob", "viewPrivate"],
  } as const;

  it.each(["private", "public"] as const)(
    "a repo.gone push for a %s repo goes only to users who can view it",
    async (kind) => {
      const repoId = repoOf(alice, kind === "private");
      for (const who of ALL) {
        await subscribe(who, who);
      }

      temp.events.publish("repo.gone", { repoId, path: "alice/thing", host: "github.com" });
      await temp.app.amber.push.flush();

      expect(sent.map((entry) => entry.endpoint).sort()).toEqual(
        GONE_RECIPIENTS[kind].map((who) => endpointOf(who)).sort(),
      );
    },
  );

  it("shows each user only the repos they can view in a mixed batch", async () => {
    const privateId = repoOf(alice, true);
    const publicId = repoOf(alice, false);
    for (const who of ALL) {
      await subscribe(who, who);
    }

    temp.events.publish("repo.gone", {
      repoId: privateId,
      path: "alice/hidden",
      host: "github.com",
    });
    temp.events.publish("repo.gone", { repoId: publicId, path: "alice/shown", host: "github.com" });
    await temp.app.amber.push.flush();

    const byEndpoint = new Map(sent.map((entry) => [entry.endpoint, entry.payload]));
    for (const who of ["admin", "alice", "viewPrivate"] as const) {
      const payload = byEndpoint.get(endpointOf(who))!;
      expect(payload.title, who).toBe("2 repositories are gone upstream");
      expect(payload.body, who).toContain("alice/hidden");
      expect(payload.body, who).toContain("alice/shown");
    }
    const bobs = byEndpoint.get(endpointOf("bob"))!;
    expect(bobs.title).toBe("A repository is gone upstream");
    expect(bobs.body).toContain("alice/shown");
    expect(bobs.body).not.toContain("alice/hidden");
    expect(byEndpoint.has(endpointOf("nothing"))).toBe(false);
  });

  it("decides who can view at flush time, not at publish time", async () => {
    const repoId = repoOf(alice, true);
    await subscribe("bob", "bob");

    temp.events.publish("repo.gone", { repoId, path: "alice/thing", host: "github.com" });
    // Bob loses nothing and gains the repo between the event and the send.
    setPrivate(repoId, false);
    await temp.app.amber.push.flush();
    expect(sent.map((entry) => entry.endpoint)).toEqual([endpointOf("bob")]);

    sent.length = 0;
    temp.events.publish("repo.gone", { repoId, path: "alice/thing", host: "github.com" });
    setPrivate(repoId, true);
    await temp.app.amber.push.flush();
    expect(sent).toEqual([]);
  });

  it("sends a repo.gone push to nobody once the user has been removed", async () => {
    const repoId = repoOf(alice, false);
    await subscribe("alice", "alice");
    temp.db.run("UPDATE users SET removed_at = ? WHERE id = ?", Date.now(), alice.id);

    temp.events.publish("repo.gone", { repoId, path: "alice/thing", host: "github.com" });
    await temp.app.amber.push.flush();
    expect(sent).toEqual([]);
  });
});

describe("GET /api/status counts only what the caller can view", () => {
  beforeEach(boot.bind(null, undefined));

  async function totals(who: Who): Promise<[number, number, number]> {
    const response = await temp.app.inject({
      method: "GET",
      url: "/api/status",
      headers: headersFor(who),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      totalRepos: number;
      goneRepos: number;
      totalDiskUsageBytes: number;
    }>();
    return [body.totalRepos, body.goneRepos, body.totalDiskUsageBytes];
  }

  function seed(): void {
    const admin = adminOf(temp.db);
    const rows: [User, boolean, number, boolean][] = [
      // owner, private, bytes, gone
      [alice, false, 100, false],
      [alice, true, 200, true],
      [admin, false, 400, true],
      [admin, true, 800, true],
    ];
    for (const [owner, isPrivate, bytes, gone] of rows) {
      const id = repoOf(owner, isPrivate);
      temp.db.run(
        "UPDATE repos SET disk_usage_bytes = ?, gone_at = ? WHERE id = ?",
        bytes,
        gone ? Date.now() : null,
        id,
      );
    }
  }

  // [totalRepos, goneRepos, totalDiskUsageBytes]
  const EXPECTED: Record<Who, [number, number, number]> = {
    admin: [4, 3, 1500],
    // Their own two, plus the admin's public one.
    alice: [3, 2, 700],
    // Both public repos only.
    bob: [2, 1, 500],
    nothing: [0, 0, 0],
    viewPrivate: [4, 3, 1500],
  };

  it.each(ALL)("%s sees totals for their own view", async (who) => {
    seed();
    expect(await totals(who)).toEqual(EXPECTED[who]);
  });

  it("follows a permission change on the very next request", async () => {
    seed();
    expect(await totals("bob")).toEqual([2, 1, 500]);
    grant(bob, { view_others_private: true });
    expect(await totals("bob")).toEqual([4, 3, 1500]);
    grant(bob, { view_others_private: false, view_others_public: false });
    expect(await totals("bob")).toEqual([0, 0, 0]);
  });

  it("still reports instance-wide queue figures to a user who sees no repos", async () => {
    seed();
    const response = await temp.app.inject({
      method: "GET",
      url: "/api/status",
      headers: headersFor("nothing"),
    });
    expect(response.json()).toMatchObject({ queueDepth: 0, activeSyncs: 0, breakerOpen: false });
  });
});
