import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Select from "primevue/select";
import SettingsPage from "../src/pages/SettingsPage.vue";
import SettingsScopeEditor from "../src/components/SettingsScopeEditor.vue";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, flush } from "./helpers/dom.ts";
import { makeAccount, makeForge, stubApi } from "./helpers/stubApi.ts";
import type { SettingsScopeRef } from "../src/api/types.ts";

const FORGE = makeForge({ id: 3, host: "github.com" });
const ACCOUNT = makeAccount({ id: 5, forgeId: 3, username: "pmaxhogan" });

function buildApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    listForges: vi.fn().mockResolvedValue([FORGE]),
    listAccounts: vi.fn().mockResolvedValue([ACCOUNT]),
    getSettings: vi.fn(async (scope: SettingsScopeRef) => {
      if (scope.scopeType === "global") return { clone_mode: "mirror" };
      if (scope.scopeType === "forge") return { paranoid: true };
      return {};
    }),
    putSettings: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as never);
}

async function mountPage(api = buildApi()) {
  const wrapper = mount(SettingsPage, { global: mountGlobals({ api }) });
  await flush();
  return { wrapper, api };
}

function selectById(wrapper: Awaited<ReturnType<typeof mountPage>>["wrapper"], id: string) {
  return wrapper.findAllComponents(Select).find((select) => select.props("inputId") === id);
}

function scopeCalls(api: ReturnType<typeof buildApi>): SettingsScopeRef[] {
  return (api.getSettings as unknown as { mock: { calls: SettingsScopeRef[][] } }).mock.calls.map(
    (call) => call[0] as SettingsScopeRef,
  );
}

describe("Settings scope switcher", () => {
  it("starts at global scope and loads only the global overrides", async () => {
    const { wrapper, api } = await mountPage();

    expect(scopeCalls(api)).toEqual([{ scopeType: "global", scopeId: null }]);
    expect(wrapper.findComponent(SettingsScopeEditor).props("scope")).toBe("global");
  });

  it("waits for a forge to be picked before loading anything", async () => {
    const { wrapper, api } = await mountPage();

    await selectById(wrapper, "settings-scope")?.vm.$emit("update:modelValue", "forge");
    await flush();

    expect(wrapper.text()).toContain("Pick a forge to edit its settings");
    expect(wrapper.findComponent(SettingsScopeEditor).exists()).toBe(false);
    expect(scopeCalls(api)).toHaveLength(1);
  });

  it("loads global plus the forge overrides at forge scope, so inheritance can be shown", async () => {
    const { wrapper, api } = await mountPage();

    await selectById(wrapper, "settings-scope")?.vm.$emit("update:modelValue", "forge");
    await flush();
    await selectById(wrapper, "settings-forge")?.vm.$emit("update:modelValue", 3);
    await flush();

    expect(scopeCalls(api)).toContainEqual({ scopeType: "forge", scopeId: 3 });
    const chain = wrapper.findComponent(SettingsScopeEditor).props("chain") as Record<
      string,
      unknown
    >;
    expect(chain.global).toEqual({ clone_mode: "mirror" });
    expect(chain.forge).toEqual({ paranoid: true });
  });

  it("walks the account's own forge at account scope, not an arbitrary one", async () => {
    // The account's inheritance runs through the forge it belongs to; getting
    // that wrong would show the user a plausible but false explanation.
    const { wrapper, api } = await mountPage();

    await selectById(wrapper, "settings-scope")?.vm.$emit("update:modelValue", "account");
    await flush();
    await selectById(wrapper, "settings-account")?.vm.$emit("update:modelValue", 5);
    await flush();

    expect(scopeCalls(api)).toContainEqual({ scopeType: "forge", scopeId: 3 });
    expect(scopeCalls(api)).toContainEqual({ scopeType: "account", scopeId: 5 });
  });

  it("describes what the chosen scope means", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain("Global values apply everywhere");

    await selectById(wrapper, "settings-scope")?.vm.$emit("update:modelValue", "account");
    await flush();

    expect(wrapper.text()).toContain("repositories that authenticate with this account");
  });
});

describe("Settings save", () => {
  it("writes the patch to the scope being edited", async () => {
    const { wrapper, api } = await mountPage();

    await wrapper.findComponent(SettingsScopeEditor).vm.$emit("save", { max_concurrent_syncs: 12 });
    await flush();

    expect(api.putSettings).toHaveBeenCalledWith(
      { scopeType: "global", scopeId: null },
      { max_concurrent_syncs: 12 },
    );
  });

  it("writes forge patches against the forge id", async () => {
    const { wrapper, api } = await mountPage();
    await selectById(wrapper, "settings-scope")?.vm.$emit("update:modelValue", "forge");
    await flush();
    await selectById(wrapper, "settings-forge")?.vm.$emit("update:modelValue", 3);
    await flush();

    await wrapper.findComponent(SettingsScopeEditor).vm.$emit("save", { paranoid: null });
    await flush();

    expect(api.putSettings).toHaveBeenCalledWith(
      { scopeType: "forge", scopeId: 3 },
      { paranoid: null },
    );
  });

  it("reloads after saving so the inherited state reflects what was written", async () => {
    const { wrapper, api } = await mountPage();
    const before = scopeCalls(api).length;

    await wrapper.findComponent(SettingsScopeEditor).vm.$emit("save", { paranoid: true });
    await flush();

    expect(scopeCalls(api).length).toBeGreaterThan(before);
  });
});

describe("Settings error handling", () => {
  it("offers a retry when the settings request fails", async () => {
    const api = buildApi({
      getSettings: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    });
    const { wrapper } = await mountPage(api);

    expect(wrapper.text()).toContain("Could not load settings");
    await clickButton(wrapper, "Try again");
    await flush();

    expect(api.getSettings).toHaveBeenCalledTimes(2);
  });
});
