import { describe, expect, it } from "vitest";
import { NAV_LINKS, routes } from "../src/router/index.ts";
import {
  DARK_MODE_SELECTOR,
  amberPalette,
  amberPreset,
  amberSemantic,
  amberSurface,
} from "../src/theme/amber-preset.ts";

/**
 * `@primeuix/themes` 2.x types `Preset["semantic"]` as an open object, so the
 * merged preset has to be viewed structurally before these assertions can read
 * into it. Only the branches asserted below are declared.
 */
type SemanticView = {
  primary?: Record<string, string>;
  colorScheme?: Record<string, { primary?: { color?: string; contrastColor?: string } }>;
};
const semantic = amberPreset.semantic as SemanticView | undefined;

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

  it("exposes the warm surface ramp and the semantic colors", () => {
    expect(Object.keys(amberSurface)).toHaveLength(12);
    for (const value of Object.values(amberSurface)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const scheme of [amberSemantic.light, amberSemantic.dark]) {
      for (const key of ["success", "warn", "error", "info"] as const) {
        expect(scheme[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("matches the dark mode selector main.ts puts on the document element", () => {
    expect(DARK_MODE_SELECTOR).toBe(".amber-dark");
    expect(DARK_MODE_SELECTOR.startsWith(".")).toBe(true);
  });

  it("builds a preset with an amber primary in both color schemes", () => {
    // definePreset merges onto Aura, which already supplies color/hoverColor.
    expect(semantic?.primary).toMatchObject(amberPalette);
    // Dark reaches for 500, light for 700. The same scale position does not
    // clear contrast in both schemes, so these must not be unified.
    expect(semantic?.colorScheme?.dark?.primary?.color).toBe("{primary.500}");
    expect(semantic?.colorScheme?.light?.primary?.color).toBe("{primary.700}");
  });

  it("never puts white text on an amber fill", () => {
    // White on amber-500 measures 2.6:1 and fails WCAG AA at any size, so the
    // dark scheme's on-primary color is a warm near-black (6.4:1). If someone
    // "fixes" this to #ffffff every filled primary button silently regresses.
    expect(semantic?.colorScheme?.dark?.primary?.contrastColor).toBe("#2a1a0b");
  });

  it("never reaches for Aura's stock amber primitive", () => {
    // "{amber.600}" resolves to Aura's built-in Tailwind amber, NOT the palette
    // above. That is how a preset ends up looking almost right with none of the
    // measured contrast actually holding. The merged semantic still contains
    // Aura's own references (slate, zinc, red, and friends), so this asserts the
    // one namespace that must never appear rather than an exact allowlist.
    const namespaces = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        for (const match of node.matchAll(/\{([a-z]+)\.[a-zA-Z0-9.]+\}/g)) {
          namespaces.add(match[1] as string);
        }
        return;
      }
      if (node && typeof node === "object") {
        for (const value of Object.values(node)) walk(value);
      }
    };
    walk(amberPreset.semantic);
    expect(namespaces.has("amber")).toBe(false);
    expect(namespaces.has("primary")).toBe(true);
  });
});
