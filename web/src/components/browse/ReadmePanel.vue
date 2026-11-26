<script setup lang="ts">
import type { BrowseBlob } from "@amber/shared";
import MarkdownFrame from "../MarkdownFrame.vue";

/**
 * A directory's README under its file list. Markdown goes through the sandboxed
 * renderer; any other README is shown as plain preformatted text.
 */
defineProps<{ blob: BrowseBlob; repoId: number }>();

defineEmits<{ navigate: [path: string] }>();
</script>

<template>
  <section class="readme" aria-label="README">
    <h3 class="readme__title">{{ blob.name }}</h3>
    <div class="readme__body">
      <MarkdownFrame
        v-if="blob.view === 'markdown'"
        :source="blob.text ?? ''"
        :repo-id="repoId"
        :commit="blob.commit"
        :file-path="blob.path"
        @navigate="$emit('navigate', $event)"
      />
      <pre v-else class="readme__plain">{{ blob.text }}</pre>
    </div>
  </section>
</template>

<style scoped>
.readme {
  margin-top: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}

.readme__title {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
  border-bottom: 1px solid var(--p-content-border-color);
}

.readme__body {
  padding: 0.75rem;
  overflow-x: auto;
}

.readme__plain {
  margin: 0;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
