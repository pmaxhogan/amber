<script setup lang="ts">
import Skeleton from "primevue/skeleton";

/**
 * Placeholder rows for a list that is still loading. Shaped like the content it
 * stands in for, so the layout does not jump when the real rows arrive.
 *
 * aria-busy plus a visually hidden label means a screen reader hears "loading"
 * rather than reading out a fence of empty boxes.
 */
withDefaults(defineProps<{ rows?: number; label?: string }>(), {
  rows: 4,
  label: "Loading",
});
</script>

<template>
  <div class="list-skeleton" role="status" aria-busy="true">
    <span class="sr-only">{{ label }}</span>
    <div v-for="row in rows" :key="row" class="list-skeleton__row" aria-hidden="true">
      <Skeleton width="40%" height="0.95rem" />
      <Skeleton width="22%" height="0.8rem" />
      <Skeleton width="14%" height="0.8rem" />
    </div>
  </div>
</template>

<style scoped>
.list-skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem 0;
}

.list-skeleton__row {
  display: flex;
  align-items: center;
  gap: 1.5rem;
}
</style>
