import { AMBER_EVENT_TYPES, type AmberEvent } from "@amber/shared";
import { parseEventData } from "./client.ts";

/**
 * SSE transport for /api/events.
 *
 * EventSource reconnects on its own, but with a fixed delay the browser picks
 * and no cap on how hard it hammers a server that is down. This wrapper closes
 * the socket on the first error and schedules its own reconnect with capped
 * exponential backoff plus full jitter, so a restarting server does not get a
 * synchronized retry from every open tab.
 */

export type StreamState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface EventStreamOptions {
  url?: string;
  /** Injected in tests. Defaults to the global EventSource when present. */
  eventSourceCtor?: EventSourceCtor;
  onEvent?: (event: AmberEvent) => void;
  onStateChange?: (state: StreamState) => void;
  /** First retry waits up to this long; each failure doubles the ceiling. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => number;
    clearTimeout: (handle: number) => void;
  };
}

export interface EventSourceLike {
  onopen: ((this: unknown, ev: Event) => unknown) | null;
  onerror: ((this: unknown, ev: Event) => unknown) | null;
  onmessage: ((this: unknown, ev: MessageEvent) => unknown) | null;
  addEventListener: (type: string, listener: (ev: MessageEvent) => void) => void;
  close: () => void;
}

export type EventSourceCtor = new (url: string) => EventSourceLike;

export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Full jitter: a uniform draw from [0, ceiling] where the ceiling doubles per
 * consecutive failure and is clamped. Attempt numbers are 1-based.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  // Never schedule a zero-delay retry; that is a tight loop by another name.
  return Math.max(Math.round(ceiling * random()), Math.min(baseDelayMs, ceiling));
}

export interface EventStream {
  start: () => void;
  stop: () => void;
  readonly state: StreamState;
  readonly attempts: number;
}

export function createEventStream(options: EventStreamOptions = {}): EventStream {
  const url = options.url ?? "/api/events";
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const scheduler = options.scheduler ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
  const ctor =
    options.eventSourceCtor ??
    (typeof globalThis.EventSource === "function"
      ? (globalThis.EventSource as unknown as EventSourceCtor)
      : undefined);

  let source: EventSourceLike | null = null;
  let timer: number | null = null;
  let state: StreamState = "idle";
  let attempts = 0;
  let stopped = true;

  function setState(next: StreamState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function handleFrame(data: unknown): void {
    if (typeof data !== "string") return;
    const event = parseEventData(data);
    if (event === null) return;
    options.onEvent?.(event);
  }

  function connect(): void {
    if (ctor === undefined) {
      setState("closed");
      return;
    }
    setState(attempts === 0 ? "connecting" : "reconnecting");
    const es = new ctor(url);
    source = es;

    es.onopen = () => {
      attempts = 0;
      setState("open");
    };
    es.onmessage = (ev) => handleFrame(ev.data);
    // Named frames never fire onmessage, so subscribe to each type as well.
    for (const type of AMBER_EVENT_TYPES) {
      es.addEventListener(type, (ev) => handleFrame(ev.data));
    }
    es.onerror = () => {
      if (stopped) return;
      es.close();
      if (source === es) source = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    attempts += 1;
    setState("reconnecting");
    const delay = backoffDelay(attempts, baseDelayMs, maxDelayMs, random);
    timer = scheduler.setTimeout(() => {
      timer = null;
      if (stopped) return;
      connect();
    }, delay);
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      connect();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        scheduler.clearTimeout(timer);
        timer = null;
      }
      if (source !== null) {
        source.close();
        source = null;
      }
      setState("closed");
    },
    get state(): StreamState {
      return state;
    },
    get attempts(): number {
      return attempts;
    },
  };
}
