import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ToggleSwitch from "primevue/toggleswitch";
import SettingsScopeEditor from "../src/components/SettingsScopeEditor.vue";
import type { ScopeOverrides } from "../src/lib/settingsResolve.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { clickButton, findButton, flush } from "./helpers/dom.ts";

function mountEditor(scope: "global" | "forge" | "account" | "repo", chain: ScopeOverrides) {
  return mount(SettingsScopeEditor, {
    props: { scope, chain },
    global: mountGlobals(),
  });
}

function rowFor(wrapper: ReturnType<typeof mountEditor>, label: string) {
  return wrapper.findAll(".setting-row").find((row) => row.find("label").text() === label);
}

describe("inherited versus set rendering", () => {
  it("names the scope a value was inherited from", async () => {
    const wrapper = mountEditor("repo", { global: { paranoid: true } });
    await flush();

    expect(rowFor(wrapper, "Paranoid mode")?.text()).toContain("Inherited from global settings");
  });

  it("says set here when this scope stores the value", async () => {
    const wrapper = mountEditor("repo", { repo: { paranoid: true }, global: { paranoid: false } });
    await flush();

    const row = rowFor(wrapper, "Paranoid mode");
    expect(row?.text()).toContain("Set here");
    expect(row?.text()).not.toContain("Inherited from");
  });

  it("attributes the value to the narrowest scope that set it", async () => {
    const wrapper = mountEditor("repo", {
      global: { clone_mode: "shallow" },
      forge: { clone_mode: "mirror" },
    });
    await flush();

    expect(rowFor(wrapper, "Clone mode")?.text()).toContain("Inherited from the forge");
  });

  it("falls back to the built-in default when nothing overrides it", async () => {
    const wrapper = mountEditor("global", {});
    await flush();

    expect(rowFor(wrapper, "Sync interval")?.text()).toContain(
      "Inherited from the built-in default",
    );
  });

  it("renders the value that actually applies, not the scope's own blank", async () => {
    const wrapper = mountEditor("repo", { global: { paranoid: true } });
    await flush();

    const toggle = rowFor(wrapper, "Paranoid mode")?.findComponent(ToggleSwitch);
    expect(toggle?.props("modelValue")).toBe(true);
  });
});

describe("override controls", () => {
  it("offers Clear override for a value set here", async () => {
    const wrapper = mountEditor("repo", { repo: { paranoid: true } });
    await flush();

    const row = rowFor(wrapper, "Paranoid mode");
    expect(findButton(row as never, "Clear override")).toBeDefined();
    expect(findButton(row as never, "Override here")).toBeUndefined();
  });

  it("offers Override here for an inherited value", async () => {
    const wrapper = mountEditor("repo", { global: { paranoid: true } });
    await flush();

    const row = rowFor(wrapper, "Paranoid mode");
    expect(findButton(row as never, "Override here")).toBeDefined();
  });

  it("clearing an override emits null, which is how the API clears one", async () => {
    const wrapper = mountEditor("repo", { repo: { paranoid: true }, global: { paranoid: false } });
    await flush();

    await clickButton(rowFor(wrapper, "Paranoid mode") as never, "Clear override");
    await flush();
    await clickButton(wrapper, "Save changes");

    expect(wrapper.emitted("save")?.[0]).toEqual([{ paranoid: null }]);
  });

  it("flips the row back to inherited as soon as the override is cleared", async () => {
    const wrapper = mountEditor("repo", { repo: { paranoid: true }, global: { paranoid: false } });
    await flush();

    await clickButton(rowFor(wrapper, "Paranoid mode") as never, "Clear override");
    await flush();

    expect(rowFor(wrapper, "Paranoid mode")?.text()).toContain("Inherited from global settings");
  });

  it("hides the save bar until something changes, then counts the changes", async () => {
    const wrapper = mountEditor("repo", { global: { paranoid: true } });
    await flush();
    expect(findButton(wrapper, "Save changes")).toBeUndefined();

    await clickButton(rowFor(wrapper, "Paranoid mode") as never, "Override here");
    await flush();

    expect(wrapper.text()).toContain("1 pending change");
    expect(findButton(wrapper, "Save changes")).toBeDefined();
  });

  it("discards pending edits without emitting", async () => {
    const wrapper = mountEditor("repo", { global: { paranoid: true } });
    await flush();

    await clickButton(rowFor(wrapper, "Paranoid mode") as never, "Override here");
    await flush();
    await clickButton(wrapper, "Discard");
    await flush();

    expect(wrapper.emitted("save")).toBeUndefined();
    expect(findButton(wrapper, "Save changes")).toBeUndefined();
  });
});

describe("scope-aware key list", () => {
  it("shows global-only keys at global scope", async () => {
    const wrapper = mountEditor("global", {});
    await flush();
    expect(wrapper.text()).toContain("Max concurrent syncs");
  });

  it("hides global-only keys at narrower scopes", async () => {
    const wrapper = mountEditor("repo", {});
    await flush();
    expect(wrapper.text()).not.toContain("Max concurrent syncs");
  });

  it("groups fields using the registry metadata", async () => {
    const wrapper = mountEditor("repo", {});
    await flush();
    const groups = wrapper.findAll(".settings-group h3").map((heading) => heading.text());
    expect(groups).toEqual(["Backup", "Schedule"]);
  });
});
