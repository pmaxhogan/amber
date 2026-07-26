<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tag from "primevue/tag";
import type {
  Account,
  AmberEvent,
  BulkRepoAction,
  Forge,
  RepoSortField,
  SortDirection,
} from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { eventPayloadSchema } from "@amber/shared";
import { deriveOutcome, type AccountSyncRow, type RepoRow } from "../api/types.ts";
import { forgeOrigin, humanBytes, pluralize, relativeTime, absoluteTime } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import { useEventsStore } from "../stores/events.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import OutcomeBadge from "../components/OutcomeBadge.vue";
import PageHeader from "../components/PageHeader.vue";
import ListSkeleton from "../components/ListSkeleton.vue";

// The drawer pulls in the tab set, the settings editor, and the export tooling.
// None of that belongs in the bundle a user downloads to read a table.
const RepoDetailDrawer = defineAsyncComponent(() => import("../components/RepoDetailDrawer.vue"));

const api = useApi();
const router = useRouter();
const toast = useToaster();
const events = useEventsStore();

// ---------------------------------------------------------------------------
// Query state
// ---------------------------------------------------------------------------

const rows = ref<RepoRow[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

const page = ref(1);
const perPage = ref(25);
// Newest first by default: the repo you just added is the one you care about.
const sort = ref<RepoSortField>("created_at");
const dir = ref<SortDirection>("desc");

const q = ref("");
const forgeId = ref<number | null>(null);
const stateFilter = ref<"active" | "paused" | null>(null);
const outcomeFilter = ref<"success" | "error" | "canceled" | null>(null);

const forges = ref<Forge[]>([]);
const accounts = ref<Account[]>([]);
const accountSyncs = ref<AccountSyncRow[]>([]);

const forgeById = computed(() => new Map(forges.value.map((forge) => [forge.id, forge])));
const accountById = computed(() => new Map(accounts.value.map((account) => [account.id, account])));
const defaultAccountByForge = computed(
  () =>
    new Map(
      accounts.value.filter((account) => account.isDefault).map((a) => [a.forgeId, a] as const),
    ),
);

const syncSourceById = computed(
  () => new Map(accountSyncs.value.map((sync) => [sync.id, sync.source] as const)),
);

/**
 * Where the repo came from. Origin is who created it, so a manual import that
 * an account sync later adopted still reads Manual; a discovered repo whose
 * sync was since deleted degrades to the generic Account label.
 */
function repoSource(row: RepoRow): string {
  if (row.origin === "manual") return "Manual";
  const source =
    row.managedByAccountSyncId === null
      ? undefined
      : syncSourceById.value.get(row.managedByAccountSyncId);
  return source === "starred" ? "Starred" : "Account";
}

const forgeOptions = computed(() => [
  { label: "All forges", value: null },
  ...forges.value.map((forge) => ({ label: forgeOrigin(forge), value: forge.id })),
]);

const stateOptions = [
  { label: "Any state", value: null },
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
];

const outcomeOptions = [
  { label: "Any outcome", value: null },
  { label: "Succeeded", value: "success" },
  { label: "Failed", value: "error" },
  { label: "Canceled", value: "canceled" },
];

const hasFilters = computed(
  () =>
    q.value.trim() !== "" ||
    forgeId.value !== null ||
    stateFilter.value !== null ||
    outcomeFilter.value !== null,
);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await api.listRepos(
      {
        page: page.value,
        perPage: perPage.value,
        sort: sort.value,
        dir: dir.value,
        q: q.value.trim() === "" ? undefined : q.value.trim(),
        forgeId: forgeId.value ?? undefined,
        state: stateFilter.value ?? undefined,
        outcome: outcomeFilter.value ?? undefined,
      },
      controller.signal,
    );
    rows.value = result.rows;
    total.value = result.total;
    error.value = null;
    structuralChanges.value = 0;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      loading.value = false;
      inflight = null;
    }
  }
}

async function loadReferenceData(): Promise<void> {
  try {
    const [forgeRows, accountRows, syncRows] = await Promise.all([
      api.listForges(),
      api.listAccounts(),
      api.listAccountSyncs(),
    ]);
    forges.value = forgeRows;
    accounts.value = accountRows;
    accountSyncs.value = syncRows;
  } catch {
    // The table still renders without the forge and account join; the columns
    // degrade to ids rather than the page failing outright.
  }
}

