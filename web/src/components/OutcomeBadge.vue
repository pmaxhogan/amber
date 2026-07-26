<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import type { DerivedOutcome } from "../api/types.ts";

const props = defineProps<{ outcome: DerivedOutcome; label?: string }>();

const LOOKUP: Record<DerivedOutcome, { icon: string; text: string }> = {
  success: { icon: "check", text: "Succeeded" },
  error: { icon: "alert", text: "Failed" },
  canceled: { icon: "close", text: "Canceled" },
  pending: { icon: "clock", text: "Not synced yet" },
};

const meta = computed(() => LOOKUP[props.outcome]);
</script>

<template>
  <span class="outcome" :class="`outcome--${outcome}`">
    <AppIcon :name="meta.icon" :size="14" :title="meta.text" />
    <span>{{ label ?? meta.text }}</span>
  </span>
</template>

<style scoped>
.outcome {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
  white-space: nowrap;
}

.outcome--success {
  color: var(--amber-success);
}

.outcome--error {
  color: var(--amber-error);
}

.outcome--canceled,
.outcome--pending {
  color: var(--p-text-muted-color);
}
</style>
