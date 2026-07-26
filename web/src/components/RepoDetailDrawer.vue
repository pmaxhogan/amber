<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Drawer from "primevue/drawer";
import ProgressBar from "primevue/progressbar";
import Select from "primevue/select";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import ToggleSwitch from "primevue/toggleswitch";
import type { Account, Forge, GitRemoteConfig, SettingKey, SyncRun } from "@amber/shared";
import { settingsRegistry } from "@amber/shared";
import { SCOPE_LABELS, normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  EXPORT_FORMATS,
  deriveOutcome,
  type EffectiveSettings,
  type ExportFormatValue,
  type ExportKind,
  type RepoRow,
  type TreeEntry,
} from "../api/types.ts";
import type { ScopeOverrides } from "../lib/settingsResolve.ts";
import {
  absoluteTime,
  forgeOrigin,
  formatDuration,
  humanBytes,
  relativeTime,
  safeFileName,
} from "../lib/format.ts";
import {
  downloadToDirectory,
  fetchManifest,
  pickDirectory,
  saveBlob,
  supportsDirectoryPicker,
} from "../lib/folderDownload.ts";
import { useToaster } from "../lib/toast.ts";
import AppIcon from "./AppIcon.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import CopyField from "./CopyField.vue";
import ErrorState from "./ErrorState.vue";
import OutcomeBadge from "./OutcomeBadge.vue";
import SettingsScopeEditor from "./SettingsScopeEditor.vue";

const props = defineProps<{
  repo: RepoRow | null;
  visible: boolean;
  forges: Forge[];
  accounts: Account[];
}>();

const emit = defineEmits<{
  "update:visible": [boolean];
  changed: [RepoRow];
  deleted: [number];
}>();

const api = useApi();
const toast = useToaster();

const activeTab = ref("overview");

// -- Overview ---------------------------------------------------------------

const forge = computed(
  () => props.forges.find((entry) => entry.id === props.repo?.forgeId) ?? null,
);
const origin = computed(() => (forge.value === null ? "" : forgeOrigin(forge.value)));
const forgeAccounts = computed(() =>
  props.accounts.filter((account) => account.forgeId === props.repo?.forgeId),
);
const defaultAccount = computed(
  () => forgeAccounts.value.find((account) => account.isDefault) ?? null,
);

/** The account amber will actually authenticate with for this repo. */
const effectiveAccount = computed(() => {
  if (props.repo === null || props.repo.forceAnonymous) return null;
  if (props.repo.accountOverrideId !== null) {
    return forgeAccounts.value.find((a) => a.id === props.repo?.accountOverrideId) ?? null;
  }
  return defaultAccount.value;
});

const accountOptions = computed(() => [
  { label: "Use the forge default account", value: null },
  ...forgeAccounts.value.map((account) => ({
    label: account.isDefault ? `${account.username} (default)` : account.username,
    value: account.id,
  })),
]);

const effective = ref<EffectiveSettings>({});
const effectiveError = ref<ApiClientError | null>(null);
const effectiveLoading = ref(false);

async function loadEffective(): Promise<void> {
  if (props.repo === null) return;
  effectiveLoading.value = true;
  effectiveError.value = null;
  try {
    effective.value = await api.getEffectiveSettings(props.repo.id);
  } catch (cause) {
    effectiveError.value = normalizeError(cause);
  } finally {
    effectiveLoading.value = false;
  }
}

const effectiveRows = computed(() =>
  (Object.keys(settingsRegistry) as SettingKey[])
    .map((key) => ({ key, entry: effective.value[key] }))
    .filter((row) => row.entry !== undefined),
);

function explain(source: string): string {
  const label = SCOPE_LABELS[source as keyof typeof SCOPE_LABELS] ?? source;
  return `from ${label}`;
}

function renderValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === null || value === undefined) return "-";
  return String(value);
}

// -- Row mutations ----------------------------------------------------------

const busy = ref(false);

