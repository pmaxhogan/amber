<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import type { BrowseCommitSummary } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { shortOid } from "../../lib/browse.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import AppIcon from "../AppIcon.vue";
import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";

/**
 * Commit history from a revision, newest first, optionally only the commits
 * that touched one path. Pages on with the server's `next` cursor.
 */
const props = defineProps<{
  repoId: number;
  /** Full commit id the walk starts at. */
  rev: string;
  /** Empty for the whole repository. */
  path: string;
  shallow: boolean;
}>();

const emit = defineEmits<{
  open: [oid: string];
  browse: [oid: string];
  "clear-path": [];
}>();

const api = useApi();

const rows = ref<BrowseCommitSummary[]>([]);
/** The `skip` of the next page; null once the history has ended. */
const next = ref<number | null>(null);
const loading = ref(false);
const more = ref(false);
const error = ref<ApiClientError | null>(null);

let inflight: AbortController | null = null;

async function fetchPage(skip: number): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  if (skip > 0) more.value = true;
  else loading.value = true;
  error.value = null;
  try {
    // The walk always starts at the same commit; only the offset moves.
    const query = props.path === "" ? { rev: props.rev } : { rev: props.rev, path: props.path };
    const page = await api.browseCommits(
      props.repoId,
      skip > 0 ? { ...query, skip } : query,
      controller.signal,
    );
    rows.value = skip > 0 ? [...rows.value, ...page.rows] : page.rows;
    next.value = page.next;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      inflight = null;
      loading.value = false;
      more.value = false;
    }
  }
}

function reload(): void {
  rows.value = [];
  next.value = null;
  void fetchPage(0);
}

function loadMore(): void {
  if (next.value !== null) void fetchPage(next.value);
}

watch(() => [props.repoId, props.rev, props.path] as const, reload, { immediate: true });

onBeforeUnmount(() => inflight?.abort());
</script>

<template>
  <div class="history-pane">
    <div v-if="path !== ''" class="history-pane__chip">
      <span>
        History of <span class="mono history-pane__path">{{ path }}</span>
      </span>
      <button
        type="button"
        class="history-pane__clear"
        aria-label="Show the history of the whole repository"
        title="Show the history of the whole repository"
        @click="emit('clear-path')"
      >
        <AppIcon name="close" :size="14" />
      </button>
    </div>

    <p v-if="shallow" class="amber-note">This is a shallow backup, so history stops early.</p>

    <ErrorState :error="error" title="Could not load the history" @retry="reload" />
    <ListSkeleton v-if="loading && rows.length === 0" />

    <EmptyState
      v-else-if="error === null && rows.length === 0"
      icon="clock"
      :title="path === '' ? 'No commits' : 'No commits touch this path'"
    />

    <ul v-else-if="rows.length > 0" class="history-pane__list">
      <li v-for="commit in rows" :key="commit.oid" class="history-pane__row">
        <div class="history-pane__main">
          <button type="button" class="history-pane__subject" @click="emit('open', commit.oid)">
            {{ commit.subject === "" ? "(no message)" : commit.subject }}
          </button>
          <span class="history-pane__meta amber-muted">
            {{ commit.authorName }} committed
            <span :title="absoluteTime(commit.committerDate)">{{
              relativeTime(commit.committerDate)
            }}</span>
          </span>
        </div>
        <div class="history-pane__side">
          <code class="history-pane__sha">{{ shortOid(commit.oid) }}</code>
          <Button
            type="button"
            size="small"
            severity="secondary"
            text
            label="Browse files"
            :aria-label="`Browse files at ${shortOid(commit.oid)}`"
            @click="emit('browse', commit.oid)"
          />
        </div>
      </li>
    </ul>

    <div v-if="next !== null" class="history-pane__more">
      <Button
        type="button"
        size="small"
        severity="secondary"
        outlined
        label="Load more"
        :loading="more"
        @click="loadMore"
      />
    </div>
  </div>
</template>

<style scoped>
.history-pane {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.history-pane__chip {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 0.5rem;
  max-width: 100%;
  padding: 0.2rem 0.4rem 0.2rem 0.7rem;
  border-radius: 999px;
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
  font-size: 0.85rem;
}

.history-pane__path {
  overflow-wrap: anywhere;
}

.history-pane__clear {
  appearance: none;
  display: inline-flex;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  padding: 0.2rem;
  cursor: pointer;
}

.history-pane__clear:hover {
  background: var(--p-content-hover-background);
}

.history-pane__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}

.history-pane__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.5rem 0.75rem;
}

.history-pane__row + .history-pane__row {
  border-top: 1px solid var(--p-content-border-color);
}

.history-pane__main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1 1 16rem;
}

.history-pane__subject {
  appearance: none;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 550;
  text-align: left;
  color: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.history-pane__subject:hover {
  text-decoration: underline;
}

.history-pane__meta {
  font-size: 0.8rem;
}

.history-pane__side {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.history-pane__sha {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.history-pane__more {
  display: flex;
  justify-content: center;
}
</style>
