<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Select from "primevue/select";
import Tag from "primevue/tag";
import { FORGE_KINDS, type Account, type Forge, type ForgeKind } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { forgeOrigin } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CredentialHelp from "../components/CredentialHelp.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import ListSkeleton from "../components/ListSkeleton.vue";

const api = useApi();
const toast = useToaster();

const forges = ref<Forge[]>([]);
const accounts = ref<Account[]>([]);
const repoCounts = ref<Record<number, number>>({});
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

const accountsByForge = computed(() => {
  const map = new Map<number, Account[]>();
  for (const account of accounts.value) {
    const list = map.get(account.forgeId) ?? [];
    list.push(account);
    map.set(account.forgeId, list);
  }
  return map;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [forgeRows, accountRows] = await Promise.all([api.listForges(), api.listAccounts()]);
    forges.value = forgeRows;
    accounts.value = accountRows;
    error.value = null;
    void loadRepoCounts(forgeRows);
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

/**
 * The forge list carries no repo count, so it is read from the repos endpoint's
 * reported total with the smallest possible page.
 */
async function loadRepoCounts(forgeRows: Forge[]): Promise<void> {
  const counts: Record<number, number> = {};
  await Promise.all(
    forgeRows.map(async (forge) => {
      try {
        const page = await api.listRepos({ forgeId: forge.id, page: 1, perPage: 1 });
        counts[forge.id] = page.total;
      } catch {
        // A missing count is cosmetic; the rest of the page still works.
      }
    }),
  );
  repoCounts.value = counts;
}

function isNonStandardPort(forge: Forge): boolean {
  return forge.port !== null;
}

// ---------------------------------------------------------------------------
// Forge dialog
// ---------------------------------------------------------------------------

const forgeDialog = ref(false);
const forgeBusy = ref(false);
const forgeForm = ref<{
  protocol: "https" | "http";
  host: string;
  port: number | null;
  kind: ForgeKind | null;
}>({ protocol: "https", host: "", port: null, kind: null });

const protocolOptions = [
  { label: "https", value: "https" },
  { label: "http", value: "http" },
];
const kindOptions = [
  { label: "Detect from the host", value: null },
  ...FORGE_KINDS.map((kind) => ({ label: kind, value: kind })),
];

function openForgeDialog(): void {
  forgeForm.value = { protocol: "https", host: "", port: null, kind: null };
  forgeDialog.value = true;
}

async function saveForge(): Promise<void> {
  forgeBusy.value = true;
  try {
    await api.createForge({
      protocol: forgeForm.value.protocol,
      host: forgeForm.value.host.trim(),
      port: forgeForm.value.port,
      kind: forgeForm.value.kind ?? undefined,
    });
    toast.success("Forge added");
    forgeDialog.value = false;
    await load();
  } catch (cause) {
    toast.failure("Could not add the forge", cause);
  } finally {
    forgeBusy.value = false;
  }
}

async function changeForgeKind(forge: Forge, kind: ForgeKind): Promise<void> {
  try {
    await api.updateForge(forge.id, kind);
    toast.success("Forge kind updated");
    await load();
  } catch (cause) {
    toast.failure("Could not update the forge", cause);
  }
}

const forgeToDelete = ref<Forge | null>(null);

async function confirmDeleteForge(): Promise<void> {
  if (forgeToDelete.value === null) return;
  forgeBusy.value = true;
  try {
    await api.deleteForge(forgeToDelete.value.id);
    toast.success("Forge removed");
    forgeToDelete.value = null;
    await load();
  } catch (cause) {
    toast.failure("Could not remove the forge", cause);
  } finally {
    forgeBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Account dialog
// ---------------------------------------------------------------------------

const accountDialog = ref(false);
const accountBusy = ref(false);
const editing = ref<Account | null>(null);
const dialogForge = ref<Forge | null>(null);
const accountForm = ref({ username: "", secret: "", isDefault: false });

const isEditing = computed(() => editing.value !== null);

function openCreateAccount(forge: Forge): void {
  editing.value = null;
  dialogForge.value = forge;
  accountForm.value = {
    username: "",
    secret: "",
    isDefault: (accountsByForge.value.get(forge.id) ?? []).length === 0,
  };
  accountDialog.value = true;
}

function openEditAccount(forge: Forge, account: Account): void {
  editing.value = account;
  dialogForge.value = forge;
  accountForm.value = { username: account.username, secret: "", isDefault: account.isDefault };
  accountDialog.value = true;
}

async function saveAccount(): Promise<void> {
  if (dialogForge.value === null) return;
  accountBusy.value = true;
  try {
    if (editing.value === null) {
      await api.createAccount({
        forgeId: dialogForge.value.id,
        username: accountForm.value.username.trim(),
        secret: accountForm.value.secret === "" ? null : accountForm.value.secret,
        isDefault: accountForm.value.isDefault,
      });
      toast.success("Account added");
    } else {
      // A blank secret field means "leave the stored secret alone", which is
      // the only sane read of a write-only field.
      await api.updateAccount(editing.value.id, {
        username: accountForm.value.username.trim(),
        ...(accountForm.value.secret === "" ? {} : { secret: accountForm.value.secret }),
      });
      toast.success("Account updated");
    }
    accountDialog.value = false;
    accountForm.value.secret = "";
    await load();
  } catch (cause) {
    toast.failure("Could not save the account", cause);
  } finally {
    accountBusy.value = false;
  }
}

async function clearSecret(): Promise<void> {
  if (editing.value === null) return;
  accountBusy.value = true;
  try {
    await api.updateAccount(editing.value.id, { secret: null });
    toast.success("Stored secret cleared", "Fetches with this account are now anonymous.");
    accountDialog.value = false;
    await load();
  } catch (cause) {
    toast.failure("Could not clear the secret", cause);
  } finally {
    accountBusy.value = false;
  }
}

async function makeDefault(account: Account): Promise<void> {
  try {
    await api.setDefaultAccount(account.id);
    toast.success(`${account.username} is now the default for this forge`);
    await load();
  } catch (cause) {
    toast.failure("Could not change the default account", cause);
  }
}

const accountToDelete = ref<Account | null>(null);

const deleteExplanation = computed(() => {
  const account = accountToDelete.value;
  if (account === null) return "";
  if (!account.isDefault) {
    return `Repositories that override to ${account.username} fall back to the forge default account.`;
  }
  const siblings = (accountsByForge.value.get(account.forgeId) ?? []).filter(
    (other) => other.id !== account.id,
  );
  if (siblings.length === 0) {
    return `${account.username} is the only account on this forge. Removing it means every repository on that forge is fetched anonymously.`;
  }
  const promoted = siblings.reduce((oldest, other) =>
    other.createdAt < oldest.createdAt ? other : oldest,
  );
  return `${account.username} is the default account. Removing it promotes ${promoted.username}, the oldest remaining account, to default.`;
});

async function confirmDeleteAccount(): Promise<void> {
  if (accountToDelete.value === null) return;
  accountBusy.value = true;
  try {
    await api.deleteAccount(accountToDelete.value.id);
    toast.success("Account removed");
    accountToDelete.value = null;
    await load();
  } catch (cause) {
    toast.failure("Could not remove the account", cause);
  } finally {
    accountBusy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section>
    <PageHeader
      title="Forges &amp; Accounts"
      description="Forges amber knows about, and the credentials it uses against each one. Secrets are write-only: amber stores them encrypted and never gives them back."
    >
      <template #actions>
        <Button label="Add forge" size="small" @click="openForgeDialog" />
      </template>
    </PageHeader>

    <ErrorState :error="error" title="Could not load forges" @retry="load" />

    <ListSkeleton v-if="loading" :rows="3" label="Loading forges" />

    <EmptyState
      v-else-if="forges.length === 0 && error === null"
      icon="accounts"
      title="No forges yet"
      description="A forge is added automatically the first time you import a repository from it. You can also add one up front to store credentials before importing."
    >
      <Button label="Add a forge" @click="openForgeDialog" />
    </EmptyState>

    <div v-else class="forge-list">
      <article v-for="forge in forges" :key="forge.id" class="amber-card forge-card">
        <header class="forge-card__header">
          <div>
            <h2 class="mono">{{ forgeOrigin(forge) }}</h2>
            <p class="amber-note">
              <Tag :value="forge.kind" severity="secondary" />
              <span v-if="isNonStandardPort(forge)"> port {{ forge.port }}</span>
              <span v-if="forge.protocol === 'http'" class="forge-card__insecure">
                plain http, credentials would travel unencrypted
              </span>
              <span>
                {{ (accountsByForge.get(forge.id) ?? []).length }} accounts,
                {{ repoCounts[forge.id] ?? 0 }} repos
              </span>
            </p>
          </div>
          <div class="amber-row">
            <Select
              :model-value="forge.kind"
              :options="FORGE_KINDS.map((kind) => ({ label: kind, value: kind }))"
              option-label="label"
              option-value="value"
              :input-id="`forge-kind-${forge.id}`"
              :aria-label="`Forge kind for ${forge.host}`"
              size="small"
              @update:model-value="changeForgeKind(forge, $event)"
            />
            <Button
              label="Add account"
              size="small"
              severity="secondary"
              @click="openCreateAccount(forge)"
            />
            <Button
              label="Remove forge"
              size="small"
              severity="danger"
              text
              @click="forgeToDelete = forge"
            />
          </div>
        </header>

        <p class="amber-note forge-card__immutable">
          Host, port, and protocol cannot be changed after a forge is created. That is what stops a
          stored credential from ever being pointed at a different host.
        </p>

        <table v-if="(accountsByForge.get(forge.id) ?? []).length > 0" class="account-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Secret</th>
              <th>Default</th>
              <th class="account-table__actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in accountsByForge.get(forge.id) ?? []" :key="account.id">
              <td class="mono">{{ account.username }}</td>
              <td>
                <span v-if="account.hasSecret" class="secret-state secret-state--set">
                  <AppIcon name="shield" :size="14" />
                  stored
                </span>
                <span v-else class="secret-state">none, fetches anonymously</span>
              </td>
              <td>
                <Tag v-if="account.isDefault" value="default" severity="info" />
                <Button
                  v-else
                  label="Make default"
                  size="small"
                  severity="secondary"
                  text
                  @click="makeDefault(account)"
                />
              </td>
              <td class="account-table__actions">
                <Button
                  label="Edit"
                  size="small"
                  severity="secondary"
                  text
                  @click="openEditAccount(forge, account)"
                />
                <Button
                  label="Delete"
                  size="small"
                  severity="danger"
                  text
                  @click="accountToDelete = account"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="amber-muted">
          No accounts on this forge. Amber fetches its repositories anonymously.
        </p>
      </article>
    </div>

    <!-- Add forge -->
    <Dialog
      v-model:visible="forgeDialog"
      modal
      header="Add a forge"
      :style="{ width: 'min(32rem, 92vw)' }"
    >
      <div class="amber-stack">
        <div class="amber-field">
          <label for="forge-protocol">Protocol</label>
          <Select
            v-model="forgeForm.protocol"
            input-id="forge-protocol"
            :options="protocolOptions"
            option-label="label"
            option-value="value"
          />
        </div>
        <div class="amber-field">
          <label for="forge-host">Host</label>
          <InputText id="forge-host" v-model="forgeForm.host" placeholder="git.example.com" />
        </div>
        <div class="amber-field">
          <label for="forge-port">Port</label>
          <InputNumber
            v-model="forgeForm.port"
            input-id="forge-port"
            :min="1"
            :max="65535"
            :use-grouping="false"
            placeholder="default for the protocol"
          />
        </div>
        <div class="amber-field">
          <label for="forge-kind">Kind</label>
          <Select
            v-model="forgeForm.kind"
            input-id="forge-kind"
            :options="kindOptions"
            option-label="label"
            option-value="value"
          />
          <p class="amber-note">
            The kind decides which API amber uses for account discovery and which credential help it
            shows. It is detected from well-known hosts and editable afterwards.
          </p>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="forgeDialog = false" />
        <Button
          label="Create forge"
          :loading="forgeBusy"
          :disabled="forgeForm.host.trim() === ''"
          @click="saveForge"
        />
      </template>
    </Dialog>

    <!-- Add or edit account -->
    <Dialog
      v-model:visible="accountDialog"
      modal
      :header="isEditing ? 'Edit account' : 'Add an account'"
      :style="{ width: 'min(38rem, 94vw)' }"
    >
      <div class="amber-stack">
        <div class="amber-field">
          <label for="account-username">Username</label>
          <InputText
            id="account-username"
            v-model="accountForm.username"
            autocomplete="username"
            spellcheck="false"
          />
        </div>
        <div class="amber-field">
          <label for="account-secret">
            {{ isEditing ? "New secret" : "Secret (token or app password)" }}
          </label>
          <Password
            v-model="accountForm.secret"
            input-id="account-secret"
            toggle-mask
            :feedback="false"
            :placeholder="isEditing ? 'Leave blank to keep the stored secret' : ''"
            autocomplete="new-password"
            fluid
          />
          <p v-if="isEditing" class="amber-note">
            {{
              editing?.hasSecret
                ? "A secret is stored for this account. Leave this blank to keep it, or type a new one to replace it."
                : "No secret is stored for this account yet."
            }}
          </p>
        </div>
        <div v-if="!isEditing" class="amber-row">
          <Checkbox v-model="accountForm.isDefault" input-id="account-default" binary />
          <label for="account-default">Use as the default account for this forge</label>
        </div>

        <CredentialHelp
          v-if="dialogForge"
          :kind="dialogForge.kind"
          :origin="forgeOrigin(dialogForge)"
        />
      </div>
      <template #footer>
        <Button
          v-if="isEditing && editing?.hasSecret"
          label="Clear stored secret"
          severity="danger"
          text
          :disabled="accountBusy"
          @click="clearSecret"
        />
        <Button label="Cancel" severity="secondary" text @click="accountDialog = false" />
        <Button
          :label="isEditing ? 'Save' : 'Create account'"
          :loading="accountBusy"
          :disabled="accountForm.username.trim() === ''"
          @click="saveAccount"
        />
      </template>
    </Dialog>

    <ConfirmDialog
      :visible="accountToDelete !== null"
      title="Remove this account?"
      :message="deleteExplanation"
      confirm-label="Remove"
      danger
      :busy="accountBusy"
      @update:visible="accountToDelete = null"
      @confirm="confirmDeleteAccount"
    />

    <ConfirmDialog
      :visible="forgeToDelete !== null"
      title="Remove this forge?"
      :message="`Removing ${forgeToDelete?.host ?? 'this forge'} deletes its accounts. A forge with repositories cannot be removed until those repositories are gone.`"
      confirm-label="Remove"
      danger
      :busy="forgeBusy"
      @update:visible="forgeToDelete = null"
      @confirm="confirmDeleteForge"
    />
  </section>
</template>

<style scoped>
.forge-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.forge-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.forge-card__header h2 {
  margin: 0;
  font-size: 1rem;
}

.forge-card__header .amber-note {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.forge-card__insecure {
  color: var(--amber-warn);
}

.forge-card__immutable {
  margin: 0.75rem 0;
}

.account-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.account-table th {
  text-align: left;
  font-weight: 550;
  color: var(--p-text-muted-color);
  padding: 0.35rem 0.5rem 0.35rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.account-table td {
  padding: 0.45rem 0.5rem 0.45rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: middle;
}

.account-table__actions {
  text-align: right;
  white-space: nowrap;
}

.secret-state {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--p-text-muted-color);
}

.secret-state--set {
  color: var(--amber-success);
}
</style>
