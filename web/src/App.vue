<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import Toast from "primevue/toast";
import logoUrl from "./assets/logo.svg";
import { NAV_LINKS, routeAllowed } from "./router/index.ts";
import AccessScreen from "./components/AccessScreen.vue";
import AppIcon from "./components/AppIcon.vue";
import CapBanner from "./components/CapBanner.vue";
import InsecureBanner from "./components/InsecureBanner.vue";
import StatusPill from "./components/StatusPill.vue";
import ThemeToggle from "./components/ThemeToggle.vue";
import { useApi } from "./api/provide.ts";
import { useEventsStore } from "./stores/events.ts";
import { useMeStore } from "./stores/me.ts";
import { useStatusStore } from "./stores/status.ts";
import { useThemeStore } from "./stores/theme.ts";

const api = useApi();
const status = useStatusStore();
const events = useEventsStore();
const me = useMeStore();
const route = useRoute();
const router = useRouter();

// Instantiating the store applies the persisted color scheme to <html>.
useThemeStore();

let stopPolling: (() => void) | null = null;
// Held explicitly rather than trusting the store's onScopeDispose fallback:
// that only fires inside an active effect scope, and a listener that outlives
// its component turns one event into a duplicated handler per remount.
let offEvents: (() => void) | null = null;
let started = false;
let unmounted = false;

/**
 * Identity first: who the caller is decides whether anything else is worth
 * asking for, so the status poll and the event stream wait for it. A caller
 * who is not admitted never opens either.
 */
async function start(): Promise<void> {
  await me.load(api);
  if (unmounted || !me.ready || started) return;
  started = true;
  void status.load(api);
  events.connect(api.eventsUrl());
  offEvents = events.on((event) => {
    status.applyEvent(event);
    // A finished sync or a removed repository moves storage usage, which is
    // what the cap banner reads.
    if (event.type === "sync.finished" || event.type === "repo.deleted") {
      me.scheduleRefresh();
    }
  });
  // A slow poll covers anything the event stream does not announce, including
  // an admin changing this user's permissions.
  const handle = setInterval(() => {
    void status.load();
    void me.refresh();
  }, 60_000);
  stopPolling = () => clearInterval(handle);
}

onMounted(() => void start());

onBeforeUnmount(() => {
  unmounted = true;
  stopPolling?.();
  offEvents?.();
  me.cancelScheduledRefresh();
  events.disconnect();
});

// The router guard stops in-app navigation to a page the caller cannot use;
// this covers the first load (identity arrives after the route resolved) and a
// permission taken away while the page is open.
watch(
  () => [me.ready, me.me?.permissions, me.me?.isAdmin, route.fullPath] as const,
  () => {
    if (me.ready && !routeAllowed(route, me)) void router.replace("/");
  },
  { deep: true },
);

const links = computed(() => NAV_LINKS.filter((link) => me.meets(link.requires)));
</script>

<template>
  <AccessScreen
    v-if="me.state === 'not_a_user'"
    title="You do not have access to this Amber"
    message="You are signed in, but this Amber does not have you on its list of people. Ask the person who runs it to add you."
    detail="Your sign-in is fine. Nothing here is shown to people who are not on the list."
  />
  <AccessScreen
    v-else-if="me.state === 'policy_unavailable'"
    title="Amber cannot confirm your access right now"
    message="Try again in a few minutes."
    detail="Amber could not read the list of people it admits and does not guess."
    icon="clock"
    retry-label="Try again"
    @retry="start"
  />
  <AccessScreen
    v-else-if="me.state === 'error'"
    title="Amber could not load your account"
    :message="me.error?.message ?? 'The server did not answer.'"
    icon="alert"
    retry-label="Try again"
    @retry="start"
  />
  <div v-else-if="!me.ready" class="amber-boot" role="status" aria-live="polite">
    <span class="amber-muted">Loading</span>
  </div>
  <div v-else class="amber-shell">
    <InsecureBanner v-if="status.insecureMode" />
    <CapBanner />
    <div class="amber-body">
      <aside class="amber-sidebar">
        <RouterLink to="/" class="amber-brand">
          <img :src="logoUrl" alt="" />
          <span>Amber</span>
        </RouterLink>
        <nav class="amber-nav" aria-label="Main">
          <RouterLink v-for="link in links" :key="link.to" :to="link.to">
            <AppIcon :name="link.icon" :size="17" />
            <span>{{ link.label }}</span>
            <span
              v-if="link.to === '/removed' && status.goneRepos > 0"
              class="amber-nav__count"
              :title="`${status.goneRepos} gone upstream`"
              >{{ status.goneRepos }}</span
            >
          </RouterLink>
        </nav>
        <div class="amber-sidebar__footer">
          <StatusPill />
          <ThemeToggle />
        </div>
      </aside>
      <main class="amber-main">
        <RouterView />
      </main>
    </div>
    <Toast position="bottom-right" />
  </div>
</template>

<style scoped>
.amber-boot {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
