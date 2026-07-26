import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Password from "primevue/password";
import Select from "primevue/select";
import AccountsPage from "../src/pages/AccountsPage.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import { makeAccount, makeForge, stubApi } from "./helpers/stubApi.ts";

const FORGE = makeForge({ id: 1, host: "github.com", kind: "github" });
const ACCOUNTS = [
  makeAccount({ id: 1, username: "pmaxhogan", isDefault: true, hasSecret: true, createdAt: 100 }),
  makeAccount({
    id: 2,
    username: "backup-bot",
    isDefault: false,
    hasSecret: false,
    createdAt: 200,
  }),
];

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listForges: vi.fn().mockResolvedValue([FORGE]),
    listAccounts: vi.fn().mockResolvedValue(ACCOUNTS),
    listRepos: vi.fn().mockResolvedValue({ rows: [], total: 9, page: 1, perPage: 1 }),
    updateAccount: vi.fn().mockResolvedValue(ACCOUNTS[0]),
    setDefaultAccount: vi.fn().mockResolvedValue(ACCOUNTS[1]),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi()) {
  const wrapper = mount(AccountsPage, { global: mountGlobals({ api }) });
  await flush();
  return { wrapper, api };
}

describe("Accounts page default badge", () => {
  it("badges exactly the default account", async () => {
    const { wrapper } = await mountPage();

    const rows = wrapper.findAll(".account-table tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.find(".p-tag").text()).toBe("default");
    expect(rows[1]?.find(".p-tag").exists()).toBe(false);
  });

  it("offers to promote a non-default account, but not the current default", async () => {
    const { wrapper } = await mountPage();

    const rows = wrapper.findAll(".account-table tbody tr");
    expect(findButton(rows[0] as never, "Make default")).toBeUndefined();
    expect(findButton(rows[1] as never, "Make default")).toBeDefined();
  });

  it("calls the default endpoint when promoting", async () => {
    const { wrapper, api } = await mountPage();
    const rows = wrapper.findAll(".account-table tbody tr");

    await clickButton(rows[1] as never, "Make default");
    await flush();

    expect(api.setDefaultAccount).toHaveBeenCalledWith(2);
  });

  it("names the account that would be promoted before a delete is confirmed", async () => {
    const { wrapper } = await mountPage();
    const rows = wrapper.findAll(".account-table tbody tr");

    await clickButton(rows[0] as never, "Delete");
    await flush();

    // The oldest remaining account inherits the default, per the domain rule.
    expect(wrapper.text()).toContain("promotes backup-bot");
  });

  it("shows whether a secret is stored without ever showing the secret", async () => {
    const { wrapper } = await mountPage();

    const rows = wrapper.findAll(".account-table tbody tr");
    expect(rows[0]?.text()).toContain("stored");
    expect(rows[1]?.text()).toContain("none, fetches anonymously");
  });

  it("shows the account and repo counts for the forge", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain("2 accounts");
    expect(wrapper.text()).toContain("9 repos");
  });
});

