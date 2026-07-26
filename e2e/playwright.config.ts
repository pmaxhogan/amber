import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke suite for the real server.
 *
 * INSECURE_ALLOW_PUBLIC_ACCESS binds 127.0.0.1 inside the process, which is
 * exactly what a browser on the same host wants and exactly what a published
 * container port cannot reach: `docker run -p 8080:8080` DNATs to the
 * container's own interface, so a host side request never arrives. The UI
 * flows therefore drive the built server directly under node, and the image is
 * smoke tested from inside the container instead (tests/dockerImage.spec.ts),
 * which covers the packaging without fighting the loopback bind.
 *
 * Every run gets a fresh DATA_DIR, so a database left over from an earlier run
 * can never make a test pass that should have failed.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.AMBER_E2E_PORT ?? 8099);
const baseURL = process.env.AMBER_E2E_BASE_URL ?? `http://127.0.0.1:${String(port)}`;
const dataDir = process.env.AMBER_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "amber-e2e-"));

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  // A first clone over the network is the slowest thing in here.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node server/dist/index.js",
    cwd: repoRoot,
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: dataDir,
      PORT: String(port),
      PUBLIC_ORIGIN: baseURL,
      // A throwaway key: this instance stores no real credentials.
      AMBER_SECRET_KEY: "a".repeat(64),
      LOG_LEVEL: "warn",
    },
  },
});
