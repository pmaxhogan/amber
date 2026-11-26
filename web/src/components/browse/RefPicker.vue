<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import type { BrowseRef, BrowseRefKind, BrowseResolved } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { shortOid } from "../../lib/browse.ts";
import { useRevResolver } from "../../lib/browseResolve.ts";
import AppIcon from "../AppIcon.vue";
import SegmentedToggle from "./SegmentedToggle.vue";

/**
 * The branch / tag dropdown. It shows what the browser is on, and lists the
 * backup's refs a kind at a time; typing filters on the server so a repo with
 * thousands of tags never has to ship them all. A row is picked by its commit
 * id, never by re-resolving its name.
 */
const props = withDefaults(
  defineProps<{
    repoId: number;
    current: BrowseResolved;
    branchCount: number;
    tagCount: number;
    debounceMs?: number;
  }>(),
  { debounceMs: 200 },
);

const emit = defineEmits<{ select: [BrowseResolved] }>();

const api = useApi();

const root = ref<HTMLElement | null>(null);
const search = ref<{ $el: HTMLElement } | null>(null);
const open = ref(false);
const kind = ref<BrowseRefKind>("branch");
const query = ref("");
const rows = ref<BrowseRef[]>([]);
const truncated = ref(false);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

const onlyOne = computed(() => props.branchCount + props.tagCount === 1);

const label = computed(() => props.current.name ?? shortOid(props.current.oid));
/** A branch can be named like a sha, so the kind is shown, not inferred from the text. */
const KIND_ICONS = { branch: "branch", tag: "tag", commit: "commit" } as const;
const KIND_LABELS = { branch: "Branch", tag: "Tag", commit: "Commit" } as const;

const onlyOneTip = computed(
  () =>
    `This backup only holds one ref (${label.value}), so there is nothing else to pick. ` +
    "That is typical of a shallow backup that keeps only the default branch.",
);

const kindOptions = computed(() => [
  { label: `Branches (${props.branchCount})`, value: "branch" },
  { label: `Tags (${props.tagCount})`, value: "tag" },
]);

let inflight: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  const q = query.value.trim();
  try {
    const result = await api.browseRefs(
      props.repoId,
      q === "" ? { kind: kind.value } : { kind: kind.value, q },
      controller.signal,
    );
    rows.value = result.rows;
    truncated.value = result.truncated;
    error.value = null;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    rows.value = [];
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      inflight = null;
      loading.value = false;
    }
  }
}

function scheduleLoad(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void load();
  }, props.debounceMs);
}

// Enter in the search box jumps to what was typed, on whichever tab is showing.
const jump = useRevResolver(
  () => props.repoId,
  (resolved) => {
    close();
    emit("select", resolved);
  },
);

watch(query, () => {
  jump.clear();
  if (open.value) scheduleLoad();
});

watch(kind, () => {
  if (open.value) void load();
});

function onDocumentMouseDown(event: MouseEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) {
    close();
  }
}

function close(): void {
  open.value = false;
  document.removeEventListener("mousedown", onDocumentMouseDown);
}

async function toggle(): Promise<void> {
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  document.addEventListener("mousedown", onDocumentMouseDown);
  query.value = "";
  jump.clear();
  // A backup of tags only would otherwise open on an empty branch list.
  kind.value = props.branchCount === 0 && props.tagCount > 0 ? "tag" : "branch";
  void load();
  await nextTick();
  search.value?.$el.focus();
}

function pick(row: BrowseRef): void {
  close();
  emit("select", { oid: row.oid, kind: row.kind, name: row.name });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && open.value) {
    event.stopPropagation();
    close();
  }
}

function isCurrent(row: BrowseRef): boolean {
  return props.current.kind === row.kind && props.current.name === row.name;
}

onBeforeUnmount(() => {
  inflight?.abort();
  if (timer !== null) clearTimeout(timer);
  document.removeEventListener("mousedown", onDocumentMouseDown);
});
</script>

