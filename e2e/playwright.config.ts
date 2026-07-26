import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke suite. It runs against the built Docker image started with
 * INSECURE_ALLOW_PUBLIC_ACCESS=1, which binds 127.0.0.1 inside the container,
 * so the compose file publishes the port and the tests talk to localhost.
 */
const baseURL = process.env.AMBER_E2E_BASE_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
