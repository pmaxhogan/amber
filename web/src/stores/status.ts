import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { eventPayloadSchema, type Status } from "@amber/shared";
import { ApiClientError, normalizeError, type ApiClient } from "../api/client.ts";
import type { AmberEvent } from "@amber/shared";

/** How long to coalesce event-driven status refreshes. */
export const STATUS_REFRESH_DEBOUNCE_MS = 1_500;

export const useStatusStore = defineStore("status", () => {
  const status = ref<Status | null>(null);
  const loading = ref(false);
  const error = ref<ApiClientError | null>(null);
  let client: ApiClient | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const insecureMode = computed(() => status.value?.insecureMode === true);
  const breakerOpen = computed(() => status.value?.breakerOpen === true);
  const activeSyncs = computed(() => status.value?.activeSyncs ?? 0);
  const queueDepth = computed(() => status.value?.queueDepth ?? 0);

  /** One short phrase for the nav status pill. */
  const summary = computed(() => {
    if (error.value !== null) return "status unavailable";
    if (status.value === null) return "connecting";
    if (breakerOpen.value) return "breaker open";
    if (activeSyncs.value > 0) {
      return `syncing ${activeSyncs.value}`;
    }
    if (queueDepth.value > 0) return `${queueDepth.value} queued`;
    return "idle";
  });

  const tone = computed<"idle" | "busy" | "warn" | "error">(() => {
    if (error.value !== null) return "error";
    if (breakerOpen.value) return "warn";
    if (activeSyncs.value > 0 || queueDepth.value > 0) return "busy";
    return "idle";
  });

  async function load(next?: ApiClient): Promise<void> {
    if (next !== undefined) client = next;
    if (client === null) return;
    loading.value = true;
    try {
      status.value = await client.status();
      error.value = null;
    } catch (cause) {
      error.value = normalizeError(cause);
    } finally {
      loading.value = false;
    }
  }

  function scheduleRefresh(): void {
    if (debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void load();
    }, STATUS_REFRESH_DEBOUNCE_MS);
  }

  /**
   * Events carry counters when the server bothers to include them; otherwise
   * they only tell us the numbers moved, so we coalesce into one refetch.
   */
  function applyEvent(event: AmberEvent): void {
    const parsed = eventPayloadSchema.safeParse(event.payload);
    const payload = parsed.success ? parsed.data : {};
    if (status.value !== null) {
      const current = status.value;
      status.value = {
        ...current,
        activeSyncs: payload.activeSyncs ?? current.activeSyncs,
        queueDepth: payload.queueDepth ?? current.queueDepth,
        breakerOpen: payload.breakerOpen ?? current.breakerOpen,
      };
    }
    if (
      payload.activeSyncs === undefined &&
      payload.queueDepth === undefined &&
      payload.breakerOpen === undefined
    ) {
      scheduleRefresh();
    }
  }

  return {
    status,
    loading,
    error,
    insecureMode,
    breakerOpen,
    activeSyncs,
    queueDepth,
    summary,
    tone,
    load,
    applyEvent,
  };
});
