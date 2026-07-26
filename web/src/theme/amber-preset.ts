import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

/**
 * Placeholder amber preset: dark-first, amber primary, built on Aura.
 *
 * The branding pass replaces this with the full brand preset (warm near-black
 * surfaces, honey gradient accents). Keep the export name stable so nothing
 * downstream has to change.
 */
export const amberPalette = {
  50: "#fffbeb",
  100: "#fef3c7",
  200: "#fde68a",
  300: "#fcd34d",
  400: "#fbbf24",
  500: "#f59e0b",
  600: "#d97706",
  700: "#b45309",
  800: "#92400e",
  900: "#78350f",
  950: "#451a03",
} as const;

export const amberPreset = definePreset(Aura, {
  semantic: {
    primary: amberPalette,
    colorScheme: {
      light: {
        primary: {
          color: "{amber.600}",
          contrastColor: "#ffffff",
          hoverColor: "{amber.700}",
          activeColor: "{amber.800}",
        },
      },
      dark: {
        primary: {
          color: "{amber.400}",
          contrastColor: "{amber.950}",
          hoverColor: "{amber.300}",
          activeColor: "{amber.200}",
        },
      },
    },
  },
});

/** Class toggled on <html> to select the dark color scheme. */
export const DARK_MODE_SELECTOR = ".amber-dark";