/** Debounced so typing in the search box does not fire a request per keystroke. */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(q, () => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    clearSelection();
    void load();
  }, 300);
});

watch([forgeId, stateFilter, outcomeFilter], () => {
  page.value = 1;
  clearSelection();
  void load();
});

function resetFilters(): void {
  q.value = "";
  forgeId.value = null;
  stateFilter.value = null;
  outcomeFilter.value = null;
}

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function onSort(event: { sortField?: unknown; sortOrder?: number | null }): void {
  const field = typeof event.sortField === "string" ? event.sortField : "created_at";
  sort.value = field as RepoSortField;
  dir.value = event.sortOrder === -1 ? "desc" : "asc";
  page.value = 1;
  void load();
}

// ---------------------------------------------------------------------------
// Selection and bulk actions
// ---------------------------------------------------------------------------

const selected = ref<RepoRow[]>([]);
const allMatching = ref(false);

const selectionCount = computed(() => (allMatching.value ? total.value : selected.value.length));
const pageFullySelected = computed(
  () => rows.value.length > 0 && selected.value.length === rows.value.length,
);
const canSelectAllMatching = computed(
  () => pageFullySelected.value && total.value > rows.value.length && !allMatching.value,
);

function clearSelection(): void {
  selected.value = [];
  allMatching.value = false;
}

watch(selected, () => {
  if (selected.value.length !== rows.value.length) allMatching.value = false;
});

const ID_PAGE_SIZE = 200;

/**
 * The bulk endpoint takes explicit ids, so "all matching" has to be expanded
 * into ids before it can be acted on. Paging at the maximum page size keeps
 * that to a handful of requests even for a large instance.
 */
async function resolveSelectedIds(): Promise<number[]> {
  if (!allMatching.value) return selected.value.map((row) => row.id);
  const ids: number[] = [];
  let cursor = 1;
  for (;;) {
    const result = await api.listRepos({
      page: cursor,
      perPage: ID_PAGE_SIZE,
      sort: sort.value,
      dir: dir.value,
      q: q.value.trim() === "" ? undefined : q.value.trim(),
      forgeId: forgeId.value ?? undefined,
      state: stateFilter.value ?? undefined,
      outcome: outcomeFilter.value ?? undefined,
    });
    ids.push(...result.rows.map((row) => row.id));
    if (ids.length >= result.total || result.rows.length === 0) break;
    cursor += 1;
  }
  return ids;
}

const bulkBusy = ref(false);
const deleteVisible = ref(false);
const deleteFiles = ref(false);

const ACTION_LABELS: Record<BulkRepoAction, string> = {
  pause: "Paused",
  resume: "Resumed",
  sync: "Queued a sync for",
  delete: "Removed",
};

async function runBulk(action: BulkRepoAction, files = false): Promise<void> {
  bulkBusy.value = true;
  try {
    const ids = await resolveSelectedIds();
    if (ids.length === 0) return;
    await api.bulkRepos(ids, action, files);
    toast.success(
      `${ACTION_LABELS[action]} ${pluralize(ids.length, "repository", "repositories")}`,
    );
    clearSelection();
    deleteVisible.value = false;
    await load();
  } catch (cause) {
    toast.failure("The bulk action failed", cause);
  } finally {
    bulkBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

const syncingIds = ref<Set<number>>(new Set());
/** Creates and deletes change the page contents, so they prompt a refresh. */
const structuralChanges = ref(0);

const pendingRefresh = new Set<number>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function queueRowRefresh(id: number): void {
  if (!rows.value.some((row) => row.id === id)) return;
  pendingRefresh.add(id);
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const ids = [...pendingRefresh];
    pendingRefresh.clear();
    void refreshRows(ids);
  }, 400);
}

/** Patch rows in place. A full refetch on every event would be a storm. */
async function refreshRows(ids: number[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        const fresh = await api.getRepo(id);
        mergeRow(fresh);
      } catch {
        // A row that cannot be refreshed keeps its last known values.
      }
    }),
  );
}

