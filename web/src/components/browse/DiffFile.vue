<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "primevue/button";
import type { BrowseDiffFile } from "@amber/shared";
import {
  DIFF_COLLAPSE_LINES,
  DIFF_MAX_FILE_ROWS,
  countPatchLines,
  parsePatch,
} from "../../lib/diff.ts";

/**
 * One changed file of a commit. A long patch starts collapsed, and so does any
 * file the commit view has no row budget left for: parsing and painting rows
 * nobody asked for would make the page crawl. An expanded patch shows its first
 * rows and offers the rest on request.
 */
const props = withDefaults(defineProps<{ file: BrowseDiffFile; collapse?: boolean }>(), {
  collapse: false,
});

const STATUS_LABELS: Record<BrowseDiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  type_changed: "type changed",
};

const lineCount = computed(() =>
  props.file.patch === null ? 0 : countPatchLines(props.file.patch),
);
const expanded = ref(false);
const showAll = ref(false);
const collapsed = computed(
  () => (props.collapse || lineCount.value > DIFF_COLLAPSE_LINES) && !expanded.value,
);
const parsed = computed(() =>
  props.file.patch === null || collapsed.value ? [] : parsePatch(props.file.patch),
);
const rows = computed(() =>
  showAll.value ? parsed.value : parsed.value.slice(0, DIFF_MAX_FILE_ROWS),
);
const hiddenRows = computed(() => parsed.value.length - rows.value.length);
const moved = computed(() => props.file.oldPath !== null && props.file.oldPath !== props.file.path);
</script>

<template>
  <section class="diff-file">
    <header class="diff-file__head">
      <span class="diff-file__status" :class="`diff-file__status--${file.status}`">{{
        STATUS_LABELS[file.status]
      }}</span>
      <span class="diff-file__path mono">
        <template v-if="moved">{{ file.oldPath }} -&gt; </template>{{ file.path }}
      </span>
      <span class="diff-file__counts mono">
        <template v-if="file.binary">binary</template>
        <template v-else>
          <span class="diff-file__plus">+{{ file.additions ?? 0 }}</span>
          <span class="diff-file__minus">-{{ file.deletions ?? 0 }}</span>
        </template>
      </span>
    </header>

    <p v-if="file.binary" class="diff-file__note">Binary file, or too large to diff.</p>
    <p v-else-if="file.patch === null && !file.truncated" class="diff-file__note">
      No textual changes (a rename, copy or mode change).
    </p>
    <p v-if="file.truncated" class="diff-file__note">
      This diff was cut for size{{ file.patch === null ? ", so none of it is shown" : "" }}.
    </p>

    <div v-if="collapsed" class="diff-file__collapsed">
      <Button
        type="button"
        size="small"
        severity="secondary"
        outlined
        label="Show diff"
        @click="expanded = true"
      />
      <span class="amber-muted">{{ lineCount }} lines</span>
    </div>

    <div v-else-if="rows.length > 0" class="diff-file__patch" role="table" aria-label="Diff">
      <div
        v-for="(row, index) in rows"
        :key="index"
        class="diff-line"
        :class="`diff-line--${row.kind}`"
        role="row"
      >
        <span class="diff-line__no" role="cell">{{ row.oldNo ?? "" }}</span>
        <span class="diff-line__no" role="cell">{{ row.newNo ?? "" }}</span>
        <span class="diff-line__text" role="cell">{{ row.text }}</span>
      </div>
    </div>

    <div v-if="hiddenRows > 0" class="diff-file__collapsed">
      <Button
        type="button"
        size="small"
        severity="secondary"
        outlined
        :label="`Show the rest (${hiddenRows} more lines)`"
        @click="showAll = true"
      />
    </div>
  </section>
</template>

<style scoped>
.diff-file {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  overflow: hidden;
}

.diff-file__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--p-content-hover-background);
  font-size: 0.85rem;
}

.diff-file__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.diff-file__status {
  flex: none;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--amber-info-bg);
  color: var(--amber-info);
}

.diff-file__status--added {
  background: var(--amber-success-bg);
  color: var(--amber-success);
}

.diff-file__status--deleted {
  background: var(--amber-error-bg);
  color: var(--amber-error);
}

.diff-file__status--renamed,
.diff-file__status--copied,
.diff-file__status--type_changed {
  background: var(--amber-warn-bg);
  color: var(--amber-warn);
}

.diff-file__counts {
  display: inline-flex;
  gap: 0.5rem;
  flex: none;
  color: var(--p-text-muted-color);
}

.diff-file__plus {
  color: var(--amber-success);
}

.diff-file__minus {
  color: var(--amber-error);
}

.diff-file__note {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.diff-file__collapsed {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
}

.diff-file__patch {
  overflow-x: auto;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.78rem;
  line-height: 1.5;
}

.diff-line {
  display: grid;
  grid-template-columns: 3.5rem 3.5rem 1fr;
  min-width: max-content;
  min-height: 1.5em;
}

.diff-line__no {
  padding-inline: 0.5rem;
  text-align: right;
  color: var(--p-text-muted-color);
  user-select: none;
}

.diff-line__text {
  padding-inline: 0.5rem;
  white-space: pre;
}

.diff-line--add {
  background: var(--amber-success-bg);
}

.diff-line--del {
  background: var(--amber-error-bg);
}

.diff-line--hunk {
  background: var(--amber-info-bg);
  color: var(--amber-info);
}

.diff-line--meta {
  color: var(--p-text-muted-color);
  font-style: italic;
}
</style>
