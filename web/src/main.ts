import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import App from "./App.vue";
import { router } from "./router/index.ts";
import { DARK_MODE_SELECTOR, amberPreset } from "./theme/amber-preset.ts";
import "./assets/main.css";

// Dark is the default. A later pass adds a persisted light/dark toggle.
document.documentElement.classList.add(DARK_MODE_SELECTOR.slice(1));

createApp(App)
  .use(createPinia())
  .use(router)
  .use(PrimeVue, {
    theme: {
      preset: amberPreset,
      options: {
        darkModeSelector: DARK_MODE_SELECTOR,
        cssLayer: false,
      },
    },
  })
  .mount("#app");
