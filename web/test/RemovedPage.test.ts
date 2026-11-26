import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
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

// The real drawer is a large async component; what matters here is which repo
// it was opened on.
vi.mock("../src/components/RepoDetailDrawer.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: { repo: { type: Object, required: true } },
    setup(props) {
      return () => h("div", { class: "drawer-stub" }, (props.repo as { path: string }).path);
    },
  }),
}));

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
    const upstream = rows[0]?.find(".removed-actions a");
    expect(upstream?.attributes("href")).toBe("https://github.com/acme/taken-down");
    expect(upstream?.attributes("rel")).toContain("noopener");
  });

  it("names a GitHub DMCA takedown and links the notice", async () => {
    const takenDown = makeRepo({
      id: 6,
      path: "realdody/Leonida",
      goneAt: 1_700_000_600_000,
      lastErrorKind: "auth",
      lastOutcome: "error",
      lastError:
        "git fetch failed (128): remote: Repository unavailable due to DMCA takedown.\n" +
        "remote: See the takedown notice for more details:\n" +
        "remote:   https://github.com/github/dmca/blob/master/2026/11/2026-11-24-take-two.md.\n" +
        "fatal: unable to access 'https://github.com/realdody/Leonida.git/': The requested URL returned error: 403",
    });
    const { wrapper } = await mountPage(buildApi([takenDown, ...GONE]));
    const rows = wrapper.findAll("tbody tr");

    expect(rows[0]?.text()).toContain("DMCA takedown");
    expect(rows[0]?.text()).not.toContain("not found");
    const notice = rows[0]?.find("a.removed-notice");
    expect(notice?.attributes("href")).toBe(
      "https://github.com/github/dmca/blob/master/2026/11/2026-11-24-take-two.md",
    );
    expect(notice?.attributes("rel")).toContain("noopener");
    // The others keep what the forge said about them.
    expect(rows[1]?.text()).not.toContain("DMCA");
    expect(rows[1]?.find("a.removed-notice").exists()).toBe(false);
  });

  it("does not read a takedown into the same words from another forge", async () => {
    const elsewhere = makeForge({ id: 2, host: "git.example", kind: "generic" });
    const repo = makeRepo({
      id: 7,
      forgeId: 2,
      path: "a/b",
      goneAt: 1_700_000_600_000,
      lastErrorKind: "auth",
      lastOutcome: "error",
      lastError: "remote: Repository unavailable due to DMCA takedown.",
    });
    const api = buildApi([repo], { listForges: vi.fn().mockResolvedValue([GITHUB, elsewhere]) });
    const { wrapper } = await mountPage(api);

    expect(wrapper.find("tbody tr").text()).toContain("not found or private");
    expect(wrapper.find("tbody tr").text()).not.toContain("DMCA");
  });

  it("shows when each one was last checked", async () => {
    const { wrapper } = await mountPage();
    const headers = wrapper.findAll("thead th").map((th) => th.text());
    expect(headers).toContain("Last checked");
    expect(wrapper.find("tbody tr td.removed-checked").attributes("title")).toBeTruthy();
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

describe("Removed list, owner account", () => {
  const gone = (extra: Record<string, unknown>) =>
    makeRepo({
      id: 9,
      path: "rowanbyte3329/stardew-valley-mod-manager",
      goneAt: 1_700_000_600_000,
      lastErrorKind: "not_found",
      lastOutcome: "error",
      ...extra,
    });

  it("says the account was removed when the owner 404s too, and explains it", async () => {
    const { wrapper } = await mountPage(buildApi([gone({ ownerGone: true })]));

    const tag = wrapper.find("tbody tr .p-tag");
    expect(tag.text()).toBe("account removed");
    expect(tag.attributes("title")).toContain("github.com/rowanbyte3329");
    expect(tag.attributes("title")).toContain("deleted or suspended");
    expect(wrapper.find("tbody tr").text()).not.toContain("not found");
    expect(wrapper.find(".removed-actions a").attributes("href")).toBe(
      "https://github.com/rowanbyte3329/stardew-valley-mod-manager",
    );
  });

  it("lets the forge's own DMCA statement win over the owner being gone", async () => {
    const takenDown = gone({
      ownerGone: true,
      lastErrorKind: "auth",
      lastError:
        "remote: Repository unavailable due to DMCA takedown.\n" +
        "remote:   https://github.com/github/dmca/blob/master/2026/11/x.md.",
    });
    const { wrapper } = await mountPage(buildApi([takenDown]));

    expect(wrapper.find("tbody tr .p-tag").text()).toBe("DMCA takedown");
  });

  it.each([null, false])("keeps the usual tag when ownerGone is %s", async (ownerGone) => {
    const { wrapper } = await mountPage(buildApi([gone({ ownerGone })]));

    expect(wrapper.find("tbody tr .p-tag").text()).toBe("not found");
    expect(wrapper.find("tbody tr").text()).not.toContain("account removed");
  });
});

describe("Removed list, fork of", () => {
  const rows = [
    makeRepo({
      id: 1,
      path: "me/tracked",
      goneAt: 2,
      forkParent: "up/tracked",
      forkParentRepoId: 9,
    }),
    makeRepo({ id: 2, path: "me/untracked", goneAt: 1, forkParent: "up/untracked" }),
    makeRepo({ id: 3, path: "me/plain", goneAt: 0, forkParent: null }),
  ];

  it("shows the upstream as a real link after the repository column", async () => {
    const { wrapper } = await mountPage(buildApi(rows));

    expect(wrapper.findAll("thead th")[1]?.text()).toBe("Fork of");
    const links = wrapper.findAll("a.fork-link");
    expect(links.map((link) => link.attributes("href"))).toEqual([
      "https://github.com/up/tracked",
      "https://github.com/up/untracked",
    ]);
    expect(wrapper.findAll("tbody tr")[2]?.find("a.fork-link").exists()).toBe(false);
  });

  it("opens the drawer on a tracked upstream, fetched by id", async () => {
    const getRepo = vi.fn().mockResolvedValue(makeRepo({ id: 9, path: "up/tracked" }));
    const { wrapper } = await mountPage(buildApi(rows, { getRepo }));

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    wrapper.findAll("a.fork-link")[0]?.element.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(getRepo).toHaveBeenCalledWith(9);
    expect(wrapper.findAll(".drawer-stub").map((node) => node.text())).toEqual(["up/tracked"]);
  });

  it("leaves an untracked upstream to the browser and opens nothing", async () => {
    const getRepo = vi.fn();
    const { wrapper } = await mountPage(buildApi(rows, { getRepo }));

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    wrapper.findAll("a.fork-link")[1]?.element.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(false);
    expect(getRepo).not.toHaveBeenCalled();
    expect(wrapper.find(".drawer-stub").exists()).toBe(false);
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
