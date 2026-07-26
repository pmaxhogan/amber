import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

/**
 * Amber - PrimeVue 5 theme preset.
 *
 * Dark-first. See palette.md for the measured contrast ratios behind every
 * value here. Three constraints are load-bearing:
 *
 *  - primary contrastColor is a warm near-black, never white. PrimeVue 5 has
 *    no inverseColor token; contrastColor is the one components consume.
 *    White on amber-500 is 2.6:1 and fails at any size.
 *  - Dark mode uses primary 400/500; light mode uses 600/700. The same scale
 *    position does not clear contrast in both schemes.
 *  - Token references point at {primary.*} and {surface.*}, never at Aura's
 *    stock {amber.*} primitive. {amber.600} resolves to Aura's built-in
 *    Tailwind amber, not to anything defined below.
 *
 * Export names match the scaffold's import site in web/src/main.ts:
 *   import { DARK_MODE_SELECTOR, amberPreset } from "./theme/amber-preset.ts";
 */

/** Amber primary scale. */
export const amberPalette = {
  50: "#fef7ec",
  100: "#fcebce",
  200: "#f9d79c",
  300: "#f5bc63",
  400: "#f0a138",
  500: "#e8890f",
  600: "#c4690b",
  700: "#9e4f0d",
  800: "#7f3f12",
  900: "#6a3512",
  950: "#3d1b07",
} as const;

/** Warm stone neutrals. Shared by both color schemes. */
export const amberSurface = {
  0: "#ffffff",
  50: "#faf7f4",
  100: "#f3eee8",
  200: "#e7dfd5",
  300: "#d5c9bb",
  400: "#ac9e8d",
  500: "#857868",
  600: "#6a5d50",
  700: "#4e443a",
  800: "#332c25",
  900: "#1e1815",
  950: "#14100d",
} as const;

/**
 * Semantic colors, per scheme. These are not part of the PrimeVue semantic
 * token set, so expose them as CSS custom properties and reference them from
 * Message, Toast, Tag, and Badge severity overrides.
 *
 * warn sits close to the brand hue in both schemes. Every warn state needs an
 * icon and a text label; color alone is not a sufficient signal.
 */
export const amberSemantic = {
  light: {
    success: "#1e7a47",
    warn: "#8f6304",
    error: "#c0322f",
    info: "#1f6fb2",
  },
  dark: {
    success: "#57b87a",
    warn: "#f2ce4b",
    error: "#e5605c",
    info: "#6aa9e0",
    successBg: "#152a1d",
    successBorder: "#255c3a",
    warnBg: "#2b2410",
    warnBorder: "#6b5a16",
    errorBg: "#2e1615",
    errorBorder: "#6e2e2c",
    infoBg: "#141f2c",
    infoBorder: "#2c4e6e",
  },
} as const;

/** Class toggled on <html> to select the dark color scheme. */
export const DARK_MODE_SELECTOR = ".amber-dark";

