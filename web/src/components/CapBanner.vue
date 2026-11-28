<script setup lang="ts">
import { computed } from "vue";
import { humanBytes } from "../lib/format.ts";
import { useMeStore } from "../stores/me.ts";
import AppIcon from "./AppIcon.vue";

/**
 * Persistent, not dismissible: being at the storage cap is a property of the
 * account until space is freed or the admin raises the cap. It disappears by
 * itself when the next identity refresh reports the user under the cap.
 */
const me = useMeStore();

const used = computed(() => humanBytes(me.storage?.usedBytes ?? 0));
const cap = computed(() => humanBytes(me.storage?.capBytes ?? null));
</script>

<template>
  <div v-if="me.overCap" class="cap-banner" role="alert" data-testid="cap-banner">
    <AppIcon name="alert" :size="20" />
    <p>
      <strong>You are at your storage limit ({{ used }} of {{ cap }}).</strong>
      <template v-if="me.storage?.atCeiling === true">
        You are using twice your limit, so syncing is paused for all your repositories. New imports
        are refused too. Remove repositories, or ask the Amber admin for more space.
      </template>
      <template v-else>
        New imports are refused. Your existing backups keep syncing until you reach twice your
        limit, when syncing pauses. Remove repositories, or ask the Amber admin for more space.
      </template>
    </p>
  </div>
</template>

<style scoped>
.cap-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 0.6rem 1rem;
  background: var(--amber-warn-bg);
  color: var(--amber-warn);
  border-bottom: 2px solid var(--amber-warn);
  font-size: 0.9rem;
  text-align: center;
}

.cap-banner p {
  margin: 0;
}
</style>
