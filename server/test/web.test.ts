import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AmberApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { TEST_SECRET_KEY } from "./helpers.ts";

/**
 * Serving the built frontend.
 *
 * The image copies web/dist in and the server has to hand it out, otherwise
 * every deployment answers 404 at the root with the whole app sitting on disk
 * one directory over.
 */

const INDEX_HTML = "<!doctype html><title>Amber</title><div id=app></div>";

let dir: string;
let webDir: string;
let db: Db;
let app: AmberApp | null;

async function build(withFrontend: boolean): Promise<AmberApp> {
  if (withFrontend) {
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), INDEX_HTML);
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "export const amber = 1;\n");
  }
  const config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: dir,
    AMBER_SECRET_KEY: TEST_SECRET_KEY,
    WEB_DIST_DIR: webDir,
  });
  const log = createConsoleLogger("silent");
  db = openDb(config.dbPath);
  migrate(db, log);
  app = await buildApp({ config, log, db, version: "9.9.9-test" });
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amber-web-"));
  webDir = join(dir, "web-dist");
  app = null;
});

afterEach(async () => {
  await app?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("with a built frontend on disk", () => {
  it("serves index.html at the root", async () => {
    const instance = await build(true);
    const response = await instance.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>Amber</title>");
  });

  it("serves a fingerprinted asset with a long lived cache header", async () => {
    const instance = await build(true);
    const response = await instance.inject({ method: "GET", url: "/assets/app-abc123.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("max-age=31536000");
  });

  it("answers client side routes with index.html so deep links work", async () => {
    const instance = await build(true);
    for (const url of ["/settings", "/accounts", "/about", "/settings/deep/link"]) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain("<title>Amber</title>");
    }
  });

  it("never caches index.html, which is not fingerprinted", async () => {
    const instance = await build(true);
    const response = await instance.inject({ method: "GET", url: "/settings" });
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("serves the git remote PAGE while leaving the git remote ROUTES alone", async () => {
    const instance = await build(true);

    // "/git-remote" is a page in the app. A prefix test on "/git" swallows it,
    // which is why the boundary is a path separator.
    const page = await instance.inject({ method: "GET", url: "/git-remote" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>Amber</title>");

    // "/git/..." belongs to the read-only remote, which is disabled by
    // default: a 404 from the remote, never the SPA shell.
    const remote = await instance.inject({ method: "GET", url: "/git/anything.git/info/refs" });
    expect(remote.body).not.toContain("<title>Amber</title>");
  });

  it("keeps unmatched API paths as JSON 404s rather than serving HTML", async () => {
    const instance = await build(true);
    const response = await instance.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("<title>Amber</title>");
    expect(response.json()).toMatchObject({ error: expect.any(String) });
  });

  it("does not answer a non-GET with the app shell", async () => {
    const instance = await build(true);
    const response = await instance.inject({ method: "POST", url: "/settings" });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("<title>Amber</title>");
  });

  it("still answers healthz from the server, not the shell", async () => {
    const instance = await build(true);
    const response = await instance.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: "9.9.9-test" });
  });
});

describe("without a built frontend", () => {
  it("serves the API and 404s the root instead of failing to boot", async () => {
    const instance = await build(false);

    expect((await instance.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await instance.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(200);
    expect((await instance.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});
