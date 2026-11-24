import type { AmberEvent, AmberEventType } from "@amber/shared";

export type EventListener = (event: AmberEvent) => void;

/**
 * In-process fan-out for live UI updates. routes/events.ts subscribes one
 * listener per open SSE connection; the sync engine publishes.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();
  readonly #taps = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * A server-side consumer (the push notifier). Kept apart from subscribers so
   * subscriberCount stays what it has always been, the number of connected
   * clients, and so clear() dropping every client cannot silence it.
   */
  tap(listener: EventListener): () => void {
    this.#taps.add(listener);
    return () => {
      this.#taps.delete(listener);
    };
  }

  publish(type: AmberEventType, payload: Record<string, unknown> = {}): void {
    const event: AmberEvent = { type, at: Date.now(), payload };
    for (const tap of this.#taps) {
      tap(event);
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
