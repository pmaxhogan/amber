<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

withDefaults(defineProps<{ icon?: string; title: string; description?: string }>(), {
  icon: "repos",
  description: undefined,
});
</script>

<template>
  <div class="empty-state">
    <AppIcon :name="icon" :size="34" />
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <div class="empty-state__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 3rem 1.5rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.empty-state h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
}

.empty-state p {
  margin: 0;
  max-width: 46ch;
  font-size: 0.9rem;
}

.empty-state__actions {
  margin-top: 0.5rem;
}
</style>
