import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AmberApp } from "../src/app.ts";
import { proxyTrustFunction } from "../src/security/trustedProxies.ts";
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

describe("trusted proxies (TRUSTED_PROXY_CIDRS)", () => {
  const ranges = (text: string) =>
    loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: dir, TRUSTED_PROXY_CIDRS: text })
      .trustedProxies;

  it("defaults to loopback only", () => {
    const trust = proxyTrustFunction(
      loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: dir }).trustedProxies,
    );
    for (const peer of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) {
      expect(trust(peer, 0)).toBe(true);
    }
    // A private peer is NOT believed unless listed: a LAN client, or every
    // client behind docker's bridge NAT, would otherwise pick its own address.
    for (const peer of ["172.18.0.2", "10.1.2.3", "192.168.1.5", "fd00::5", "203.0.113.9"]) {
      expect(trust(peer, 0)).toBe(false);
    }
  });

  it("believes a listed peer for one hop only, never a public peer that is not listed", () => {
    const trust = proxyTrustFunction(ranges("172.18.0.0/16, 10.0.0.7"));
    expect(trust("172.18.4.2", 0)).toBe(true);
    expect(trust("::ffff:172.18.4.2", 0)).toBe(true);
    expect(trust("10.0.0.7", 0)).toBe(true);
    expect(trust("10.0.0.8", 0)).toBe(false);
    expect(trust("127.0.0.1", 0)).toBe(false);
    expect(trust("203.0.113.9", 0)).toBe(false);
    expect(trust("172.18.4.2", 1)).toBe(false);
    expect(trust("not-an-ip", 0)).toBe(false);
  });

  it("refuses an entry that is not an address or CIDR", () => {
    for (const bad of ["10.0.0.0/33", "example.com", "10.0.0.0/x", "::1/129"]) {
      expect(() => ranges(bad)).toThrow(/TRUSTED_PROXY_CIDRS/);
    }
  });

  async function ipSeen(
    trusted: string | undefined,
    remoteAddress: string,
    forwarded: string,
  ): Promise<string> {
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: dir,
      ...(trusted === undefined ? {} : { TRUSTED_PROXY_CIDRS: trusted }),
    });
    const probe = await buildApp({ config, log: createConsoleLogger("silent"), db });
    try {
      probe.get("/whoami-test", { config: { authz: "public" } }, (request) => ({ ip: request.ip }));
      const response = await probe.inject({
        method: "GET",
        url: "/whoami-test",
        remoteAddress,
        headers: { "x-forwarded-for": forwarded },
      });
      return response.json<{ ip: string }>().ip;
    } finally {
      await probe.close();
    }
  }

  it("takes the right-most entry from a listed peer, not the client's spoofed left-most", async () => {
    expect(await ipSeen(undefined, "127.0.0.1", "198.51.100.66, 203.0.113.5")).toBe("203.0.113.5");
    expect(await ipSeen("172.18.0.0/16", "172.18.0.3", "198.51.100.66, 203.0.113.5")).toBe(
      "203.0.113.5",
    );
  });

  it("ignores X-Forwarded-For from an unlisted private peer and from a public peer", async () => {
    expect(await ipSeen(undefined, "172.18.0.3", "198.51.100.66, 203.0.113.5")).toBe("172.18.0.3");
    expect(await ipSeen(undefined, "203.0.113.9", "198.51.100.66, 10.0.0.1")).toBe("203.0.113.9");
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
