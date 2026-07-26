import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

/**
 * Packaging smoke for the built image.
 *
 * Everything is probed from INSIDE the container with `docker exec`, because
 * insecure mode binds 127.0.0.1 and a published port DNATs to the container's
 * own interface: a host side request would never arrive. The browser flows in
 * smoke.spec.ts cover the UI against the same build running under node, so
 * what is left to prove here is that the image itself carries the binaries and
 * boots.
 *
 * Skipped unless AMBER_E2E_IMAGE names an image, so the suite still runs on a
 * machine with no docker.
 */

const image = process.env.AMBER_E2E_IMAGE;

test.describe("docker image", () => {
  test.skip(image === undefined, "set AMBER_E2E_IMAGE to smoke test a built image");

  let container: string | null = null;

  test.afterAll(async () => {
    if (container !== null) {
      await run("docker", ["rm", "-f", container]).catch(() => undefined);
    }
  });

  test("boots, answers healthz, and carries git, git-lfs and 7z", async () => {
    test.setTimeout(180_000);

    const started = await run("docker", [
      "run",
      "-d",
      "--rm",
      "-e",
      "INSECURE_ALLOW_PUBLIC_ACCESS=1",
      "-e",
      `AMBER_SECRET_KEY=${"a".repeat(64)}`,
      "-e",
      "LOG_LEVEL=warn",
      image!,
    ]);
    container = started.stdout.trim();
    expect(container).not.toBe("");

    const exec = async (...argv: string[]): Promise<string> => {
      const { stdout } = await run("docker", ["exec", container!, ...argv]);
      return stdout.trim();
    };

    expect(await exec("git", "--version")).toContain("git version");
    expect(await exec("git", "lfs", "version")).toContain("git-lfs");
    // p7zip prints its banner on a bare invocation, so ask for something.
    expect(await exec("sh", "-c", "7z i >/dev/null && echo ok")).toBe("ok");

    // The server needs a moment to migrate and bind before healthz answers.
    let health = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      health = await exec("sh", "-c", "curl -fsS http://127.0.0.1:8080/healthz || true");
      if (health.includes('"ok":true')) break;
      await new Promise((done) => setTimeout(done, 2_000));
    }
    expect(health, "healthz never returned ok inside the container").toContain('"ok":true');

    // The image ships the built frontend, so the root has to be the SPA and
    // not a 404 from an API-only server.
    const root = await exec(
      "sh",
      "-c",
      "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true",
    );
    expect(root).toBe("200");
  });
});
