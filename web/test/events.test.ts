import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AmberEvent } from "@amber/shared";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  backoffDelay,
  createEventStream,
  type EventSourceLike,
  type StreamState,
} from "../src/api/events.ts";

/** Minimal EventSource stand-in that lets a test drive open and error. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  closed = false;
  readonly named = new Map<string, (ev: MessageEvent) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.named.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  emit(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitNamed(type: string, data: string): void {
    this.named.get(type)?.({ data } as MessageEvent);
  }
}

function frame(type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, at: 1_700_000_000_000, payload });
}

describe("backoffDelay", () => {
  it("doubles its ceiling per attempt", () => {
    const ceilingAt = (attempt: number) => backoffDelay(attempt, 1000, 60_000, () => 1);
    expect(ceilingAt(1)).toBe(1000);
    expect(ceilingAt(2)).toBe(2000);
    expect(ceilingAt(3)).toBe(4000);
    expect(ceilingAt(4)).toBe(8000);
  });

  it("clamps at the maximum however many failures pile up", () => {
    expect(backoffDelay(50, 1000, 30_000, () => 1)).toBe(30_000);
  });

  it("never schedules a zero-delay retry even when the jitter draw is zero", () => {
    // Full jitter draws from [0, ceiling]; a literal zero would be a tight
    // reconnect loop against a server that is already struggling.
    expect(backoffDelay(1, 1000, 30_000, () => 0)).toBeGreaterThan(0);
    expect(backoffDelay(9, 1000, 30_000, () => 0)).toBeGreaterThan(0);
  });

  it("jitters below the ceiling", () => {
    expect(backoffDelay(4, 1000, 60_000, () => 0.25)).toBe(2000);
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(1000);
    expect(DEFAULT_MAX_DELAY_MS).toBe(30_000);
  });
});

describe("createEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(onEvent?: (event: AmberEvent) => void) {
    const states: StreamState[] = [];
    const stream = createEventStream({
      url: "/api/events",
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
      onEvent,
      onStateChange: (state) => states.push(state),
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      random: () => 1,
    });
    return { stream, states };
  }

  it("connects on start and reports open", () => {
    const { stream, states } = build();
    stream.start();

    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]?.open();

    expect(states).toEqual(["connecting", "open"]);
    expect(stream.state).toBe("open");
  });

  it("delivers both unnamed and named frames", () => {
    const received: AmberEvent[] = [];
    const { stream } = build((event) => received.push(event));
    stream.start();
    const source = FakeEventSource.instances[0];

    source?.emit(frame("sync.started", { repoId: 1 }));
    source?.emitNamed("sync.finished", frame("sync.finished", { repoId: 1 }));

    expect(received.map((event) => event.type)).toEqual(["sync.started", "sync.finished"]);
  });

  it("ignores an unreadable frame instead of throwing", () => {
    const received: AmberEvent[] = [];
    const { stream } = build((event) => received.push(event));
    stream.start();

    FakeEventSource.instances[0]?.emit("not json at all");

    expect(received).toHaveLength(0);
  });

  it("closes the socket on error and reconnects after a backoff", () => {
    const { stream, states } = build();
    stream.start();
    const first = FakeEventSource.instances[0];
    first?.open();

    first?.fail();

    // Closed immediately so the browser's own retry cannot race ours.
    expect(first?.closed).toBe(true);
    expect(stream.state).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(states).toContain("reconnecting");
  });

  it("backs off further on each consecutive failure", () => {
    const { stream } = build();
    stream.start();

    FakeEventSource.instances[0]?.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances[1]?.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);

    expect(stream.attempts).toBe(2);
  });

  it("resets the backoff once a reconnect succeeds", () => {
    const { stream } = build();
    stream.start();

    FakeEventSource.instances[0]?.fail();
    vi.advanceTimersByTime(1000);
    FakeEventSource.instances[1]?.open();

    expect(stream.attempts).toBe(0);

    FakeEventSource.instances[1]?.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("stops reconnecting after stop, and cancels a pending retry", () => {
    const { stream } = build();
    stream.start();
    FakeEventSource.instances[0]?.fail();

    stream.stop();
    vi.advanceTimersByTime(60_000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(stream.state).toBe("closed");
  });

  it("closes the open socket on stop", () => {
    const { stream } = build();
    stream.start();
    FakeEventSource.instances[0]?.open();

    stream.stop();

    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("reports closed when the environment has no EventSource", () => {
    const stream = createEventStream({ url: "/api/events", eventSourceCtor: undefined });
    stream.start();
    expect(stream.state).toBe("closed");
  });
});
