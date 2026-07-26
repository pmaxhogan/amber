<script setup lang="ts">
import Button from "primevue/button";
import Dialog from "primevue/dialog";

/**
 * Local confirmation dialog rather than PrimeVue's ConfirmationService, so a
 * destructive action is a plain parent-owned boolean that a test can assert on
 * without installing a service.
 */
withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    busy?: boolean;
  }>(),
  { confirmLabel: "Confirm", danger: false, busy: false },
);

const emit = defineEmits<{ "update:visible": [boolean]; confirm: [] }>();
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    :style="{ width: 'min(30rem, 92vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="confirm-message">{{ message }}</p>
    <slot />
    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        :disabled="busy"
        @click="emit('update:visible', false)"
      />
      <Button
        :label="confirmLabel"
        :severity="danger ? 'danger' : 'primary'"
        :loading="busy"
        @click="emit('confirm')"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-message {
  margin: 0 0 0.5rem;
  color: var(--p-text-muted-color);
  line-height: 1.5;
}
</style>
