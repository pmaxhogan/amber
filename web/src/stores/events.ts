import { defineStore } from "pinia";
import { onScopeDispose, ref, shallowRef } from "vue";
import type { AmberEvent } from "@amber/shared";
import { createEventStream, type EventStream, type StreamState } from "../api/events.ts";

export type EventListener = (event: AmberEvent) => void;

/**
 * One SSE connection per tab, fanned out to every interested component.
 * Components subscribe rather than opening their own stream, which is what
 * keeps a live table from turning into a refetch storm.
 */
export const useEventsStore = defineStore("events", () => {
  const state = ref<StreamState>("idle");
  const lastEvent = shallowRef<AmberEvent | null>(null);
  const listeners = new Set<EventListener>();
  let stream: EventStream | null = null;

  function dispatch(event: AmberEvent): void {
    lastEvent.value = event;
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  function connect(url?: string): void {
    if (stream !== null) return;
    stream = createEventStream({
      url,
      onEvent: dispatch,
      onStateChange: (next) => {
        state.value = next;
      },
    });
    stream.start();
  }

  function disconnect(): void {
    stream?.stop();
    stream = null;
  }

  /** Subscribe for the lifetime of the calling component. */
  function on(listener: EventListener): () => void {
    listeners.add(listener);
    const off = (): void => {
      listeners.delete(listener);
    };
    onScopeDispose(off, true);
    return off;
  }

  return { state, lastEvent, connect, disconnect, on, dispatch };
});
