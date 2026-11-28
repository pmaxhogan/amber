import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, trustNearestProxy, type AmberApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { EventBus } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";

let dir: string;
let db: Db;
let app: AmberApp;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "amber-app-"));
  const config = loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: dir });
  const log = createConsoleLogger("silent");
  db = openDb(join(dir, "state", "amber.db"));
  migrate(db, log);
  app = await buildApp({ config, log, db, version: "9.9.9-test" });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /healthz", () => {
  it("responds ok with the running version", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: "9.9.9-test" });
  });

  it("needs no authentication, which is what the docker healthcheck relies on", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz", headers: {} });
    expect(response.statusCode).toBe(200);
  });
});

describe("buildApp", () => {
  it("decorates the instance with the app context", () => {
    expect(app.amber.version).toBe("9.9.9-test");
    expect(app.amber.config.insecureMode).toBe(true);
    expect(app.amber.events).toBeInstanceOf(EventBus);
  });

  it("returns 404 for an unregistered route", async () => {
    const response = await app.inject({ method: "GET", url: "/api/not-a-resource" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
  });

  it("serves the registered API routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/repos" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rows: [], total: 0 });
  });
});

describe("trustNearestProxy", () => {
  it("believes exactly one hop, and only from a loopback or private peer", () => {
    for (const peer of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "172.18.0.2",
      "10.1.2.3",
      "fd00::5",
    ]) {
      expect(trustNearestProxy(peer, 0)).toBe(true);
    }
    // A direct client on a public address cannot hand us an X-Forwarded-For.
    for (const peer of ["203.0.113.9", "8.8.8.8", "2606:4700::1", "not-an-ip"]) {
      expect(trustNearestProxy(peer, 0)).toBe(false);
    }
    // Never a second hop, whatever it is.
    expect(trustNearestProxy("127.0.0.1", 1)).toBe(false);
    expect(trustNearestProxy("10.0.0.1", 2)).toBe(false);
  });

  it("makes request.ip the entry the nearest proxy appended, not the client's", async () => {
    app.get("/whoami-test", { config: { authz: "public" } }, (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/whoami-test",
      headers: { "x-forwarded-for": "198.51.100.66, 203.0.113.5" },
    });
    expect(response.json()).toEqual({ ip: "203.0.113.5" });
  });

  it("ignores X-Forwarded-For from a peer on a public address", async () => {
    app.get("/whoami-public-test", { config: { authz: "public" } }, (request) => ({
      ip: request.ip,
    }));
    const response = await app.inject({
      method: "GET",
      url: "/whoami-public-test",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "198.51.100.66, 10.0.0.1" },
    });
    // A direct client cannot pick its own address, spoofed or "private".
    expect(response.json()).toEqual({ ip: "203.0.113.9" });
  });
});

describe("EventBus", () => {
  it("delivers published events to every subscriber until unsubscribed", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.type));
    bus.subscribe((event) => seen.push(`second:${event.type}`));

    bus.publish("repo.created", { id: 1 });
    expect(seen).toEqual(["repo.created", "second:repo.created"]);
    expect(bus.subscriberCount).toBe(2);

    unsubscribe();
    bus.publish("repo.deleted");
    expect(seen).toEqual(["repo.created", "second:repo.created", "second:repo.deleted"]);
    expect(bus.subscriberCount).toBe(1);
  });

  it("stamps every event with a timestamp and payload", () => {
    const bus = new EventBus();
    let captured: { at: number; payload: Record<string, unknown> } | null = null;
    bus.subscribe((event) => {
      captured = event;
    });
    bus.publish("sync.started", { repoId: 7 });
    expect(captured).not.toBeNull();
    expect(captured!.payload).toEqual({ repoId: 7 });
    expect(captured!.at).toBeGreaterThan(0);
  });
});

describe("EventBus taps", () => {
  it("delivers to a tap without counting it, and survives clear()", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const stop = bus.tap((event) => seen.push(event.type));

    expect(bus.subscriberCount).toBe(0);
    bus.publish("repo.gone", { repoId: 1 });
    bus.clear();
    bus.publish("repo.deleted", { repoId: 1 });
    stop();
    bus.publish("repo.created", { repoId: 1 });

    expect(seen).toEqual(["repo.gone", "repo.deleted"]);
  });
});
