<script setup lang="ts">
import { computed } from "vue";
import { breadcrumbs } from "../../lib/browse.ts";

/** Where we are in the tree. Every crumb but the last opens that directory. */
const props = defineProps<{ rootName: string; path: string }>();

defineEmits<{ go: [path: string] }>();

const crumbs = computed(() => breadcrumbs(props.path));
</script>

<template>
  <nav class="crumbs" aria-label="Path">
    <button v-if="path !== ''" type="button" class="crumbs__link" @click="$emit('go', '')">
      {{ rootName }}
    </button>
    <strong v-else class="crumbs__here">{{ rootName }}</strong>
    <template v-for="(crumb, index) in crumbs" :key="crumb.path">
      <span class="crumbs__sep" aria-hidden="true">/</span>
      <strong v-if="index === crumbs.length - 1" class="crumbs__here">{{ crumb.name }}</strong>
      <button v-else type="button" class="crumbs__link" @click="$emit('go', crumb.path)">
        {{ crumb.name }}
      </button>
    </template>
  </nav>
</template>

<style scoped>
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem;
  font-size: 0.9rem;
  word-break: break-all;
}

.crumbs__link {
  appearance: none;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--p-primary-color);
  cursor: pointer;
}

.crumbs__link:hover {
  text-decoration: underline;
}

.crumbs__sep {
  color: var(--p-text-muted-color);
}

.crumbs__here {
  font-weight: 600;
}
</style>
