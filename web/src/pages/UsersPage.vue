<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";
import {
  PERMISSIONS,
  type PermissionKey,
  type UserRefreshResponse,
  type UserRow,
} from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { absoluteTime, humanBytes, pluralize, relativeTime } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import { useMeStore } from "../stores/me.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const toast = useToaster();
const me = useMeStore();

const BYTES_PER_GB = 1024 ** 3;

const rows = ref<UserRow[]>([]);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);
/** Ids with a save in flight, so one row's save does not lock the others. */
const saving = ref<Set<number>>(new Set());
/**
 * Bumped when a save fails. The toggle switches keep their own on/off state,
 * so after a refused save the row is re-mounted to show what the server holds.
 */
const epochs = ref<Record<number, number>>({});

/** The cap each row is being edited to, in GB. Absent: not being edited. */
const capDrafts = ref<Record<number, number | null>>({});

const policy = computed(() => me.policy);
const configured = computed(() => policy.value?.configured === true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api.listUsers();
    error.value = null;
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

function setSaving(id: number, on: boolean): void {
  const next = new Set(saving.value);
  if (on) next.add(id);
  else next.delete(id);
  saving.value = next;
}

/** Replace a row with the server's answer; nothing is shown before it arrives. */
function applyRow(updated: UserRow): void {
  rows.value = rows.value.map((row) => (row.id === updated.id ? updated : row));
}

async function patch(
  user: UserRow,
  input: { permissions?: Partial<Record<PermissionKey, boolean>>; storageCapBytes?: number | null },
  done: string,
): Promise<boolean> {
  setSaving(user.id, true);
  try {
    applyRow(await api.updateUser(user.id, input));
    toast.success(done);
    return true;
  } catch (cause) {
    toast.failure(`Could not update ${user.email}`, cause);
    epochs.value = { ...epochs.value, [user.id]: (epochs.value[user.id] ?? 0) + 1 };
    return false;
  } finally {
    setSaving(user.id, false);
  }
}

async function togglePermission(user: UserRow, key: PermissionKey, value: boolean): Promise<void> {
  await patch(user, { permissions: { [key]: value } }, "Permission saved");
}

// -- Storage cap -------------------------------------------------------------

function capGb(user: UserRow): number | null {
  return user.storageCapBytes === null ? null : user.storageCapBytes / BYTES_PER_GB;
}

function draftFor(user: UserRow): number | null {
  return user.id in capDrafts.value ? (capDrafts.value[user.id] ?? null) : capGb(user);
}

function capDirty(user: UserRow): boolean {
  return user.id in capDrafts.value && draftFor(user) !== capGb(user);
}

function setDraft(user: UserRow, value: number | null): void {
  capDrafts.value = { ...capDrafts.value, [user.id]: value };
}

async function saveCap(user: UserRow): Promise<void> {
  const gb = draftFor(user);
  const ok = await patch(
    user,
    { storageCapBytes: gb === null ? null : Math.round(gb * BYTES_PER_GB) },
    gb === null ? "Back to the default cap" : "Cap saved",
  );
  if (ok) {
    const rest = { ...capDrafts.value };
    delete rest[user.id];
    capDrafts.value = rest;
  }
}

function capLabel(user: UserRow): string {
  if (user.isAdmin) return "no cap";
  return user.capBytes === null ? "default" : humanBytes(user.capBytes);
}

// -- Git password ------------------------------------------------------------

const revokeTarget = ref<UserRow | null>(null);

async function confirmRevoke(): Promise<void> {
  const user = revokeTarget.value;
  if (user === null) return;
  setSaving(user.id, true);
  try {
    applyRow(await api.revokeUserGit(user.id));
    toast.success("Git password revoked", user.email);
    revokeTarget.value = null;
  } catch (cause) {
    toast.failure("Could not revoke the git password", cause);
  } finally {
    setSaving(user.id, false);
  }
}

// -- Adopt -------------------------------------------------------------------

const adoptTarget = ref<UserRow | null>(null);

async function confirmAdopt(): Promise<void> {
  const user = adoptTarget.value;
  if (user === null) return;
  setSaving(user.id, true);
  try {
    const result = await api.adoptUserRepos(user.id);
    toast.success(
      `Adopted ${pluralize(result.adopted, "repository", "repositories")}`,
      "You now own them, and their account overrides are cleared.",
    );
    adoptTarget.value = null;
    await load();
  } catch (cause) {
    toast.failure("Could not adopt the repositories", cause);
  } finally {
    setSaving(user.id, false);
  }
}

// -- Policy ------------------------------------------------------------------

const refreshing = ref(false);
const refreshResult = ref<UserRefreshResponse | null>(null);

async function refreshPolicy(): Promise<void> {
  refreshing.value = true;
  try {
    const result = await api.refreshUsers();
    refreshResult.value = result;
    me.setPolicy(result.policy);
    await load();
  } catch (cause) {
    refreshResult.value = null;
    toast.failure("Could not refresh the list", cause);
  } finally {
    refreshing.value = false;
  }
}

const refreshSummary = computed(() => {
  const result = refreshResult.value;
  if (result === null) return "";
  if (!result.ok) return "";
  const { created, removed, restored } = result.changes;
  if (created + removed + restored === 0) return "Nothing changed.";
  return [
    created > 0 ? `${pluralize(created, "user")} added` : "",
    removed > 0 ? `${pluralize(removed, "user")} removed` : "",
    restored > 0 ? `${pluralize(restored, "user")} restored` : "",
  ]
    .filter((part) => part !== "")
    .join(", ");
});

function permissionOn(user: UserRow, key: PermissionKey): boolean {
  return user.isAdmin || user.permissions[key] === true;
}

onMounted(() => void load());
</script>

<template>
  <section>
    <PageHeader
      title="Users"
      description="Who may use this Amber is decided by the Cloudflare Access policy. Here you decide what each person can do and how much space they get."
    />

    <!-- Access policy -->
    <article class="amber-card policy" data-testid="policy-card">
      <template v-if="configured && policy">
        <header class="policy__head">
          <h2>Access policy</h2>
          <Tag
            v-if="policy.stale || policy.lastError"
            value="out of date"
            severity="warn"
            data-testid="policy-stale"
          />
          <Tag v-else value="in sync" severity="success" />
        </header>
        <p class="amber-note" data-testid="policy-fetched">
          Last read from Cloudflare
          <span :title="absoluteTime(policy.fetchedAt)">{{ relativeTime(policy.fetchedAt) }}</span
          >.
        </p>
        <p v-if="policy.stale || policy.lastError" class="policy__warn" role="alert">
          <AppIcon name="alert" :size="15" />
          <span>
            Amber could not refresh the list from Cloudflare, so it is using the last good copy.
            <span v-if="policy.lastError"> {{ policy.lastError }}</span>
          </span>
        </p>
        <div class="amber-row policy__actions">
          <Button
            label="Refresh from Cloudflare"
            size="small"
            severity="secondary"
            :loading="refreshing"
            @click="refreshPolicy"
          />
          <a
            v-if="policy.editUrl"
            :href="policy.editUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="policy__link"
            >Edit the Access policy in Cloudflare
            <AppIcon name="external" :size="13" />
          </a>
        </div>
        <p v-if="refreshResult?.ok" class="amber-note" role="status" data-testid="refresh-result">
          {{ refreshSummary }}
        </p>
        <p v-else-if="refreshResult" class="policy__warn" role="alert" data-testid="refresh-error">
          <AppIcon name="alert" :size="15" />
          <span>The refresh failed. {{ refreshResult.error }}</span>
        </p>
      </template>
      <template v-else>
        <header class="policy__head">
          <h2>Set up the Access policy</h2>
          <Tag value="admin only" severity="warn" />
        </header>
        <p>
          Amber is admin-only until it can read the list of people from Cloudflare. Set these three
          environment variables and restart it:
        </p>
        <ul class="policy__vars mono">
          <li>CF_API_TOKEN - a token whose only scope is "Access: Apps and Policies Read"</li>
          <li>CF_ACCOUNT_ID - your Cloudflare account id</li>
          <li>CF_ACCESS_POLICY_ID - the reusable Access policy that lists who may get in</li>
        </ul>
        <p class="amber-note">
          Only people named by an email entry in that policy become users. Set all three or none.
        </p>
      </template>
    </article>

    <ErrorState :error="error" title="Could not load users" @retry="load" />

    <ListSkeleton v-if="loading && rows.length === 0" :rows="4" label="Loading users" />

    <EmptyState
      v-else-if="rows.length === 0 && error === null"
      icon="users"
      title="No users yet"
      description="Add someone's email to the Access policy in Cloudflare, then refresh."
    />

    <div v-else-if="error === null" class="users-wrap">
      <table class="users-table" data-testid="users-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Last seen</th>
            <th>Repos</th>
            <th>Storage</th>
            <th>Git password</th>
            <th>Cap (GB)</th>
            <th class="users-table__actions">Actions</th>
          </tr>
        </thead>
        <tbody
          v-for="user in rows"
          :key="`${user.id}-${epochs[user.id] ?? 0}`"
          :data-testid="`user-${user.id}`"
        >
          <tr class="users-table__main" :class="{ 'users-table__main--removed': user.removedAt }">
            <td>
              <div class="user-id">
                <span class="mono user-id__email">{{ user.email }}</span>
                <span class="user-id__tags">
                  <Tag v-if="user.isAdmin" value="admin" severity="info" />
                  <Tag
                    v-if="user.removedAt !== null"
                    value="removed"
                    severity="danger"
                    :title="`Left the access policy ${absoluteTime(user.removedAt)}`"
                  />
                </span>
              </div>
            </td>
            <td>
              <span :title="absoluteTime(user.lastSeenAt)">{{
                relativeTime(user.lastSeenAt)
              }}</span>
            </td>
            <td>{{ user.repoCount }}</td>
            <td>
              <span class="storage">
                {{ humanBytes(user.usedBytes) }} of {{ capLabel(user) }}
                <Tag
                  v-if="user.overCap"
                  value="over cap"
                  severity="warn"
                  data-testid="over-cap"
                  :title="
                    user.capNotifiedAt === null
                      ? ''
                      : `Went over ${absoluteTime(user.capNotifiedAt)}`
                  "
                />
              </span>
            </td>
            <td>
              <span v-if="user.hasGitPassword" data-testid="has-git">yes</span>
              <span v-else class="amber-muted">no</span>
            </td>
            <td>
              <div v-if="!user.isAdmin" class="cap-edit">
                <InputNumber
                  :model-value="draftFor(user)"
                  :input-id="`cap-${user.id}`"
                  :aria-label="`Storage cap in GB for ${user.email}`"
                  :min="0"
                  :min-fraction-digits="0"
                  :max-fraction-digits="2"
                  placeholder="default"
                  size="small"
                  @update:model-value="setDraft(user, $event)"
                />
                <Button
                  label="Save cap"
                  size="small"
                  severity="secondary"
                  :disabled="!capDirty(user) || saving.has(user.id)"
                  @click="saveCap(user)"
                />
              </div>
              <span v-else class="amber-muted">no cap</span>
            </td>
            <td class="users-table__actions">
              <Button
                v-if="user.hasGitPassword"
                label="Revoke git password"
                size="small"
                severity="secondary"
                text
                :disabled="saving.has(user.id)"
                @click="revokeTarget = user"
              />
              <Button
                v-if="user.repoCount > 0 && !user.isAdmin"
                label="Adopt repos"
                size="small"
                severity="secondary"
                text
                :disabled="saving.has(user.id)"
                @click="adoptTarget = user"
              />
            </td>
          </tr>
          <tr class="users-table__perms">
            <td colspan="7">
              <p v-if="user.isAdmin" class="amber-note">
                The admin holds every permission, and this row cannot be changed.
              </p>
              <ul class="perm-grid">
                <li v-for="permission in PERMISSIONS" :key="permission.key" class="perm">
                  <ToggleSwitch
                    :model-value="permissionOn(user, permission.key)"
                    :input-id="`perm-${user.id}-${permission.key}`"
                    :disabled="user.isAdmin || saving.has(user.id)"
                    @update:model-value="togglePermission(user, permission.key, $event)"
                  />
                  <label :for="`perm-${user.id}-${permission.key}`">
                    <span class="perm__label">{{ permission.label }}</span>
                    <span class="perm__desc">{{ permission.description }}</span>
                  </label>
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :visible="revokeTarget !== null"
      title="Revoke this git password?"
      :message="`${revokeTarget?.email ?? 'This user'} will not be able to clone over git until they create a new password.`"
      confirm-label="Revoke"
      danger
      :busy="revokeTarget !== null && saving.has(revokeTarget.id)"
      @update:visible="revokeTarget = null"
      @confirm="confirmRevoke"
    />

    <ConfirmDialog
      :visible="adoptTarget !== null"
      title="Adopt this user's repositories?"
      :message="`You will become the owner of all ${adoptTarget?.repoCount ?? 0} repositories ${adoptTarget?.email ?? 'this user'} owns, and each one's account override is cleared. They are set to fetch anonymously, so your own accounts are never used on paths someone else chose; turn that off per repository once you have checked it. Their backups stay and keep syncing.`"
      confirm-label="Adopt"
      :busy="adoptTarget !== null && saving.has(adoptTarget.id)"
      @update:visible="adoptTarget = null"
      @confirm="confirmAdopt"
    />
  </section>
</template>

<style scoped>
.policy {
  margin-bottom: 1.25rem;
  max-width: 60rem;
}

.policy__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.policy__head h2 {
  margin: 0;
  font-size: 1rem;
}

.policy p {
  margin: 0.5rem 0 0;
  line-height: 1.5;
}

.policy__actions {
  margin-top: 0.75rem;
}

.policy__link {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.88rem;
}

.policy__warn {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  background: var(--amber-warn-bg);
  color: var(--amber-warn);
  font-size: 0.86rem;
}

.policy__vars {
  margin: 0.5rem 0;
  padding-left: 1.2rem;
  font-size: 0.82rem;
  line-height: 1.7;
}

.users-wrap {
  overflow-x: auto;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.users-table th {
  text-align: left;
  font-weight: 550;
  color: var(--p-text-muted-color);
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}

.users-table td {
  padding: 0.5rem 0.6rem;
  vertical-align: middle;
}

.users-table tbody {
  border-bottom: 1px solid var(--p-content-border-color);
}

.users-table__actions {
  text-align: right;
  white-space: nowrap;
}

.users-table__main--removed .user-id__email {
  text-decoration: line-through;
  opacity: 0.7;
}

.user-id {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.user-id__tags {
  display: inline-flex;
  gap: 0.3rem;
}

.storage {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}

.cap-edit {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.cap-edit :deep(input) {
  width: 6rem;
}

.perm-grid {
  list-style: none;
  margin: 0 0 0.4rem;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.6rem 1.25rem;
}

.perm {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
}

.perm label {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  cursor: pointer;
}

.perm__label {
  font-weight: 550;
}

.perm__desc {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
  line-height: 1.4;
}
</style>
