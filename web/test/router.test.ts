import { describe, expect, it } from "vitest";
import { NAV_LINKS, routes } from "../src/router/index.ts";
import { amberPalette, amberPreset } from "../src/theme/amber-preset.ts";

describe("router config", () => {
  it("uses the Repos page as the default route", () => {
    expect(routes[0]?.path).toBe("/");
    expect(routes[0]?.name).toBe("repos");
  });

  it("has a nav link for every named page route", () => {
    const pagePaths = routes.filter((route) => route.name !== undefined).map((route) => route.path);
    expect(NAV_LINKS.map((link) => link.to)).toEqual(pagePaths);
  });

  it("catches unknown paths and redirects home", () => {
    const fallback = routes[routes.length - 1];
    expect(fallback?.path).toBe("/:pathMatch(.*)*");
    expect(fallback?.redirect).toBe("/");
  });
});

describe("amber theme preset", () => {
  it("exposes a full amber ramp", () => {
    expect(Object.keys(amberPalette)).toEqual([
      "50",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
      "950",
    ]);
    for (const value of Object.values(amberPalette)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("builds a preset with an amber primary in both color schemes", () => {
    // definePreset merges onto Aura, which already supplies color/hoverColor.
    expect(amberPreset.semantic?.primary).toMatchObject(amberPalette);
    expect(amberPreset.semantic?.colorScheme?.dark?.primary?.color).toBe("{amber.400}");
    expect(amberPreset.semantic?.colorScheme?.light?.primary?.color).toBe("{amber.600}");
  });
});
