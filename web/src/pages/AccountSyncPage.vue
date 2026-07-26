<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";
import type { Account, AccountSyncSource, AccountSyncVisibility, Forge } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { STARRED_SUPPORTED_FORGE_KINDS, type AccountSyncRow } from "../api/types.ts";
import { absoluteTime, relativeTime } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import ListSkeleton from "../components/ListSkeleton.vue";

const api = useApi();
const toast = useToaster();

const syncs = ref<AccountSyncRow[]>([]);
const accounts = ref<Account[]>([]);
const forges = ref<Forge[]>([]);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

const accountById = computed(() => new Map(accounts.value.map((a) => [a.id, a])));
const forgeById = computed(() => new Map(forges.value.map((f) => [f.id, f])));

function forgeForAccount(accountId: number): Forge | undefined {
  const account = accountById.value.get(accountId);
  return account === undefined ? undefined : forgeById.value.get(account.forgeId);
}

function accountLabel(accountId: number): string {
  const account = accountById.value.get(accountId);
  const forge = forgeForAccount(accountId);
  if (account === undefined) return `account ${accountId}`;
  return forge === undefined ? account.username : `${account.username} at ${forge.host}`;
}

/** Starred discovery needs the GitHub API, so it is offered only there. */
function supportsStarred(accountId: number): boolean {
  const forge = forgeForAccount(accountId);
  return (
    forge !== undefined && (STARRED_SUPPORTED_FORGE_KINDS as readonly string[]).includes(forge.kind)
  );
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [syncRows, accountRows, forgeRows] = await Promise.all([
      api.listAccountSyncs(),
      api.listAccounts(),
      api.listForges(),
    ]);
    syncs.value = syncRows;
    accounts.value = accountRows;
    forges.value = forgeRows;
    error.value = null;
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------

const dialog = ref(false);
const busy = ref(false);
const editing = ref<AccountSyncRow | null>(null);
const form = ref<{
  accountId: number | null;
  source: AccountSyncSource;
  visibility: AccountSyncVisibility;
  intervalMinutes: number;
  enabled: boolean;
}>({ accountId: null, source: "owned", visibility: "all", intervalMinutes: 360, enabled: true });

const accountOptions = computed(() =>
  accounts.value.map((account) => ({ label: accountLabel(account.id), value: account.id })),
);

const sourceOptions = computed(() => {
  const starredAllowed = form.value.accountId !== null && supportsStarred(form.value.accountId);
  return [
    { label: "Repositories the account owns", value: "owned", disabled: false },
    {
      label: starredAllowed
        ? "Repositories the account has starred"
        : "Starred (GitHub accounts only)",
      value: "starred",
      disabled: !starredAllowed,
    },
  ];
});

const visibilityOptions = [
  { label: "All repositories", value: "all" },
  { label: "Public only", value: "public" },
  { label: "Private only", value: "private" },
];

function openCreate(): void {
  editing.value = null;
  form.value = {
    accountId: accounts.value[0]?.id ?? null,
    source: "owned",
    visibility: "all",
    intervalMinutes: 360,
    enabled: true,
  };
  dialog.value = true;
}

function openEdit(sync: AccountSyncRow): void {
  editing.value = sync;
  form.value = {
    accountId: sync.accountId,
    source: sync.source,
    visibility: sync.visibility,
    intervalMinutes: sync.intervalMinutes,
    enabled: sync.enabled,
  };
  dialog.value = true;
}

async function save(): Promise<void> {
  if (form.value.accountId === null) return;
  busy.value = true;
  try {
    const body = {
      accountId: form.value.accountId,
      source: form.value.source,
      visibility: form.value.visibility,
      intervalMinutes: form.value.intervalMinutes,
      enabled: form.value.enabled,
    };
    if (editing.value === null) {
      await api.createAccountSync(body);
      toast.success("Account sync created", "The first discovery run starts shortly.");
    } else {
      await api.updateAccountSync(editing.value.id, body);
      toast.success("Account sync updated");
    }
    dialog.value = false;
    await load();
  } catch (cause) {
    toast.failure("Could not save the account sync", cause);
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled(sync: AccountSyncRow, enabled: boolean): Promise<void> {
  try {
    await api.updateAccountSync(sync.id, { enabled });
    toast.success(enabled ? "Account sync enabled" : "Account sync paused");
    await load();
  } catch (cause) {
    toast.failure("Could not change the account sync", cause);
  }
}

async function runNow(sync: AccountSyncRow): Promise<void> {
  try {
    await api.runAccountSync(sync.id);
    toast.success("Discovery run queued");
  } catch (cause) {
    toast.failure("Could not start the discovery run", cause);
  }
}

const toDelete = ref<AccountSyncRow | null>(null);

async function confirmDelete(): Promise<void> {
  if (toDelete.value === null) return;
  busy.value = true;
  try {
    await api.deleteAccountSync(toDelete.value.id);
    toast.success("Account sync removed", "Repositories it discovered stay and keep syncing.");
    toDelete.value = null;
    await load();
  } catch (cause) {
    toast.failure("Could not remove the account sync", cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section>
    <PageHeader
      title="Account Sync"
      description="Discover repositories automatically from a linked account, instead of pasting URLs by hand."
    >
      <template #actions>
        <Button
          label="Add account sync"
          size="small"
          :disabled="accounts.length === 0"
          @click="openCreate"
        />
      </template>
    </PageHeader>

    <ErrorState :error="error" title="Could not load account syncs" @retry="load" />

    <ListSkeleton v-if="loading" :rows="3" label="Loading account syncs" />

    <EmptyState
      v-else-if="accounts.length === 0 && error === null"
      icon="accounts"
      title="No accounts to sync from"
      description="Account discovery needs a credential that can list repositories. Add an account on the Forges &amp; Accounts page first."
    />

    <EmptyState
      v-else-if="syncs.length === 0 && error === null"
      icon="sync"
      title="No account syncs yet"
      description="An account sync enumerates the repositories an account owns or has starred, and imports whatever it finds on a schedule."
    >
      <Button label="Add an account sync" @click="openCreate" />
    </EmptyState>

    <div v-else class="sync-list">
      <article v-for="sync in syncs" :key="sync.id" class="amber-card sync-card">
        <header class="sync-card__header">
          <div>
            <h2>{{ accountLabel(sync.accountId) }}</h2>
            <p class="amber-note">
              <Tag
                :value="sync.source === 'starred' ? 'starred' : 'owned'"
                :severity="sync.source === 'starred' ? 'warn' : 'secondary'"
              />
              <span v-if="sync.source === 'owned'">visibility: {{ sync.visibility }}</span>
              <span>every {{ sync.intervalMinutes }} minutes</span>
            </p>
          </div>
          <div class="amber-row">
            <ToggleSwitch
              :model-value="sync.enabled"
              :input-id="`sync-enabled-${sync.id}`"
              @update:model-value="toggleEnabled(sync, $event)"
            />
            <label :for="`sync-enabled-${sync.id}`" class="amber-muted">
              {{ sync.enabled ? "enabled" : "paused" }}
            </label>
            <Button label="Run now" size="small" severity="secondary" @click="runNow(sync)" />
            <Button label="Edit" size="small" severity="secondary" text @click="openEdit(sync)" />
            <Button label="Delete" size="small" severity="danger" text @click="toDelete = sync" />
          </div>
        </header>

        <dl class="sync-card__stats">
          <div>
            <dt>Last run</dt>
            <dd :title="absoluteTime(sync.lastRunAt)">{{ relativeTime(sync.lastRunAt) }}</dd>
          </div>
          <div>
            <dt>Next run</dt>
            <dd :title="absoluteTime(sync.nextRunAt)">{{ relativeTime(sync.nextRunAt) }}</dd>
          </div>
          <div>
            <dt>Repositories discovered</dt>
            <dd>{{ sync.reposDiscovered ?? "-" }}</dd>
          </div>
        </dl>

        <p v-if="sync.lastError" class="sync-card__error">
          <AppIcon name="alert" :size="15" />
          {{ sync.lastError }}
        </p>

        <p v-if="sync.source === 'starred'" class="amber-note">
          A starred sync always mirrors your current starred list. Unstarred repositories are
          removed only when amber can still reach them upstream. A repository that has been deleted,
          made private, or is simply unreachable is kept and keeps syncing, because that is exactly
          what a backup is for.
        </p>
      </article>
    </div>

    <Dialog
      v-model:visible="dialog"
      modal
      :header="editing === null ? 'Add an account sync' : 'Edit account sync'"
      :style="{ width: 'min(36rem, 94vw)' }"
    >
      <div class="amber-stack">
        <div class="amber-field">
          <label for="sync-account">Account</label>
          <Select
            v-model="form.accountId"
            input-id="sync-account"
            :options="accountOptions"
            option-label="label"
            option-value="value"
            :disabled="editing !== null"
          />
        </div>

        <div class="amber-field">
          <label for="sync-source">What to discover</label>
          <Select
            v-model="form.source"
            input-id="sync-source"
            :options="sourceOptions"
            option-label="label"
            option-value="value"
            option-disabled="disabled"
          />
          <p v-if="form.source === 'starred'" class="amber-note">
            Always mirrors your current starred list. Unstarred repositories are removed only when
            still accessible upstream; deleted or unreachable repositories are kept.
          </p>
        </div>

        <div v-if="form.source === 'owned'" class="amber-field">
          <label for="sync-visibility">Visibility</label>
          <Select
            v-model="form.visibility"
            input-id="sync-visibility"
            :options="visibilityOptions"
            option-label="label"
            option-value="value"
          />
        </div>

        <div class="amber-field">
          <label for="sync-interval">Discovery interval</label>
          <InputNumber
            v-model="form.intervalMinutes"
            input-id="sync-interval"
            :min="1"
            :use-grouping="false"
            suffix=" minutes"
          />
          <p class="amber-note">
            How often amber re-enumerates the account. This is separate from how often each
            repository is fetched.
          </p>
        </div>

        <div class="amber-row">
          <ToggleSwitch v-model="form.enabled" input-id="sync-form-enabled" />
          <label for="sync-form-enabled">Run on a schedule</label>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="dialog = false" />
        <Button
          :label="editing === null ? 'Create' : 'Save'"
          :loading="busy"
          :disabled="form.accountId === null"
          @click="save"
        />
      </template>
    </Dialog>

    <ConfirmDialog
      :visible="toDelete !== null"
      title="Remove this account sync?"
      message="Repositories it already discovered stay in amber and keep syncing. Only the automatic discovery stops."
      confirm-label="Remove"
      danger
      :busy="busy"
      @update:visible="toDelete = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.sync-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sync-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.sync-card__header h2 {
  margin: 0;
  font-size: 1rem;
}

.sync-card__header .amber-note {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.sync-card__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.6rem 1.25rem;
  margin: 1rem 0 0;
}

.sync-card__stats dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.sync-card__stats dd {
  margin: 0.1rem 0 0;
}

.sync-card__error {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0.9rem 0 0;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  background: var(--amber-error-bg);
  color: var(--amber-error);
  font-size: 0.85rem;
  word-break: break-word;
}
</style>
