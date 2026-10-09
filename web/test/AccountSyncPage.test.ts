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
  it("points at the Accounts page when there is nothing at all to sync from", async () => {
    const api = buildApi({
      listForges: vi.fn().mockResolvedValue([GITEA]),
      listAccounts: vi.fn().mockResolvedValue([]),
      listAccountSyncs: vi.fn().mockResolvedValue([]),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("No accounts to sync from");
    expect(findButton(wrapper, "Add account sync")?.attributes().disabled).toBeDefined();
  });

  it("still offers a namespace sync on GitHub when there are no accounts", async () => {
    const api = buildApi({
      listAccounts: vi.fn().mockResolvedValue([]),
      listAccountSyncs: vi.fn().mockResolvedValue([]),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).not.toContain("No accounts to sync from");
    expect(findButton(wrapper, "Add account sync")?.attributes().disabled).toBeUndefined();
    await clickButton(wrapper, "Add account sync");
    await flush();
    expect(sourceSelect(wrapper)?.props("modelValue")).toBe("namespace");
  });

  it("explains what an account sync does when there are none", async () => {
    const api = buildApi({ listAccountSyncs: vi.fn().mockResolvedValue([]) });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("No account syncs yet");
  });
});

describe("Namespace syncs", () => {
  async function openNamespaceForm() {
    const { wrapper, api } = await mountPage();
    await clickButton(wrapper, "Add account sync");
    await flush();
    await sourceSelect(wrapper)?.vm.$emit("update:modelValue", "namespace");
    await flush();
    return { wrapper, api };
  }

  function selectById(wrapper: Awaited<ReturnType<typeof mountPage>>["wrapper"], id: string) {
    return wrapper.findAllComponents(Select).find((select) => select.props("inputId") === id);
  }

  it("titles a namespace sync by its namespace and forge, and says which account it uses", async () => {
    const api = buildApi({
      listAccountSyncs: vi
        .fn()
        .mockResolvedValue([
          makeAccountSync({ id: 4, source: "namespace", namespace: "nodejs", accountId: null }),
          makeAccountSync({ id: 5, source: "namespace", namespace: "acme", accountId: 1 }),
        ]),
    });
    const { wrapper } = await mountPage(api);
    const [first, second] = wrapper.findAll(".sync-card");

    expect(first?.find("h2").text()).toBe("nodejs on github.com");
    expect(first?.text()).toContain("user or org");
    expect(first?.text()).toContain("via the forge default account");
    expect(first?.text()).toContain("repositories created later are picked up");
    expect(second?.text()).toContain("via pmaxhogan");
  });

  it("only offers forges that can enumerate a namespace", async () => {
    const { wrapper } = await openNamespaceForm();

    expect(selectById(wrapper, "sync-forge")?.props("options")).toEqual([
      { label: "github.com", value: 1 },
    ]);
    expect(wrapper.find("#sync-account").exists()).toBe(false);
  });

  it("creates a namespace sync from a pasted profile URL with the forge default", async () => {
    const { wrapper, api } = await openNamespaceForm();
    // Switching to namespace keeps an account only when it is on the chosen forge.
    await selectById(wrapper, "sync-namespace-account")?.vm.$emit("update:modelValue", null);
    await wrapper.find("#sync-namespace").setValue("https://github.com/nodejs/");
    await flush();

    await clickButton(wrapper, "Create");
    await flush();

    expect(api.createAccountSync).toHaveBeenCalledWith({
      source: "namespace",
      forgeId: 1,
      namespace: "nodejs",
      visibility: "all",
      intervalMinutes: 360,
      enabled: true,
    });
  });

  it("pins a namespace sync to an account on that forge when one is picked", async () => {
    const { wrapper, api } = await openNamespaceForm();
    const accounts = selectById(wrapper, "sync-namespace-account")?.props("options") as {
      value: number | null;
    }[];
    expect(accounts.map((option) => option.value)).toEqual([null, 1]);

    await selectById(wrapper, "sync-namespace-account")?.vm.$emit("update:modelValue", 1);
    await wrapper.find("#sync-namespace").setValue("acme");
    await flush();
    await clickButton(wrapper, "Create");
    await flush();

    expect(api.createAccountSync).toHaveBeenCalledWith(
      expect.objectContaining({ source: "namespace", accountId: 1, namespace: "acme" }),
    );
  });

  it("refuses to create until the namespace is a single valid name", async () => {
    const { wrapper, api } = await openNamespaceForm();
    await wrapper.find("#sync-namespace").setValue("nodejs/node");
    await flush();

    expect(findButton(wrapper, "Create")?.attributes().disabled).toBeDefined();
    expect(wrapper.text()).toContain("Use a user or organization name");
    expect(api.createAccountSync).not.toHaveBeenCalled();
  });

  it("sends only the editable fields when saving an edit", async () => {
    const api = buildApi({
      listAccountSyncs: vi
        .fn()
        .mockResolvedValue([
          makeAccountSync({ id: 4, source: "namespace", namespace: "nodejs", accountId: null }),
        ]),
    });
    const { wrapper } = await mountPage(api);

    await clickButton(wrapper, "Edit");
    await flush();
    await clickButton(wrapper, "Save");
    await flush();

    expect(api.updateAccountSync).toHaveBeenCalledWith(4, {
      visibility: "all",
      intervalMinutes: 360,
      enabled: true,
    });
  });
});
