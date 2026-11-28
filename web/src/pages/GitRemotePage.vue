<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { GitRemoteMe } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { absoluteTime } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import { useMeStore } from "../stores/me.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CopyField from "../components/CopyField.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import ListSkeleton from "../components/ListSkeleton.vue";

const api = useApi();
const toast = useToaster();
const me = useMeStore();

const config = ref<GitRemoteMe | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref<ApiClientError | null>(null);

/**
 * The one-time password reveal.
 *
 * Deliberately a component-local ref and nothing else: not a store, not
 * session storage, not the URL. Navigating away unmounts this component and
 * the value is gone, which is exactly the promise the copy makes.
 */
const revealedPassword = ref<string | null>(null);

const enabled = computed(() => config.value?.enabled === true);
const hasPassword = computed(() => config.value?.hasPassword === true);
const canSwitch = computed(() => me.can("manage_settings"));

/**
 * The template carries {password} and {slug}. Neither is filled in here: the
 * password is only ever shown in the reveal box, and the slug is per repo.
 */
const cloneTemplate = computed(() => config.value?.cloneUrlTemplate ?? null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    config.value = await api.getGitRemote();
    error.value = null;
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

const rotateVisible = ref(false);
const revokeVisible = ref(false);
const disableVisible = ref(false);

async function confirmRotate(): Promise<void> {
  const wasSet = hasPassword.value;
  busy.value = true;
  try {
    const result = await api.rotateGitRemote();
    const { password, ...state } = result;
    config.value = state;
    revealedPassword.value = password;
    rotateVisible.value = false;
    toast.success(wasSet ? "Password rotated" : "Password created");
  } catch (cause) {
    toast.failure("Could not create the password", cause);
  } finally {
    busy.value = false;
  }
}

function askRotate(): void {
  if (hasPassword.value) {
    rotateVisible.value = true;
  } else {
    void confirmRotate();
  }
}

async function confirmRevoke(): Promise<void> {
  busy.value = true;
  try {
    config.value = await api.revokeGitRemote();
    revealedPassword.value = null;
    revokeVisible.value = false;
    toast.success("Password revoked", "Clones using it have stopped working.");
  } catch (cause) {
    toast.failure("Could not revoke the password", cause);
  } finally {
    busy.value = false;
  }
}

async function switchOn(): Promise<void> {
  busy.value = true;
  try {
    config.value = await api.enableGitRemote();
    toast.success("Git remote turned on");
  } catch (cause) {
    toast.failure("Could not turn the git remote on", cause);
  } finally {
    busy.value = false;
  }
}

async function confirmDisable(): Promise<void> {
  busy.value = true;
  try {
    config.value = await api.disableGitRemote();
    disableVisible.value = false;
    toast.success("Git remote turned off", "Every /git route now returns 404.");
  } catch (cause) {
    toast.failure("Could not turn the git remote off", cause);
  } finally {
    busy.value = false;
  }
}

function dismissReveal(): void {
  revealedPassword.value = null;
}

onMounted(() => void load());
</script>

<template>
  <section>
    <PageHeader
      title="Git Remote"
      description="Amber can serve its backups back out as a read-only git remote, so a backed-up repository can be cloned with plain git."
    />

    <ErrorState :error="error" title="Could not load the git remote settings" @retry="load" />

    <!-- One-time password reveal -->
    <div
      v-if="revealedPassword"
      class="reveal"
      role="alert"
      aria-live="assertive"
      data-testid="password-reveal"
    >
      <div class="reveal__head">
        <AppIcon name="alert" :size="18" />
        <strong>You will not see this password again.</strong>
      </div>
      <p>
        Amber stores only a hash of it. Copy it somewhere safe now. If you lose it, create a new
        password, which stops the old one working.
      </p>
      <CopyField label="Git password" :value="revealedPassword" monospace />
      <Button label="I have saved it" severity="secondary" size="small" @click="dismissReveal" />
    </div>

    <ListSkeleton v-if="loading && config === null" :rows="3" label="Loading the git remote" />

    <div v-else-if="error === null && config" class="amber-stack remote-grid">
      <article class="amber-card">
        <header class="remote-status">
          <h2>Your git credential</h2>
          <Tag
            :value="enabled ? 'remote on' : 'remote off'"
            :severity="enabled ? 'success' : 'secondary'"
            data-testid="remote-state"
          />
        </header>

        <p v-if="!enabled" class="remote-off" data-testid="remote-off">
          The git remote is switched off for the whole Amber, so nothing can be cloned right now.
          You can still manage your password here.
        </p>

        <dl class="remote-facts">
          <div>
            <dt>Username</dt>
            <dd class="mono" data-testid="git-username">{{ config.username ?? "-" }}</dd>
          </div>
          <div>
            <dt>Password</dt>
            <dd>{{ hasPassword ? "set" : "not created yet" }}</dd>
          </div>
          <div>
            <dt>Password last changed</dt>
            <dd>{{ absoluteTime(config.rotatedAt) }}</dd>
          </div>
          <div v-if="cloneTemplate" class="remote-facts__wide">
            <dt>Clone URL template</dt>
            <dd class="mono" data-testid="clone-template">{{ cloneTemplate }}</dd>
          </div>
        </dl>

        <div class="amber-row remote-actions">
          <Button
            :label="hasPassword ? 'Rotate password' : 'Create password'"
            :disabled="busy"
            :severity="hasPassword ? 'secondary' : 'primary'"
            @click="askRotate"
          />
          <Button
            v-if="hasPassword"
            label="Revoke"
            severity="danger"
            outlined
            :disabled="busy"
            @click="revokeVisible = true"
          />
        </div>

        <p class="amber-note">
          Your credential stops working as soon as your access to Amber is removed.
        </p>
      </article>

      <article v-if="canSwitch" class="amber-card">
        <h2>Remote on or off</h2>
        <p class="amber-note">
          This switch is for everyone. When it is off, every
          <span class="mono">/git</span> route returns 404 and nobody can clone.
        </p>
        <div class="amber-row remote-actions">
          <Button
            v-if="!enabled"
            label="Turn the git remote on"
            :disabled="busy"
            @click="switchOn"
          />
          <Button
            v-else
            label="Turn the git remote off"
            severity="danger"
            outlined
            :disabled="busy"
            @click="disableVisible = true"
          />
        </div>
      </article>

      <article class="amber-card">
        <h2>How the access model works</h2>
        <p>
          The rest of amber sits behind Cloudflare Access, which expects a browser and an SSO login.
          Git has neither, so it can never get past that page.
        </p>
        <p>
          The fix is two rules rather than one. A second Cloudflare Access application, scoped to
          the <span class="mono">/git</span> path of the same hostname, carries a Bypass policy.
          Requests to <span class="mono">/git</span> skip SSO entirely and land on amber, which then
          asks for HTTP basic auth itself.
        </p>
        <p>
          So <span class="mono">/git</span> is protected by the username and password on this page,
          not by Cloudflare. Each person has their own, stored only as a hash, and it only reaches
          the repositories that person can see. Failed attempts are throttled per IP.
        </p>
        <p>
          The remote is read-only by construction, not by configuration. Amber never spawns
          <span class="mono">git receive-pack</span> anywhere in its code, so a push is rejected no
          matter what credentials are presented.
        </p>
      </article>
    </div>

    <ConfirmDialog
      v-model:visible="rotateVisible"
      title="Rotate your git password?"
      message="A new password is generated and shown once. Every clone using the old password stops working immediately."
      confirm-label="Rotate and show the new password"
      danger
      :busy="busy"
      @confirm="confirmRotate"
    />

    <ConfirmDialog
      v-model:visible="revokeVisible"
      title="Revoke your git password?"
      message="Your password is deleted and every clone using it stops working. You can create a new one any time."
      confirm-label="Revoke"
      danger
      :busy="busy"
      @confirm="confirmRevoke"
    />

    <ConfirmDialog
      v-model:visible="disableVisible"
      title="Turn the git remote off for everyone?"
      message="Every /git route starts returning 404 and existing clones can no longer fetch. Backups themselves are untouched."
      confirm-label="Turn off"
      danger
      :busy="busy"
      @confirm="confirmDisable"
    />
  </section>
</template>

<style scoped>
.remote-grid {
  max-width: 56rem;
}

.remote-status {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.remote-status h2,
.amber-card h2 {
  margin: 0 0 0.35rem;
  font-size: 1rem;
}

.remote-status h2 {
  margin: 0;
}

.remote-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 1rem 0;
}

.remote-facts__wide {
  grid-column: 1 / -1;
}

.remote-facts dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.remote-facts dd {
  margin: 0.15rem 0 0;
  word-break: break-all;
}

.remote-actions {
  margin-top: 0.5rem;
}

.remote-off {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  background: var(--amber-warn-bg);
  color: var(--amber-warn);
  font-size: 0.86rem;
}

.amber-card p {
  margin: 0 0 0.7rem;
  color: var(--p-text-muted-color);
  line-height: 1.55;
  max-width: 72ch;
}

.reveal {
  border: 2px solid var(--amber-error);
  background: var(--amber-error-bg);
  border-radius: 10px;
  padding: 1rem 1.1rem;
  margin-bottom: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  max-width: 56rem;
}

.reveal__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--amber-error);
}

.reveal p {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
}
</style>
