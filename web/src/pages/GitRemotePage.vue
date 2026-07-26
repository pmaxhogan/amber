<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Tag from "primevue/tag";
import type { GitRemoteConfig } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { absoluteTime } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CopyField from "../components/CopyField.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const toast = useToaster();

const config = ref<GitRemoteConfig | null>(null);
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

const username = ref("");
const usernameDirty = computed(
  () => username.value.trim() !== "" && username.value.trim() !== config.value?.username,
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    config.value = await api.getGitRemote();
    username.value = config.value.username;
    error.value = null;
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

const enableVisible = ref(false);
const rotateVisible = ref(false);
const disableVisible = ref(false);

async function confirmEnable(): Promise<void> {
  busy.value = true;
  try {
    const result = await api.enableGitRemote();
    config.value = result;
    username.value = result.username;
    revealedPassword.value = result.password;
    enableVisible.value = false;
    toast.success("Read-only git remote enabled");
  } catch (cause) {
    toast.failure("Could not enable the git remote", cause);
  } finally {
    busy.value = false;
  }
}

async function confirmRotate(): Promise<void> {
  busy.value = true;
  try {
    const result = await api.rotateGitRemote();
    config.value = result;
    revealedPassword.value = result.password;
    rotateVisible.value = false;
    toast.success("Password rotated", "Every existing clone credential has stopped working.");
  } catch (cause) {
    toast.failure("Could not rotate the password", cause);
  } finally {
    busy.value = false;
  }
}

async function confirmDisable(): Promise<void> {
  busy.value = true;
  try {
    config.value = await api.disableGitRemote();
    revealedPassword.value = null;
    disableVisible.value = false;
    toast.success("Read-only git remote disabled", "Every /git route now returns 404.");
  } catch (cause) {
    toast.failure("Could not disable the git remote", cause);
  } finally {
    busy.value = false;
  }
}

async function saveUsername(): Promise<void> {
  busy.value = true;
  try {
    config.value = await api.setGitRemoteUsername(username.value.trim());
    toast.success("Username updated");
  } catch (cause) {
    toast.failure("Could not update the username", cause);
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
        <strong>This password will never be shown again.</strong>
      </div>
      <p>
        Amber stores only a scrypt hash of it. Copy it somewhere safe now. If you lose it, the only
        way forward is to rotate, which invalidates every existing clone credential.
      </p>
      <CopyField label="Git remote password" :value="revealedPassword" monospace />
      <Button label="I have saved it" severity="secondary" size="small" @click="dismissReveal" />
    </div>

    <p v-if="loading" class="amber-muted">Loading...</p>

    <div v-else-if="error === null" class="amber-stack remote-grid">
      <article class="amber-card">
        <header class="remote-status">
          <h2>Status</h2>
          <Tag
            :value="enabled ? 'enabled' : 'disabled'"
            :severity="enabled ? 'success' : 'secondary'"
          />
        </header>

        <dl class="remote-facts">
          <div>
            <dt>Username</dt>
            <dd class="mono">{{ config?.username ?? "-" }}</dd>
          </div>
          <div>
            <dt>Password last rotated</dt>
            <dd>{{ absoluteTime(config?.rotatedAt ?? null) }}</dd>
          </div>
          <div class="remote-facts__wide">
            <dt>Clone URL template</dt>
            <dd class="mono">{{ config?.cloneUrlTemplate || "not configured" }}</dd>
          </div>
        </dl>

        <div class="amber-row remote-actions">
          <Button
            v-if="!enabled"
            label="Enable read-only remote"
            :disabled="busy"
            @click="enableVisible = true"
          />
          <template v-else>
            <Button
              label="Rotate password"
              severity="secondary"
              :disabled="busy"
              @click="rotateVisible = true"
            />
            <Button
              label="Disable"
              severity="danger"
              outlined
              :disabled="busy"
              @click="disableVisible = true"
            />
          </template>
        </div>
      </article>

      <article v-if="enabled" class="amber-card">
        <h2>Username</h2>
        <p class="amber-note">
          Git sends this as the basic-auth user. Changing it does not change the password.
        </p>
        <div class="amber-row remote-username">
          <InputText
            v-model="username"
            aria-label="Git remote username"
            autocomplete="off"
            spellcheck="false"
          />
          <Button
            label="Save username"
            size="small"
            :disabled="!usernameDirty || busy"
            @click="saveUsername"
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
          not by Cloudflare. That is the whole reason the password is 32 random characters and is
          stored only as a scrypt hash: it is the only thing standing in front of those routes.
          Failed attempts are throttled per IP.
        </p>
        <p>
          The remote is read-only by construction, not by configuration. Amber never spawns
          <span class="mono">git receive-pack</span> anywhere in its code, so a push is rejected no
          matter what credentials are presented. When the remote is disabled, every
          <span class="mono">/git</span> route returns 404.
        </p>
      </article>
    </div>

    <ConfirmDialog
      v-model:visible="enableVisible"
      title="Enable the read-only git remote?"
      message="Amber will generate a 32 character password and show it exactly once. Anyone with the URL, the username, and that password can clone every backup on this instance."
      confirm-label="Enable and show the password"
      :busy="busy"
      @confirm="confirmEnable"
    />

    <ConfirmDialog
      v-model:visible="rotateVisible"
      title="Rotate the git remote password?"
      message="A new password is generated and shown once. Every clone credential using the old password stops working immediately."
      confirm-label="Rotate and show the new password"
      danger
      :busy="busy"
      @confirm="confirmRotate"
    />

    <ConfirmDialog
      v-model:visible="disableVisible"
      title="Disable the read-only git remote?"
      message="Every /git route starts returning 404. Existing clones can no longer fetch. Backups themselves are untouched."
      confirm-label="Disable"
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

.remote-username {
  margin-top: 0.5rem;
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
