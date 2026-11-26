<script setup lang="ts">
import { ref } from "vue";
import InputText from "primevue/inputtext";
import type { BrowseResolved } from "@amber/shared";
import { useRevResolver } from "../../lib/browseResolve.ts";

/**
 * Type a branch, tag, short sha or full sha and press Enter. This is a
 * separate control from the ref picker on purpose: it keeps working when the
 * picker is disabled (a backup with a single ref) or lists the wrong kind.
 */
const props = defineProps<{ repoId: number }>();

const emit = defineEmits<{ jump: [BrowseResolved] }>();

const text = ref("");

const { busy, message, submit, clear } = useRevResolver(
  () => props.repoId,
  (resolved) => {
    text.value = "";
    emit("jump", resolved);
  },
);
</script>

<template>
  <div class="rev-jump">
    <InputText
      v-model="text"
      size="small"
      class="rev-jump__input"
      placeholder="Jump to a branch, tag or commit"
      aria-label="Jump to a branch, tag or commit"
      autocomplete="off"
      spellcheck="false"
      :aria-busy="busy"
      :aria-invalid="message !== ''"
      @keydown.enter.prevent="submit(text)"
      @input="clear"
    />
    <p v-if="message" class="rev-jump__message" role="alert">{{ message }}</p>
  </div>
</template>

<style scoped>
.rev-jump {
  flex: 1 1 14rem;
  min-width: 0;
}

.rev-jump__input {
  width: 100%;
}

.rev-jump__message {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: var(--amber-error);
  overflow-wrap: anywhere;
}
</style>
