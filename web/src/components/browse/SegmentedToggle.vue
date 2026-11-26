<script setup lang="ts">
/**
 * A small joined row of buttons where exactly one (or none) is pressed. Used
 * for Files | History, Preview | Source and Branches | Tags.
 */
defineProps<{
  modelValue: string | null;
  options: { label: string; value: string }[];
  label: string;
}>();

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <div class="segmented" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="segmented__item"
      :class="{ 'segmented__item--on': option.value === modelValue }"
      :aria-pressed="option.value === modelValue"
      @click="$emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  overflow: hidden;
}

.segmented__item {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--p-text-muted-color);
  font: inherit;
  font-size: 0.85rem;
  padding: 0.3rem 0.75rem;
  cursor: pointer;
}

.segmented__item + .segmented__item {
  border-left: 1px solid var(--p-content-border-color);
}

.segmented__item:hover {
  color: var(--p-text-color);
}

.segmented__item:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -2px;
}

.segmented__item--on {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
  font-weight: 550;
}
</style>