export const amberPreset = definePreset(Aura, {
  semantic: {
    primary: amberPalette,

    // Aura declares focusRing at the semantic level, outside colorScheme, and
    // PrimeVue requires an override to keep the original structure. So the ring
    // cannot be given a different hex per scheme - it follows primary.color,
    // which resolves to amber-500 on dark (3.6:1 worst case) and amber-700 on
    // light (3.6:1 worst case). Both clear the 3:1 non-text floor. Pinning
    // amber-400 here would look better on dark but is 2.1:1 on white.
    focusRing: {
      width: "2px",
      style: "solid",
      color: "{primary.color}",
      offset: "2px",
      shadow: "none",
    },

    colorScheme: {
      light: {
        surface: amberSurface,
        primary: {
          color: "{primary.700}",
          contrastColor: "#ffffff",
          hoverColor: "{primary.800}",
          activeColor: "{primary.900}",
        },
        highlight: {
          background: "{primary.100}",
          focusBackground: "{primary.200}",
          color: "{primary.900}",
          focusColor: "{primary.950}",
        },
        text: {
          color: "{surface.900}",
          hoverColor: "{surface.950}",
          mutedColor: "{surface.700}",
          hoverMutedColor: "{surface.800}",
        },
        content: {
          background: "{surface.0}",
          hoverBackground: "{surface.100}",
          borderColor: "{surface.200}",
        },
        overlay: {
          select: {
            background: "{surface.0}",
            borderColor: "{surface.200}",
            color: "{text.color}",
          },
          popover: {
            background: "{surface.0}",
            borderColor: "{surface.200}",
            color: "{text.color}",
          },
          modal: {
            background: "{surface.0}",
            borderColor: "{surface.200}",
            color: "{text.color}",
          },
        },
        formField: {
          background: "{surface.0}",
          disabledBackground: "{surface.100}",
          filledBackground: "{surface.50}",
          filledHoverBackground: "{surface.100}",
          filledFocusBackground: "{surface.0}",
          borderColor: "{surface.300}",
          hoverBorderColor: "{surface.400}",
          focusBorderColor: "{primary.color}",
          invalidBorderColor: "#c0322f",
          color: "{surface.900}",
          disabledColor: "{surface.400}",
          placeholderColor: "{surface.500}",
          invalidPlaceholderColor: "#c0322f",
          floatLabelColor: "{surface.600}",
          floatLabelFocusColor: "{primary.color}",
          floatLabelActiveColor: "{surface.600}",
          floatLabelInvalidColor: "#c0322f",
          iconColor: "{surface.500}",
          shadow: "0 1px 2px 0 rgba(33, 28, 24, 0.06)",
        },
        navigation: {
          item: {
            focusBackground: "{surface.100}",
            activeBackground: "{primary.50}",
            color: "{text.color}",
            focusColor: "{text.hoverColor}",
            activeColor: "{primary.700}",
            icon: {
              color: "{surface.500}",
              focusColor: "{surface.600}",
              activeColor: "{primary.700}",
            },
          },
        },
      },

      dark: {
        surface: amberSurface,
        primary: {
          color: "{primary.500}",
          // Dark text on an amber fill. White would be 2.6:1.
          contrastColor: "#2a1a0b",
          hoverColor: "{primary.400}",
          activeColor: "{primary.600}",
        },
        highlight: {
          background: "rgba(232, 137, 15, 0.16)",
          focusBackground: "rgba(232, 137, 15, 0.26)",
          color: "{primary.300}",
          focusColor: "{primary.200}",
        },
        text: {
          color: "#f5efe7",
          hoverColor: "#ffffff",
          mutedColor: "#b8aa9a",
          hoverMutedColor: "{surface.300}",
        },
        content: {
          background: "{surface.900}",
          hoverBackground: "#2a231d",
          borderColor: "#3a3129",
        },
        overlay: {
          select: {
            background: "#2a231d",
            borderColor: "#3a3129",
            color: "{text.color}",
          },
          popover: {
            background: "#2a231d",
            borderColor: "#3a3129",
            color: "{text.color}",
          },
          modal: {
            background: "{surface.900}",
            borderColor: "#3a3129",
            color: "{text.color}",
          },
        },
        formField: {
          background: "{surface.900}",
          disabledBackground: "#2a231d",
          filledBackground: "#2a231d",
          filledHoverBackground: "{surface.800}",
          filledFocusBackground: "{surface.900}",
          borderColor: "#3a3129",
          hoverBorderColor: "{surface.700}",
          focusBorderColor: "{primary.400}",
          invalidBorderColor: "#e5605c",
          color: "#f5efe7",
          disabledColor: "{surface.600}",
          placeholderColor: "#8a7d6e",
          invalidPlaceholderColor: "#e5605c",
          floatLabelColor: "#b8aa9a",
          floatLabelFocusColor: "{primary.400}",
          floatLabelActiveColor: "#b8aa9a",
          floatLabelInvalidColor: "#e5605c",
          iconColor: "#8a7d6e",
          shadow: "0 1px 2px 0 rgba(10, 7, 4, 0.4)",
        },
        navigation: {
          item: {
            focusBackground: "#2a231d",
            activeBackground: "rgba(232, 137, 15, 0.14)",
            color: "{text.color}",
            focusColor: "{text.hoverColor}",
            activeColor: "{primary.400}",
            icon: {
              color: "#8a7d6e",
              focusColor: "#b8aa9a",
              activeColor: "{primary.400}",
            },
          },
        },
      },
    },
  },
});

/**
 * Wiring, as the scaffold already has it in web/src/main.ts:
 *
 *   import { DARK_MODE_SELECTOR, amberPreset } from "./theme/amber-preset.ts";
 *
 *   document.documentElement.classList.add(DARK_MODE_SELECTOR.slice(1));
 *
 *   app.use(PrimeVue, {
 *     theme: {
 *       preset: amberPreset,
 *       options: { darkModeSelector: DARK_MODE_SELECTOR, cssLayer: false },
 *     },
 *   });
 *
 * Amber is dark-first, so the class goes on <html> by default and a user
 * preference removes it, rather than the other way around.
 */