<template>
  <div ref="root" class="ref-picker" @keydown="onKeydown">
    <!-- Disabled buttons swallow hover, so the explanation hangs on the wrapper. -->
    <span class="ref-picker__anchor" :title="onlyOne ? onlyOneTip : undefined">
      <Button
        type="button"
        severity="secondary"
        outlined
        size="small"
        class="ref-picker__button"
        :disabled="onlyOne"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-describedby="onlyOne ? 'ref-picker-only-one' : undefined"
        @click="toggle"
      >
        <span
          class="ref-picker__kind"
          role="img"
          :aria-label="KIND_LABELS[current.kind]"
          :title="KIND_LABELS[current.kind]"
        >
          <AppIcon :name="KIND_ICONS[current.kind]" :size="15" />
        </span>
        <span class="ref-picker__label">{{ label }}</span>
        <AppIcon name="chevron" :size="14" />
      </Button>
    </span>
    <span v-if="onlyOne" id="ref-picker-only-one" class="sr-only">{{ onlyOneTip }}</span>

    <div v-if="open" class="ref-picker__panel">
      <InputText
        ref="search"
        v-model="query"
        size="small"
        type="search"
        placeholder="Filter, or type a ref or sha and press Enter"
        aria-label="Filter refs, or jump to a ref or sha"
        autocomplete="off"
        @keydown.enter.prevent="jump.submit(query)"
      />
      <p v-if="jump.message.value" class="ref-picker__note ref-picker__note--error" role="alert">
        {{ jump.message.value }}
      </p>
      <SegmentedToggle v-model="kind" :options="kindOptions" label="Kind of ref" />

      <p v-if="error" class="ref-picker__note ref-picker__note--error" role="alert">
        {{ error.message }}
      </p>
      <p v-else-if="loading && rows.length === 0" class="ref-picker__note">Loading...</p>
      <p v-else-if="rows.length === 0" class="ref-picker__note">
        {{ query.trim() === "" ? "Nothing here." : "No refs match." }}
      </p>
      <ul
        v-else
        class="ref-picker__list"
        role="listbox"
        :aria-label="kind === 'tag' ? 'Tags' : 'Branches'"
      >
        <li v-for="row in rows" :key="`${row.kind}:${row.name}`" role="presentation">
          <button
            type="button"
            role="option"
            class="ref-picker__row"
            :class="{ 'ref-picker__row--current': isCurrent(row) }"
            :aria-selected="isCurrent(row)"
            @click="pick(row)"
          >
            <span
              class="ref-picker__kind"
              role="img"
              :aria-label="KIND_LABELS[row.kind]"
              :title="KIND_LABELS[row.kind]"
            >
              <AppIcon :name="KIND_ICONS[row.kind]" :size="14" />
            </span>
            <span class="ref-picker__name">{{ row.name }}</span>
            <span class="ref-picker__sha mono">{{ shortOid(row.oid) }}</span>
          </button>
        </li>
      </ul>
      <p v-if="truncated" class="ref-picker__note">
        More refs match than are listed. Keep typing to narrow them down.
      </p>
    </div>
  </div>
</template>

<style scoped>
.ref-picker {
  position: relative;
  flex: none;
  max-width: 100%;
}

.ref-picker__anchor {
  display: inline-block;
  max-width: 100%;
}

.ref-picker__anchor :deep(button:disabled) {
  pointer-events: none;
}

.ref-picker__button {
  max-width: 14rem;
  gap: 0.4rem;
}

.ref-picker__kind {
  display: inline-flex;
  flex: none;
  color: var(--p-text-muted-color);
}

.ref-picker__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-picker__panel {
  position: absolute;
  z-index: 20;
  top: calc(100% + 0.25rem);
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: min(22rem, 80vw);
  padding: 0.6rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
}

.ref-picker__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 16rem;
  overflow-y: auto;
}

.ref-picker__row {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  padding: 0.3rem 0.5rem;
  cursor: pointer;
}

.ref-picker__row:hover,
.ref-picker__row:focus-visible {
  background: var(--p-content-hover-background);
}

.ref-picker__row--current {
  font-weight: 600;
  color: var(--p-primary-color);
}

.ref-picker__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ref-picker__sha {
  flex: none;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.ref-picker__note {
  margin: 0;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.ref-picker__note--error {
  color: var(--amber-error);
}
</style>
