import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Select from "primevue/select";
import Tabs from "primevue/tabs";
import RepoDetailDrawer from "../src/components/RepoDetailDrawer.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import SettingsScopeEditor from "../src/components/SettingsScopeEditor.vue";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";
import {
  makeAccount,
  makeForge,
  makeGitRemote,
  makeRepo,
  makeRun,
  stubApi,
} from "./helpers/stubApi.ts";
import type { SettingsScopeRef } from "../src/api/types.ts";

const FORGE = makeForge({ id: 1, host: "github.com", kind: "github" });
const ACCOUNTS = [
  makeAccount({ id: 1, forgeId: 1, username: "pmaxhogan", isDefault: true }),
  makeAccount({ id: 2, forgeId: 1, username: "backup-bot", isDefault: false }),
];
const REPO = makeRepo({ id: 42, displayName: "node", path: "nodejs/node", diskUsageBytes: 2048 });

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    getEffectiveSettings: vi.fn().mockResolvedValue({
      clone_mode: { value: "mirror", source: "forge", sourceId: 1 },
      paranoid: { value: true, source: "repo", sourceId: 42 },
      sync_interval_minutes: { value: 180, source: "default", sourceId: null },
    }),
    listRuns: vi.fn().mockResolvedValue({
      rows: [makeRun({ id: 9, outcome: "error", error: "auth failed", errorKind: "auth" })],
      total: 1,
      page: 1,
      perPage: 10,
    }),
    getSettings: vi.fn(async (scope: SettingsScopeRef) =>
      scope.scopeType === "global" ? { paranoid: false } : {},
    ),
    updateRepo: vi.fn(async (id: number, patch: Record<string, unknown>) => ({
      ...REPO,
      id,
      ...patch,
    })),
    getGitRemote: vi.fn().mockResolvedValue(
      makeGitRemote({
        enabled: true,
        cloneUrlTemplate: "https://amber:PASSWORD@amber.example.com/git/{slug}.git",
      }),
    ),
    downloadExport: vi.fn().mockResolvedValue(new Blob(["archive"])),
    ...overrides,
  } as never);
}

async function mountDrawer(api = buildApi(), repo = REPO) {
  const wrapper = mount(RepoDetailDrawer, {
    props: { repo, visible: true, forges: [FORGE], accounts: ACCOUNTS },
    global: mountGlobals({ api }),
  });
  await flush();
  return { wrapper, api };
}

async function openTab(wrapper: Awaited<ReturnType<typeof mountDrawer>>["wrapper"], value: string) {
  await wrapper.findComponent(Tabs).vm.$emit("update:value", value);
  await flush();
}

describe("drawer overview", () => {
  it("shows the full repository identity", async () => {
    const { wrapper } = await mountDrawer();
    const text = wrapper.text();

    expect(text).toContain("https://github.com/nodejs/node");
    expect(text).toContain("nodejs-node-a1b2c3d4");
    expect(text).toContain("a1b2c3d4");
    expect(text).toContain("2.00 KB");
    expect(text).toContain("main");
  });

  it("says the repository was imported manually when no account sync owns it", async () => {
    const { wrapper } = await mountDrawer();
    expect(wrapper.text()).toContain("imported manually");
  });

  it("names the account amber will actually authenticate with", async () => {
    const { wrapper } = await mountDrawer();
    expect(wrapper.text()).toContain("pmaxhogan");
  });

  it("says nobody when the repository is forced anonymous", async () => {
    const { wrapper } = await mountDrawer(
      buildApi(),
      makeRepo({ id: 42, forceAnonymous: true, accountOverrideId: 2 }),
    );
    expect(wrapper.text()).toContain("nobody (anonymous)");
  });

  it("prefers the override account over the forge default", async () => {
    const { wrapper } = await mountDrawer(buildApi(), makeRepo({ id: 42, accountOverrideId: 2 }));
    expect(wrapper.text()).toContain("backup-bot");
  });

  it("surfaces the last error prominently", async () => {
    const { wrapper } = await mountDrawer(
      buildApi(),
      makeRepo({ id: 42, lastError: "remote hung up unexpectedly" }),
    );
    expect(wrapper.find(".repo-drawer__error").text()).toContain("remote hung up unexpectedly");
  });
});

describe("drawer effective settings", () => {
  it("requests the explain endpoint for this repository", async () => {
    const { api } = await mountDrawer();
    expect(api.getEffectiveSettings).toHaveBeenCalledWith(42);
  });

  it("names the scope each resolved value came from", async () => {
    const { wrapper } = await mountDrawer();
    const table = wrapper.find(".explain-table").text();

    expect(table).toContain("from the forge");
    expect(table).toContain("from this repository");
    expect(table).toContain("from the built-in default");
  });

  it("renders booleans as on and off rather than raw true and false", async () => {
    const { wrapper } = await mountDrawer();
    expect(wrapper.find(".explain-table").text()).toContain("on");
  });
});

