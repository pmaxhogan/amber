import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AmberEvent } from "@amber/shared";
import { STATUS_REFRESH_DEBOUNCE_MS, useStatusStore } from "../src/stores/status.ts";
import { makeStatus, stubApi } from "./helpers/stubApi.ts";
import { flush } from "./helpers/dom.ts";

function event(payload: Record<string, unknown>): AmberEvent {
  return { type: "sync.finished", at: 1_700_000_000_000, payload };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("status summary", () => {
  it("reads as connecting before the first response", () => {
    const store = useStatusStore();
    expect(store.summary).toBe("connecting");
    expect(store.tone).toBe("idle");
  });

  it("reads as idle with nothing running", async () => {
    const store = useStatusStore();
    await store.load(stubApi());

    expect(store.summary).toBe("idle");
    expect(store.tone).toBe("idle");
  });

  it("counts active syncs", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({ status: vi.fn().mockResolvedValue(makeStatus({ activeSyncs: 3 })) }),
    );

    expect(store.summary).toBe("syncing 3");
    expect(store.tone).toBe("busy");
  });

  it("falls back to the queue depth when nothing is running yet", async () => {
    const store = useStatusStore();
    await store.load(stubApi({ status: vi.fn().mockResolvedValue(makeStatus({ queueDepth: 7 })) }));

    expect(store.summary).toBe("7 queued");
    expect(store.tone).toBe("busy");
  });

  it("puts the open breaker ahead of the sync count, since it is the bigger news", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({
        status: vi.fn().mockResolvedValue(makeStatus({ breakerOpen: true, activeSyncs: 2 })),
      }),
    );

    expect(store.summary).toBe("breaker open");
    expect(store.tone).toBe("warn");
  });

  it("reports an unreachable server rather than pretending to be idle", async () => {
    const store = useStatusStore();
    await store.load(stubApi({ status: vi.fn().mockRejectedValue(new TypeError("nope")) }));

    expect(store.summary).toBe("status unavailable");
    expect(store.tone).toBe("error");
    expect(store.error?.problem).toBe("network_error");
  });

  it("clears a previous error once a load succeeds", async () => {
    const store = useStatusStore();
    const status = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("nope"))
      .mockResolvedValueOnce(makeStatus());
    const api = stubApi({ status });

    await store.load(api);
    expect(store.error).not.toBeNull();

    await store.load();
    expect(store.error).toBeNull();
  });

  it("exposes insecure mode for the banner", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({ status: vi.fn().mockResolvedValue(makeStatus({ insecureMode: true })) }),
    );

    expect(store.insecureMode).toBe(true);
  });
});

describe("applying events", () => {
  it("takes counters straight from the event when it carries them", async () => {
    const store = useStatusStore();
    await store.load(stubApi());

    store.applyEvent(event({ activeSyncs: 4, queueDepth: 11, breakerOpen: true }));

    expect(store.activeSyncs).toBe(4);
    expect(store.queueDepth).toBe(11);
    expect(store.breakerOpen).toBe(true);
  });

  it("keeps the fields the event does not mention", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({ status: vi.fn().mockResolvedValue(makeStatus({ queueDepth: 5, activeSyncs: 1 })) }),
    );

    store.applyEvent(event({ activeSyncs: 2 }));

    expect(store.activeSyncs).toBe(2);
    expect(store.queueDepth).toBe(5);
  });

  it("coalesces counter-less events into a single debounced refetch", async () => {
    vi.useFakeTimers();
    const store = useStatusStore();
    const status = vi.fn().mockResolvedValue(makeStatus());
    await store.load(stubApi({ status }));
    expect(status).toHaveBeenCalledTimes(1);

    store.applyEvent(event({ repoId: 1 }));
    store.applyEvent(event({ repoId: 2 }));
    store.applyEvent(event({ repoId: 3 }));
    expect(status).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_DEBOUNCE_MS);

    expect(status).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when the event already answered the question", async () => {
    vi.useFakeTimers();
    const store = useStatusStore();
    const status = vi.fn().mockResolvedValue(makeStatus());
    await store.load(stubApi({ status }));

    store.applyEvent(event({ activeSyncs: 1 }));
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_DEBOUNCE_MS * 2);

    expect(status).toHaveBeenCalledTimes(1);
  });

  it("survives an event whose payload does not match the expected shape", async () => {
    const store = useStatusStore();
    await store.load(stubApi());

    expect(() => store.applyEvent(event({ activeSyncs: "lots" }))).not.toThrow();
    expect(store.activeSyncs).toBe(0);
  });

  it("does nothing on an event received before the first load", () => {
    const store = useStatusStore();
    expect(() => store.applyEvent(event({ activeSyncs: 2 }))).not.toThrow();
    expect(store.status).toBeNull();
  });

  it("is a no-op to load without ever supplying a client", async () => {
    const store = useStatusStore();
    await store.load();
    await flush();
    expect(store.status).toBeNull();
  });
});
