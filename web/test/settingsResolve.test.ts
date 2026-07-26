import { describe, expect, it } from "vitest";
import { settingsRegistry } from "@amber/shared";
import {
  fieldState,
  groupedKeys,
  inheritedValue,
  isSettingScope,
} from "../src/lib/settingsResolve.ts";

describe("inheritedValue", () => {
  it("falls back to the registry default when nothing is set", () => {
    const result = inheritedValue("clone_mode", "repo", {});
    expect(result.value).toBe(settingsRegistry.clone_mode.default);
    expect(result.source).toBe("default");
  });

  it("takes the narrowest scope that is broader than the one being edited", () => {
    const chain = {
      global: { clone_mode: "shallow" },
      forge: { clone_mode: "mirror" },
      account: { clone_mode: "full" },
    };
    expect(inheritedValue("clone_mode", "repo", chain)).toEqual({
      value: "full",
      source: "account",
    });
    expect(inheritedValue("clone_mode", "account", chain)).toEqual({
      value: "mirror",
      source: "forge",
    });
    expect(inheritedValue("clone_mode", "forge", chain)).toEqual({
      value: "shallow",
      source: "global",
    });
  });

  it("ignores the scope being edited, so its own value is never its inheritance", () => {
    const chain = { repo: { clone_mode: "mirror" }, global: { clone_mode: "shallow" } };
    expect(inheritedValue("clone_mode", "repo", chain).source).toBe("global");
  });

  it("skips a scope that stores an explicit null, which means cleared", () => {
    const chain = { forge: { paranoid: null }, global: { paranoid: true } };
    expect(inheritedValue("paranoid", "repo", chain)).toEqual({ value: true, source: "global" });
  });
});

describe("fieldState", () => {
  it("marks a value stored at this scope as set", () => {
    const state = fieldState("paranoid", "repo", { repo: { paranoid: true }, global: {} });
    expect(state.isSet).toBe(true);
    expect(state.effective).toBe(true);
  });

  it("marks an unset field as inherited and reports where from", () => {
    const state = fieldState("paranoid", "repo", { global: { paranoid: true } });
    expect(state.isSet).toBe(false);
    expect(state.effective).toBe(true);
    expect(state.source).toBe("global");
  });

  it("reports a default-sourced inheritance when no scope sets it", () => {
    const state = fieldState("sync_interval_minutes", "forge", {});
    expect(state.isSet).toBe(false);
    expect(state.source).toBe("default");
    expect(state.effective).toBe(settingsRegistry.sync_interval_minutes.default);
  });
});

describe("groupedKeys", () => {
  it("groups keys by the registry group, preserving registry order", () => {
    const groups = groupedKeys(["clone_mode", "sync_interval_minutes", "shallow_depth"]);
    expect(groups.map((group) => group.group)).toEqual(["Backup", "Schedule"]);
    expect(groups[0]?.keys).toEqual(["clone_mode", "shallow_depth"]);
  });
});

describe("isSettingScope", () => {
  it("accepts the registry scopes and rejects anything else", () => {
    expect(isSettingScope("repo")).toBe(true);
    expect(isSettingScope("universe")).toBe(false);
  });
});