async function patchRepo(input: Parameters<typeof api.updateRepo>[1]): Promise<void> {
  if (props.repo === null) return;
  busy.value = true;
  try {
    const updated = await api.updateRepo(props.repo.id, input);
    emit("changed", updated);
    toast.success("Repository updated");
  } catch (cause) {
    toast.failure("Could not update the repository", cause);
  } finally {
    busy.value = false;
  }
}

async function syncNow(): Promise<void> {
  if (props.repo === null) return;
  busy.value = true;
  try {
    await api.syncRepo(props.repo.id);
    toast.success("Sync queued", "It will start as soon as a worker is free.");
  } catch (cause) {
    toast.failure("Could not queue the sync", cause);
  } finally {
    busy.value = false;
  }
}

const deleteVisible = ref(false);
const deleteFiles = ref(false);

async function confirmDelete(): Promise<void> {
  if (props.repo === null) return;
  busy.value = true;
  const id = props.repo.id;
  try {
    await api.deleteRepo(id, deleteFiles.value);
    toast.success("Repository removed");
    deleteVisible.value = false;
    emit("deleted", id);
    emit("update:visible", false);
  } catch (cause) {
    toast.failure("Could not remove the repository", cause);
  } finally {
    busy.value = false;
  }
}

// -- History ----------------------------------------------------------------

const runs = ref<SyncRun[]>([]);
const runsTotal = ref(0);
const runsPage = ref(1);
const runsPerPage = ref(10);
const runsLoading = ref(false);
const runsError = ref<ApiClientError | null>(null);
const expandedRuns = ref<Record<number, boolean>>({});

async function loadRuns(): Promise<void> {
  if (props.repo === null) return;
  runsLoading.value = true;
  runsError.value = null;
  try {
    const page = await api.listRuns(props.repo.id, runsPage.value, runsPerPage.value);
    runs.value = page.rows;
    runsTotal.value = page.total;
  } catch (cause) {
    runsError.value = normalizeError(cause);
  } finally {
    runsLoading.value = false;
  }
}

function onRunsPage(event: { page: number; rows: number }): void {
  runsPage.value = event.page + 1;
  runsPerPage.value = event.rows;
  void loadRuns();
}

// -- Settings ---------------------------------------------------------------

const chain = ref<ScopeOverrides>({});
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsError = ref<ApiClientError | null>(null);

async function loadSettings(): Promise<void> {
  if (props.repo === null) return;
  settingsLoading.value = true;
  settingsError.value = null;
  try {
    const accountId = effectiveAccount.value?.id ?? null;
    const [global, forgeScope, repoScope, accountScope] = await Promise.all([
      api.getSettings({ scopeType: "global", scopeId: null }),
      api.getSettings({ scopeType: "forge", scopeId: props.repo.forgeId }),
      api.getSettings({ scopeType: "repo", scopeId: props.repo.id }),
      accountId === null
        ? Promise.resolve({})
        : api.getSettings({ scopeType: "account", scopeId: accountId }),
    ]);
    chain.value = {
      global,
      forge: forgeScope,
      account: accountScope,
      repo: repoScope,
    };
  } catch (cause) {
    settingsError.value = normalizeError(cause);
  } finally {
    settingsLoading.value = false;
  }
}

const settingsEditor = ref<InstanceType<typeof SettingsScopeEditor> | null>(null);
const discardConfirmVisible = ref(false);

/**
 * Closing the drawer (click-off, escape, the X) silently threw away a dirty
 * settings draft; route every close request through here so it asks first.
 */
function requestClose(visible: boolean): void {
  if (!visible && settingsEditor.value?.hasChanges === true) {
    discardConfirmVisible.value = true;
    return;
  }
  emit("update:visible", visible);
}

function confirmDiscard(): void {
  settingsEditor.value?.discard();
  discardConfirmVisible.value = false;
  emit("update:visible", false);
}

async function saveSettings(patch: Partial<Record<SettingKey, unknown>>): Promise<void> {
  if (props.repo === null) return;
  settingsSaving.value = true;
  try {
    await api.putSettings({ scopeType: "repo", scopeId: props.repo.id }, patch);
    toast.success("Settings saved");
    await Promise.all([loadSettings(), loadEffective()]);
  } catch (cause) {
    toast.failure("Could not save the settings", cause);
  } finally {
    settingsSaving.value = false;
  }
}

