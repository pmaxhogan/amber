<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import {
  settingKeysForScope,
  settingsRegistry,
  type SettingKey,
  type SettingScope,
} from "@amber/shared";
import { SCOPE_LABELS } from "../api/client.ts";
import { fieldState, groupedKeys, type ScopeOverrides } from "../lib/settingsResolve.ts";

/**
 * One layered-settings editor, reused by the Settings page (global, forge, and
 * account scope) and by the repo drawer (repo scope).
 *
 * A field is either SET at this scope or INHERITED from a broader one. The
 * distinction is the whole point of the layering, so it is shown on every
 * field, and clearing an override is a first-class control rather than an
 * "unset it by typing the default" guessing game.
 */

const props = withDefaults(
  defineProps<{
    scope: SettingScope;
    /** Overrides stored at every scope, this one included. */
    chain: ScopeOverrides;
    saving?: boolean;
    disabled?: boolean;
  }>(),
  { saving: false, disabled: false },
);

const emit = defineEmits<{ save: [Partial<Record<SettingKey, unknown>>] }>();

/** null in the draft means "clear the override at this scope". */
type Draft = Partial<Record<SettingKey, unknown>>;

const draft = ref<Draft>({});

const keys = computed(() => settingKeysForScope(props.scope));
const groups = computed(() => groupedKeys(keys.value));

watch(
  () => props.chain,
  () => {
    draft.value = {};
  },
  { deep: true },
);

function state(key: SettingKey) {
  return fieldState(key, props.scope, props.chain);
}

function isDirty(key: SettingKey): boolean {
  return Object.prototype.hasOwnProperty.call(draft.value, key);
}

/** The value a control should display right now. */
function currentValue(key: SettingKey): unknown {
  if (isDirty(key)) {
    const pending = draft.value[key];
    return pending === null ? state(key).value : pending;
  }
  return state(key).effective;
}

/** True when the value shown comes from this scope rather than a broader one. */
function isSet(key: SettingKey): boolean {
  if (isDirty(key)) return draft.value[key] !== null;
  return state(key).isSet;
}

function inheritedLabel(key: SettingKey): string {
  const source = state(key).source;
  return `Inherited from ${SCOPE_LABELS[source]}`;
}

function setValue(key: SettingKey, value: unknown): void {
  draft.value = { ...draft.value, [key]: value };
}

function clearOverride(key: SettingKey): void {
  draft.value = { ...draft.value, [key]: null };
}

function keepOverride(key: SettingKey): void {
  // Re-asserting an override writes the currently displayed value.
  setValue(key, state(key).value);
}

const dirtyKeys = computed(() => Object.keys(draft.value) as SettingKey[]);
const hasChanges = computed(() => dirtyKeys.value.length > 0);

function discard(): void {
  draft.value = {};
}

function save(): void {
  emit("save", { ...draft.value });
}

function selectOptions(key: SettingKey) {
  return settingsRegistry[key].ui.options ?? [];
}

function fieldId(key: SettingKey): string {
  return `setting-${props.scope}-${key}`;
}

// The repo drawer asks before closing over a dirty editor.
defineExpose({ hasChanges, discard });
</script>

<template>
  <div class="settings-editor">
    <section v-for="group in groups" :key="group.group" class="settings-group">
      <h3>{{ group.group }}</h3>
      <div v-for="key in group.keys" :key="key" class="setting-row">
        <div class="setting-row__label">
          <label :for="fieldId(key)">{{ settingsRegistry[key].ui.label }}</label>
          <p class="amber-note">{{ settingsRegistry[key].ui.description }}</p>
          <p class="setting-row__origin" :class="{ 'is-set': isSet(key) }">
            <template v-if="isSet(key)">Set here</template>
            <template v-else>{{ inheritedLabel(key) }}</template>
          </p>
        </div>

        <div class="setting-row__control">
          <ToggleSwitch
            v-if="settingsRegistry[key].ui.control === 'toggle'"
            :input-id="fieldId(key)"
            :model-value="currentValue(key) === true"
            :disabled="disabled"
            @update:model-value="setValue(key, $event)"
          />
          <Select
            v-else-if="settingsRegistry[key].ui.control === 'select'"
            :input-id="fieldId(key)"
            :model-value="currentValue(key)"
            :options="[...selectOptions(key)]"
            option-label="label"
            option-value="value"
            :disabled="disabled"
            class="setting-control"
            @update:model-value="setValue(key, $event)"
          />
          <div v-else class="setting-number">
            <InputNumber
              :input-id="fieldId(key)"
              :model-value="Number(currentValue(key) ?? 0)"
              :min="settingsRegistry[key].ui.min"
              :max="settingsRegistry[key].ui.max"
              :disabled="disabled"
              show-buttons
              button-layout="horizontal"
              @update:model-value="setValue(key, $event)"
            />
            <span v-if="settingsRegistry[key].ui.unit" class="amber-muted">
              {{ settingsRegistry[key].ui.unit }}
            </span>
          </div>

          <Button
            v-if="isSet(key)"
            label="Clear override"
            size="small"
            severity="secondary"
            text
            :disabled="disabled"
            @click="clearOverride(key)"
          />
          <Button
            v-else
            label="Override here"
            size="small"
            severity="secondary"
            text
            :disabled="disabled"
            @click="keepOverride(key)"
          />
        </div>
      </div>
    </section>

    <div v-if="hasChanges" class="settings-editor__actions">
      <span class="amber-muted">
        {{ dirtyKeys.length }} pending {{ dirtyKeys.length === 1 ? "change" : "changes" }}
      </span>
      <Button label="Discard" severity="secondary" text :disabled="saving" @click="discard" />
      <Button label="Save changes" :loading="saving" @click="save" />
    </div>
  </div>
</template>

<style scoped>
.settings-editor {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.settings-group h3 {
  margin: 0 0 0.6rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.setting-row {
  display: flex;
  gap: 1.5rem;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0.85rem 0;
  border-top: 1px solid var(--p-content-border-color);
  flex-wrap: wrap;
}

.setting-row__label {
  flex: 1 1 22rem;
  min-width: 16rem;
}

.setting-row__label label {
  font-weight: 550;
}

.setting-row__origin {
  margin: 0.35rem 0 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.setting-row__origin.is-set {
  color: var(--p-primary-color);
}

.setting-row__control {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.setting-control {
  min-width: 15rem;
}

.setting-number {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.setting-number :deep(input) {
  width: 6rem;
}

.settings-editor__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.6rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--p-content-border-color);
}
</style>
