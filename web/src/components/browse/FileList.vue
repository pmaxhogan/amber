<script setup lang="ts">
import type { BrowseEntry, BrowseTree } from "@amber/shared";
import { humanBytes } from "../../lib/format.ts";
import { shortOid } from "../../lib/browse.ts";
import AppIcon from "../AppIcon.vue";

/** One directory: a ".." row, then directories, then files. */
defineProps<{ tree: BrowseTree }>();

defineEmits<{ open: [entry: BrowseEntry]; up: [] }>();

function iconFor(entry: BrowseEntry): string {
  if (entry.type === "tree") return "folder";
  if (entry.type === "symlink") return "link";
  if (entry.type === "submodule") return "remote";
  return "file";
}
</script>

<template>
  <ul class="file-list">
    <li v-if="tree.path !== ''">
      <button type="button" class="file-list__row" @click="$emit('up')">
        <AppIcon name="folder" :size="16" />
        <span class="file-list__name">..</span>
      </button>
    </li>
    <li v-for="entry in tree.entries" :key="entry.path">
      <div v-if="entry.type === 'submodule'" class="file-list__row file-list__row--static">
        <AppIcon :name="iconFor(entry)" :size="16" />
        <span class="file-list__name">{{ entry.name }}</span>
        <span class="file-list__meta amber-muted">
          submodule <span class="mono">{{ shortOid(entry.oid) }}</span>
        </span>
      </div>
      <button v-else type="button" class="file-list__row" @click="$emit('open', entry)">
        <AppIcon :name="iconFor(entry)" :size="16" />
        <span class="file-list__name">{{ entry.name }}</span>
        <span v-if="entry.type === 'symlink'" class="file-list__meta amber-muted">symlink</span>
        <span v-if="entry.size !== null" class="file-list__meta amber-muted">
          {{ humanBytes(entry.size) }}
        </span>
      </button>
    </li>
    <li v-if="tree.entries.length === 0" class="file-list__empty amber-muted">
      This directory is empty.
    </li>
  </ul>
  <p v-if="tree.truncated" class="amber-note">
    This directory is too large to list in full: only the first {{ tree.entries.length }} entries
    are shown.
  </p>
</template>

<style scoped>
.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  overflow: hidden;
}

.file-list li + li {
  border-top: 1px solid var(--p-content-border-color);
}

.file-list__row {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  text-align: left;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
}

button.file-list__row:hover,
button.file-list__row:focus-visible {
  background: var(--p-content-hover-background);
}

.file-list__row--static {
  cursor: default;
}

.file-list__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.file-list__meta {
  flex: none;
  font-size: 0.8rem;
}

.file-list__empty {
  padding: 0.75rem;
  font-size: 0.9rem;
}
</style>
