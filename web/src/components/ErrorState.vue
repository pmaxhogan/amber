<script setup lang="ts">
import Button from "primevue/button";
import AppIcon from "./AppIcon.vue";
import type { ApiClientError } from "../api/client.ts";

defineProps<{ error: ApiClientError | null; title?: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="error" class="error-state" role="alert">
    <AppIcon name="alert" :size="28" />
    <h2>{{ title ?? "Something went wrong" }}</h2>
    <p class="error-state__message">{{ error.message }}</p>
    <p class="error-state__code">{{ error.problem }}</p>
    <Button label="Try again" size="small" @click="$emit('retry')" />
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2.5rem 1.5rem;
  text-align: center;
  color: var(--amber-error);
}

.error-state h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
}

.error-state__message {
  margin: 0;
  max-width: 60ch;
  color: var(--p-text-muted-color);
}

.error-state__code {
  margin: 0;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  opacity: 0.75;
}
</style>
