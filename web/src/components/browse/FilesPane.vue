<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import type { BrowseBlob, BrowseContents, BrowseEntry } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { isNotFound, parentPath, pickReadme } from "../../lib/browse.ts";
import { useToaster } from "../../lib/toast.ts";
import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";
import FileList from "./FileList.vue";
import FileView from "./FileView.vue";
import PathCrumbs from "./PathCrumbs.vue";
import ReadmePanel from "./ReadmePanel.vue";

/**
 * The Files mode: a path at a commit, shown as a directory listing (with its
 * README) or as a file. The path lives in the parent so the toolbar can act on
 * it; this pane only asks to change it.
 */
const props = defineProps<{
  repoId: number;
  rootName: string;
  /** Full commit id. */
  commit: string;
  /** Directory or file; empty for the root. */
  path: string;
}>();

const emit = defineEmits<{ navigate: [path: string]; history: [path: string] }>();

const api = useApi();
const toast = useToaster();

const contents = ref<BrowseContents | null>(null);
const readme = ref<BrowseBlob | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

let inflight: AbortController | null = null;
/** A path already fetched to decide between file and directory, reused once. */
let seed: { commit: string; path: string; value: BrowseContents } | null = null;

async function loadReadme(tree: BrowseContents, signal: AbortSignal): Promise<void> {
  if (tree.type !== "tree") return;
  const entry = pickReadme(tree.entries);
  if (entry === null) return;
  try {
    const result = await api.browseContents(props.repoId, tree.commit, entry.path, signal);
    if (signal.aborted) return;
    if (result.type === "blob" && !result.tooLarge && result.text !== null) {
      readme.value = result;
    }
  } catch {
    // A README that will not load must not take the listing down with it.
  }
}

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  error.value = null;
  contents.value = null;
  readme.value = null;
  try {
    let result: BrowseContents;
    if (seed !== null && seed.commit === props.commit && seed.path === props.path) {
      result = seed.value;
    } else {
      result = await api.browseContents(props.repoId, props.commit, props.path, controller.signal);
    }
    seed = null;
    if (controller.signal.aborted) return;
    contents.value = result;
    loading.value = false;
    await loadReadme(result, controller.signal);
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      inflight = null;
      loading.value = false;
    }
  }
}

watch(() => [props.repoId, props.commit, props.path] as const, load, { immediate: true });

onBeforeUnmount(() => inflight?.abort());

function open(entry: BrowseEntry): void {
  emit("navigate", entry.path);
}

/**
 * A link inside rendered markdown. Whether it is a file or a directory is the
 * server's call, and a dead link is a toast rather than a broken view.
 */
async function followMarkdownLink(path: string): Promise<void> {
  try {
    const value = await api.browseContents(props.repoId, props.commit, path);
    seed = { commit: props.commit, path, value };
    emit("navigate", path);
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    if (isNotFound(normalized)) {
      toast.warn("Not found", `That path does not exist at this commit.`);
    } else {
      toast.failure("Could not open that path", normalized);
    }
  }
}
</script>

<template>
  <div class="files-pane">
    <div class="files-pane__bar">
      <PathCrumbs :root-name="rootName" :path="path" @go="emit('navigate', $event)" />
      <Button
        v-if="contents?.type === 'tree' && path !== ''"
        type="button"
        size="small"
        severity="secondary"
        text
        label="History"
        @click="emit('history', path)"
      />
    </div>

    <EmptyState
      v-if="isNotFound(error)"
      icon="folder"
      title="Not found at this commit"
      description="That path does not exist in this version of the repository."
    >
      <Button type="button" size="small" label="Go to the top" @click="emit('navigate', '')" />
    </EmptyState>
    <ErrorState v-else :error="error" title="Could not open this path" @retry="load" />

    <ListSkeleton v-if="loading && contents === null" />

    <template v-else-if="contents?.type === 'tree'">
      <FileList :tree="contents" @open="open" @up="emit('navigate', parentPath(path))" />
      <ReadmePanel
        v-if="readme !== null"
        :blob="readme"
        :repo-id="repoId"
        @navigate="followMarkdownLink"
      />
    </template>

    <FileView
      v-else-if="contents?.type === 'blob'"
      :blob="contents"
      :repo-id="repoId"
      @history="emit('history', $event)"
      @navigate="followMarkdownLink"
    />
  </div>
</template>

<style scoped>
.files-pane {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.files-pane__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
</style>
