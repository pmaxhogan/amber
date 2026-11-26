<script setup lang="ts">
import { computed } from "vue";
import type { Forge } from "@amber/shared";
import { useApi } from "../api/provide.ts";
import type { RepoRow } from "../api/types.ts";
import { forgeOrigin } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";

/**
 * The "Fork of" cell, shared by the repository tables. A real link to the
 * upstream's page on the forge, so a middle or modified click behaves as the
 * browser would anyway. A plain click opens the upstream's own backup instead
 * when amber tracks it: the parent decides how by listening for `open`.
 */
const props = defineProps<{ repo: RepoRow; forge: Forge | undefined }>();
const emit = defineEmits<{ open: [repo: RepoRow] }>();

const api = useApi();
const toast = useToaster();

/** The upstream's page on the forge. Null when the repo's forge is not loaded yet. */
const url = computed(() => {
  if (props.forge === undefined || props.repo.forkParent === null) return null;
  const path = props.repo.forkParent
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${forgeOrigin(props.forge)}/${path}`;
});

/**
 * Every click stops here: the table row around this cell opens the row's own
 * drawer, and a click on its upstream must not also do that.
 */
function onClick(event: MouseEvent): void {
  event.stopPropagation();
  const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
  if (event.button !== 0 || modified) return;
  const parentId = props.repo.forkParentRepoId;
  if (parentId === null || parentId === undefined) return;
  event.preventDefault();
  void openParent(parentId);
}

async function openParent(parentId: number): Promise<void> {
  try {
    // The upstream may not be in the loaded list, so read it by id.
    emit("open", await api.getRepo(parentId));
  } catch (cause) {
    toast.failure("Could not open the upstream repository", cause);
    if (url.value !== null) window.open(url.value, "_blank", "noopener,noreferrer");
  }
}
</script>

<template>
  <template v-if="repo.forkParent">
    <a
      v-if="url"
      :href="url"
      target="_blank"
      rel="noopener noreferrer"
      class="fork-link mono"
      :title="repo.forkParent"
      @click="onClick"
      @keydown.enter.stop
      >{{ repo.forkParent }}</a
    >
    <span v-else class="fork-link mono" :title="repo.forkParent">{{ repo.forkParent }}</span>
  </template>
</template>

<style scoped>
.fork-link {
  display: inline-block;
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-size: 0.82rem;
  color: var(--p-primary-color);
}
</style>
