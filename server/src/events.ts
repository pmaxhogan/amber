import type { AmberEvent, AmberEventType } from "@amber/shared";

export type EventListener = (event: AmberEvent) => void;

/**
 * In-process fan-out for live UI updates. routes/events.ts subscribes one
 * listener per open SSE connection; the sync engine publishes.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(type: AmberEventType, payload: Record<string, unknown> = {}): void {
    const event: AmberEvent = { type, at: Date.now(), payload };
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
