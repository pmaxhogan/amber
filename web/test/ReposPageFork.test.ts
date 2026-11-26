import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import DataTable from "primevue/datatable";
import { defineComponent, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import ReposPage from "../src/pages/ReposPage.vue";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { flush } from "./helpers/dom.ts";
import { makeAccount, makeForge, makeRepo, stubApi } from "./helpers/stubApi.ts";
import type { RepoRow } from "../src/api/types.ts";

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

const ROWS: RepoRow[] = [
  makeRepo({ id: 1, displayName: "linux", path: "me/linux", forkParent: "torvalds/linux" }),
  makeRepo({
    id: 2,
    displayName: "tracked",
    path: "me/tracked",
    forkParent: "up/tracked",
    forkParentRepoId: 9,
  }),
  makeRepo({ id: 3, displayName: "plain", path: "me/plain", forkParent: null }),
];

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listRepos: vi.fn().mockResolvedValue({ rows: ROWS, total: 3, page: 1, perPage: 25 }),
    listForges: vi.fn().mockResolvedValue([makeForge()]),
    listAccounts: vi.fn().mockResolvedValue([makeAccount({ username: "pmaxhogan" })]),
    getRepo: vi
      .fn()
      .mockResolvedValue(makeRepo({ id: 9, displayName: "tracked", path: "up/tracked" })),
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

describe("Repos page Fork of column", () => {
  it("renders the upstream as a real link to its page on the forge, and nothing for non-forks", async () => {
    const { wrapper } = await mountPage();

    const links = wrapper.findAll("a.fork-link");
    expect(links.map((link) => link.text())).toEqual(["torvalds/linux", "up/tracked"]);
    const first = links[0];
    expect(first?.attributes()).toMatchObject({
      href: "https://github.com/torvalds/linux",
      target: "_blank",
      rel: "noopener noreferrer",
      title: "torvalds/linux",
    });
    expect(wrapper.text()).toContain("Fork of");
  });

  it("encodes each path segment of the upstream", async () => {
    const api = buildApi({
      listRepos: vi.fn().mockResolvedValue({
        rows: [makeRepo({ id: 1, forkParent: "some group/a b#c" })],
        total: 1,
        page: 1,
        perPage: 25,
      }),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.find("a.fork-link").attributes("href")).toBe(
      "https://github.com/some%20group/a%20b%23c",
    );
  });

  it("sorts on the server by fork_parent", async () => {
    const { wrapper, api } = await mountPage();

    await wrapper
      .findComponent(DataTable)
      .vm.$emit("sort", { sortField: "fork_parent", sortOrder: 1 });
    await flush();

    const calls = (api.listRepos as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[1]?.[0]).toMatchObject({ sort: "fork_parent", dir: "asc" });
  });

  it("opens the drawer on a tracked upstream, fetched by id, and not on the row itself", async () => {
    const { wrapper, api } = await mountPage();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    wrapper.findAll("a.fork-link")[1]?.element.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(api.getRepo).toHaveBeenCalledWith(9);
    expect(wrapper.findAll(".drawer-stub").map((node) => node.text())).toEqual(["up/tracked"]);
  });

  it("leaves an untracked upstream as a plain external link and does not open the row", async () => {
    const { wrapper, api } = await mountPage();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    wrapper.findAll("a.fork-link")[0]?.element.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(false);
    expect(api.getRepo).not.toHaveBeenCalled();
    expect(wrapper.find(".drawer-stub").exists()).toBe(false);
  });

  it("leaves a ctrl-click on a tracked upstream to the browser", async () => {
    const { wrapper, api } = await mountPage();

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    wrapper.findAll("a.fork-link")[1]?.element.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(false);
    expect(api.getRepo).not.toHaveBeenCalled();
    expect(wrapper.find(".drawer-stub").exists()).toBe(false);
  });

  it("falls back to the forge page when the upstream cannot be read", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const api = buildApi({ getRepo: vi.fn().mockRejectedValue(new Error("boom")) });
    const { wrapper } = await mountPage(api);

    wrapper
      .findAll("a.fork-link")[1]
      ?.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();

    expect(open).toHaveBeenCalledWith(
      "https://github.com/up/tracked",
      "_blank",
      "noopener,noreferrer",
    );
    expect(wrapper.find(".drawer-stub").exists()).toBe(false);
    open.mockRestore();
  });

  it("keeps Enter on the link from reaching the row", async () => {
    const { wrapper } = await mountPage();

    const keydown = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const reached = vi.fn();
    wrapper.find("tbody tr").element.addEventListener("keydown", reached);
    wrapper.findAll("a.fork-link")[0]?.element.dispatchEvent(keydown);

    expect(reached).not.toHaveBeenCalled();
  });
});
