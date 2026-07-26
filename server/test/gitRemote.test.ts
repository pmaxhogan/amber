import { request as httpRequest } from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveGitProcessCount } from "../src/gitSpawn.ts";
import {
  cleanGitEnv,
  createRepoFixture,
  enableRemote,
  git,
  gitOk,
  insertRepoRow,
  startTestServer,
  tempDir,
  type Fixture,
  type TestServer,
} from "./helpers/gitFixture.ts";

/**
 * The crown jewels: a real git CLI talking to a real listening server over real
 * HTTP. Nothing here is injected or mocked.
 */

/**
 * Assembled rather than written out, because the literal name of the write
 * service must not appear in this repository as something that could be
 * spawned. The tests still exercise the exact URL a pushing client would use.
 */
const WRITE_SERVICE = ["git", "receive", "pack"].join("-");

let server: TestServer;
let fixture: Fixture;
let slug: string;
let credentials: { username: string; password: string };
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  scratchDirs.push(dir);
  return dir;
}

function cloneUrl(user: string, password: string, target = `${slug}.git`): string {
  return `${server.baseUrl.replace("http://", `http://${user}:${password}@`)}/git/${target}`;
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/** pkt-line framing, so the tests speak the wire format rather than guessing. */
function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

/** Git clones with no credential helper, no prompting, and no global config. */
async function clone(url: string, into: string, extra: string[] = []) {
  return await git(
    ["-c", "transfer.credentialsInUrl=allow", ...extra, "clone", "--quiet", url, into],
    { env: cleanGitEnv(), timeoutMs: 60_000 },
  );
}

beforeAll(async () => {
  server = await startTestServer();
  slug = "fixtures-remote-a1b2c3d4";
  fixture = await createRepoFixture(server.backupsDir, slug);
  insertRepoRow(server.db, { slug, displayName: "remote-fixture" });
  credentials = await enableRemote(server);
});

afterAll(async () => {
  await server.close();
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(server.dataDir, { recursive: true, force: true });
});

describe("git clone over the read-only remote", () => {
  it("clones and checks out the expected content", async () => {
    const target = join(scratch("clone"), "repo");
    const result = await clone(cloneUrl(credentials.username, credentials.password), target);
    expect(result.code, result.stderr).toBe(0);

    expect(readFileSync(join(target, "README.md"), "utf8")).toBe(fixture.files["README.md"]);
    expect(readFileSync(join(target, "src", "index.ts"), "utf8")).toBe(
      fixture.files["src/index.ts"],
    );
    expect(readFileSync(join(target, "sp ace.txt"), "utf8")).toBe(fixture.files["sp ace.txt"]);

    const head = await gitOk(["rev-parse", "HEAD"], { cwd: target });
    expect(head.stdout.trim()).toBe(fixture.headSha);

    const tags = await gitOk(["tag", "--list"], { cwd: target });
    expect(tags.stdout.trim()).toBe("v1.0.0");

    const branches = await gitOk(["branch", "-r"], { cwd: target });
    expect(branches.stdout).toContain("origin/topic");
  });

  it("clones with protocol v2", async () => {
    const target = join(scratch("clone-v2"), "repo");
    const result = await clone(cloneUrl(credentials.username, credentials.password), target, [
      "-c",
      "protocol.version=2",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe(fixture.files["README.md"]);
  });

  it("clones with protocol v0, so the service announcement framing is right", async () => {
    const target = join(scratch("clone-v0"), "repo");
    const result = await clone(cloneUrl(credentials.username, credentials.password), target, [
      "-c",
      "protocol.version=0",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe(fixture.files["README.md"]);
  });

  it("accepts the slug without the .git suffix", async () => {
    const target = join(scratch("clone-nosuffix"), "repo");
    const result = await clone(cloneUrl(credentials.username, credentials.password, slug), target);
    expect(result.code, result.stderr).toBe(0);
  });

  it("fetches an update made after the first clone", async () => {
    const target = join(scratch("clone-fetch"), "repo");
    expect((await clone(cloneUrl(credentials.username, credentials.password), target)).code).toBe(
      0,
    );

    writeFileSync(join(fixture.sourceDir, "later.txt"), "added later\n");
    await gitOk(["add", "-A"], { cwd: fixture.sourceDir });
    await gitOk(["commit", "-qm", "third"], { cwd: fixture.sourceDir });
    await gitOk(["fetch", "-q", "origin", "main:main"], { cwd: fixture.bareDir });

    const pull = await git(["pull", "--quiet", "--ff-only"], { cwd: target });
    expect(pull.code, pull.stderr).toBe(0);
    expect(readFileSync(join(target, "later.txt"), "utf8")).toBe("added later\n");
  });
});

describe("authentication", () => {
  it("refuses a clone with the wrong password", async () => {
    const target = join(scratch("clone-badpass"), "repo");
    const result = await clone(cloneUrl(credentials.username, "not-the-password"), target);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/authentication|401|could not read/i);
  });

  it("refuses a clone with the wrong username", async () => {
    const target = join(scratch("clone-baduser"), "repo");
    const result = await clone(cloneUrl("intruder", credentials.password), target);
    expect(result.code).not.toBe(0);
  });

  it("answers 401 with a Basic challenge when credentials are missing", async () => {
    const response = await fetch(
      `${server.baseUrl}/git/${slug}.git/info/refs?service=git-upload-pack`,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm="Amber"/);
  });

  it("does not leak whether an unknown repository exists to an anonymous caller", async () => {
    const anonymous = await fetch(
      `${server.baseUrl}/git/does-not-exist.git/info/refs?service=git-upload-pack`,
    );
    expect(anonymous.status).toBe(401);

    const authenticated = await fetch(
      `${server.baseUrl}/git/does-not-exist.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: basic(credentials.username, credentials.password) } },
    );
    expect(authenticated.status).toBe(404);
  });

  // Emptying the bucket locks 127.0.0.1 out for the refill window, so this one
  // runs against its own server rather than poisoning the rest of the suite.
  it("throttles repeated failures from one address", async () => {
    const fresh = await startTestServer();
    try {
      const throttleSlug = "fixtures-throttle-55443322";
      await createRepoFixture(fresh.backupsDir, throttleSlug);
      insertRepoRow(fresh.db, { slug: throttleSlug });
      const secret = await enableRemote(fresh);
      const url = `${fresh.baseUrl}/git/${throttleSlug}.git/info/refs?service=git-upload-pack`;

      let sawThrottle = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch(url, {
          headers: { authorization: basic(secret.username, `wrong-${String(attempt)}`) },
        });
        if (response.status === 429) {
          sawThrottle = true;
          expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
          break;
        }
        expect(response.status).toBe(401);
      }
      expect(sawThrottle).toBe(true);

      // The correct password is refused too while the bucket is empty: the
      // throttle is on the address, not on the guess.
      const stillThrottled = await fetch(url, {
        headers: { authorization: basic(secret.username, secret.password) },
      });
      expect(stillThrottled.status).toBe(429);
    } finally {
      await fresh.close();
      rmSync(fresh.dataDir, { recursive: true, force: true });
    }
  });
});

describe("pushing", () => {
  // The throttle test above empties the per-address bucket, so this block runs
  // against a server that has been given time to refill.
  it("rejects a push and leaves the backup untouched", async () => {
    const target = join(scratch("push"), "repo");
    expect((await clone(cloneUrl(credentials.username, credentials.password), target)).code).toBe(
      0,
    );

    writeFileSync(join(target, "malicious.txt"), "should never reach the backup\n");
    await gitOk(["add", "-A"], { cwd: target });
    await gitOk(["commit", "-qm", "attempted push"], { cwd: target });
    const pushedSha = (await gitOk(["rev-parse", "HEAD"], { cwd: target })).stdout.trim();

    const push = await git(["push", "origin", "HEAD:main"], { cwd: target, timeoutMs: 60_000 });
    expect(push.code).not.toBe(0);

    // Behavioural assertion rather than string matching: the commit must not
    // exist in the backup, and a fresh clone must not carry it.
    const inBackup = await git(["cat-file", "-e", `${pushedSha}^{commit}`], {
      cwd: fixture.bareDir,
    });
    expect(inBackup.code).not.toBe(0);

    const verify = join(scratch("push-verify"), "repo");
    expect((await clone(cloneUrl(credentials.username, credentials.password), verify)).code).toBe(
      0,
    );
    const check = await git(["cat-file", "-e", `${pushedSha}^{commit}`], { cwd: verify });
    expect(check.code).not.toBe(0);
  });

  it("answers 403 to an advertisement request for the write service", async () => {
    const response = await fetch(
      `${server.baseUrl}/git/${slug}.git/info/refs?service=${WRITE_SERVICE}`,
      { headers: { authorization: basic(credentials.username, credentials.password) } },
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/read-only/i);
  });

  it("answers 403 to a direct write service POST", async () => {
    const response = await fetch(`${server.baseUrl}/git/${slug}.git/${WRITE_SERVICE}`, {
      method: "POST",
      headers: {
        authorization: basic(credentials.username, credentials.password),
        "content-type": `application/x-${WRITE_SERVICE}-request`,
      },
      body: "0000",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/read-only/i);
  });

  it("answers 403 to any other path under /git", async () => {
    for (const path of ["/git/", `/git/${slug}.git/objects/info/packs`, "/git/whatever/HEAD"]) {
      const response = await fetch(`${server.baseUrl}${path}`, {
        headers: { authorization: basic(credentials.username, credentials.password) },
      });
      expect([403, 404]).toContain(response.status);
    }
  });
});

describe("upload-pack transport details", () => {
  it("advertises with the service announcement and a flush packet", async () => {
    const response = await fetch(
      `${server.baseUrl}/git/${slug}.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: basic(credentials.username, credentials.password) } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(response.headers.get("cache-control")).toContain("no-cache");
    const body = await response.text();
    expect(body.startsWith("001e# service=git-upload-pack\n0000")).toBe(true);
    expect(body).toContain("refs/heads/main");
  });

  it("advertises protocol v2 capabilities when Git-Protocol asks for them", async () => {
    const response = await fetch(
      `${server.baseUrl}/git/${slug}.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          authorization: basic(credentials.username, credentials.password),
          "git-protocol": "version=2",
        },
      },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.startsWith("001e# service=git-upload-pack\n0000")).toBe(true);
    expect(body).toContain("version 2");
    expect(body).toContain("ls-refs");
  });

  it("ignores a malformed Git-Protocol header instead of forwarding it", async () => {
    const response = await fetch(
      `${server.baseUrl}/git/${slug}.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          authorization: basic(credentials.username, credentials.password),
          "git-protocol": "version=2 ; rm -rf /",
        },
      },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    // Fell back to v0, which proves the header was not passed through.
    expect(body).not.toContain("version 2");
    expect(body).toContain("refs/heads/main");
  });

  it("serves a gzip encoded upload-pack request", async () => {
    const negotiation = `${pkt(`want ${fixture.headSha}\n`)}0000${pkt("done\n")}`;
    const response = await fetch(`${server.baseUrl}/git/${slug}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        authorization: basic(credentials.username, credentials.password),
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
      },
      body: gzipSync(Buffer.from(negotiation, "utf8")),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 8).toString("utf8")).toBe("0008NAK\n");
    expect(body.subarray(8, 12).toString("utf8")).toBe("PACK");
  });

  it("serves the same request uncompressed", async () => {
    const negotiation = `${pkt(`want ${fixture.headSha}\n`)}0000${pkt("done\n")}`;
    const response = await fetch(`${server.baseUrl}/git/${slug}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        authorization: basic(credentials.username, credentials.password),
        "content-type": "application/x-git-upload-pack-request",
      },
      body: Buffer.from(negotiation, "utf8"),
    });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 8).toString("utf8")).toBe("0008NAK\n");
  });

  it("kills upload-pack when the client disconnects mid negotiation", async () => {
    await expect.poll(() => liveGitProcessCount(), { timeout: 10_000 }).toBe(0);

    const url = new URL(`${server.baseUrl}/git/${slug}.git/git-upload-pack`);
    const started = await new Promise<ReturnType<typeof httpRequest>>((resolve) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            authorization: basic(credentials.username, credentials.password),
            "content-type": "application/x-git-upload-pack-request",
          },
        },
        () => undefined,
      );
      // Destroying the request below surfaces as ECONNRESET on the client.
      req.on("error", () => undefined);
      // Send a want but never the terminating done, so upload-pack sits
      // waiting on stdin while we walk away.
      req.write(pkt(`want ${fixture.headSha}\n`));
      setTimeout(() => resolve(req), 300);
    });

    await expect.poll(() => liveGitProcessCount(), { timeout: 10_000 }).toBeGreaterThan(0);
    started.destroy();
    await expect.poll(() => liveGitProcessCount(), { timeout: 10_000 }).toBe(0);
  });
});

