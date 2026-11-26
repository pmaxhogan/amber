<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import type { BrowseRefs, BrowseResolved } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import type { RepoRow } from "../../api/types.ts";
import { isNotBackedUp, shortOid } from "../../lib/browse.ts";
import { safeFileName } from "../../lib/format.ts";
import { saveBlob } from "../../lib/folderDownload.ts";
import { useToaster } from "../../lib/toast.ts";
import AppIcon from "../AppIcon.vue";
import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";
import CommitView from "./CommitView.vue";
import FilesPane from "./FilesPane.vue";
import HistoryPane from "./HistoryPane.vue";
import RefPicker from "./RefPicker.vue";
import RevJump from "./RevJump.vue";
import SegmentedToggle from "./SegmentedToggle.vue";

/**
 * The Browse tab of the repo drawer: a read-only view of what the backup
 * holds. Mounted lazily, the first time the tab is opened.
 *
 * The state is deliberately small and local: the revision being browsed (always
 * resolved to a commit id), a mode, a path and, in commit mode, the commit
 * being read. Nothing here is in the URL.
 */
const props = defineProps<{ repo: RepoRow }>();

type Mode = "files" | "history" | "commit";

const api = useApi();
const toast = useToaster();

const refs = ref<BrowseRefs | null>(null);
const loading = ref(true);
const error = ref<ApiClientError | null>(null);

const revision = ref<BrowseResolved | null>(null);
const mode = ref<Mode>("files");
const path = ref("");
/** Set while History is narrowed to one file or directory. */
const historyPath = ref("");
const commitOid = ref<string | null>(null);
const zipping = ref(false);

const notBackedUp = computed(() => isNotBackedUp(error.value));

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  error.value = null;
  try {
    const result = await api.browseRefs(props.repo.id, {}, controller.signal);
    if (controller.signal.aborted) return;
    refs.value = result;
    revision.value = result.head;
    mode.value = "files";
    path.value = "";
    historyPath.value = "";
    commitOid.value = null;
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

watch(() => props.repo.id, load, { immediate: true });

onBeforeUnmount(() => inflight?.abort());

/** Switching ref or commit starts over at the top of the tree. */
function switchRevision(next: BrowseResolved): void {
  revision.value = next;
  path.value = "";
  historyPath.value = "";
  commitOid.value = null;
  if (mode.value === "commit") mode.value = "files";
}

function showFiles(): void {
  mode.value = "files";
  commitOid.value = null;
}

function openHistory(forPath: string): void {
  historyPath.value = forPath;
  mode.value = "history";
  commitOid.value = null;
}

function onModeChange(value: string): void {
  if (value === "files") showFiles();
  else openHistory(path.value);
}

function openCommit(oid: string): void {
  commitOid.value = oid;
  mode.value = "commit";
}

function browseAtCommit(oid: string): void {
  switchRevision({ oid, kind: "commit", name: null });
  mode.value = "files";
}

function goTo(next: string): void {
  path.value = next;
  mode.value = "files";
}

async function downloadZip(): Promise<void> {
  if (revision.value === null) return;
  // In commit mode the page on screen is one commit, so that is what to pack.
  const target =
    mode.value === "commit" && commitOid.value !== null ? commitOid.value : revision.value.oid;
  zipping.value = true;
  try {
    const blob = await api.downloadExport(props.repo.id, "source", "zip", target);
    saveBlob(blob, `${safeFileName(props.repo.displayName)}-${shortOid(target)}.zip`);
    toast.success("Download ready");
  } catch (cause) {
    toast.failure("Could not download the archive", cause);
  } finally {
    zipping.value = false;
  }
}

const modeOptions = [
  { label: "Files", value: "files" },
  { label: "History", value: "history" },
];
</script>

<template>
  <div class="repo-browser">
    <ListSkeleton v-if="loading" label="Loading the backup" />

    <EmptyState
      v-else-if="notBackedUp"
      icon="repos"
      title="Not backed up yet"
      description="There is nothing to browse until the first sync has finished. Try again once it has."
    >
      <Button type="button" size="small" label="Check again" @click="load" />
    </EmptyState>

    <ErrorState v-else-if="error" :error="error" title="Could not open the backup" @retry="load" />

    <EmptyState
      v-else-if="refs !== null && refs.head === null"
      icon="commit"
      title="This backup has no commits yet."
    />

    <template v-else-if="refs !== null && revision !== null">
      <div class="repo-browser__toolbar">
        <RefPicker
          :repo-id="repo.id"
          :current="revision"
          :branch-count="refs.branchCount"
          :tag-count="refs.tagCount"
          @select="switchRevision"
        />
        <RevJump :repo-id="repo.id" @jump="switchRevision" />
      </div>

      <div class="repo-browser__bar">
        <SegmentedToggle
          :model-value="mode === 'commit' ? null : mode"
          :options="modeOptions"
          label="What to show"
          @update:model-value="onModeChange"
        />
        <Button
          type="button"
          size="small"
          severity="secondary"
          outlined
          :loading="zipping"
          @click="downloadZip"
        >
          <AppIcon name="download" :size="14" />
          Download zip
        </Button>
      </div>

      <FilesPane
        v-if="mode === 'files'"
        :repo-id="repo.id"
        :root-name="repo.displayName"
        :commit="revision.oid"
        :path="path"
        @navigate="goTo"
        @history="openHistory"
      />
      <HistoryPane
        v-else-if="mode === 'history'"
        :repo-id="repo.id"
        :rev="revision.oid"
        :path="historyPath"
        :shallow="refs.shallow"
        @open="openCommit"
        @browse="browseAtCommit"
        @clear-path="historyPath = ''"
      />
      <CommitView
        v-else-if="commitOid !== null"
        :repo-id="repo.id"
        :oid="commitOid"
        @back="mode = 'history'"
        @open="openCommit"
        @browse="browseAtCommit"
      />
    </template>
  </div>
</template>

<style scoped>
.repo-browser {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.repo-browser__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.5rem;
}

.repo-browser__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
</style>
