<script setup lang="ts">
import { computed } from "vue";
import { countLines, gutterText } from "../../lib/browse.ts";

/**
 * File text with line numbers and no wrapping. A file can be a megabyte, so
 * this is two text nodes (the numbers and the code) instead of an element per
 * line; both blocks share a font and line height so the rows stay aligned.
 */
const props = defineProps<{ text: string }>();

const lines = computed(() => countLines(props.text));
const gutter = computed(() => gutterText(lines.value));
</script>

<template>
  <div class="code-view">
    <pre class="code-view__gutter" aria-hidden="true">{{ gutter }}</pre>
    <pre class="code-view__code"><code>{{ text }}</code></pre>
  </div>
</template>

<style scoped>
.code-view {
  display: flex;
  overflow: auto;
  max-height: 70vh;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}

.code-view pre {
  margin: 0;
  /* Block only: a shorthand here would outrank the inline padding below. */
  padding-block: 0.5rem;
  font: inherit;
  line-height: inherit;
  tab-size: 4;
  white-space: pre;
}

.code-view__gutter {
  position: sticky;
  left: 0;
  flex: none;
  padding-inline: 0.75rem;
  text-align: right;
  color: var(--p-text-muted-color);
  background: var(--p-content-background);
  border-right: 1px solid var(--p-content-border-color);
  user-select: none;
}

.code-view__code {
  flex: 1 0 auto;
  padding-inline: 0.75rem;
}
</style>
