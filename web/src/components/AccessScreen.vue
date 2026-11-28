<script setup lang="ts">
import Button from "primevue/button";
import AppIcon from "./AppIcon.vue";

/**
 * Full-page stand-in for the whole app when the caller cannot be admitted or
 * Amber cannot tell. Nothing else renders, so no navigation or data leaks to
 * someone who is not a user.
 */
defineProps<{
  title: string;
  message: string;
  detail?: string;
  /** Label of a retry button; no button when absent. */
  retryLabel?: string;
  icon?: string;
}>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <main class="access-screen" role="alert">
    <div class="access-screen__card">
      <AppIcon :name="icon ?? 'shield'" :size="36" />
      <h1>{{ title }}</h1>
      <p>{{ message }}</p>
      <p v-if="detail" class="access-screen__detail">{{ detail }}</p>
      <Button v-if="retryLabel" :label="retryLabel" size="small" @click="$emit('retry')" />
    </div>
  </main>
</template>

<style scoped>
.access-screen {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.access-screen__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  max-width: 34rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.access-screen__card h1 {
  margin: 0;
  font-size: 1.35rem;
  color: var(--p-text-color);
}

.access-screen__card p {
  margin: 0;
  line-height: 1.55;
}

.access-screen__detail {
  font-size: 0.82rem;
  opacity: 0.8;
}
</style>
