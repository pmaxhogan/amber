import type { AmberEvent, AmberEventType } from "@amber/shared";

/**
 * Server-side facts that travel WITH an event but are never serialized to a
 * client. The SSE route writes only the AmberEvent itself, so anything here
 * stays on the server.
 */
export interface EventMeta {
  /**
   * For `repo.deleted`: the ids of the users who could view the repository
   * just before its row went away. Once the row is gone visibility can no
   * longer be computed, so the publisher computes it first.
   */
  audience?: readonly number[];
  /**
   * For a sync that moved its owner from under to at-or-over their storage
   * cap: that owner's user id, so the push notifier can tell them (and the
   * admin).
   */
  capReachedUserId?: number;
}

export type EventListener = (event: AmberEvent, meta: EventMeta) => void;

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

  publish(type: AmberEventType, payload: Record<string, unknown> = {}, meta: EventMeta = {}): void {
    const event: AmberEvent = { type, at: Date.now(), payload };
    for (const tap of this.#taps) {
      tap(event, meta);
    }
    for (const listener of this.#listeners) {
      listener(event, meta);
    }
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
