import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";
import type { Plugin } from "vue";
import type { Router } from "vue-router";
import type { ApiClient } from "../../src/api/client.ts";
import { apiKey } from "../../src/api/provide.ts";
import { DARK_MODE_SELECTOR, amberPreset } from "../../src/theme/amber-preset.ts";
import { stubApi } from "./stubApi.ts";

type PluginEntry = Plugin | [Plugin, ...unknown[]];

/**
 * Everything a component under test needs: a fresh pinia, the real PrimeVue
 * theme (its components read the theme config on render), the toast service,
 * and a stubbed API client provided through the injection key.
 */
export function mountGlobals(options: { api?: ApiClient; router?: Router } = {}) {
  const plugins: PluginEntry[] = [
    createPinia(),
    [
      PrimeVue as Plugin,
      {
        theme: {
          preset: amberPreset,
          options: { darkModeSelector: DARK_MODE_SELECTOR, cssLayer: false },
        },
      },
    ],
    ToastService as Plugin,
  ];
  if (options.router !== undefined) plugins.push(options.router as unknown as Plugin);

  return {
    plugins,
    provide: { [apiKey as symbol]: options.api ?? stubApi() },
    stubs: { teleport: true },
  };
}