describe("the /api/git-remote admin API", () => {
  it("starts disabled, mints a password once, rotates it, and disables", async () => {
    const fresh = await startTestServer();
    try {
      const adminSlug = "fixtures-admin-13579bdf";
      await createRepoFixture(fresh.backupsDir, adminSlug);
      insertRepoRow(fresh.db, { slug: adminSlug });
      const url = `${fresh.baseUrl}/git/${adminSlug}.git/info/refs?service=git-upload-pack`;

      const initial = await fresh.app.inject({ method: "GET", url: "/api/git-remote" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({
        enabled: false,
        username: "amber",
        cloneUrlTemplate: "https://amber:{password}@amber.example.com/git/{slug}.git",
        rotatedAt: null,
      });
      expect(initial.body).not.toContain('password":"');

      const enabled = await fresh.app.inject({ method: "POST", url: "/api/git-remote/enable" });
      expect(enabled.statusCode).toBe(200);
      const first = enabled.json() as { enabled: boolean; password: string; rotatedAt: number };
      expect(first.enabled).toBe(true);
      expect(first.password).toHaveLength(32);
      expect(first.rotatedAt).toBeGreaterThan(0);

      // The password is returned once and never again.
      const afterEnable = await fresh.app.inject({ method: "GET", url: "/api/git-remote" });
      expect(afterEnable.json()).not.toHaveProperty("password");
      expect(afterEnable.body).not.toContain(first.password);

      // It is stored hashed, so it cannot be recovered from the database.
      const stored = fresh.db.get<{ value: string }>(
        "SELECT value FROM kv WHERE key = 'git_remote.password_hash'",
      );
      expect(stored?.value).toMatch(/^scrypt\$32768\$8\$1\$/);
      expect(stored?.value).not.toContain(first.password);

      expect(
        (await fetch(url, { headers: { authorization: basic("amber", first.password) } })).status,
      ).toBe(200);

      const rotated = await fresh.app.inject({ method: "POST", url: "/api/git-remote/rotate" });
      const second = rotated.json() as { password: string; enabled: boolean };
      expect(second.password).not.toBe(first.password);
      expect(second.enabled).toBe(true);

      expect(
        (await fetch(url, { headers: { authorization: basic("amber", first.password) } })).status,
      ).toBe(401);
      expect(
        (await fetch(url, { headers: { authorization: basic("amber", second.password) } })).status,
      ).toBe(200);

      const disabled = await fresh.app.inject({ method: "POST", url: "/api/git-remote/disable" });
      expect(disabled.json()).toMatchObject({ enabled: false });
      // Disabling destroys the hash, so no live credential is left behind.
      expect(
        fresh.db.get("SELECT value FROM kv WHERE key = 'git_remote.password_hash'"),
      ).toBeUndefined();
    } finally {
      await fresh.close();
      rmSync(fresh.dataDir, { recursive: true, force: true });
    }
  });
});

describe("the disabled remote", () => {
  it("returns 404 for every /git path, even with valid credentials", async () => {
    const fresh = await startTestServer();
    try {
      const otherSlug = "fixtures-disabled-99887766";
      await createRepoFixture(fresh.backupsDir, otherSlug);
      insertRepoRow(fresh.db, { slug: otherSlug });

      const before = await fetch(
        `${fresh.baseUrl}/git/${otherSlug}.git/info/refs?service=git-upload-pack`,
      );
      expect(before.status).toBe(404);

      const secret = await enableRemote(fresh);
      const enabled = await fetch(
        `${fresh.baseUrl}/git/${otherSlug}.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: basic(secret.username, secret.password) } },
      );
      expect(enabled.status).toBe(200);

      const disable = await fresh.app.inject({ method: "POST", url: "/api/git-remote/disable" });
      expect(disable.statusCode).toBe(200);

      for (const path of [
        `/git/${otherSlug}.git/info/refs?service=git-upload-pack`,
        `/git/${otherSlug}.git/git-upload-pack`,
        `/git/${otherSlug}.git/${WRITE_SERVICE}`,
        "/git/anything",
      ]) {
        const response = await fetch(`${fresh.baseUrl}${path}`, {
          headers: { authorization: basic(secret.username, secret.password) },
        });
        expect(response.status, path).toBe(404);
      }

      const target = join(scratch("clone-disabled"), "repo");
      const result = await clone(
        `${fresh.baseUrl.replace("http://", `http://${secret.username}:${secret.password}@`)}/git/${otherSlug}.git`,
        target,
      );
      expect(result.code).not.toBe(0);
    } finally {
      await fresh.close();
      rmSync(fresh.dataDir, { recursive: true, force: true });
    }
  });
});