describe("drawer actions", () => {
  it("queues a manual sync", async () => {
    const { wrapper, api } = await mountDrawer();

    await clickButton(wrapper, "Sync now");
    await flush();

    expect(api.syncRepo).toHaveBeenCalledWith(42);
  });

  it("pauses an active repository and offers to resume a paused one", async () => {
    const { wrapper, api } = await mountDrawer();
    await clickButton(wrapper, "Pause");
    await flush();
    expect(api.updateRepo).toHaveBeenCalledWith(42, { state: "paused" });

    const paused = await mountDrawer(buildApi(), makeRepo({ id: 42, state: "paused" }));
    await clickButton(paused.wrapper, "Resume");
    await flush();
    expect(paused.api.updateRepo).toHaveBeenCalledWith(42, { state: "active" });
  });

  it("emits the updated row so the table can patch in place", async () => {
    const { wrapper } = await mountDrawer();

    await clickButton(wrapper, "Pause");
    await flush();

    const changed = wrapper.emitted("changed")?.[0]?.[0] as { state: string };
    expect(changed.state).toBe("paused");
  });

  it("changes the account override", async () => {
    const { wrapper, api } = await mountDrawer();
    const select = wrapper
      .findAllComponents(Select)
      .find((entry) => entry.props("inputId") === "repo-account-override");

    await select?.vm.$emit("update:modelValue", 2);
    await flush();

    expect(api.updateRepo).toHaveBeenCalledWith(42, { accountOverrideId: 2 });
  });

  it("confirms before deleting, and passes the delete-files choice through", async () => {
    const { wrapper, api } = await mountDrawer();

    await clickButton(wrapper, "Delete");
    await flush();
    expect(api.deleteRepo).not.toHaveBeenCalled();

    const dialog = wrapper
      .findAllComponents(ConfirmDialog)
      .find((entry) => entry.props("visible") === true);
    expect(dialog?.props("danger")).toBe(true);
    dialog?.vm.$emit("confirm");
    await flush();

    expect(api.deleteRepo).toHaveBeenCalledWith(42, false);
    expect(wrapper.emitted("deleted")?.[0]).toEqual([42]);
    expect(wrapper.emitted("update:visible")?.[0]).toEqual([false]);
  });
});

describe("drawer history", () => {
  it("loads runs only when the history tab is opened", async () => {
    const { wrapper, api } = await mountDrawer();
    expect(api.listRuns).not.toHaveBeenCalled();

    await openTab(wrapper, "history");

    expect(api.listRuns).toHaveBeenCalledWith(42, 1, 10);
  });

  it("shows the outcome, duration, and bytes of each run", async () => {
    const { wrapper } = await mountDrawer();
    await openTab(wrapper, "history");

    const text = wrapper.text();
    expect(text).toContain("Failed");
    expect(text).toContain("4.0 s");
    expect(text).toContain("2.00 KB");
  });

  it("pages the run list on the server", async () => {
    const { wrapper, api } = await mountDrawer();
    await openTab(wrapper, "history");

    const table = wrapper.findAllComponents({ name: "DataTable" })[0];
    await table?.vm.$emit("page", { page: 1, rows: 10 });
    await flush();

    expect(api.listRuns).toHaveBeenLastCalledWith(42, 2, 10);
  });
});

describe("drawer settings tab", () => {
  it("assembles the whole inheritance chain, since there is no explain endpoint per scope", async () => {
    const { wrapper, api } = await mountDrawer();

    await openTab(wrapper, "settings");

    const scopes = (
      api.getSettings as unknown as { mock: { calls: SettingsScopeRef[][] } }
    ).mock.calls.map((call) => call[0]?.scopeType);
    expect(scopes).toContain("global");
    expect(scopes).toContain("forge");
    expect(scopes).toContain("repo");
    expect(scopes).toContain("account");
  });

  it("hands the editor repo scope", async () => {
    const { wrapper } = await mountDrawer();
    await openTab(wrapper, "settings");

    expect(wrapper.findComponent(SettingsScopeEditor).props("scope")).toBe("repo");
  });

  it("saves repo-scope overrides against this repository", async () => {
    const { wrapper, api } = await mountDrawer();
    await openTab(wrapper, "settings");

    await wrapper.findComponent(SettingsScopeEditor).vm.$emit("save", { paranoid: true });
    await flush();

    expect(api.putSettings).toHaveBeenCalledWith(
      { scopeType: "repo", scopeId: 42 },
      { paranoid: true },
    );
  });
});

describe("drawer export tab", () => {
  it("downloads the chosen kind and format", async () => {
    const { wrapper, api } = await mountDrawer();
    await openTab(wrapper, "export");

    await clickButton(wrapper, "Download archive");
    await flush();

    expect(api.downloadExport).toHaveBeenCalledWith(42, "gitdir", "zip");
  });

  it("hides the folder download where the File System Access API is missing", async () => {
    const { wrapper } = await mountDrawer();
    await openTab(wrapper, "export");

    expect(findButton(wrapper, "Choose folder and download")).toBeUndefined();
  });
});

describe("drawer clone tab", () => {
  it("substitutes the repo slug into the clone URL template", async () => {
    const { wrapper } = await mountDrawer();
    await openTab(wrapper, "clone");

    const fields = wrapper
      .findAll(".copy-field__input")
      .map((input) => (input.element as HTMLInputElement).value);
    expect(fields).toContain(
      "git clone https://amber:PASSWORD@amber.example.com/git/nodejs-node-a1b2c3d4.git",
    );
    expect(fields).toContain(
      "https://amber:PASSWORD@amber.example.com/git/nodejs-node-a1b2c3d4.git",
    );
  });

  it("points at the Git Remote page when the remote is off", async () => {
    const api = buildApi({
      getGitRemote: vi.fn().mockResolvedValue(makeGitRemote({ enabled: false })),
    });
    const { wrapper } = await mountDrawer(api);
    await openTab(wrapper, "clone");

    expect(wrapper.text()).toContain("Turn it on from the Git Remote page");
  });
});
