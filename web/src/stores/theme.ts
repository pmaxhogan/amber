import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { DARK_MODE_SELECTOR } from "../theme/amber-preset.ts";

export const THEME_STORAGE_KEY = "amber.color-scheme";

const DARK_CLASS = DARK_MODE_SELECTOR.slice(1);

function readStoredPreference(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (stored === "light") return false;
    if (stored === "dark") return true;
  } catch {
    // Private-mode storage denial is not worth a broken app.
  }
  return true;
}

/**
 * Amber is dark-first: the dark class sits on <html> from boot and a stored
 * light preference removes it, not the other way around.
 */
export const useThemeStore = defineStore("theme", () => {
  const dark = ref(readStoredPreference());

  function apply(): void {
    const root = globalThis.document?.documentElement;
    if (root === undefined) return;
    root.classList.toggle(DARK_CLASS, dark.value);
    root.style.colorScheme = dark.value ? "dark" : "light";
  }

  watch(
    dark,
    (value) => {
      apply();
      try {
        globalThis.localStorage?.setItem(THEME_STORAGE_KEY, value ? "dark" : "light");
      } catch {
        // Ignore: the toggle still works for this session.
      }
    },
    { immediate: true },
  );

  function toggle(): void {
    dark.value = !dark.value;
  }

  return { dark, toggle };
});
