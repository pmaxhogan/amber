import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Me } from "@amber/shared";
import App from "../src/App.vue";
import { ApiClientError } from "../src/api/client.ts";
import { NAV_LINKS, installAccessGuard, routes } from "../src/router/index.ts";
import { useEventsStore } from "../src/stores/events.ts";
import { ME_REFRESH_DEBOUNCE_MS, useMeStore } from "../src/stores/me.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, flush } from "./helpers/dom.ts";
import { makeMe, makeNobody, makeUser, stubApi } from "./helpers/stubApi.ts";

afterEach(() => {
  vi.useRealTimers();
});

async function mountApp(
  me: Me | null,
  path = "/",
  api = stubApi({ me: vi.fn().mockResolvedValue(me) }),
) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  installAccessGuard(router);
  // The guard reads the store, so the pinia must exist before the first navigation.
  const globals = mountGlobals({ api, router, me: null });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: globals });
  await flush(5);
  return { wrapper, router, api };
}

function navLabels(wrapper: Awaited<ReturnType<typeof mountApp>>["wrapper"]): string[] {
  return wrapper.findAll(".amber-nav a").map((link) => link.text());
}

describe("navigation gating", () => {
  it("shows the admin every page, including Users", async () => {
    const { wrapper } = await mountApp(makeMe());
    expect(navLabels(wrapper)).toEqual(NAV_LINKS.map((link) => link.label));
    expect(navLabels(wrapper)).toContain("Users");
  });

  it("gives a default user Repos, Import, Account Sync, Git Remote and About", async () => {
    const { wrapper } = await mountApp(makeUser());
    expect(navLabels(wrapper)).toEqual(["Repos", "Import", "Account Sync", "Git Remote", "About"]);
  });

  it("gives a user with nothing only Repos and About", async () => {
    const { wrapper } = await mountApp(makeNobody());
    expect(navLabels(wrapper)).toEqual(["Repos", "About"]);
  });

  it("shows Accounts to a user with either import_private or manage_forges", async () => {
    const a = await mountApp(makeUser({ import_private: true }));
    expect(navLabels(a.wrapper)).toContain("Forges & Accounts");
    const b = await mountApp(makeUser({ manage_forges: true }));
    expect(navLabels(b.wrapper)).toContain("Forges & Accounts");
  });

  it("shows Settings and Removed on their own permissions", async () => {
    const { wrapper } = await mountApp(makeUser({ manage_settings: true, view_removed: true }));
    expect(navLabels(wrapper)).toContain("Settings");
    expect(navLabels(wrapper)).toContain("Removed");
    expect(navLabels(wrapper)).not.toContain("Users");
  });
});

