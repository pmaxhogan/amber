<script setup lang="ts">
import { computed } from "vue";
import { useThemeStore } from "../stores/theme.ts";
import AppIcon from "./AppIcon.vue";

const theme = useThemeStore();
const label = computed(() => (theme.dark ? "Switch to light mode" : "Switch to dark mode"));
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :aria-label="label"
    :aria-pressed="theme.dark"
    :title="label"
    @click="theme.toggle()"
  >
    <AppIcon :name="theme.dark ? 'moon' : 'sun'" :size="16" />
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 8px;
  border: 1px solid var(--p-content-border-color);
  background: transparent;
  color: var(--p-text-muted-color);
  cursor: pointer;
}

.theme-toggle:hover {
  color: var(--p-text-color);
  background: var(--p-content-hover-background);
}
</style>
