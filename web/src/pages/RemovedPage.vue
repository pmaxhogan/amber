<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { Account, Forge } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import type { RepoRow } from "../api/types.ts";
import { absoluteTime, forgeOrigin, humanBytes, pluralize, relativeTime } from "../lib/format.ts";
import { disablePush, enablePush, readPushState, type PushState } from "../lib/push.ts";
import { useToaster } from "../lib/toast.ts";
import { useEventsStore } from "../stores/events.ts";
import AppIcon from "../components/AppIcon.vue";
import EmptyState from "../components/EmptyState.vue";
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

const forgeById = computed(() => new Map(forges.value.map((forge) => [forge.id, forge])));

function upstreamUrl(repo: RepoRow): string {
  const forge = forgeById.value.get(repo.forgeId);
  return forge === undefined ? repo.path : `${forgeOrigin(forge)}/${repo.path}`;
}

function hostOf(repo: RepoRow): string {
  return forgeById.value.get(repo.forgeId)?.host ?? "";
}

/** Why amber thinks it is gone, in the words of what the forge answered. */
function reason(repo: RepoRow): { label: string; severity: string } {
  return repo.lastErrorKind === "auth"
    ? { label: "not found or private", severity: "warn" }
    : { label: "not found", severity: "danger" };
}

async function load(quiet = false): Promise<void> {
  if (!quiet) loading.value = true;
  try {
    const [page, forgeRows, accountRows] = await Promise.all([
      api.listRepos({ gone: true, sort: "gone_at", dir: "desc", perPage: PER_PAGE }),
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
      description="Repositories that synced at least once and can no longer be fetched upstream: deleted, taken down, or made private. Amber keeps every backup and keeps checking."
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
      description="Every repository that has synced is still reachable upstream. When one stops answering twice in a row, it shows up here and its backup is kept."
    />

    <div v-else-if="repos.length > 0" class="amber-card removed-table-wrap">
      <table class="removed-table">
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Gone since</th>
            <th scope="col">Last good sync</th>
            <th scope="col">Backup size</th>
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
            <td :title="absoluteTime(repo.goneAt)">{{ relativeTime(repo.goneAt) }}</td>
            <td :title="absoluteTime(repo.lastSuccessAt)">
              {{ relativeTime(repo.lastSuccessAt) }}
            </td>
            <td>{{ humanBytes(repo.diskUsageBytes) }}</td>
            <td><Tag :value="reason(repo).label" :severity="reason(repo).severity" /></td>
            <td class="removed-actions">
              <a :href="upstreamUrl(repo)" target="_blank" rel="noopener noreferrer">
                upstream <AppIcon name="external" :size="13" />
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="total > repos.length" class="amber-note removed-more">
        Showing the {{ repos.length }} most recent of {{ total }}.
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

.removed-actions a {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--p-text-muted-color);
  text-decoration: none;
}

.removed-actions a:hover {
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
