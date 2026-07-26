import { AMBER_EVENT_TYPES, eventPayloadSchema, eventPayloadSchemas } from "@amber/shared";
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEventData } from "../src/api/client.ts";
import { STATUS_REFRESH_DEBOUNCE_MS, useStatusStore } from "../src/stores/status.ts";
import { stubApi } from "./helpers/stubApi.ts";

/**
 * The browser half of the SSE contract pinned in shared/src/apiTypes.ts.
 *
 * server/test/routes/contracts.test.ts asserts the server PUBLISHES these
 * payloads; this file asserts the client READS them. The pair is what keeps
 * the two from drifting, since every component test stubs the API and would
 * stay green against a server that renamed a payload key.
 */

/** One frame exactly as routes/events.ts writes it onto the wire. */
function wireFrame(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, at: 1_700_000_000_000, payload });
}

const PINNED: Record<string, Record<string, unknown>> = {
  "sync.started": { repoId: 7 },
  "sync.finished": { repoId: 7, outcome: "success" },
  "repo.created": { repoId: 7 },
  "repo.updated": { repoId: 7 },
  "repo.deleted": { repoId: 7 },
  "account_sync.finished": { accountSyncId: 3 },
  "status.changed": { activeSyncs: 2, queueDepth: 5, breakerOpen: false },
};

describe("SSE payload contract", () => {
  it("covers every event type the server can publish", () => {
    expect(Object.keys(PINNED).sort()).toEqual([...AMBER_EVENT_TYPES].sort());
  });

  it("parses each pinned frame off the wire", () => {
    for (const [type, payload] of Object.entries(PINNED)) {
      // The pinned payload has to satisfy its own per-type schema first, so a
      // typo in this fixture cannot make the rest of the assertions vacuous.
      eventPayloadSchemas[type as keyof typeof eventPayloadSchemas].parse(payload);

      const event = parseEventData(wireFrame(type, payload));
      expect(event, `${type} should parse`).not.toBeNull();
      expect(event?.type).toBe(type);
      expect(eventPayloadSchema.parse(event?.payload)).toEqual(payload);
    }
  });

  it("reads the repo subject as repoId, never as id", () => {
    for (const type of ["sync.started", "sync.finished", "repo.updated"]) {
      const event = parseEventData(wireFrame(type, PINNED[type]!));
      expect(eventPayloadSchema.parse(event?.payload).repoId).toBe(7);
    }
    // A payload that named the subject `id` would leave repoId undefined,
    // which is exactly the dead-row-refresh bug this contract closes.
    const legacy = eventPayloadSchema.parse({ id: 7 });
    expect(legacy.repoId).toBeUndefined();
  });
});

describe("status store against pinned payloads", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("applies the counters from a status.changed frame without refetching", async () => {
    const api = stubApi();
    const store = useStatusStore();
    await store.load(api);
    const before = (api.status as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;

    const event = parseEventData(wireFrame("status.changed", PINNED["status.changed"]!));
    store.applyEvent(event!);

    expect(store.activeSyncs).toBe(2);
    expect(store.status?.queueDepth).toBe(5);
    expect(store.breakerOpen).toBe(false);

    // Counters arrived in the payload, so nothing needs to be fetched.
    await new Promise((done) => setTimeout(done, STATUS_REFRESH_DEBOUNCE_MS + 50));
    expect((api.status as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(
      before,
    );
  });

  it("falls back to a refetch for an event that carries no counters", async () => {
    vi.useFakeTimers();
    try {
      const api = stubApi();
      const store = useStatusStore();
      await store.load(api);
      const event = parseEventData(wireFrame("repo.updated", PINNED["repo.updated"]!));
      store.applyEvent(event!);
      await vi.advanceTimersByTimeAsync(STATUS_REFRESH_DEBOUNCE_MS + 50);
      // One for the initial load, one for the debounced refresh the event triggered.
      expect((api.status as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
