<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useStatusStore } from "../stores/status.ts";
import { useEventsStore } from "../stores/events.ts";
import AppIcon from "./AppIcon.vue";
import { computed } from "vue";

const status = useStatusStore();
const events = useEventsStore();
const { summary, tone } = storeToRefs(status);

const icon = computed(() => {
  if (tone.value === "error") return "alert";
  if (tone.value === "warn") return "shield";
  if (tone.value === "busy") return "sync";
  return "check";
});

const connection = computed(() =>
  events.state === "open" ? "Live updates connected" : `Live updates ${events.state}`,
);
</script>

<template>
  <div class="status-pill" :class="`tone-${tone}`" :title="connection">
    <AppIcon :name="icon" :size="14" />
    <span class="status-pill__text" aria-live="polite">{{ summary }}</span>
    <span class="sr-only">{{ connection }}</span>
  </div>
</template>

<style scoped>
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  font-size: 0.8rem;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.status-pill.tone-busy {
  border-color: var(--p-primary-600);
  color: var(--p-primary-color);
}

.status-pill.tone-warn {
  border-color: #6b5a16;
  color: var(--amber-warn);
}

.status-pill.tone-error {
  border-color: #6e2e2c;
  color: var(--amber-error);
}
</style>
