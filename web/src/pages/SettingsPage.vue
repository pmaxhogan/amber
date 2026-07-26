<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Select from "primevue/select";
import type { Account, Forge, SettingKey, SettingScope } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import type { ScopeOverrides } from "../lib/settingsResolve.ts";
import { forgeOrigin } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import SettingsScopeEditor from "../components/SettingsScopeEditor.vue";

const api = useApi();
const toast = useToaster();

/** Repo scope is edited from the repo drawer, where the repo is in context. */
type EditableScope = Extract<SettingScope, "global" | "forge" | "account">;

const scope = ref<EditableScope>("global");
const forgeId = ref<number | null>(null);
const accountId = ref<number | null>(null);

const forges = ref<Forge[]>([]);
const accounts = ref<Account[]>([]);
const chain = ref<ScopeOverrides>({});
const loading = ref(false);
const saving = ref(false);
const error = ref<ApiClientError | null>(null);

const scopeOptions = [
  { label: "Global (applies to everything)", value: "global" },
  { label: "A forge", value: "forge" },
  { label: "An account", value: "account" },
];

const forgeOptions = computed(() =>
  forges.value.map((forge) => ({ label: forgeOrigin(forge), value: forge.id })),
);

const accountOptions = computed(() =>
  accounts.value.map((account) => {
    const forge = forges.value.find((entry) => entry.id === account.forgeId);
    return {
      label: forge === undefined ? account.username : `${account.username} at ${forge.host}`,
      value: account.id,
    };
  }),
);

const currentAccount = computed(
  () => accounts.value.find((account) => account.id === accountId.value) ?? null,
);

/** The id whose overrides are being edited, null for global. */
const scopeId = computed(() => {
  if (scope.value === "forge") return forgeId.value;
  if (scope.value === "account") return accountId.value;
  return null;
});

const ready = computed(() => scope.value === "global" || scopeId.value !== null);

const scopeDescription = computed(() => {
  if (scope.value === "global") {
    return "Global values apply everywhere unless a forge, account, or repository overrides them.";
  }
  if (scope.value === "forge") {
    return "Forge values apply to every repository on that forge, and are themselves overridden by account and repository values.";
  }
  return "Account values apply to repositories that authenticate with this account, whether by override or because it is the forge default.";
});

async function load(): Promise<void> {
  if (!ready.value) return;
  loading.value = true;
  try {
    const global = await api.getSettings({ scopeType: "global", scopeId: null });
    const next: ScopeOverrides = { global };

    if (scope.value === "forge" && forgeId.value !== null) {
      next.forge = await api.getSettings({ scopeType: "forge", scopeId: forgeId.value });
    }
    if (scope.value === "account" && accountId.value !== null) {
      const account = currentAccount.value;
      const [forgeScope, accountScope] = await Promise.all([
        account === undefined || account === null
          ? Promise.resolve({})
          : api.getSettings({ scopeType: "forge", scopeId: account.forgeId }),
        api.getSettings({ scopeType: "account", scopeId: accountId.value }),
      ]);
      next.forge = forgeScope;
      next.account = accountScope;
    }
    chain.value = next;
    error.value = null;
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

async function save(patch: Partial<Record<SettingKey, unknown>>): Promise<void> {
  saving.value = true;
  try {
    await api.putSettings({ scopeType: scope.value, scopeId: scopeId.value }, patch);
    toast.success("Settings saved");
    await load();
  } catch (cause) {
    toast.failure("Could not save the settings", cause);
  } finally {
    saving.value = false;
  }
}

async function loadReferenceData(): Promise<void> {
  try {
    const [forgeRows, accountRows] = await Promise.all([api.listForges(), api.listAccounts()]);
    forges.value = forgeRows;
    accounts.value = accountRows;
  } catch (cause) {
    error.value = normalizeError(cause);
  }
}

watch([scope, forgeId, accountId], () => {
  chain.value = {};
  void load();
});

onMounted(async () => {
  await loadReferenceData();
  await load();
});
</script>

<template>
  <section>
    <PageHeader
      title="Settings"
      description="Layered settings. The narrowest scope that sets a value wins: repository, then account, then forge, then global, then the built-in default."
    />

    <div class="scope-bar amber-card">
      <div class="amber-field">
        <label for="settings-scope">Scope</label>
        <Select
          v-model="scope"
          input-id="settings-scope"
          :options="scopeOptions"
          option-label="label"
          option-value="value"
        />
      </div>

      <div v-if="scope === 'forge'" class="amber-field">
        <label for="settings-forge">Forge</label>
        <Select
          v-model="forgeId"
          input-id="settings-forge"
          :options="forgeOptions"
          option-label="label"
          option-value="value"
          placeholder="Pick a forge"
        />
      </div>

      <div v-if="scope === 'account'" class="amber-field">
        <label for="settings-account">Account</label>
        <Select
          v-model="accountId"
          input-id="settings-account"
          :options="accountOptions"
          option-label="label"
          option-value="value"
          placeholder="Pick an account"
        />
      </div>

      <p class="amber-note scope-bar__note">{{ scopeDescription }}</p>
    </div>

    <ErrorState :error="error" title="Could not load settings" @retry="load" />

    <p v-if="!ready" class="amber-muted scope-empty">
      Pick {{ scope === "forge" ? "a forge" : "an account" }} to edit its settings.
    </p>
    <ListSkeleton v-else-if="loading" :rows="5" label="Loading settings" />
    <SettingsScopeEditor
      v-else-if="error === null"
      :scope="scope"
      :chain="chain"
      :saving="saving"
      @save="save"
    />
  </section>
</template>

<style scoped>
.scope-bar {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

.scope-bar .amber-field {
  min-width: 16rem;
}

.scope-bar__note {
  flex: 1 1 20rem;
  margin: 0 0 0.4rem;
}

.scope-empty {
  padding: 2rem 0;
}
</style>
