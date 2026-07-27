import { describe, expect, it } from "vitest";
import { isPlausibleRef } from "../src/gitRef.ts";

describe("isPlausibleRef", () => {
  it("accepts ordinary ref names", () => {
    expect(isPlausibleRef("main")).toBe(true);
    expect(isPlausibleRef("feature/one")).toBe(true);
    expect(isPlausibleRef("release-2.0")).toBe(true);
    expect(isPlausibleRef("v1.0.0")).toBe(true);
  });

  it("rejects a name that would read as a git flag", () => {
    // A malicious forge can advertise HEAD as a symref to any of these; each
    // would otherwise land in a positional argv slot and be parsed as an option
    // (e.g. `git lfs fetch origin -p` == prune).
    expect(isPlausibleRef("-p")).toBe(false);
    expect(isPlausibleRef("--prune")).toBe(false);
    expect(isPlausibleRef("-X")).toBe(false);
  });

  it("rejects traversal, trailing slash, empty and whitespace", () => {
    expect(isPlausibleRef("a/../b")).toBe(false);
    expect(isPlausibleRef("heads/")).toBe(false);
    expect(isPlausibleRef("")).toBe(false);
    expect(isPlausibleRef("has space")).toBe(false);
  });
});
