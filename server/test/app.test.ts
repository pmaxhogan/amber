import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AmberApp } from "../src/app.ts";
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