describe("route gating", () => {
  it("sends a user without the permission to / when they go to a gated page", async () => {
    const { router, wrapper } = await mountApp(makeUser(), "/");
    for (const path of ["/removed", "/accounts", "/settings", "/users"]) {
      await router.push(path);
      await flush();
      expect(router.currentRoute.value.path).toBe("/");
    }
    expect(wrapper.find(".amber-main h1").text()).toBe("Repos");
  });

  it("lets a permitted user in", async () => {
    const { router } = await mountApp(makeUser(), "/");
    await router.push("/import");
    await flush();
    expect(router.currentRoute.value.path).toBe("/import");
  });

  it("lets the admin reach Users", async () => {
    const { router, wrapper } = await mountApp(makeMe(), "/");
    await router.push("/users");
    await flush(5);
    expect(router.currentRoute.value.path).toBe("/users");
    expect(wrapper.find(".amber-main h1").text()).toBe("Users");
  });

  it("moves a user off a gated page when identity arrives after the route resolved", async () => {
    const { router } = await mountApp(makeNobody(), "/settings");
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("guards a non-admin from Users even with manage_settings", async () => {
    const { router } = await mountApp(makeUser({ manage_settings: true }), "/");
    await router.push("/users");
    await flush();
    expect(router.currentRoute.value.path).toBe("/");
  });
});

describe("full-page refusal states", () => {
  it("shows the no-access screen for 403 not_a_user and nothing else", async () => {
    const api = stubApi({
      me: vi.fn().mockRejectedValue(new ApiClientError("not_a_user", "no", 403)),
    });
    const { wrapper } = await mountApp(null, "/", api);

    expect(wrapper.text()).toContain("You do not have access to this Amber");
    expect(wrapper.find(".amber-nav").exists()).toBe(false);
    expect(wrapper.find(".amber-main").exists()).toBe(false);
    // Nothing else is asked for: no status poll, no event stream.
    expect(api.status).not.toHaveBeenCalled();
    expect(api.eventsUrl).not.toHaveBeenCalled();
  });

  it("shows the try-again-later screen for 503 policy_unavailable, with a retry that recovers", async () => {
    const answers = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("policy_unavailable", "later", 503))
      .mockResolvedValueOnce(makeUser());
    const api = stubApi({ me: answers });
    const { wrapper } = await mountApp(null, "/", api);

    expect(wrapper.text()).toContain("Amber cannot confirm your access right now");
    expect(wrapper.text()).toContain("Try again in a few minutes");
    expect(wrapper.find(".amber-nav").exists()).toBe(false);

    await clickButton(wrapper, "Try again");
    await flush(5);

    expect(wrapper.find(".amber-nav").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("cannot confirm");
  });

  it("shows a generic screen when identity cannot be read at all", async () => {
    const api = stubApi({
      me: vi.fn().mockRejectedValue(new ApiClientError("http_500", "boom", 500)),
    });
    const { wrapper } = await mountApp(null, "/", api);
    expect(wrapper.text()).toContain("Amber could not load your account");
    expect(wrapper.text()).toContain("boom");
  });

  it("loads identity before the status poll and the event stream", async () => {
    const order: string[] = [];
    const api = stubApi({
      me: vi.fn(async () => {
        order.push("me");
        return makeUser();
      }),
      status: vi.fn(async () => {
        order.push("status");
        return { ...(await stubApi().status()) };
      }),
      eventsUrl: vi.fn(() => {
        order.push("events");
        return "/api/events";
      }),
    });
    await mountApp(null, "/", api);
    expect(order.slice(0, 3)).toEqual(["me", "status", "events"]);
  });
});

describe("storage cap banner", () => {
  const OVER = (over: boolean): Me => ({
    ...makeUser(),
    storage: { usedBytes: 5 * 1024 ** 3, capBytes: 5 * 1024 ** 3, overCap: over },
  });

  it("shows a persistent banner for a user at the cap, in human units", async () => {
    const { wrapper } = await mountApp(OVER(true));
    const banner = wrapper.find('[data-testid="cap-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("5.00 GB of 5.00 GB");
    expect(banner.text()).toContain("New imports are refused");
    expect(banner.text()).toContain("keep syncing");
    expect(banner.text()).toContain("twice your limit");
    // Not dismissible: there is no button on it.
    expect(banner.find("button").exists()).toBe(false);
  });

  it("says syncing is paused once the user is at twice the cap", async () => {
    const me: Me = {
      ...makeUser(),
      storage: {
        usedBytes: 10 * 1024 ** 3,
        capBytes: 5 * 1024 ** 3,
        overCap: true,
        atCeiling: true,
      },
    };
    const banner = (await mountApp(me)).wrapper.find('[data-testid="cap-banner"]');
    expect(banner.text()).toContain("syncing is paused");
    expect(banner.text()).not.toContain("keep syncing");
  });

  it("is absent under the cap and for the admin", async () => {
    expect((await mountApp(OVER(false))).wrapper.find('[data-testid="cap-banner"]').exists()).toBe(
      false,
    );
    const admin = makeMe();
    admin.storage = { usedBytes: 9, capBytes: null, overCap: true };
    expect((await mountApp(admin)).wrapper.find('[data-testid="cap-banner"]').exists()).toBe(false);
  });

  it("appears and clears without a reload when a sync finishes", async () => {
    vi.useFakeTimers();
    const answers = vi
      .fn()
      .mockResolvedValueOnce(OVER(false))
      .mockResolvedValueOnce(OVER(true))
      .mockResolvedValueOnce(OVER(false));
    const api = stubApi({ me: answers });
    const router = createRouter({ history: createMemoryHistory(), routes });
    const globals = mountGlobals({ api, router, me: null });
    await router.push("/");
    await router.isReady();
    const wrapper = mount(App, { global: globals });
    await vi.advanceTimersByTimeAsync(50);
    expect(wrapper.find('[data-testid="cap-banner"]').exists()).toBe(false);

    const events = useEventsStore();
    events.dispatch({ type: "sync.finished", at: 1, payload: { repoId: 1, outcome: "success" } });
    events.dispatch({ type: "sync.finished", at: 2, payload: { repoId: 2, outcome: "success" } });
    await vi.advanceTimersByTimeAsync(ME_REFRESH_DEBOUNCE_MS + 50);
    // The burst was coalesced into a single read.
    expect(answers).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="cap-banner"]').exists()).toBe(true);

    events.dispatch({ type: "repo.deleted", at: 3, payload: { repoId: 3 } });
    await vi.advanceTimersByTimeAsync(ME_REFRESH_DEBOUNCE_MS + 50);
    expect(useMeStore().overCap).toBe(false);
    expect(wrapper.find('[data-testid="cap-banner"]').exists()).toBe(false);
  });
});
