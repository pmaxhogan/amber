import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const API_TARGET = process.env.AMBER_DEV_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@amber/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Every page except Repos is a dynamic import, and the repo drawer splits
    // out again on first open. What is left in the entry chunk is Vue, the
    // router, pinia, zod, the PrimeVue runtime and Aura theme, and the
    // DataTable the landing route is built around - roughly 115 kB gzipped,
    // which is the honest floor for this stack rather than something to split
    // further. The limit is raised so a real regression still trips it.
    chunkSizeWarningLimit: 600,
  },
});