// -- Export -----------------------------------------------------------------

const exportKind = ref<ExportKind>("gitdir");
const exportFormat = ref<ExportFormatValue>("zip");
const exporting = ref(false);

const kindOptions = [
  { label: "Source tree (files at the default branch)", value: "source" as ExportKind },
  { label: "Full backup (git directory, including archived refs)", value: "gitdir" as ExportKind },
];

const formatOptions = EXPORT_FORMATS.map((format) => ({ label: format, value: format }));

async function runExport(): Promise<void> {
  if (props.repo === null) return;
  exporting.value = true;
  try {
    const blob = await api.downloadExport(props.repo.id, exportKind.value, exportFormat.value);
    saveBlob(
      blob,
      `${safeFileName(props.repo.displayName)}-${exportKind.value}.${exportFormat.value}`,
    );
    toast.success("Export downloaded");
  } catch (cause) {
    toast.failure("Could not export the repository", cause);
  } finally {
    exporting.value = false;
  }
}

const folderSupported = supportsDirectoryPicker();
const folderBusy = ref(false);
const folderDone = ref(0);
const folderTotal = ref(0);
const folderPath = ref("");

const folderPercent = computed(() =>
  folderTotal.value === 0 ? 0 : Math.round((folderDone.value / folderTotal.value) * 100),
);

async function downloadToFolder(): Promise<void> {
  if (props.repo === null) return;
  const directory = await pickDirectory();
  if (directory === null) return;
  folderBusy.value = true;
  folderDone.value = 0;
  folderTotal.value = 0;
  folderPath.value = "";
  try {
    const entries: TreeEntry[] = await fetchManifest(api, props.repo.id);
    folderTotal.value = entries.length;
    const result = await downloadToDirectory({
      api,
      repoId: props.repo.id,
      directory,
      entries,
      onProgress: (progress) => {
        folderDone.value = progress.done;
        folderTotal.value = progress.total;
        folderPath.value = progress.path;
      },
    });
    if (result.failed.length > 0) {
      toast.warn(
        `Wrote ${result.written} files, ${result.failed.length} failed`,
        result.failed[0]?.message,
      );
    } else {
      toast.success(`Wrote ${result.written} files to the chosen folder`);
    }
  } catch (cause) {
    toast.failure("Could not write the folder", cause);
  } finally {
    folderBusy.value = false;
  }
}

// -- Clone ------------------------------------------------------------------

const gitRemote = ref<GitRemoteConfig | null>(null);
const gitRemoteError = ref<ApiClientError | null>(null);

async function loadGitRemote(): Promise<void> {
  try {
    gitRemote.value = await api.getGitRemote();
    gitRemoteError.value = null;
  } catch (cause) {
    gitRemoteError.value = normalizeError(cause);
  }
}

/**
 * The template carries a {slug} placeholder. Older templates may not, in which
 * case the slug is appended so the command is still copy-pasteable.
 */
const cloneUrl = computed(() => {
  const template = gitRemote.value?.cloneUrlTemplate ?? "";
  const slug = props.repo?.slug ?? "";
  if (template === "") return "";
  if (template.includes("{slug}")) return template.replace("{slug}", slug);
  return `${template.replace(/\/$/, "")}/${slug}.git`;
});

const cloneCommand = computed(() => (cloneUrl.value === "" ? "" : `git clone ${cloneUrl.value}`));

// -- Tab loading ------------------------------------------------------------

watch(
  () => [props.visible, props.repo?.id] as const,
  ([visible]) => {
    if (!visible || props.repo === null) return;
    activeTab.value = "overview";
    runsPage.value = 1;
    void loadEffective();
  },
  { immediate: true },
);

watch(activeTab, (tab) => {
  if (props.repo === null) return;
  if (tab === "history") void loadRuns();
  if (tab === "settings") void loadSettings();
  if (tab === "clone") void loadGitRemote();
});
</script>

