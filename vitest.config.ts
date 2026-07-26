import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSrc = fileURLToPath(new URL("./shared/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@amber/shared": sharedSrc } },
        test: {
          name: "shared",
          root: "./shared",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: { "@amber/shared": sharedSrc } },
        test: {
          name: "server",
          root: "./server",
          environment: "node",
          include: ["test/**/*.test.ts"],
          // Integration tests create real git repos and sqlite files in temp dirs.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      "./web/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["shared/src/**/*.ts", "server/src/**/*.ts", "web/src/**/*.{ts,vue}"],
      exclude: [
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
        "shared/src/index.ts",
        "web/src/main.ts",
      ],
    },
  },
});
