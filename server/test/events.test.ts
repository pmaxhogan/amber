import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AmberApp } from "../src/app.ts";
import { EventBus } from "../src/events.ts";
import { SSE_HEARTBEAT_MS } from "../src/routes/events.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

/**
 * SSE cannot be exercised with app.inject: the response never ends, so inject
 * would buffer forever. These tests bind an ephemeral port and read the stream
 * with fetch, which is also what the browser does.
 */

let temp: TempApp;
let app: AmberApp;
let origin: string;

beforeEach(async () => {
  temp = await createTempApp();
  app = temp.app;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await temp.close();
});

interface Stream {
  /** Read decoded chunks until `predicate` is satisfied, or time out. */
  until(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  cancel(): Promise<void>;
}

async function openStream(path = "/api/events"): Promise<{ response: Response; stream: Stream }> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${path}`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const stream: Stream = {
    async until(predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the stream. Saw: ${JSON.stringify(buffer)}`);
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    },
    async cancel() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };

  return { response, stream };
}

describe("GET /api/events", () => {
  it("opens an event stream with the right headers", async () => {
    const { response, stream } = await openStream();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    await stream.cancel();
  });

  it("sends a connected comment immediately", async () => {
    const { stream } = await openStream();
    expect(await stream.until((text) => text.includes(": connected"))).toContain(": connected\n\n");
    await stream.cancel();
  });

  it("delivers a published event as a named SSE frame", async () => {
    const { stream } = await openStream();
    await stream.until((text) => text.includes(": connected"));

    temp.events.publish("repo.created", { id: 42 });
    const text = await stream.until((chunk) => chunk.includes("repo.created"));

    expect(text).toContain("event: repo.created\n");
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice(6))).toMatchObject({
      type: "repo.created",
      payload: { id: 42 },
    });
    await stream.cancel();
  });

  it("delivers events in order", async () => {
    const { stream } = await openStream();
    await stream.until((text) => text.includes(": connected"));

    temp.events.publish("sync.started", { repoId: 1 });
    temp.events.publish("sync.finished", { repoId: 1 });
    const text = await stream.until((chunk) => chunk.includes("sync.finished"));

    expect(text.indexOf("sync.started")).toBeLessThan(text.indexOf("sync.finished"));
    await stream.cancel();
  });

  it("fans out to several clients at once", async () => {
    const first = await openStream();
    const second = await openStream();
    await first.stream.until((text) => text.includes(": connected"));
    await second.stream.until((text) => text.includes(": connected"));

    temp.events.publish("repo.updated", { id: 7 });
    expect(await first.stream.until((text) => text.includes("repo.updated"))).toContain(
      "repo.updated",
    );
    expect(await second.stream.until((text) => text.includes("repo.updated"))).toContain(
      "repo.updated",
    );

    await first.stream.cancel();
    await second.stream.cancel();
  });

  it("emits events caused by API calls on the same app", async () => {
    const { stream } = await openStream();
    await stream.until((text) => text.includes(": connected"));

    await app.inject({
      method: "POST",
      url: "/api/import",
      payload: { text: "https://github.com/nodejs/node" },
    });
    expect(await stream.until((text) => text.includes("repo.created"))).toContain(
      "event: repo.created",
    );
    await stream.cancel();
  });

  it("unsubscribes the client when it disconnects", async () => {
    const { stream } = await openStream();
    await stream.until((text) => text.includes(": connected"));
    expect(temp.events.subscriberCount).toBe(1);

    await stream.cancel();

    const deadline = Date.now() + 5_000;
    while (temp.events.subscriberCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(temp.events.subscriberCount).toBe(0);
  });

  it("cleans up every client, so publishing after a disconnect is harmless", async () => {
    const first = await openStream();
    const second = await openStream();
    await first.stream.until((text) => text.includes(": connected"));
    await second.stream.until((text) => text.includes(": connected"));
    expect(temp.events.subscriberCount).toBe(2);

    await first.stream.cancel();
    const deadline = Date.now() + 5_000;
    while (temp.events.subscriberCount > 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(temp.events.subscriberCount).toBe(1);

    // The surviving client still receives events.
    temp.events.publish("status.changed", {});
    expect(await second.stream.until((text) => text.includes("status.changed"))).toContain(
      "status.changed",
    );
    await second.stream.cancel();
  });
});

describe("SSE heartbeat", () => {
  it("defaults to 25 seconds", () => {
    expect(SSE_HEARTBEAT_MS).toBe(25_000);
  });

  it("sends a comment on the configured interval", async () => {
    // A dedicated app so the heartbeat can be turned right down.
    const fast = await createTempApp();
    // The route plugin is registered by routes/index.ts with the default, so a
    // second instance is mounted here purely to observe the timing.
    const { eventRoutes } = await import("../src/routes/events.ts");
    await fast.app.register(eventRoutes, { heartbeatMs: 20, prefix: "/fast" });
    await fast.app.listen({ port: 0, host: "127.0.0.1" });
    const address = fast.app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/fast/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 5_000;

    while (!buffer.includes(": heartbeat") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
    }

    expect(buffer).toContain(": heartbeat\n\n");
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await fast.close();
  });
});

describe("EventBus", () => {
  it("publishes typed events with a timestamp", () => {
    const bus = new EventBus();
    const seen: { type: string; at: number }[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.publish("account_sync.finished", { accountId: 3 });
    expect(seen[0]).toMatchObject({ type: "account_sync.finished" });
    expect(seen[0]!.at).toBeGreaterThan(0);
  });
});