function mergeRow(fresh: RepoRow): void {
  const index = rows.value.findIndex((row) => row.id === fresh.id);
  if (index === -1) return;
  const next = [...rows.value];
  next[index] = fresh;
  rows.value = next;
}

function handleEvent(event: AmberEvent): void {
  const parsed = eventPayloadSchema.safeParse(event.payload);
  const payload = parsed.success ? parsed.data : {};
  const repoId = payload.repoId;

  if (event.type === "repo.created" || event.type === "repo.deleted") {
    structuralChanges.value += 1;
    return;
  }
  if (repoId === undefined) return;

  if (event.type === "sync.started") {
    const next = new Set(syncingIds.value);
    next.add(repoId);
    syncingIds.value = next;
    return;
  }
  if (event.type === "sync.finished") {
    const next = new Set(syncingIds.value);
    next.delete(repoId);
    syncingIds.value = next;
  }
  queueRowRefresh(repoId);
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

const drawerRepo = ref<RepoRow | null>(null);
const drawerVisible = ref(false);

function openDrawer(row: RepoRow): void {
  drawerRepo.value = row;
  drawerVisible.value = true;
}

function onRepoChanged(updated: RepoRow): void {
  mergeRow(updated);
  drawerRepo.value = updated;
}

function onRepoDeleted(id: number): void {
  rows.value = rows.value.filter((row) => row.id !== id);
  total.value = Math.max(0, total.value - 1);
  drawerRepo.value = null;
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

function forgeLabel(row: RepoRow): string {
  const forge = forgeById.value.get(row.forgeId);
  return forge === undefined ? `forge ${row.forgeId}` : forge.host;
}

function repoUrl(row: RepoRow): string {
  const forge = forgeById.value.get(row.forgeId);
  return forge === undefined ? row.path : `${forgeOrigin(forge)}/${row.path}`;
}

interface AccountBadge {
  label: string;
  severity: "secondary" | "info" | "warn";
  title: string;
}

function accountBadge(row: RepoRow): AccountBadge {
  if (row.forceAnonymous) {
    return {
      label: "anonymous",
      severity: "warn",
      title: "This repository is always fetched without credentials.",
    };
  }
  if (row.accountOverrideId !== null) {
    const account = accountById.value.get(row.accountOverrideId);
    return {
      label: account === undefined ? "override" : `${account.username} (override)`,
      severity: "info",
      title: "This repository overrides the forge default account.",
    };
  }
  const fallback = defaultAccountByForge.value.get(row.forgeId);
  return {
    label: fallback === undefined ? "none" : fallback.username,
    severity: "secondary",
    title:
      fallback === undefined
        ? "No account is configured on this forge, so fetches are anonymous."
        : "Uses the forge default account.",
  };
}

// Unsubscribed explicitly on unmount. Leaving it to the store's
// onScopeDispose fallback would risk a listener per visit to this route, and
// each stale handler still holds the rows it saw, so one sync.finished would
// fan out into a refetch per leaked subscription.
let offEvents: (() => void) | null = null;

onMounted(() => {
  void loadReferenceData();
  void load();
  offEvents = events.on(handleEvent);
});

onBeforeUnmount(() => {
  inflight?.abort();
  offEvents?.();
  if (searchTimer !== null) clearTimeout(searchTimer);
  if (refreshTimer !== null) clearTimeout(refreshTimer);
});
</script>

<template>
  <section class="repos-page">
    <PageHeader title="Repos" description="Every repository amber is backing up.">
      <template #actions>
        <Button label="Import repositories" size="small" @click="router.push('/import')" />
      </template>
    </PageHeader>

    <div class="repos-filters" role="search">
      <div class="amber-field repos-filters__search">
        <label for="repo-search">Search</label>
        <InputText
          id="repo-search"
          v-model="q"
          placeholder="Filter by name or path"
          autocomplete="off"
        />
      </div>
      <div class="amber-field">
        <label for="repo-forge">Forge</label>
        <Select
          v-model="forgeId"
          input-id="repo-forge"
          :options="forgeOptions"
          option-label="label"
          option-value="value"
        />
      </div>
      <div class="amber-field">
        <label for="repo-state">State</label>
        <Select
          v-model="stateFilter"
          input-id="repo-state"
          :options="stateOptions"
          option-label="label"
          option-value="value"
        />
      </div>
      <div class="amber-field">
        <label for="repo-outcome">Last outcome</label>
        <Select
          v-model="outcomeFilter"
          input-id="repo-outcome"
          :options="outcomeOptions"
          option-label="label"
          option-value="value"
        />
      </div>
      <Button
        v-if="hasFilters"
        label="Reset"
        severity="secondary"
        text
        size="small"
        @click="resetFilters"
      />
    </div>

    <div v-if="structuralChanges > 0" class="repos-stale" role="status">
      <AppIcon name="sync" :size="15" />
      <span>
        {{ pluralize(structuralChanges, "change", "changes") }} to the repository list since this
        page loaded.
      </span>
      <Button label="Refresh" size="small" severity="secondary" text @click="load" />
    </div>

    <div v-if="selectionCount > 0" class="repos-bulk" role="region" aria-label="Bulk actions">
      <span class="repos-bulk__count">
        {{ pluralize(selectionCount, "repository", "repositories") }} selected
      </span>
      <Button
        v-if="canSelectAllMatching"
        :label="`Select all ${total} matching`"
        size="small"
        severity="secondary"
        text
        @click="allMatching = true"
      />
      <span class="repos-bulk__spacer" />
      <Button
        label="Pause"
        size="small"
        severity="secondary"
        :disabled="bulkBusy"
        @click="runBulk('pause')"
      />
      <Button
        label="Resume"
        size="small"
        severity="secondary"
        :disabled="bulkBusy"
        @click="runBulk('resume')"
      />
      <Button label="Sync now" size="small" :disabled="bulkBusy" @click="runBulk('sync')" />
      <Button
        label="Delete"
        size="small"
        severity="danger"
        outlined
        :disabled="bulkBusy"
        @click="deleteVisible = true"
      />
      <Button
        label="Clear selection"
        size="small"
        severity="secondary"
        text
        @click="clearSelection"
      />
    </div>

    <ErrorState :error="error" title="Could not load the repository list" @retry="load" />

    <DataTable
      v-if="error === null"
      v-model:selection="selected"
      :value="rows"
      data-key="id"
      lazy
      paginator
      :rows="perPage"
      :rows-per-page-options="[25, 50, 100, 200]"
      :total-records="total"
      :loading="loading"
      :sort-field="sort"
      :sort-order="dir === 'asc' ? 1 : -1"
      size="small"
      striped-rows
      removable-sort
      row-hover
      class="repos-table"
      current-page-report-template="{first} to {last} of {totalRecords}"
      paginator-template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown CurrentPageReport"
      @page="onPage"
      @sort="onSort"
      @row-click="openDrawer($event.data)"
    >
      <template #empty>
        <EmptyState
          v-if="!loading && hasFilters"
          icon="search"
          title="No repositories match these filters"
          description="Try a broader search, or reset the filters to see everything amber is backing up."
        >
          <Button label="Reset filters" size="small" severity="secondary" @click="resetFilters" />
        </EmptyState>
        <EmptyState
          v-else-if="!loading"
          icon="repos"
          title="No repositories yet"
          description="Amber backs up any git repository reachable over HTTPS. Paste a list of URLs to get started."
        >
          <Button label="Import your first repository" @click="router.push('/import')" />
        </EmptyState>
        <ListSkeleton v-else :rows="5" label="Loading repositories" />
      </template>

      <Column selection-mode="multiple" header-style="width: 3rem" :sortable="false" />

      <Column field="displayName" header="Repo" sort-field="display_name" sortable>
        <template #body="{ data }">
          <div class="repo-cell" :title="repoUrl(data)">
            <span class="repo-cell__name">{{ data.displayName }}</span>
            <span class="repo-cell__path mono">{{ forgeLabel(data) }}/{{ data.path }}</span>
          </div>
        </template>
      </Column>

      <Column header="Forge" :sortable="false">
        <template #body="{ data }">
          <span class="amber-muted">{{ forgeById.get(data.forgeId)?.kind ?? "generic" }}</span>
        </template>
      </Column>

      <Column header="Account" :sortable="false">
        <template #body="{ data }">
          <Tag
            :value="accountBadge(data).label"
            :severity="accountBadge(data).severity"
            :title="accountBadge(data).title"
          />
        </template>
      </Column>

      <Column header="Source" :sortable="false">
        <template #body="{ data }">
          <span class="amber-muted">{{ repoSource(data) }}</span>
        </template>
      </Column>

      <Column header="Mode" :sortable="false">
        <template #body="{ data }">
          <span class="mono">{{ data.cloneMode ?? "-" }}</span>
          <span
            v-if="data.syncEnabled === false"
            class="amber-muted repo-cell__path"
            title="Syncing is switched off for this repository by a settings override."
            >sync off</span
          >
        </template>
      </Column>

      <Column header="Last sync" sort-field="last_sync_at" sortable>
        <template #body="{ data }">
          <div class="repo-cell">
            <OutcomeBadge :outcome="deriveOutcome(data)" :label="relativeTime(data.lastSyncAt)" />
            <span class="repo-cell__path" :title="absoluteTime(data.lastSyncAt)">
              {{ data.lastErrorKind ?? absoluteTime(data.lastSyncAt) }}
            </span>
          </div>
        </template>
      </Column>

      <Column header="Next sync" sort-field="next_sync_at" sortable>
        <template #body="{ data }">
          <span :title="absoluteTime(data.nextSyncAt)">{{ relativeTime(data.nextSyncAt) }}</span>
        </template>
      </Column>

      <Column header="Size" sort-field="disk_usage_bytes" sortable>
        <template #body="{ data }">{{ humanBytes(data.diskUsageBytes) }}</template>
      </Column>

      <Column header="Added" sort-field="created_at" sortable>
        <template #body="{ data }">
          <span :title="absoluteTime(data.createdAt)">{{ relativeTime(data.createdAt) }}</span>
        </template>
      </Column>

      <Column header="Status" :sortable="false">
        <template #body="{ data }">
          <span v-if="syncingIds.has(data.id)" class="repo-status repo-status--syncing">
            <AppIcon name="sync" :size="14" />
            syncing
          </span>
          <span v-else-if="data.state === 'paused'" class="repo-status">
            <AppIcon name="pause" :size="14" />
            paused
          </span>
          <span v-else class="repo-status">
            <AppIcon name="play" :size="14" />
            active
          </span>
        </template>
      </Column>
    </DataTable>

    <ConfirmDialog
      v-model:visible="deleteVisible"
      title="Remove the selected repositories?"
      :message="`Amber will stop backing up ${pluralize(selectionCount, 'repository', 'repositories')}.`"
      confirm-label="Remove"
      danger
      :busy="bulkBusy"
      @confirm="runBulk('delete', deleteFiles)"
    >
      <div class="amber-row">
        <Checkbox v-model="deleteFiles" input-id="bulk-delete-files" binary />
        <label for="bulk-delete-files">Also delete the backup files on disk</label>
      </div>
    </ConfirmDialog>

    <RepoDetailDrawer
      v-if="drawerRepo"
      v-model:visible="drawerVisible"
      :repo="drawerRepo"
      :forges="forges"
      :accounts="accounts"
      @changed="onRepoChanged"
      @deleted="onRepoDeleted"
    />
  </section>
</template>

<style scoped>
.repos-filters {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.repos-filters__search {
  flex: 1 1 18rem;
  min-width: 14rem;
}

.repos-stale,
.repos-bulk {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
  font-size: 0.87rem;
}

.repos-bulk__count {
  font-weight: 600;
}

.repos-bulk__spacer {
  flex: 1;
}

.repos-loading {
  padding: 2rem 0;
  text-align: center;
}

.repo-cell {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.repo-cell__name {
  font-weight: 550;
}

.repo-cell__path {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 26rem;
}

.repo-status {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.repo-status--syncing {
  color: var(--p-primary-color);
}

.repos-table :deep(tbody tr) {
  cursor: pointer;
}
</style>
