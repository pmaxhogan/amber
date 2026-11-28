import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Me, PermissionKey, PolicyStatus, StorageUsage } from "@amber/shared";
import { normalizeError, type ApiClient, type ApiClientError } from "../api/client.ts";

/** How long to coalesce event-driven refreshes of the caller's identity. */
export const ME_REFRESH_DEBOUNCE_MS = 2_000;

/**
 * - `idle`: nothing asked yet.
 * - `loading`: the first read is in flight.
 * - `ready`: `me` is set.
 * - `not_a_user`: a valid sign-in that Amber does not admit (403).
 * - `policy_unavailable`: Amber cannot confirm access right now (503).
 * - `error`: anything else (transport, a malformed answer).
 */
export type MeState = "idle" | "loading" | "ready" | "not_a_user" | "policy_unavailable" | "error";

/** What a route or control may require. */
export type Requirement = PermissionKey | "admin";

/**
 * Who the caller is and what they may do. The API enforces every rule
 * regardless; this store only decides what the UI shows, so a missing
 * permission here hides a control and never grants anything.
 */
export const useMeStore = defineStore("me", () => {
  const me = ref<Me | null>(null);
  const state = ref<MeState>("idle");
  const error = ref<ApiClientError | null>(null);
  let client: ApiClient | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;

  const ready = computed(() => state.value === "ready" && me.value !== null);
  const isAdmin = computed(() => me.value?.isAdmin === true);
  const email = computed(() => me.value?.email ?? "");
  const userId = computed(() => me.value?.id ?? null);
  const storage = computed<StorageUsage | null>(() => me.value?.storage ?? null);
  const policy = computed<PolicyStatus | null>(() => me.value?.policy ?? null);
  /** The persistent banner: a non-admin at or over their storage cap. */
  const overCap = computed(() => !isAdmin.value && me.value?.storage.overCap === true);

  /** True when the caller holds `key`. The admin holds everything. */
  function can(key: PermissionKey): boolean {
    if (me.value === null) return false;
    return me.value.isAdmin || me.value.permissions[key] === true;
  }

  /** True when the caller satisfies a route or control requirement. */
  function meets(requirement: Requirement | readonly Requirement[] | undefined): boolean {
    if (requirement === undefined) return true;
    const list = typeof requirement === "string" ? [requirement] : requirement;
    // A list means "any of": Accounts, for one, needs import_private OR manage_forges.
    return list.some((entry) => (entry === "admin" ? isAdmin.value : can(entry)));
  }

  function setMe(next: Me): void {
    me.value = next;
    state.value = "ready";
    error.value = null;
  }

  /** The Users page re-reads the policy; keep the shared copy in step. */
  function setPolicy(next: PolicyStatus): void {
    if (me.value !== null && me.value.isAdmin) me.value = { ...me.value, policy: next };
  }

  function applyFailure(cause: unknown): void {
    const normalized = normalizeError(cause);
    error.value = normalized;
    if (normalized.status === 403 && normalized.problem === "not_a_user") {
      state.value = "not_a_user";
      me.value = null;
    } else if (normalized.status === 503 && normalized.problem === "policy_unavailable") {
      state.value = "policy_unavailable";
      me.value = null;
    } else if (state.value !== "ready") {
      state.value = "error";
    }
    // A failed refresh of an already-known identity keeps what it had: a
    // transient error must not blank the nav out from under the user.
  }

  async function run(): Promise<void> {
    if (client === null) return;
    try {
      setMe(await client.me());
    } catch (cause) {
      applyFailure(cause);
    }
  }

  /** The first read, and the retry button on the error screens. */
  async function load(next?: ApiClient): Promise<void> {
    if (next !== undefined) client = next;
    if (client === null) return;
    if (inflight !== null) return inflight;
    if (state.value !== "ready") state.value = "loading";
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Re-read quietly; the state never drops back to `loading`. */
  async function refresh(): Promise<void> {
    if (client === null) return;
    if (inflight !== null) return inflight;
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Coalesce a burst of events (a sync finishing per repo) into one read. */
  function scheduleRefresh(): void {
    if (debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void refresh();
    }, ME_REFRESH_DEBOUNCE_MS);
  }

  function cancelScheduledRefresh(): void {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  }

  return {
    me,
    state,
    error,
    ready,
    isAdmin,
    email,
    userId,
    storage,
    policy,
    overCap,
    can,
    meets,
    setMe,
    setPolicy,
    load,
    refresh,
    scheduleRefresh,
    cancelScheduledRefresh,
  };
});
