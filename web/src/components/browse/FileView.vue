<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import type { BrowseBlob } from "@amber/shared";
import { useApi } from "../../api/provide.ts";
import { humanBytes } from "../../lib/format.ts";
import AppIcon from "../AppIcon.vue";
import MarkdownFrame from "../MarkdownFrame.vue";
import CodeView from "./CodeView.vue";
import SegmentedToggle from "./SegmentedToggle.vue";

/**
 * One file at one commit. What it shows is decided by the server's `view`
 * (and the symlink / LFS / too-large flags); the file's own bytes never pick
 * the markup. Images are an `<img>` pointing at the raw endpoint and nothing
 * else.
 */
const props = defineProps<{ blob: BrowseBlob; repoId: number }>();

const emit = defineEmits<{ history: [path: string]; navigate: [path: string] }>();

const api = useApi();

const mode = ref<"preview" | "source">("preview");
watch(
  () => props.blob.path + props.blob.commit,
  () => {
    mode.value = "preview";
  },
);

const rawUrl = computed(() => api.browseRawUrl(props.repoId, props.blob.commit, props.blob.path));
const inlineUrl = computed(() =>
  api.browseRawUrl(props.repoId, props.blob.commit, props.blob.path, true),
);

const previewOptions = [
  { label: "Preview", value: "preview" },
  { label: "Source", value: "source" },
];
const imageOptions = [
  { label: "Image", value: "preview" },
  { label: "Source", value: "source" },
];

const body = computed<"symlink" | "lfs" | "tooLarge" | "markdown" | "text" | "image" | "binary">(
  () => {
    const blob = props.blob;
    if (blob.symlink) return "symlink";
    if (blob.lfsPointer) return "lfs";
    if (blob.tooLarge) return "tooLarge";
    return blob.view;
  },
);
</script>

<template>
  <section class="file-view">
    <header class="file-view__head">
      <AppIcon name="file" :size="16" />
      <strong class="file-view__name">{{ blob.name }}</strong>
      <span class="amber-muted file-view__size">{{ humanBytes(blob.size) }}</span>
      <span class="file-view__actions">
        <Button
          type="button"
          size="small"
          severity="secondary"
          outlined
          label="History"
          @click="emit('history', blob.path)"
        />
        <a
          class="file-view__download p-button p-button-sm p-button-outlined"
          :href="rawUrl"
          download
        >
          <AppIcon name="download" :size="14" />
          Download
        </a>
      </span>
    </header>

    <div class="file-view__body">
      <p v-if="body === 'symlink'" class="file-view__note">
        Symbolic link to <span class="mono">{{ blob.text }}</span>
      </p>

      <template v-else-if="body === 'lfs'">
        <p class="file-view__note">
          This is a Git LFS pointer. The real file is not part of the backed up tree, so it cannot
          be shown or downloaded here.
        </p>
        <CodeView v-if="blob.text" :text="blob.text" />
      </template>

      <p v-else-if="body === 'tooLarge'" class="file-view__note">
        This file is too large to show here ({{ humanBytes(blob.size) }}). Use the download link to
        get it.
      </p>

      <template v-else-if="body === 'markdown'">
        <SegmentedToggle v-model="mode" :options="previewOptions" label="Markdown view" />
        <MarkdownFrame
          v-if="mode === 'preview'"
          class="file-view__markdown"
          :source="blob.text ?? ''"
          :repo-id="repoId"
          :commit="blob.commit"
          :file-path="blob.path"
          @navigate="emit('navigate', $event)"
        />
        <CodeView v-else :text="blob.text ?? ''" />
      </template>

      <template v-else-if="body === 'image'">
        <SegmentedToggle
          v-if="blob.text !== null"
          v-model="mode"
          :options="imageOptions"
          label="Image view"
        />
        <div v-if="mode === 'preview' || blob.text === null" class="file-view__image">
          <img :src="inlineUrl" :alt="blob.name" />
        </div>
        <CodeView v-else :text="blob.text" />
      </template>

      <p v-else-if="body === 'binary'" class="file-view__note">
        Binary file, {{ humanBytes(blob.size) }}. Use the download link to get it.
      </p>

      <template v-else>
        <p v-if="!blob.text" class="file-view__note">This file is empty.</p>
        <CodeView v-else :text="blob.text" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.file-view__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.file-view__name {
  overflow-wrap: anywhere;
}

.file-view__size {
  font-size: 0.85rem;
}

.file-view__actions {
  display: inline-flex;
  gap: 0.5rem;
  margin-left: auto;
}

.file-view__download {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  text-decoration: none;
}

.file-view__body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: flex-start;
}

.file-view__body > * {
  max-width: 100%;
}

.file-view__body :deep(.code-view),
.file-view__markdown {
  align-self: stretch;
}

.file-view__note {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}

.file-view__image {
  padding: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 50% / 16px 16px;
  align-self: stretch;
  text-align: center;
  overflow: auto;
}

.file-view__image img {
  max-width: 100%;
  height: auto;
}
</style>
