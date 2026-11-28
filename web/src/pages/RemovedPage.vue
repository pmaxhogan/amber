<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { dmcaTakedown, type Account, type Forge } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import type { RepoRow } from "../api/types.ts";
import {
  absoluteTime,
  compactCount,
  forgeOrigin,
  humanBytes,
  pluralize,
  relativeTime,
  starsTitle,
} from "../lib/format.ts";
import { disablePush, enablePush, readPushState, type PushState } from "../lib/push.ts";
import { useToaster } from "../lib/toast.ts";
import { useEventsStore } from "../stores/events.ts";
import AppIcon from "../components/AppIcon.vue";
import EmptyState from "../components/EmptyState.vue";
import ForkParentLink from "../components/ForkParentLink.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";

const RepoDetailDrawer = defineAsyncComponent(() => import("../components/RepoDetailDrawer.vue"));

/** One page is the whole list in practice; more than this says so. */
const PER_PAGE = 200;

const api = useApi();
const toast = useToaster();
const events = useEventsStore();

const repos = ref<RepoRow[]>([]);
const total = ref(0);
const forges = ref<Forge[]>([]);
const accounts = ref<Account[]>([]);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

/**
 * Newest removal first by default; the Stars header re-sorts by the last
 * reported count instead (never-reported last either way, server side).
 */
type RemovedSort = "gone_at" | "stars";
const sortField = ref<RemovedSort>("gone_at");
const sortDir = ref<"asc" | "desc">("desc");

function sortBy(field: RemovedSort): void {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === "desc" ? "asc" : "desc";
  } else {
    sortField.value = field;
    sortDir.value = "desc";
  }
  void load(true);
}

function ariaSort(field: RemovedSort): "ascending" | "descending" | "none" {
  if (sortField.value !== field) return "none";
  return sortDir.value === "asc" ? "ascending" : "descending";
}

const forgeById = computed(() => new Map(forges.value.map((forge) => [forge.id, forge])));

function upstreamUrl(repo: RepoRow): string {
  const forge = forgeById.value.get(repo.forgeId);
  return forge === undefined ? repo.path : `${forgeOrigin(forge)}/${repo.path}`;
}

function hostOf(repo: RepoRow): string {
  return forgeById.value.get(repo.forgeId)?.host ?? "";
}

interface Reason {
  label: string;
  severity: string;
  /** The published takedown notice, when the forge linked one. */
  noticeUrl: string | null;
  /** What the tag means, for a tooltip. */
  title?: string;
}

/** The user or organization segment of a repository path. */
function ownerOf(repo: RepoRow): string {
  return repo.path.split("/")[0] ?? "";
}

/** Why amber thinks it is gone, in the words of what the forge answered. */
function reason(repo: RepoRow): Reason {
  // GitHub is the one forge that says a repository was taken down, and why.
  const takedown = dmcaTakedown(forgeById.value.get(repo.forgeId)?.kind, repo.lastError);
  if (takedown !== null) {
    return { label: "DMCA takedown", severity: "danger", noticeUrl: takedown.noticeUrl };
  }
  // The forge's explicit statement wins above; otherwise a 404 on the owner
  // too means the whole account went, which takes its repositories with it.
  if (repo.ownerGone === true) {
    return {
      label: "account removed",
      severity: "danger",
      noticeUrl: null,
      title: `${hostOf(repo)}/${ownerOf(repo)} is gone too: the account was deleted or suspended, which takes every repository it owned with it.`,
    };
  }
  return repo.lastErrorKind === "auth"
    ? { label: "not found or private", severity: "warn", noticeUrl: null }
    : { label: "not found", severity: "danger", noticeUrl: null };
}

