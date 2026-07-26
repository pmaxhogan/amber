<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ value: string; label: string; monospace?: boolean }>();

const copied = ref(false);
const failed = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

async function copy(): Promise<void> {
  failed.value = false;
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // Clipboard access can be denied. Select the text so the user can copy it.
    failed.value = true;
    inputRef.value?.select();
  }
}
</script>

<template>
  <div class="copy-field">
    <label :for="`copy-${label.replace(/\W+/g, '-')}`">{{ label }}</label>
    <div class="copy-field__row">
      <input
        :id="`copy-${label.replace(/\W+/g, '-')}`"
        ref="inputRef"
        class="copy-field__input"
        :class="{ mono: monospace }"
        readonly
        :value="value"
        @focus="inputRef?.select()"
      />
      <Button
        size="small"
        severity="secondary"
        :aria-label="`Copy ${label}`"
        :title="`Copy ${label}`"
        @click="copy"
      >
        <AppIcon :name="copied ? 'check' : 'copy'" :size="15" />
      </Button>
    </div>
    <p v-if="copied" class="copy-field__hint" aria-live="polite">Copied to the clipboard.</p>
    <p v-else-if="failed" class="copy-field__hint" aria-live="polite">
      Could not reach the clipboard. The text is selected - copy it manually.
    </p>
  </div>
</template>

<style scoped>
.copy-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.copy-field label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.copy-field__row {
  display: flex;
  gap: 0.4rem;
}

.copy-field__input {
  flex: 1;
  min-width: 0;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--p-form-field-border-color);
  background: var(--p-form-field-background);
  color: var(--p-form-field-color);
  font-size: 0.85rem;
}

.copy-field__input.mono {
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
}

.copy-field__hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
</style>
