import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Select from "primevue/select";
import AccountSyncPage from "../src/pages/AccountSyncPage.vue";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeAccount, makeAccountSync, makeForge, stubApi } from "./helpers/stubApi.ts";

const GITHUB = makeForge({ id: 1, host: "github.com", kind: "github" });
const GITEA = makeForge({ id: 2, host: "git.example.com", kind: "gitea" });

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listForges: vi.fn().mockResolvedValue([GITHUB, GITEA]),
    listAccounts: vi
      .fn()
      .mockResolvedValue([
        makeAccount({ id: 1, forgeId: 1, username: "pmaxhogan" }),
        makeAccount({ id: 2, forgeId: 2, username: "selfhoster", isDefault: true }),
      ]),
    listAccountSyncs: vi.fn().mockResolvedValue([makeAccountSync()]),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi()) {
  const wrapper = mount(AccountSyncPage, { global: mountGlobals({ api }) });
  await flush();
  return { wrapper, api };
}

function sourceSelect(wrapper: Awaited<ReturnType<typeof mountPage>>["wrapper"]) {
  return wrapper
    .findAllComponents(Select)
    .find((select) => select.props("inputId") === "sync-source");
}

describe("Account sync list", () => {
  it("shows the source, visibility, and interval of each sync", async () => {
    const { wrapper } = await mountPage();
    const card = wrapper.find(".sync-card");

    expect(card.text()).toContain("pmaxhogan at github.com");
    expect(card.text()).toContain("owned");
    expect(card.text()).toContain("visibility: all");
    expect(card.text()).toContain("every 360 minutes");
  });

  it("reports the discovery stats", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.find(".sync-card__stats").text()).toContain("12");
  });

  it("surfaces the last error when there is one", async () => {
    const api = buildApi({
      listAccountSyncs: vi
        .fn()
        .mockResolvedValue([makeAccountSync({ lastError: "GitHub returned 401" })]),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.find(".sync-card__error").text()).toContain("GitHub returned 401");
  });

  it("runs a discovery pass on demand", async () => {
    const { wrapper, api } = await mountPage();

    await clickButton(wrapper, "Run now");
    await flush();

    expect(api.runAccountSync).toHaveBeenCalledWith(1);
  });

  it("pauses a sync through the enable toggle", async () => {
    const { wrapper, api } = await mountPage();

    await wrapper.find("#sync-enabled-1").setValue(false);
    await flush();

    expect(api.updateAccountSync).toHaveBeenCalledWith(1, { enabled: false });
  });

  it("explains the starred retention rule on a starred sync", async () => {
    const api = buildApi({
      listAccountSyncs: vi.fn().mockResolvedValue([makeAccountSync({ source: "starred" })]),
    });
    const { wrapper } = await mountPage(api);
    const text = wrapper.find(".sync-card").text();

    expect(text).toContain("always mirrors your current starred list");
    expect(text).toContain("removed only when amber can still reach them upstream");
    expect(text).toContain("is kept and keeps syncing");
  });
});

describe("Account sync form", () => {
  async function openCreate() {
    const { wrapper, api } = await mountPage();
    await clickButton(wrapper, "Add account sync");
    await flush();
    return { wrapper, api };
  }

  it("offers starred discovery for a GitHub account", async () => {
    const { wrapper } = await openCreate();

    const options = sourceSelect(wrapper)?.props("options") as {
      label: string;
      disabled: boolean;
    }[];
    const starred = options.find((option) => option.label.includes("starred"));
    expect(starred?.disabled).toBe(false);
  });

  it("disables starred discovery for a non-GitHub account and says why", async () => {
    const api = buildApi({
      listAccounts: vi
        .fn()
        .mockResolvedValue([makeAccount({ id: 2, forgeId: 2, username: "selfhoster" })]),
      listAccountSyncs: vi.fn().mockResolvedValue([]),
    });
    const wrapper = mount(AccountSyncPage, { global: mountGlobals({ api }) });
    await flush();
    await clickButton(wrapper, "Add an account sync");
    await flush();

    const options = sourceSelect(wrapper)?.props("options") as {
      label: string;
      value: string;
      disabled: boolean;
    }[];
    const starred = options.find((option) => option.value === "starred");
    expect(starred?.disabled).toBe(true);
    expect(starred?.label).toBe("Starred (GitHub accounts only)");
  });

  it("creates a sync with the chosen source and visibility", async () => {
    const { wrapper, api } = await openCreate();

    await clickButton(wrapper, "Create");
    await flush();

    expect(api.createAccountSync).toHaveBeenCalledWith({
      accountId: 1,
      source: "owned",
      visibility: "all",
      intervalMinutes: 360,
      enabled: true,
    });
  });

  it("omits visibility from a starred sync payload, which the server rejects", async () => {
    const { wrapper, api } = await openCreate();

    await sourceSelect(wrapper)?.vm.$emit("update:modelValue", "starred");
    await flush();
    await clickButton(wrapper, "Create");
    await flush();

    expect(api.createAccountSync).toHaveBeenCalledWith({
      accountId: 1,
      source: "starred",
      intervalMinutes: 360,
      enabled: true,
    });
  });

  it("hides the visibility picker for a starred sync, which has no such notion", async () => {
    const { wrapper } = await openCreate();
    expect(wrapper.find("#sync-visibility").exists()).toBe(true);

    await sourceSelect(wrapper)?.vm.$emit("update:modelValue", "starred");
    await flush();

    expect(wrapper.find("#sync-visibility").exists()).toBe(false);
  });
});

describe("Account sync empty states", () => {
  it("points at the Accounts page when there is no credential to sync from", async () => {
    const api = buildApi({
      listAccounts: vi.fn().mockResolvedValue([]),
      listAccountSyncs: vi.fn().mockResolvedValue([]),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("No accounts to sync from");
    expect(findButton(wrapper, "Add account sync")?.attributes().disabled).toBeDefined();
  });

  it("explains what an account sync does when there are none", async () => {
    const api = buildApi({ listAccountSyncs: vi.fn().mockResolvedValue([]) });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("No account syncs yet");
  });
});
