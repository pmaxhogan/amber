import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke suite against the built Docker image.
 *
 * Reaching it needs a decision that is still open. INSECURE_ALLOW_PUBLIC_ACCESS
 * binds 127.0.0.1 inside the container, and a published port DNATs to the
 * container's own interface, so `docker run -p 8080:8080` plus a host-side
 * request cannot work. build-image.yml sidesteps this by probing with
 * `docker exec`, which is fine for curl but not for a browser.
 *
 * Whoever enables these tests picks one of: run the container with
 * `--network host`, run Playwright inside the container, or stand up a real
 * Cloudflare Access setup and drop the insecure flag.
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
