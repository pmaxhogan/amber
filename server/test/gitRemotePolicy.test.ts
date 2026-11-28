import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUserByEmail, getAdminUser } from "../src/domain/users.ts";
import { setGitRemoteEnabled } from "../src/gitremote/config.ts";
import { mintGitCredential } from "../src/gitremote/credentials.ts";
import { POLICY_UNAVAILABLE_BODY } from "../src/gitremote/routes.ts";
import {
  ADMIN_EMAIL,
  createAccessKeys,
  FakeClock,
  FakePolicyEndpoint,
  secureEnv,
} from "./helpers/accessFixtures.ts";
import {
  cleanGitEnv,
  createRepoFixture,
  git,
  insertRepoRow,
  startTestServer,
  tempDir,
  type TestServer,
} from "./helpers/gitFixture.ts";

/**
 * The git remote against a REAL policy reader (the Cloudflare source, with a
 * scripted endpoint and a hand-moved clock). /git bypasses Access at the edge,
 * so THE MEMBERSHIP RULE is the only thing standing between a removed user's
 * old password and a clone; these tests drive it through a real git client.
 */

const FRIEND = "friend@example.com";
const SLUG = "fixtures-policy-f6f6f6f6";

let server: TestServer;
let endpoint: FakePolicyEndpoint;
let clock: FakeClock;
let friend: { username: string; password: string };
let admin: { username: string; password: string };
const scratchDirs: string[] = [];

async function clone(credentials: { username: string; password: string }) {
  const dir = tempDir("policy");
  scratchDirs.push(dir);
  const url = `${server.baseUrl.replace(
    "http://",
    `http://${credentials.username}:${credentials.password}@`,
  )}/git/${SLUG}.git`;
  return await git(
    ["-c", "transfer.credentialsInUrl=allow", "clone", "--quiet", url, join(dir, "repo")],
    { env: cleanGitEnv(), timeoutMs: 60_000 },
  );
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function advertise(credentials: { username: string; password: string }) {
  return await fetch(`${server.baseUrl}/git/${SLUG}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: basic(credentials.username, credentials.password) },
  });
}

beforeEach(async () => {
  endpoint = new FakePolicyEndpoint([FRIEND]);
  clock = new FakeClock();
  const keys = await createAccessKeys();
  server = await startTestServer({
    env: secureEnv({ PUBLIC_ORIGIN: "https://amber.example.com" }),
    cfAccessGetKey: keys.getKey,
    accessPolicyFetch: endpoint.fetch,
    now: clock.now,
  });
  // The first read reconciles the users table: FRIEND gets a row.
  expect((await server.app.amber.policy.refresh()).ok).toBe(true);
  const friendRow = findUserByEmail(server.db, FRIEND);
  if (friendRow === undefined) {
    throw new Error("the policy read did not create the friend's row");
  }

  await createRepoFixture(server.backupsDir, SLUG);
  const repoId = insertRepoRow(server.db, { slug: SLUG });
  server.db.run("UPDATE repos SET owner_user_id = ? WHERE id = ?", friendRow.id, repoId);

  setGitRemoteEnabled(server.db, true);
  friend = mintGitCredential(server.db, friendRow.id, { now: clock.now() });
  admin = mintGitCredential(server.db, getAdminUser(server.db).id, { now: clock.now() });
  expect(getAdminUser(server.db).email).toBe(ADMIN_EMAIL);
});

afterEach(async () => {
  await server.close();
  rmSync(server.dataDir, { recursive: true, force: true });
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the git remote under a real access policy", () => {
  it("clones the member's own repository with a real git client", async () => {
    const result = await clone(friend);
    expect(result.code, result.stderr).toBe(0);
  });

  it("keeps serving from a recent copy when one refresh fails", async () => {
    endpoint.fail(500);
    clock.advance(2 * 60_000);
    const result = await clone(friend);
    expect(result.code, result.stderr).toBe(0);
  });

  it("fails closed with a text/plain 503 that git prints to the user", async () => {
    endpoint.fail(500);
    clock.advance(6 * 60_000);

    const response = await advertise(friend);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.text()).toBe(POLICY_UNAVAILABLE_BODY);

    const result = await clone(friend);
    expect(result.code).not.toBe(0);
    // git shows a text/plain error body as "remote: <line>".
    expect(result.stderr).toContain(`remote: ${POLICY_UNAVAILABLE_BODY.trim()}`);
  });

  it("still lets the admin clone while the policy cannot be read", async () => {
    endpoint.fail(500);
    clock.advance(6 * 60_000);
    expect((await advertise(friend)).status).toBe(503);

    const callsBefore = endpoint.calls.length;
    const result = await clone(admin);
    expect(result.code, result.stderr).toBe(0);
    // Exempt, not lucky: the admin's requests never asked the policy.
    expect(endpoint.calls.length).toBe(callsBefore);
  });

  it("refuses a removed member on the very next request, and needs a new mint after return", async () => {
    // FRIEND leaves the policy. No background tick has run: the git request
    // itself finds the copy older than a minute and refreshes it.
    endpoint.members([]);
    clock.advance(61_000);
    const gone = await advertise(friend);
    expect(gone.status).toBe(401);
    expect(findUserByEmail(server.db, FRIEND)).toMatchObject({ hasGitPassword: false });
    expect((await clone(friend)).code).not.toBe(0);

    // Back in the policy: the row is restored, the old password is not.
    endpoint.members([FRIEND]);
    clock.advance(61_000);
    expect((await server.app.amber.policy.refresh()).ok).toBe(true);
    expect(findUserByEmail(server.db, FRIEND)).toMatchObject({ removedAt: null });
    expect((await advertise(friend)).status).toBe(401);

    const renewed = mintGitCredential(server.db, findUserByEmail(server.db, FRIEND)!.id, {
      now: clock.now(),
    });
    expect(renewed.username).toBe(friend.username);
    const result = await clone(renewed);
    expect(result.code, result.stderr).toBe(0);
  });
});