<template>
  <Drawer
    :visible="visible"
    position="right"
    class="repo-drawer"
    :style="{ width: 'min(48rem, 100vw)' }"
    :header="repo?.displayName ?? 'Repository'"
    @update:visible="requestClose($event)"
  >
    <div v-if="repo" class="repo-drawer__body">
      <p class="repo-drawer__path mono">{{ origin }}/{{ repo.path }}</p>

      <div class="amber-row repo-drawer__actions">
        <Button label="Sync now" size="small" :loading="busy" :disabled="busy" @click="syncNow" />
        <Button
          :label="repo.state === 'paused' ? 'Resume' : 'Pause'"
          size="small"
          severity="secondary"
          :disabled="busy"
          @click="patchRepo({ state: repo.state === 'paused' ? 'active' : 'paused' })"
        />
        <Button
          label="Delete"
          size="small"
          severity="danger"
          outlined
          :disabled="busy"
          @click="deleteVisible = true"
        />
      </div>

      <Tabs v-model:value="activeTab">
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="history">History</Tab>
          <Tab value="settings">Settings</Tab>
          <Tab value="export">Export</Tab>
          <Tab value="clone">Clone</Tab>
        </TabList>

        <TabPanels>
          <!-- Overview -->
          <TabPanel value="overview">
            <dl class="detail-grid">
              <div>
                <dt>Display name</dt>
                <dd>{{ repo.displayName }}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd class="mono">{{ repo.path }}</dd>
              </div>
              <div>
                <dt>Forge</dt>
                <dd>{{ origin }} ({{ forge?.kind ?? "unknown" }})</dd>
              </div>
              <div>
                <dt>Disk slug</dt>
                <dd class="mono">{{ repo.slug }}</dd>
              </div>
              <div>
                <dt>Short id</dt>
                <dd class="mono">{{ repo.shortId }}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{{ repo.state }}</dd>
              </div>
              <div>
                <dt>Last sync</dt>
                <dd>
                  <OutcomeBadge :outcome="deriveOutcome(repo)" />
                  <span class="amber-muted"> {{ relativeTime(repo.lastSyncAt) }}</span>
                </dd>
              </div>
              <div>
                <dt>Last success</dt>
                <dd>{{ absoluteTime(repo.lastSuccessAt) }}</dd>
              </div>
              <div>
                <dt>Next sync</dt>
                <dd>{{ absoluteTime(repo.nextSyncAt) }}</dd>
              </div>
              <div>
                <dt>Consecutive failures</dt>
                <dd>{{ repo.consecutiveFailures }}</dd>
              </div>
              <div>
                <dt>Size on disk</dt>
                <dd>{{ humanBytes(repo.diskUsageBytes) }}</dd>
              </div>
              <div>
                <dt>Default branch</dt>
                <dd>{{ repo.defaultBranch ?? "-" }}</dd>
              </div>
              <div>
                <dt>Last fetch head</dt>
                <dd class="mono">{{ repo.lastFetchHead ?? "-" }}</dd>
              </div>
              <div>
                <dt>Managed by account sync</dt>
                <dd>{{ repo.managedByAccountSyncId ?? "no, imported manually" }}</dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{{ absoluteTime(repo.createdAt) }}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ absoluteTime(repo.updatedAt) }}</dd>
              </div>
            </dl>

            <p v-if="repo.lastError" class="repo-drawer__error">
              <AppIcon name="alert" :size="15" />
              {{ repo.lastError }}
            </p>

            <section class="repo-drawer__section">
              <h3>Credentials</h3>
              <div class="amber-field">
                <label for="repo-account-override">Account override</label>
                <Select
                  input-id="repo-account-override"
                  :model-value="repo.accountOverrideId"
                  :options="accountOptions"
                  option-label="label"
                  option-value="value"
                  :disabled="busy || repo.forceAnonymous"
                  @update:model-value="patchRepo({ accountOverrideId: $event })"
                />
                <p class="amber-note">
                  Amber authenticates as
                  <strong>{{
                    repo.forceAnonymous
                      ? "nobody (anonymous)"
                      : (effectiveAccount?.username ?? "nobody (no account on this forge)")
                  }}</strong
                  >.
                </p>
              </div>
              <div class="amber-row repo-drawer__toggle">
                <ToggleSwitch
                  input-id="repo-force-anonymous"
                  :model-value="repo.forceAnonymous"
                  :disabled="busy"
                  @update:model-value="patchRepo({ forceAnonymous: $event })"
                />
                <label for="repo-force-anonymous">Always fetch anonymously</label>
              </div>
            </section>

            <section class="repo-drawer__section">
              <h3>Effective settings</h3>
              <ErrorState :error="effectiveError" @retry="loadEffective" />
              <p v-if="effectiveLoading" class="amber-muted">Resolving settings...</p>
              <table v-else-if="effectiveRows.length > 0" class="explain-table">
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Value</th>
                    <th>Where it came from</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in effectiveRows" :key="row.key">
                    <td>{{ settingsRegistry[row.key].ui.label }}</td>
                    <td class="mono">{{ renderValue(row.entry?.value) }}</td>
                    <td class="amber-muted">{{ explain(row.entry?.source ?? "default") }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else-if="effectiveError === null" class="amber-muted">
                No resolved settings reported for this repository.
              </p>
            </section>
          </TabPanel>

          <!-- History -->
          <TabPanel value="history">
            <ErrorState :error="runsError" @retry="loadRuns" />
            <DataTable
              v-if="runsError === null"
              v-model:expanded-rows="expandedRuns"
              :value="runs"
              data-key="id"
              lazy
              paginator
              :rows="runsPerPage"
              :total-records="runsTotal"
              :loading="runsLoading"
              size="small"
              @page="onRunsPage"
            >
              <template #empty>
                <p class="amber-muted">No syncs have run for this repository yet.</p>
              </template>
              <Column expander style="width: 3rem" />
              <Column header="Outcome">
                <template #body="{ data }">
                  <OutcomeBadge :outcome="data.outcome" />
                </template>
              </Column>
              <Column header="Started">
                <template #body="{ data }">
                  <span :title="absoluteTime(data.startedAt)">
                    {{ relativeTime(data.startedAt) }}
                  </span>
                </template>
              </Column>
              <Column header="Duration">
                <template #body="{ data }">{{ formatDuration(data.durationMs) }}</template>
              </Column>
              <Column header="Fetched">
                <template #body="{ data }">{{ humanBytes(data.bytesFetched) }}</template>
              </Column>
              <Column header="Refs">
                <template #body="{ data }">{{ data.refsChanged ?? "-" }}</template>
              </Column>
              <template #expansion="{ data }">
                <div class="run-detail">
                  <p>
                    <strong>Archived refs:</strong> {{ data.paranoidArchived ?? 0 }} |
                    <strong>Finished:</strong> {{ absoluteTime(data.finishedAt) }}
                  </p>
                  <p v-if="data.error" class="run-detail__error mono">
                    [{{ data.errorKind ?? "other" }}] {{ data.error }}
                  </p>
                  <p v-else class="amber-muted">No error recorded.</p>
                </div>
              </template>
            </DataTable>
          </TabPanel>

          <!-- Settings -->
          <TabPanel value="settings">
            <ErrorState :error="settingsError" @retry="loadSettings" />
            <p v-if="settingsLoading" class="amber-muted">Loading settings...</p>
            <SettingsScopeEditor
              v-else-if="settingsError === null"
              ref="settingsEditor"
              scope="repo"
              :chain="chain"
              :saving="settingsSaving"
              @save="saveSettings"
            />
          </TabPanel>

          <!-- Export -->
          <TabPanel value="export">
            <div class="amber-stack">
              <div class="amber-field">
                <label for="export-kind">What to export</label>
                <Select
                  v-model="exportKind"
                  input-id="export-kind"
                  :options="kindOptions"
                  option-label="label"
                  option-value="value"
                />
              </div>
              <div class="amber-field">
                <label for="export-format">Archive format</label>
                <Select
                  v-model="exportFormat"
                  input-id="export-format"
                  :options="formatOptions"
                  option-label="label"
                  option-value="value"
                />
              </div>
              <div>
                <Button label="Download archive" :loading="exporting" @click="runExport" />
              </div>

              <div v-if="folderSupported" class="repo-drawer__section">
                <h3>Download to a folder</h3>
                <p class="amber-note">
                  Writes the working files straight into a folder you pick, without an archive step.
                  Your browser will ask for permission to that folder.
                </p>
                <Button
                  label="Choose folder and download"
                  severity="secondary"
                  :loading="folderBusy"
                  @click="downloadToFolder"
                />
                <div v-if="folderBusy || folderDone > 0" class="folder-progress">
                  <ProgressBar :value="folderPercent" />
                  <p class="amber-note">
                    {{ folderDone }} of {{ folderTotal }} files
                    <span v-if="folderPath" class="mono"> - {{ folderPath }}</span>
                  </p>
                </div>
              </div>
            </div>
          </TabPanel>

          <!-- Clone -->
          <TabPanel value="clone">
            <ErrorState :error="gitRemoteError" @retry="loadGitRemote" />
            <div v-if="gitRemoteError === null" class="amber-stack">
              <template v-if="gitRemote?.enabled">
                <p class="amber-muted">
                  Amber serves this backup as a read-only git remote. Clone it with the command
                  below; git will ask for the password shown when the remote was enabled.
                </p>
                <CopyField label="Clone command" :value="cloneCommand" monospace />
                <CopyField label="Remote URL" :value="cloneUrl" monospace />
              </template>
              <template v-else>
                <p class="amber-muted">
                  The read-only git remote is turned off, so this backup cannot be cloned over HTTP
                  yet. Turn it on from the Git Remote page.
                </p>
              </template>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>

    <ConfirmDialog
      v-model:visible="deleteVisible"
      title="Remove this repository?"
      :message="`Amber will stop backing up ${repo?.displayName ?? 'this repository'}.`"
      confirm-label="Remove"
      danger
      :busy="busy"
      @confirm="confirmDelete"
    >
      <div class="amber-row">
        <Checkbox v-model="deleteFiles" input-id="delete-files" binary />
        <label for="delete-files">Also delete the backup files on disk</label>
      </div>
      <p class="amber-note">
        Without this, the backup directory stays on disk and re-importing the same URL picks it up
        again.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      v-model:visible="discardConfirmVisible"
      title="Discard unsaved settings?"
      message="This repository has settings changes that have not been saved. Closing the panel discards them."
      confirm-label="Discard changes"
      danger
      @confirm="confirmDiscard"
    />
  </Drawer>
</template>

<style scoped>
.repo-drawer__body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.repo-drawer__path {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  word-break: break-all;
}

.repo-drawer__actions {
  padding-bottom: 0.25rem;
}

.repo-drawer__section {
  margin-top: 1.25rem;
}

.repo-drawer__section h3 {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.repo-drawer__toggle {
  margin-top: 0.75rem;
}

.repo-drawer__error {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: var(--amber-error-bg);
  color: var(--amber-error);
  font-size: 0.85rem;
  word-break: break-word;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 0;
}

.detail-grid dt {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.detail-grid dd {
  margin: 0.15rem 0 0;
  word-break: break-word;
}

.explain-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.explain-table th {
  text-align: left;
  font-weight: 550;
  color: var(--p-text-muted-color);
  padding: 0.3rem 0.5rem 0.3rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.explain-table td {
  padding: 0.35rem 0.5rem 0.35rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.run-detail {
  padding: 0.5rem 0.25rem;
  font-size: 0.85rem;
}

.run-detail p {
  margin: 0 0 0.35rem;
}

.run-detail__error {
  color: var(--amber-error);
  word-break: break-word;
}

.folder-progress {
  margin-top: 0.75rem;
}
</style>
