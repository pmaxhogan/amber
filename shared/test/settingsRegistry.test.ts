import { describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  SETTING_KEYS,
  SETTING_SCOPES,
  defaultSettings,
  isScopeAllowed,
  isSettingKey,
  parseSettingValue,
  parseSettingsPatch,
  settingKeysForScope,
  settingsRegistry,
} from "../src/settingsRegistry.ts";

describe("settingsRegistry shape", () => {
  it("declares every key documented in the architecture doc", () => {
    expect([...SETTING_KEYS].sort()).toEqual(
      [
        "clone_mode",
        "lfs_enabled",
        "max_concurrent_per_forge",
        "max_concurrent_syncs",
        "paranoid",
        "shallow_depth",
        "sync_enabled",
        "sync_interval_minutes",
      ].sort(),
    );
  });

  it("gives every key a schema, a valid default, scopes, and UI metadata", () => {
    for (const key of SETTING_KEYS) {
      const def = settingsRegistry[key];
      expect(def.scopes.length, `${key} has no scopes`).toBeGreaterThan(0);
      for (const scope of def.scopes) {
        expect(SETTING_SCOPES).toContain(scope);
      }
      expect(def.ui.label.length, `${key} has no label`).toBeGreaterThan(0);
      expect(def.ui.description.length, `${key} has no description`).toBeGreaterThan(0);
      expect(def.ui.group.length, `${key} has no group`).toBeGreaterThan(0);
      expect(def.schema.safeParse(def.default).success, `${key} default fails its schema`).toBe(
        true,
      );
    }
  });

  it("uses only ASCII hyphens in UI copy", () => {
    for (const key of SETTING_KEYS) {
      const copy = `${settingsRegistry[key].ui.label} ${settingsRegistry[key].ui.description}`;
      expect(copy, `${key} UI copy contains a non-ASCII dash`).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("defaults", () => {
  it("matches the documented defaults", () => {
    expect(defaultSettings()).toEqual({
      clone_mode: "bare",
      shallow_depth: 1,
      sync_interval_minutes: 180,
      sync_enabled: true,
      lfs_enabled: true,
      paranoid: false,
      max_concurrent_syncs: 8,
      max_concurrent_per_forge: 4,
    });
  });

  it("returns a fresh object each call", () => {
    const a = defaultSettings();
    const b = defaultSettings();
    expect(a).not.toBe(b);
    a.paranoid = true;
    expect(b.paranoid).toBe(false);
  });
});

describe("scopes", () => {
  it("allows the overridable keys at every scope", () => {
    for (const scope of ALL_SCOPES) {
      expect(isScopeAllowed("clone_mode", scope)).toBe(true);
      expect(isScopeAllowed("paranoid", scope)).toBe(true);
    }
  });

  it("restricts concurrency keys to global", () => {
    expect(isScopeAllowed("max_concurrent_syncs", "global")).toBe(true);
    expect(isScopeAllowed("max_concurrent_syncs", "repo")).toBe(false);
    expect(isScopeAllowed("max_concurrent_per_forge", "forge")).toBe(false);
  });

  it("lists keys per scope in registry order", () => {
    expect(settingKeysForScope("repo")).toEqual([
      "clone_mode",
      "shallow_depth",
      "sync_interval_minutes",
      "sync_enabled",
      "lfs_enabled",
      "paranoid",
    ]);
    expect(settingKeysForScope("global")).toEqual(SETTING_KEYS);
  });
});

describe("isSettingKey", () => {
  it("accepts known keys and rejects everything else", () => {
    expect(isSettingKey("clone_mode")).toBe(true);
    expect(isSettingKey("nope")).toBe(false);
    expect(isSettingKey("toString")).toBe(false);
    expect(isSettingKey("__proto__")).toBe(false);
  });
});

describe("parseSettingValue", () => {
  it("accepts valid values", () => {
    expect(parseSettingValue("clone_mode", "mirror")).toEqual({ ok: true, value: "mirror" });
    expect(parseSettingValue("paranoid", true)).toEqual({ ok: true, value: true });
    expect(parseSettingValue("shallow_depth", 5)).toEqual({ ok: true, value: 5 });
  });

  it("rejects invalid values with a message", () => {
    const badMode = parseSettingValue("clone_mode", "sparse");
    expect(badMode.ok).toBe(false);
    const badDepth = parseSettingValue("shallow_depth", 0);
    expect(badDepth.ok).toBe(false);
    expect(parseSettingValue("shallow_depth", 1.5).ok).toBe(false);
    expect(parseSettingValue("sync_enabled", "yes").ok).toBe(false);
    expect(parseSettingValue("sync_interval_minutes", -1).ok).toBe(false);
  });
});

describe("parseSettingsPatch", () => {
  it("accepts a valid patch for the scope", () => {
    const result = parseSettingsPatch("repo", { clone_mode: "shallow", shallow_depth: 10 });
    expect(result).toEqual({ ok: true, value: { clone_mode: "shallow", shallow_depth: 10 } });
  });

  it("passes null through so the resolver can fall back to a wider scope", () => {
    const result = parseSettingsPatch("repo", { paranoid: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.paranoid).toBeNull();
    }
  });

  it("reports unknown keys", () => {
    const result = parseSettingsPatch("global", { nonsense: 1 });
    expect(result).toEqual({ ok: false, errors: { nonsense: "Unknown setting" } });
  });

  it("reports keys that are not allowed at the scope", () => {
    const result = parseSettingsPatch("repo", { max_concurrent_syncs: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.max_concurrent_syncs).toMatch(/cannot be set at the repo scope/);
    }
  });

  it("reports per-key validation errors", () => {
    const result = parseSettingsPatch("global", { shallow_depth: 0, clone_mode: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["clone_mode", "shallow_depth"]);
    }
  });
});
