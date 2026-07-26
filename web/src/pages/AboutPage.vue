<script setup lang="ts">
import { computed, onMounted } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import logoUrl from "../assets/logo.svg";
import { useApi } from "../api/provide.ts";
import { useEventsStore } from "../stores/events.ts";
import { useStatusStore } from "../stores/status.ts";
import { humanBytes } from "../lib/format.ts";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const statusStore = useStatusStore();
const events = useEventsStore();

const status = computed(() => statusStore.status);

/** A bare commit SHA is shortened for display; the full value sits in the title. */
const displayVersion = computed(() => {
  const raw = status.value?.version ?? "";
  return /^[0-9a-f]{20,}$/i.test(raw) ? raw.slice(0, 12) : raw;
});

const stats = computed(() => {
  const current = status.value;
  if (current === null) return [];
  return [
    { label: "Repositories", value: String(current.totalRepos) },
    { label: "Backed up on disk", value: humanBytes(current.totalDiskUsageBytes) },
    { label: "Active syncs", value: String(current.activeSyncs) },
    { label: "Queued", value: String(current.queueDepth) },
  ];
});

function reload(): void {
  void statusStore.load(api);
}

onMounted(reload);
</script>

<template>
  <section>
    <PageHeader title="About" description="What this instance is doing right now.">
      <template #actions>
        <Button label="Refresh" size="small" severity="secondary" @click="reload" />
      </template>
    </PageHeader>

    <div class="about-hero amber-card">
      <img :src="logoUrl" alt="" width="64" height="64" />
      <div>
        <h2>Amber - git history, preserved.</h2>
        <p class="amber-muted">
          A self-hosted git backup service. It keeps up-to-date local mirrors of any repository
          reachable over HTTPS, on a schedule, and can serve those mirrors back out as a read-only
          git remote.
        </p>
        <p class="about-hero__links">
          <a href="https://github.com/pmaxhogan/amber" target="_blank" rel="noopener noreferrer">
            github.com/pmaxhogan/amber
          </a>
        </p>
      </div>
    </div>

    <ErrorState
      :error="statusStore.error"
      title="Could not read the instance status"
      @retry="reload"
    />

    <div v-if="status" class="amber-stack about-grid">
      <article class="amber-card">
        <h3>Instance</h3>
        <dl class="about-facts">
          <div>
            <dt>Version</dt>
            <dd class="mono" :title="status.version">{{ displayVersion }}</dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>
              <Tag
                :value="status.insecureMode ? 'disabled' : 'enforced'"
                :severity="status.insecureMode ? 'danger' : 'success'"
              />
            </dd>
          </div>
          <div>
            <dt>Circuit breaker</dt>
            <dd>
              <Tag
                :value="status.breakerOpen ? 'open' : 'closed'"
                :severity="status.breakerOpen ? 'warn' : 'secondary'"
              />
            </dd>
          </div>
          <div>
            <dt>Live updates</dt>
            <dd>{{ events.state }}</dd>
          </div>
        </dl>
        <p v-if="status.breakerOpen" class="amber-note">
          The breaker opens when several syncs across different forges fail with network or timeout
          errors in a row. Amber pauses dequeuing and probes with a single retry rather than
          hammering a network that is down. It never gives up permanently.
        </p>
      </article>

      <article class="amber-card">
        <h3>Right now</h3>
        <div class="about-stats">
          <div v-for="stat in stats" :key="stat.label" class="about-stat">
            <span class="about-stat__value">{{ stat.value }}</span>
            <span class="about-stat__label">{{ stat.label }}</span>
          </div>
        </div>
      </article>
    </div>
    <p v-else-if="statusStore.error === null" class="amber-muted">Reading instance status...</p>
  </section>
</template>

<style scoped>
.about-hero {
  display: flex;
  gap: 1.25rem;
  align-items: flex-start;
  margin-bottom: 1.25rem;
  max-width: 56rem;
}

.about-hero h2 {
  margin: 0 0 0.4rem;
  font-size: 1.15rem;
}

.about-hero p {
  margin: 0;
  line-height: 1.55;
  max-width: 66ch;
}

/* Two classes so this outranks the type selector's margin: 0 above. */
.about-hero .about-hero__links {
  margin-top: 0.5rem;
}

.about-hero__links a {
  color: var(--p-primary-color);
  text-decoration: none;
}

.about-hero__links a:hover {
  text-decoration: underline;
}

.about-grid {
  max-width: 56rem;
}

.amber-card h3 {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.about-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 0;
}

.about-facts dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.about-facts dd {
  margin: 0.2rem 0 0;
  /* Grid cells must contain long values (a full commit SHA), not overflow. */
  min-width: 0;
  overflow-wrap: anywhere;
}

.about-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1rem;
}

.about-stat {
  display: flex;
  flex-direction: column;
}

.about-stat__value {
  font-size: 1.6rem;
  font-weight: 600;
  color: var(--p-primary-color);
}

.about-stat__label {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
</style>
