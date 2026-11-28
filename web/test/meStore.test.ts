import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ApiClientError } from "../src/api/client.ts";
import { ME_REFRESH_DEBOUNCE_MS, useMeStore } from "../src/stores/me.ts";
import { makeMe, makeNobody, makeUser, stubApi } from "./helpers/stubApi.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

function failing(problem: string, status: number) {
  return vi.fn().mockRejectedValue(new ApiClientError(problem, `${problem} message`, status));
}

describe("me store identity", () => {
  it("starts idle, holding nothing", () => {
    const me = useMeStore();
    expect(me.state).toBe("idle");
    expect(me.ready).toBe(false);
    expect(me.can("import")).toBe(false);
    expect(me.isAdmin).toBe(false);
  });

  it("loads identity from /api/me", async () => {
    const me = useMeStore();
    const api = stubApi({ me: vi.fn().mockResolvedValue(makeUser()) });
    await me.load(api);

    expect(me.state).toBe("ready");
    expect(me.email).toBe("friend@example.com");
    expect(me.userId).toBe(2);
    expect(me.isAdmin).toBe(false);
  });

  it("coalesces concurrent loads into one request", async () => {
    const me = useMeStore();
    const api = stubApi();
    await Promise.all([me.load(api), me.load(api)]);
    expect(api.me).toHaveBeenCalledTimes(1);
  });
});

describe("me store permissions", () => {
  it("gives the admin every permission", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: vi.fn().mockResolvedValue(makeMe()) }));
    expect(me.can("manage_settings")).toBe(true);
    expect(me.meets("admin")).toBe(true);
  });

  it("reads a user's own permission set, with the new-user defaults", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: vi.fn().mockResolvedValue(makeUser()) }));
    expect(me.can("import")).toBe(true);
    expect(me.can("browse")).toBe(true);
    expect(me.can("view_removed")).toBe(false);
    expect(me.can("manage_settings")).toBe(false);
    expect(me.meets("admin")).toBe(false);
  });

  it("treats a list requirement as any-of", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: vi.fn().mockResolvedValue(makeUser()) }));
    expect(me.meets(["import_private", "manage_forges"])).toBe(false);
    me.setMe(makeUser({ manage_forges: true }));
    expect(me.meets(["import_private", "manage_forges"])).toBe(true);
    expect(me.meets(undefined)).toBe(true);
  });

  it("gives a user with nothing no permission at all", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: vi.fn().mockResolvedValue(makeNobody()) }));
    expect(me.can("import")).toBe(false);
    expect(me.can("git")).toBe(false);
  });
});

describe("me store refusal states", () => {
  it("maps 403 not_a_user and clears identity", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: failing("not_a_user", 403) }));
    expect(me.state).toBe("not_a_user");
    expect(me.ready).toBe(false);
  });

  it("maps 503 policy_unavailable", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: failing("policy_unavailable", 503) }));
    expect(me.state).toBe("policy_unavailable");
  });

  it("falls back to a generic error for anything else", async () => {
    const me = useMeStore();
    await me.load(stubApi({ me: failing("http_500", 500) }));
    expect(me.state).toBe("error");
    expect(me.error?.message).toBe("http_500 message");
  });

  it("recovers on retry", async () => {
    const me = useMeStore();
    const answers = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("policy_unavailable", "later", 503))
      .mockResolvedValueOnce(makeUser());
    const api = stubApi({ me: answers });
    await me.load(api);
    expect(me.state).toBe("policy_unavailable");
    await me.load(api);
    expect(me.state).toBe("ready");
  });

  it("keeps a known identity through a failed background refresh", async () => {
    const me = useMeStore();
    const answers = vi
      .fn()
      .mockResolvedValueOnce(makeUser())
      .mockRejectedValueOnce(new ApiClientError("http_500", "boom", 500));
    await me.load(stubApi({ me: answers }));
    await me.refresh();
    expect(me.state).toBe("ready");
    expect(me.email).toBe("friend@example.com");
  });

  it("drops to the refusal screen when a refresh finds the user removed", async () => {
    const me = useMeStore();
    const answers = vi
      .fn()
      .mockResolvedValueOnce(makeUser())
      .mockRejectedValueOnce(new ApiClientError("not_a_user", "no", 403));
    await me.load(stubApi({ me: answers }));
    await me.refresh();
    expect(me.state).toBe("not_a_user");
  });
});

describe("me store refresh and cap", () => {
  it("reports over cap for a user and never for the admin", () => {
    const me = useMeStore();
    me.setMe({ ...makeUser(), storage: { usedBytes: 10, capBytes: 10, overCap: true } });
    expect(me.overCap).toBe(true);
    me.setMe({ ...makeMe(), storage: { usedBytes: 10, capBytes: null, overCap: true } });
    expect(me.overCap).toBe(false);
  });

  it("debounces scheduled refreshes into one request", async () => {
    vi.useFakeTimers();
    const me = useMeStore();
    const api = stubApi({ me: vi.fn().mockResolvedValue(makeUser()) });
    await me.load(api);
    (api.me as ReturnType<typeof vi.fn>).mockClear();

    me.scheduleRefresh();
    me.scheduleRefresh();
    me.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(ME_REFRESH_DEBOUNCE_MS + 10);

    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it("can cancel a scheduled refresh", async () => {
    vi.useFakeTimers();
    const me = useMeStore();
    const api = stubApi();
    await me.load(api);
    (api.me as ReturnType<typeof vi.fn>).mockClear();

    me.scheduleRefresh();
    me.cancelScheduledRefresh();
    await vi.advanceTimersByTimeAsync(ME_REFRESH_DEBOUNCE_MS * 2);

    expect(api.me).not.toHaveBeenCalled();
  });

  it("keeps the policy copy in step for the admin only", () => {
    const me = useMeStore();
    me.setMe(makeMe());
    const next = { configured: true, fetchedAt: 5, stale: true, editUrl: null, lastError: "x" };
    me.setPolicy(next);
    expect(me.policy).toEqual(next);

    me.setMe(makeUser());
    me.setPolicy(next);
    expect(me.policy).toBeNull();
  });
});