async function load(quiet = false): Promise<void> {
  if (!quiet) loading.value = true;
  try {
    const [page, forgeRows, accountRows] = await Promise.all([
      api.listRepos({ gone: true, sort: sortField.value, dir: sortDir.value, perPage: PER_PAGE }),
      api.listForges(),
      api.listAccounts(),
    ]);
    repos.value = page.rows;
    total.value = page.total;
    forges.value = forgeRows;
    accounts.value = accountRows;
    error.value = null;
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Notifications on this device
// ---------------------------------------------------------------------------

const pushState = ref<PushState>("off");
const pushBusy = ref(false);

const pushNote = computed(() => {
  switch (pushState.value) {
    case "on":
      return "This device gets a notification when a repository goes gone.";
    case "denied":
      return "Notifications are blocked for this site. Allow them in the browser's site settings, then reload.";
    case "needs_install":
      return "On iPhone and iPad, add Amber to the Home Screen (Share, then Add to Home Screen) and open it from there to turn notifications on.";
    case "unsupported":
      return "This browser cannot receive push notifications.";
    default:
      return "Get a notification on this device when a repository goes gone. Each device turns it on for itself.";
  }
});

async function refreshPush(): Promise<void> {
  try {
    pushState.value = await readPushState(api);
  } catch {
    // The list still works without it; the button simply stays "off".
    pushState.value = "off";
  }
}

async function togglePush(): Promise<void> {
  pushBusy.value = true;
  try {
    if (pushState.value === "on") {
      pushState.value = await disablePush(api);
      toast.success("Notifications turned off on this device");
    } else {
      pushState.value = await enablePush(api);
      if (pushState.value === "on") {
        toast.success("Notifications turned on", "Send a test to see what one looks like.");
      }
    }
  } catch (cause) {
    toast.failure("Could not change notifications", cause);
  } finally {
    pushBusy.value = false;
  }
}

async function sendTest(): Promise<void> {
  pushBusy.value = true;
  try {
    const result = await api.testPush();
    if (result.sent > 0) {
      toast.success(
        "Test notification sent",
        `Delivered to ${pluralize(result.sent, "device")}${result.failed > 0 ? `, ${result.failed} failed` : ""}.`,
      );
    } else {
      toast.failure(
        "No test notification went out",
        new Error(
          result.failed > 0
            ? "Every subscribed device rejected it."
            : "No device is subscribed yet.",
        ),
      );
    }
  } catch (cause) {
    toast.failure("Could not send a test notification", cause);
  } finally {
    pushBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

const drawerRepo = ref<RepoRow | null>(null);
const drawerVisible = ref(false);

function open(repo: RepoRow): void {
  drawerRepo.value = repo;
  drawerVisible.value = true;
}

let offEvents: (() => void) | null = null;

onMounted(() => {
  void load();
  void refreshPush();
  // A repository going gone, coming back, or being deleted all change this
  // list; a quiet reload keeps it honest without flashing the skeleton.
  offEvents = events.on((event) => {
    if (
      event.type === "repo.gone" ||
      event.type === "repo.deleted" ||
      (event.type === "sync.finished" && repos.value.some((r) => r.id === event.payload.repoId))
    ) {
      void load(true);
    }
  });
});

onBeforeUnmount(() => {
  offEvents?.();
});
</script>

<template>
  <section>
    <PageHeader
      title="Removed"
      description="Repositories that synced at least once and have not been fetchable upstream for hours: deleted, taken down, or made private. Amber keeps every backup and keeps checking, so one that comes back leaves this list."
    />

    <div class="amber-card removed-push">
      <div class="removed-push__text">
        <AppIcon name="bell" :size="18" />
        <p class="amber-note">{{ pushNote }}</p>
      </div>
      <div class="amber-row">
        <Button
          v-if="pushState === 'on'"
          label="Send a test"
          size="small"
          severity="secondary"
          :loading="pushBusy"
          @click="sendTest"
        />
        <Button
          v-if="pushState === 'on' || pushState === 'off'"
          :label="pushState === 'on' ? 'Turn off' : 'Notify this device'"
          size="small"
          :severity="pushState === 'on' ? 'secondary' : undefined"
          :text="pushState === 'on'"
          :loading="pushBusy"
          @click="togglePush"
        />
      </div>
    </div>

    <ErrorState :error="error" title="Could not load removed repositories" @retry="load()" />

    <ListSkeleton v-if="loading" :rows="3" label="Loading removed repositories" />

    <EmptyState
      v-else-if="repos.length === 0 && error === null"
      icon="check"
      title="Nothing has been removed"
      description="Every repository that has synced is still reachable upstream. When one stays unreachable for six hours, or GitHub says it was taken down, it shows up here and its backup is kept."
    />

    <div v-else-if="repos.length > 0" class="amber-card removed-table-wrap">
      <table class="removed-table">
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Fork of</th>
            <th scope="col" :aria-sort="ariaSort('gone_at')">
              <button type="button" class="removed-sort" @click="sortBy('gone_at')">
                Gone since
                <AppIcon
                  v-if="sortField === 'gone_at'"
                  name="chevron"
                  :size="12"
                  :class="{ 'removed-sort__up': sortDir === 'asc' }"
                />
              </button>
            </th>
            <th scope="col">Last checked</th>
            <th scope="col">Last good sync</th>
            <th scope="col">Backup size</th>
            <th scope="col" class="removed-num" :aria-sort="ariaSort('stars')">
              <button type="button" class="removed-sort" @click="sortBy('stars')">
                Stars
                <AppIcon
                  v-if="sortField === 'stars'"
                  name="chevron"
                  :size="12"
                  :class="{ 'removed-sort__up': sortDir === 'asc' }"
                />
              </button>
            </th>
            <th scope="col">Forge said</th>
            <th scope="col"><span class="removed-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="repo in repos" :key="repo.id">
            <td>
              <button type="button" class="removed-name" @click="open(repo)">
                {{ repo.path }}
              </button>
              <div class="amber-muted removed-host">{{ hostOf(repo) }}</div>
            </td>
            <td>
              <ForkParentLink :repo="repo" :forge="forgeById.get(repo.forgeId)" @open="open" />
            </td>
            <td :title="absoluteTime(repo.goneAt)">{{ relativeTime(repo.goneAt) }}</td>
            <td class="removed-checked" :title="absoluteTime(repo.lastSyncAt)">
              {{ relativeTime(repo.lastSyncAt) }}
            </td>
            <td :title="absoluteTime(repo.lastSuccessAt)">
              {{ relativeTime(repo.lastSuccessAt) }}
            </td>
            <td>{{ humanBytes(repo.diskUsageBytes) }}</td>
            <td class="removed-num" :title="starsTitle(repo.stars)">
              {{ compactCount(repo.stars) }}
            </td>
            <td>
              <Tag
                :value="reason(repo).label"
                :severity="reason(repo).severity"
                :title="reason(repo).title"
              />
              <a
                v-if="reason(repo).noticeUrl"
                class="removed-notice"
                :href="reason(repo).noticeUrl ?? undefined"
                target="_blank"
                rel="noopener noreferrer"
              >
                notice <AppIcon name="external" :size="13" />
              </a>
            </td>
            <td class="removed-actions">
              <a :href="upstreamUrl(repo)" target="_blank" rel="noopener noreferrer">
                upstream <AppIcon name="external" :size="13" />
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="total > repos.length" class="amber-note removed-more">
        <template v-if="sortField === 'gone_at'">
          Showing the {{ repos.length }} most recent of {{ total }}.
        </template>
        <template v-else>Showing {{ repos.length }} of {{ total }}.</template>
      </p>
    </div>

    <RepoDetailDrawer
      v-if="drawerRepo"
      v-model:visible="drawerVisible"
      :repo="drawerRepo"
      :forges="forges"
      :accounts="accounts"
      @changed="load(true)"
      @deleted="load(true)"
    />
  </section>
</template>

<style scoped>
.removed-push {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.removed-push__text {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: 1 1 18rem;
}

.removed-push__text .amber-note {
  margin: 0;
}

.removed-table-wrap {
  overflow-x: auto;
  padding: 0;
}

.removed-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.removed-table th {
  text-align: left;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
  font-weight: 600;
}

.removed-table th,
.removed-table td {
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}

.removed-table .removed-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.removed-sort {
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.removed-sort__up {
  transform: rotate(180deg);
}

.removed-sort:hover {
  color: var(--p-text-color);
}

.removed-sort:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.removed-table tbody tr:last-child td {
  border-bottom: none;
}

.removed-name {
  padding: 0;
  border: none;
  background: none;
  color: var(--p-primary-color);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  white-space: normal;
  word-break: break-word;
}

.removed-name:hover {
  text-decoration: underline;
}

.removed-name:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.removed-host {
  font-size: 0.78rem;
}

.removed-notice {
  margin-left: 0.5rem;
}

.removed-actions a,
.removed-notice {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--p-text-muted-color);
  text-decoration: none;
}

.removed-actions a:hover,
.removed-notice:hover {
  color: var(--p-text-color);
}

.removed-more {
  margin: 0;
  padding: 0.6rem 0.9rem;
}

.removed-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
