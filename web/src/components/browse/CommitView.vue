<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import type { BrowseCommitDetail } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { shortOid } from "../../lib/browse.ts";
import { countPatchLines, planCollapsed } from "../../lib/diff.ts";
import { absoluteTime, pluralize } from "../../lib/format.ts";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";
import DiffFile from "./DiffFile.vue";

/** One commit: its message, people, parents and the diff against its first parent. */
const props = defineProps<{ repoId: number; oid: string }>();

const emit = defineEmits<{ back: []; open: [oid: string]; browse: [oid: string] }>();

const api = useApi();

const detail = ref<BrowseCommitDetail | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  error.value = null;
  detail.value = null;
  try {
    const result = await api.browseCommit(props.repoId, props.oid, controller.signal);
    if (controller.signal.aborted) return;
    detail.value = result;
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

/**
 * Files whose diff starts collapsed. One budget covers the whole commit, so a
 * commit of hundreds of mid-sized files cannot put hundreds of thousands of rows
 * on the page.
 */
const collapsedPlan = computed(() =>
  planCollapsed(
    (detail.value?.files ?? []).map((file) =>
      file.patch === null ? 0 : countPatchLines(file.patch),
    ),
  ),
);
const collapsedCount = computed(() => collapsedPlan.value.filter(Boolean).length);

watch(() => [props.repoId, props.oid] as const, load, { immediate: true });

onBeforeUnmount(() => inflight?.abort());
</script>

<template>
  <div class="commit-view">
    <div class="commit-view__bar">
      <Button
        type="button"
        size="small"
        severity="secondary"
        text
        label="Back to history"
        @click="emit('back')"
      />
      <Button
        type="button"
        size="small"
        severity="secondary"
        outlined
        label="Browse files at this commit"
        @click="emit('browse', oid)"
      />
    </div>

    <ErrorState :error="error" title="Could not load this commit" @retry="load" />
    <ListSkeleton v-if="loading" />

    <template v-else-if="detail">
      <header class="commit-view__head">
        <h3 class="commit-view__subject">
          {{ detail.subject === "" ? "(no message)" : detail.subject }}
        </h3>
        <pre v-if="detail.body" class="commit-view__body">{{ detail.body }}</pre>
      </header>

      <dl class="commit-view__facts">
        <div>
          <dt>Author</dt>
          <dd>
            {{ detail.authorName }}
            <span class="amber-muted">&lt;{{ detail.authorEmail }}&gt;</span>
            <span class="amber-muted"> on {{ absoluteTime(detail.authorDate) }}</span>
          </dd>
        </div>
        <div>
          <dt>Committer</dt>
          <dd>
            {{ detail.committerName }}
            <span class="amber-muted">&lt;{{ detail.committerEmail }}&gt;</span>
            <span class="amber-muted"> on {{ absoluteTime(detail.committerDate) }}</span>
          </dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd class="mono commit-view__oid">{{ detail.oid }}</dd>
        </div>
        <div>
          <dt>{{ detail.parents.length === 1 ? "Parent" : "Parents" }}</dt>
          <dd>
            <span v-if="detail.parents.length === 0" class="amber-muted">none (root commit)</span>
            <button
              v-for="parent in detail.parents"
              :key="parent"
              type="button"
              class="commit-view__parent mono"
              @click="emit('open', parent)"
            >
              {{ shortOid(parent) }}
            </button>
          </dd>
        </div>
      </dl>

      <p v-if="detail.missingParents" class="amber-note">
        This commit is the edge of a shallow backup, so there is nothing earlier to compare it with.
      </p>

      <p class="commit-view__summary">
        {{ pluralize(detail.filesChanged, "file") }} changed,
        <span class="commit-view__plus">+{{ detail.additions }}</span>
        <span class="commit-view__minus"> -{{ detail.deletions }}</span>
      </p>
      <p v-if="detail.filesTruncated" class="amber-note">
        Showing {{ detail.files.length }} of {{ detail.filesChanged }} files.
      </p>

      <p v-if="collapsedCount > 0" class="amber-note">
        {{ pluralize(collapsedCount, "file") }} collapsed for size. Use "Show diff" on a file to
        open it.
      </p>

      <div class="commit-view__files">
        <DiffFile
          v-for="(file, index) in detail.files"
          :key="file.path + ':' + (file.oldPath ?? '')"
          :file="file"
          :collapse="collapsedPlan[index] === true"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.commit-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.commit-view__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.commit-view__subject {
  margin: 0;
  font-size: 1.05rem;
  overflow-wrap: anywhere;
}

.commit-view__body {
  margin: 0.5rem 0 0;
  font: inherit;
  font-size: 0.9rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.commit-view__facts {
  display: grid;
  gap: 0.4rem;
  margin: 0;
  font-size: 0.85rem;
}

.commit-view__facts > div {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
}

.commit-view__facts dt {
  flex: none;
  width: 5.5rem;
  color: var(--p-text-muted-color);
}

.commit-view__facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.commit-view__oid {
  font-size: 0.8rem;
}

.commit-view__parent {
  appearance: none;
  margin-right: 0.5rem;
  border: 0;
  background: none;
  padding: 0;
  font-size: 0.85rem;
  color: var(--p-primary-color);
  cursor: pointer;
}

.commit-view__parent:hover {
  text-decoration: underline;
}

.commit-view__summary {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 550;
}

.commit-view__plus {
  color: var(--amber-success);
}

.commit-view__minus {
  color: var(--amber-error);
}

.commit-view__files {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
