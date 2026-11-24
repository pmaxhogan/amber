import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RemovedPage from "../src/pages/RemovedPage.vue";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeForge, makeRepo, stubApi } from "./helpers/stubApi.ts";
import { useEventsStore } from "../src/stores/events.ts";

const pushLib = vi.hoisted(() => ({
  readPushState: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));
vi.mock("../src/lib/push.ts", () => pushLib);

const GITHUB = makeForge({ id: 1, host: "github.com", kind: "github" });

const GONE = [
  makeRepo({
    id: 4,
    path: "acme/taken-down",
    goneAt: 1_700_000_500_000,
    lastErrorKind: "not_found",
    lastOutcome: "error",
  }),
  makeRepo({
    id: 5,
    path: "acme/went-private",
    goneAt: 1_700_000_400_000,
    lastErrorKind: "auth",
    lastOutcome: "error",
  }),
];

function buildApi(rows = GONE, overrides: Record<string, unknown> = {}) {
  return stubApi({
    listForges: vi.fn().mockResolvedValue([GITHUB]),
    listRepos: vi.fn().mockResolvedValue({ rows, total: rows.length, page: 1, perPage: 200 }),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi(), state = "off") {
  pushLib.readPushState.mockResolvedValue(state);
  const wrapper = mount(RemovedPage, { global: mountGlobals({ api }) });
  await flush();
  return { wrapper, api };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Removed list", () => {
  it("asks for gone repositories, newest first", async () => {
    const { api } = await mountPage();
    expect(api.listRepos).toHaveBeenCalledWith({
      gone: true,
      sort: "gone_at",
      dir: "desc",
      perPage: 200,
    });
  });

  it("lists each one with its host, what the forge said and an upstream link", async () => {
    const { wrapper } = await mountPage();
    const rows = wrapper.findAll("tbody tr");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain("acme/taken-down");
    expect(rows[0]?.text()).toContain("github.com");
    expect(rows[0]?.text()).toContain("not found");
    expect(rows[1]?.text()).toContain("not found or private");
    expect(rows[0]?.find("a").attributes("href")).toBe("https://github.com/acme/taken-down");
    expect(rows[0]?.find("a").attributes("rel")).toContain("noopener");
  });

  it("says so when nothing has been removed", async () => {
    const { wrapper } = await mountPage(buildApi([]));
    expect(wrapper.text()).toContain("Nothing has been removed");
    expect(wrapper.find("table").exists()).toBe(false);
  });

  it("says when the list is longer than the page", async () => {
    const api = buildApi(GONE, {
      listRepos: vi.fn().mockResolvedValue({ rows: GONE, total: 450, page: 1, perPage: 200 }),
    });
    const { wrapper } = await mountPage(api);
    expect(wrapper.text()).toContain("Showing the 2 most recent of 450");
  });

  it("shows the error state when the list cannot be loaded", async () => {
    const api = buildApi(GONE, { listRepos: vi.fn().mockRejectedValue(new Error("boom")) });
    const { wrapper } = await mountPage(api);
    expect(wrapper.text()).toContain("Could not load removed repositories");
  });
});

describe("Removed list, live", () => {
  const frame = (type: string, payload: Record<string, unknown>) =>
    ({ type, at: 1_700_000_000_000, payload }) as never;

  it("reloads quietly when a repository goes gone, comes back or is deleted", async () => {
    const { api } = await mountPage();
    const events = useEventsStore();
    expect(api.listRepos).toHaveBeenCalledTimes(1);

    events.dispatch(frame("repo.gone", { repoId: 9 }));
    await flush();
    expect(api.listRepos).toHaveBeenCalledTimes(2);

    // A listed repo that finishes a sync may have come back.
    events.dispatch(frame("sync.finished", { repoId: 4, outcome: "success" }));
    await flush();
    expect(api.listRepos).toHaveBeenCalledTimes(3);

    events.dispatch(frame("repo.deleted", { repoId: 5 }));
    await flush();
    expect(api.listRepos).toHaveBeenCalledTimes(4);
  });

  it("ignores events about repositories that are not on the list", async () => {
    const { api } = await mountPage();
    const events = useEventsStore();

    events.dispatch(frame("sync.finished", { repoId: 999, outcome: "success" }));
    events.dispatch(frame("sync.started", { repoId: 4 }));
    await flush();

    expect(api.listRepos).toHaveBeenCalledTimes(1);
  });

  it("stops listening once it is unmounted", async () => {
    const { wrapper, api } = await mountPage();
    const events = useEventsStore();
    wrapper.unmount();

    events.dispatch(frame("repo.gone", { repoId: 9 }));
    await flush();

    expect(api.listRepos).toHaveBeenCalledTimes(1);
  });

  it("opens the detail drawer for a repository, which is where its backup is exported", async () => {
    const { wrapper } = await mountPage();
    await wrapper.find("button.removed-name").trigger("click");
    await flush();
    expect(wrapper.find("button.removed-name").text()).toBe("acme/taken-down");
  });
});

describe("Removed notifications", () => {
  it("says so when a test reaches no device", async () => {
    const api = buildApi(GONE, { testPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }) });
    const { wrapper } = await mountPage(api, "on");
    await clickButton(wrapper, "Send a test");
    await flush();
    expect(api.testPush).toHaveBeenCalledTimes(1);

    const rejecting = buildApi(GONE, { testPush: vi.fn().mockRejectedValue(new Error("down")) });
    const second = await mountPage(rejecting, "on");
    await clickButton(second.wrapper, "Send a test");
    await flush();
    expect(rejecting.testPush).toHaveBeenCalledTimes(1);
    expect(findButton(second.wrapper, "Send a test")).toBeDefined();
  });

  it("stays off, without a crash, when turning it on fails or is declined", async () => {
    pushLib.enablePush.mockRejectedValueOnce(new Error("no push service"));
    const { wrapper } = await mountPage();
    await clickButton(wrapper, "Notify this device");
    await flush();
    expect(findButton(wrapper, "Notify this device")).toBeDefined();

    pushLib.enablePush.mockResolvedValueOnce("denied");
    await clickButton(wrapper, "Notify this device");
    await flush();
    expect(wrapper.text()).toContain("Notifications are blocked");
  });

  it("offers to notify this device, and turns it on", async () => {
    pushLib.enablePush.mockResolvedValue("on");
    const { wrapper, api } = await mountPage();
    expect(findButton(wrapper, "Send a test")).toBeUndefined();

    await clickButton(wrapper, "Notify this device");
    await flush();

    expect(pushLib.enablePush).toHaveBeenCalledWith(api);
    expect(findButton(wrapper, "Turn off")).toBeDefined();
    expect(wrapper.text()).toContain("This device gets a notification");
  });

  it("sends a test and turns off again once it is on", async () => {
    pushLib.disablePush.mockResolvedValue("off");
    const { wrapper, api } = await mountPage(buildApi(), "on");

    await clickButton(wrapper, "Send a test");
    await flush();
    expect(api.testPush).toHaveBeenCalledTimes(1);

    await clickButton(wrapper, "Turn off");
    await flush();
    expect(pushLib.disablePush).toHaveBeenCalledWith(api);
    expect(findButton(wrapper, "Notify this device")).toBeDefined();
  });

  it("explains itself instead of offering a button where it cannot work", async () => {
    for (const [state, text] of [
      ["denied", "Notifications are blocked"],
      ["needs_install", "add Amber to the Home Screen"],
      ["unsupported", "cannot receive push notifications"],
    ] as const) {
      const { wrapper } = await mountPage(buildApi(), state);
      expect(wrapper.text(), state).toContain(text);
      expect(findButton(wrapper, "Notify this device"), state).toBeUndefined();
      wrapper.unmount();
    }
  });

  it("still shows the list when the push state cannot be read", async () => {
    pushLib.readPushState.mockRejectedValue(new Error("no service worker"));
    const wrapper = mount(RemovedPage, { global: mountGlobals({ api: buildApi() }) });
    await flush();
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    expect(findButton(wrapper, "Notify this device")).toBeDefined();
  });
});