describe("Accounts page write-only secret", () => {
  async function openEdit() {
    const { wrapper, api } = await mountPage();
    const rows = wrapper.findAll(".account-table tbody tr");
    await clickButton(rows[0] as never, "Edit");
    await flush();
    return { wrapper, api };
  }

  it("opens the edit form with the secret field blank, never prefilled", async () => {
    const { wrapper } = await openEdit();
    expect(wrapper.findComponent(Password).props("modelValue")).toBe("");
  });

  it("tells the user that leaving it blank keeps the stored secret", async () => {
    const { wrapper } = await openEdit();
    expect(wrapper.text()).toContain("Leave this blank to keep it");
  });

  it("omits the secret from the patch when the field was left blank", async () => {
    const { wrapper, api } = await openEdit();

    await clickButton(wrapper, "Save");
    await flush();

    expect(api.updateAccount).toHaveBeenCalledTimes(1);
    const [, patch] = (api.updateAccount as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [number, Record<string, unknown>];
    expect(Object.prototype.hasOwnProperty.call(patch, "secret")).toBe(false);
    expect(patch.username).toBe("pmaxhogan");
  });

  it("sends the secret only when one was typed", async () => {
    const { wrapper, api } = await openEdit();

    await wrapper.findComponent(Password).vm.$emit("update:modelValue", "ghp_newtoken");
    await flush();
    await clickButton(wrapper, "Save");
    await flush();

    const [, patch] = (api.updateAccount as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [number, Record<string, unknown>];
    expect(patch.secret).toBe("ghp_newtoken");
  });

  it("clears a stored secret through an explicit null, not an empty string", async () => {
    const { wrapper, api } = await openEdit();

    await clickButton(wrapper, "Clear stored secret");
    await flush();

    expect(api.updateAccount).toHaveBeenCalledWith(1, { secret: null });
  });

  it("shows forge-specific credential help in the account form", async () => {
    const { wrapper } = await openEdit();

    expect(wrapper.text()).toContain("GitHub fine-grained personal access token");
    expect(wrapper.text()).toContain('grant ONLY "Contents: Read-only"');
    expect(wrapper.html()).toContain("https://github.com/settings/personal-access-tokens/new");
  });
});

describe("Accounts page forge management", () => {
  it("says the origin cannot be changed later, which is the credential-safety rule", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain(
      "Host, port, and protocol cannot be changed after a forge is created",
    );
  });

  it("shows a non-default port and flags plain http", async () => {
    const api = buildApi({
      listForges: vi
        .fn()
        .mockResolvedValue([
          makeForge({ id: 1, protocol: "http", host: "git.local", port: 8080, kind: "gitea" }),
        ]),
      listAccounts: vi.fn().mockResolvedValue([]),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("http://git.local:8080");
    expect(wrapper.text()).toContain("port 8080");
    expect(wrapper.find(".forge-card__insecure").text()).toContain(
      "credentials would travel unencrypted",
    );
  });

  it("says fetches are anonymous when a forge has no accounts", async () => {
    const api = buildApi({ listAccounts: vi.fn().mockResolvedValue([]) });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("Amber fetches its repositories anonymously");
  });

  it("creates a forge from the dialog", async () => {
    const api = buildApi({ createForge: vi.fn().mockResolvedValue(FORGE) });
    const { wrapper } = await mountPage(api);

    await clickButton(wrapper, "Add forge");
    await flush();
    await wrapper.find("#forge-host").setValue("git.example.com");
    await flush();
    await clickButton(wrapper, "Create forge");
    await flush();

    expect(api.createForge).toHaveBeenCalledWith({
      protocol: "https",
      host: "git.example.com",
      port: null,
      kind: undefined,
    });
  });

  it("keeps the create button inert while the host is blank", async () => {
    const { wrapper } = await mountPage();

    await clickButton(wrapper, "Add forge");
    await flush();

    expect(findButton(wrapper, "Create forge")?.attributes().disabled).toBeDefined();
  });

  it("updates only the kind, the one mutable forge field", async () => {
    const api = buildApi({ updateForge: vi.fn().mockResolvedValue(FORGE) });
    const { wrapper } = await mountPage(api);

    const kindSelect = wrapper
      .findAllComponents(Select)
      .find((select) => select.props("inputId") === "forge-kind-1");
    await kindSelect?.vm.$emit("update:modelValue", "gitea");
    await flush();

    expect(api.updateForge).toHaveBeenCalledWith(1, "gitea");
  });

  it("confirms before removing a forge and explains what goes with it", async () => {
    const { wrapper, api } = await mountPage();

    await clickButton(wrapper, "Remove forge");
    await flush();

    expect(api.deleteForge).not.toHaveBeenCalled();
    const dialog = wrapper
      .findAllComponents(ConfirmDialog)
      .find((entry) => entry.props("visible") === true);
    expect(String(dialog?.props("message"))).toContain("deletes its accounts");

    dialog?.vm.$emit("confirm");
    await flush();
    expect(api.deleteForge).toHaveBeenCalledWith(1);
  });

  it("adds an account to a specific forge", async () => {
    const api = buildApi({ createAccount: vi.fn().mockResolvedValue(ACCOUNTS[0]) });
    const { wrapper } = await mountPage(api);

    await clickButton(wrapper, "Add account");
    await flush();
    await wrapper.find("#account-username").setValue("new-user");
    await flush();
    await clickButton(wrapper, "Create account");
    await flush();

    expect(api.createAccount).toHaveBeenCalledWith({
      forgeId: 1,
      username: "new-user",
      secret: null,
      // The forge already has a default, so a new account does not steal it.
      isDefault: false,
    });
  });
});

describe("Accounts page states", () => {
  it("explains what a forge is when there are none", async () => {
    const api = buildApi({
      listForges: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("No forges yet");
    expect(findButton(wrapper, "Add a forge")).toBeDefined();
  });

  it("offers a retry when the forge list cannot be read", async () => {
    const api = buildApi({ listForges: vi.fn().mockRejectedValue(new TypeError("nope")) });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("Could not load forges");
    await clickButton(wrapper, "Try again");
    await flush();

    expect(api.listForges).toHaveBeenCalledTimes(2);
  });

  it("still renders when the repo counts cannot be read", async () => {
    const api = buildApi({ listRepos: vi.fn().mockRejectedValue(new TypeError("nope")) });
    const { wrapper } = await mountPage(api);

    expect(wrapper.findAll(".account-table tbody tr")).toHaveLength(2);
    expect(wrapper.text()).toContain("0 repos");
  });
});
