import { describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import DataTable from "primevue/datatable";
import { createMemoryHistory, createRouter } from "vue-router";
import ReposPage from "../src/pages/ReposPage.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeAccount, makeAccountSync, makeForge, makeRepo, stubApi } from "./helpers/stubApi.ts";
import type { RepoRow } from "../src/api/types.ts";
import type { AmberEvent } from "@amber/shared";
import { useEventsStore } from "../src/stores/events.ts";

const ROWS: RepoRow[] = [
  makeRepo({ id: 1, displayName: "node", path: "nodejs/node" }),
  makeRepo({ id: 2, displayName: "core", path: "vuejs/core", state: "paused" }),
];

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listRepos: vi.fn().mockResolvedValue({ rows: ROWS, total: 57, page: 1, perPage: 25 }),
    listForges: vi.fn().mockResolvedValue([makeForge()]),
    listAccounts: vi.fn().mockResolvedValue([makeAccount({ username: "pmaxhogan" })]),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi()) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(ReposPage, { global: mountGlobals({ api, router }) });
  await flush();
  return { wrapper, api };
}

function table(wrapper: VueWrapper) {
  return wrapper.findComponent(DataTable);
}

describe("Repos page lazy loading", () => {
  it("asks the server for the first page on mount and reports the total", async () => {
    const { wrapper, api } = await mountPage();

    expect(api.listRepos).toHaveBeenCalledTimes(1);
    const [query] = (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [Record<string, unknown>];
    expect(query).toMatchObject({ page: 1, perPage: 25, sort: "display_name", dir: "asc" });
    expect(table(wrapper).props("totalRecords")).toBe(57);
    expect(table(wrapper).props("lazy")).toBe(true);
  });

  it("refetches with the new page rather than slicing locally", async () => {
    const { wrapper, api } = await mountPage();

    await table(wrapper).vm.$emit("page", { page: 2, rows: 50 });
    await flush();

    expect(api.listRepos).toHaveBeenCalledTimes(2);
    const [query] = (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[1] as [Record<string, unknown>];
    expect(query).toMatchObject({ page: 3, perPage: 50 });
  });

  it("sends the snake_case sort field the API expects, not the camelCase row key", async () => {
    const { wrapper, api } = await mountPage();

    await table(wrapper).vm.$emit("sort", { sortField: "disk_usage_bytes", sortOrder: -1 });
    await flush();

    const [query] = (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[1] as [Record<string, unknown>];
    expect(query).toMatchObject({ sort: "disk_usage_bytes", dir: "desc", page: 1 });
  });

  it("passes the filters through to the query", async () => {
    const { wrapper, api } = await mountPage();

    const input = wrapper.find("#repo-search");
    await input.setValue("node");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush();

    const calls = (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const last = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(last.q).toBe("node");
  });
});

describe("Repos page selection and bulk actions", () => {
  it("hides the bulk bar until something is selected", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.find('[aria-label="Bulk actions"]').exists()).toBe(false);
  });

  it("labels where each repo came from: manual import, owned sync, or starred sync", async () => {
    const api = buildApi({
      listRepos: vi.fn().mockResolvedValue({
        rows: [
          makeRepo({ id: 1, origin: "manual", managedByAccountSyncId: null }),
          makeRepo({ id: 2, origin: "account_sync", managedByAccountSyncId: 1 }),
          makeRepo({ id: 3, origin: "account_sync", managedByAccountSyncId: 2 }),
          // The managing sync was deleted: degrade to the generic label.
          makeRepo({ id: 4, origin: "account_sync", managedByAccountSyncId: null }),
        ],
        total: 4,
        page: 1,
        perPage: 25,
      }),
      listAccountSyncs: vi
        .fn()
        .mockResolvedValue([
          makeAccountSync({ id: 1, source: "owned" }),
          makeAccountSync({ id: 2, source: "starred" }),
        ]),
    });
    const { wrapper } = await mountPage(api);

    const cells = wrapper
      .findAll("td")
      .map((cell) => cell.text())
      .filter((text) => ["Manual", "Account", "Starred"].includes(text));
    expect(cells).toEqual(["Manual", "Account", "Starred", "Account"]);
  });

  it("shows the bulk bar with a count once rows are selected", async () => {
    const { wrapper } = await mountPage();

    await table(wrapper).vm.$emit("update:selection", [ROWS[0]]);
    await flush();

    const bar = wrapper.find('[aria-label="Bulk actions"]');
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain("1 repository selected");
  });

  it("sends the selected ids to the bulk endpoint", async () => {
    const { wrapper, api } = await mountPage();
    await table(wrapper).vm.$emit("update:selection", [ROWS[0], ROWS[1]]);
    await flush();

    await clickButton(wrapper, "Pause");
    await flush();

    expect(api.bulkRepos).toHaveBeenCalledWith([1, 2], "pause", false);
  });

  it("offers select-all-across-pages only when the page does not cover the total", async () => {
    const { wrapper } = await mountPage();

    await table(wrapper).vm.$emit("update:selection", [ROWS[0]]);
    await flush();
    expect(findButton(wrapper, "Select all 57 matching")).toBeUndefined();

    await table(wrapper).vm.$emit("update:selection", [ROWS[0], ROWS[1]]);
    await flush();
    expect(findButton(wrapper, "Select all 57 matching")).toBeDefined();
  });

  it("expands select-all into real ids before acting, since bulk takes ids", async () => {
    const api = buildApi();
    const listRepos = api.listRepos as unknown as {
      mockResolvedValueOnce: (value: unknown) => void;
    };
    const { wrapper } = await mountPage(api);

    await table(wrapper).vm.$emit("update:selection", [ROWS[0], ROWS[1]]);
    await flush();
    // The expansion pass reads full pages until the reported total is covered.
    listRepos.mockResolvedValueOnce({
      rows: [makeRepo({ id: 7 }), makeRepo({ id: 8 })],
      total: 2,
      page: 1,
      perPage: 200,
    });

    await clickButton(wrapper, "Select all 57 matching");
    await flush();
    await clickButton(wrapper, "Sync now");
    await flush();

    expect(api.bulkRepos).toHaveBeenCalledWith([7, 8], "sync", false);
  });

  it("clears the selection after a bulk action lands", async () => {
    const { wrapper } = await mountPage();
    await table(wrapper).vm.$emit("update:selection", [ROWS[0]]);
    await flush();

    await clickButton(wrapper, "Resume");
    await flush();

    expect(wrapper.find('[aria-label="Bulk actions"]').exists()).toBe(false);
  });

  it("routes delete through a confirmation rather than acting immediately", async () => {
    const { wrapper, api } = await mountPage();
    await table(wrapper).vm.$emit("update:selection", [ROWS[0]]);
    await flush();

    await clickButton(wrapper, "Delete");
    await flush();

    expect(api.bulkRepos).not.toHaveBeenCalled();
    const confirm = wrapper
      .findAllComponents(ConfirmDialog)
      .find((dialog) => dialog.props("visible") === true);
    expect(confirm?.props("title")).toBe("Remove the selected repositories?");
    expect(confirm?.props("danger")).toBe(true);
  });

  it("runs the delete once the confirmation is accepted", async () => {
    const { wrapper, api } = await mountPage();
    await table(wrapper).vm.$emit("update:selection", [ROWS[0]]);
    await flush();
    await clickButton(wrapper, "Delete");
    await flush();

    const confirm = wrapper
      .findAllComponents(ConfirmDialog)
      .find((dialog) => dialog.props("visible") === true);
    await confirm?.vm.$emit("confirm");
    await flush();

    expect(api.bulkRepos).toHaveBeenCalledWith([1], "delete", false);
  });
});

describe("Repos page states", () => {
  it("offers the import CTA when nothing has been imported yet", async () => {
    const api = buildApi({
      listRepos: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, perPage: 25 }),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("No repositories yet");
    expect(findButton(wrapper, "Import your first repository")).toBeDefined();
  });

  it("shows a retryable error state when the list request fails", async () => {
    const api = buildApi({
      listRepos: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("Could not load the repository list");
    expect(findButton(wrapper, "Try again")).toBeDefined();
  });
});

describe("Repos page live updates", () => {
  function frame(type: string, payload: Record<string, unknown>): AmberEvent {
    return { type, at: 1_700_000_000_000, payload } as AmberEvent;
  }

  const settleRefresh = () => new Promise((resolve) => setTimeout(resolve, 450));

  function listCalls(api: ReturnType<typeof buildApi>): number {
    return (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
  }

  it("marks a row syncing without refetching anything", async () => {
    const { wrapper, api } = await mountPage();
    const events = useEventsStore();

    events.dispatch(frame("sync.started", { repoId: 1 }));
    await flush();

    expect(wrapper.find(".repo-status--syncing").exists()).toBe(true);
    expect(api.getRepo).not.toHaveBeenCalled();
  });

  it("patches the finished row in place rather than reloading the page", async () => {
    const api = buildApi({
      getRepo: vi.fn().mockResolvedValue(makeRepo({ id: 1, displayName: "node", state: "paused" })),
    });
    const { wrapper } = await mountPage(api);
    const events = useEventsStore();
    const before = listCalls(api);

    events.dispatch(frame("sync.finished", { repoId: 1 }));
    await settleRefresh();
    await flush();

    expect(api.getRepo).toHaveBeenCalledWith(1);
    // The whole point: no refetch storm behind a row-level change.
    expect(listCalls(api)).toBe(before);
    expect(wrapper.find(".repo-status--syncing").exists()).toBe(false);
  });

  it("coalesces a burst of events into one refetch per row", async () => {
    const api = buildApi({ getRepo: vi.fn().mockResolvedValue(makeRepo({ id: 1 })) });
    await mountPage(api);
    const events = useEventsStore();

    for (let i = 0; i < 5; i += 1) events.dispatch(frame("sync.finished", { repoId: 1 }));
    await settleRefresh();
    await flush();

    expect(api.getRepo).toHaveBeenCalledTimes(1);
  });

  it("ignores an event for a repository that is not on this page", async () => {
    const { api } = await mountPage();
    const events = useEventsStore();

    events.dispatch(frame("sync.finished", { repoId: 999 }));
    await settleRefresh();
    await flush();

    expect(api.getRepo).not.toHaveBeenCalled();
  });

  it("offers a refresh rather than guessing when the list gains or loses a row", async () => {
    const { wrapper, api } = await mountPage();
    const events = useEventsStore();

    events.dispatch(frame("repo.created", {}));
    events.dispatch(frame("repo.deleted", { repoId: 2 }));
    await flush();

    expect(wrapper.find(".repos-stale").text()).toContain("2 changes");
    expect(api.getRepo).not.toHaveBeenCalled();

    await clickButton(wrapper, "Refresh");
    await flush();
    expect(wrapper.find(".repos-stale").exists()).toBe(false);
  });

  it("stops listening once unmounted, so revisiting the route cannot double up", async () => {
    // A leaked subscription keeps the rows it captured alive, turning a single
    // event into one refetch per past visit to this route.
    const api = buildApi({ getRepo: vi.fn().mockResolvedValue(makeRepo({ id: 1 })) });
    const { wrapper } = await mountPage(api);
    const events = useEventsStore();

    wrapper.unmount();
    events.dispatch(frame("sync.finished", { repoId: 1 }));
    await settleRefresh();
    await flush();

    expect(api.getRepo).not.toHaveBeenCalled();
  });
});
