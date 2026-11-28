import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail, reconcileUsers, updateUser } from "../src/domain/users.ts";
import { mintGitCredential } from "../src/gitremote/credentials.ts";
import { asUser } from "./helpers/accessFixtures.ts";
import {
  cleanGitEnv,
  createRepoFixture,
  enableRemote,
  git,
  insertRepoRow,
  mintRemoteCredential,
  startTestServer,
  tempDir,
  type Fixture,
  type TestServer,
} from "./helpers/gitFixture.ts";

/**
 * The per-user git remote over real HTTP, in insecure mode with a stand-in
 * user list. Each user mints their own credential through the API, and the
 * remote serves exactly the repositories canView lets that user see. The
 * policy-failure paths need a real (secure) policy reader and live in
 * gitRemotePolicy.test.ts.
 */

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const NOGIT = "nogit@example.com";

let server: TestServer;
let alicePrivate: Fixture;
const slugs = {
  alicePrivate: "fixtures-alice-priv-a1a1a1a1",
  bobPrivate: "fixtures-bob-priv-b2b2b2b2",
  bobPublic: "fixtures-bob-pub-c3c3c3c3",
  unsynced: "fixtures-alice-new-d4d4d4d4",
};
let alice: { username: string; password: string };
let bob: { username: string; password: string };
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  scratchDirs.push(dir);
  return dir;
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function idOf(email: string): number {
  const user = findUserByEmail(server.db, email);
  if (user === undefined) {
    throw new Error(`no row for ${email}`);
  }
  return user.id;
}

function own(repoId: number, email: string, isPrivate: boolean): void {
  server.db.run(
    "UPDATE repos SET owner_user_id = ?, is_private = ? WHERE id = ?",
    idOf(email),
    isPrivate ? 1 : 0,
    repoId,
  );
}

function advertisementUrl(slug: string): string {
  return `${server.baseUrl}/git/${slug}.git/info/refs?service=git-upload-pack`;
}

async function clone(slug: string, credentials: { username: string; password: string }) {
  const target = join(scratch("peruser"), "repo");
  const url = `${server.baseUrl.replace(
    "http://",
    `http://${credentials.username}:${credentials.password}@`,
  )}/git/${slug}.git`;
  const result = await git(
    ["-c", "transfer.credentialsInUrl=allow", "clone", "--quiet", url, target],
    { env: cleanGitEnv(), timeoutMs: 60_000 },
  );
  return { ...result, target };
}

/** Everything a client can observe about a response, for byte-for-byte comparisons. */
async function observe(response: Response) {
  const headers = Object.fromEntries(
    [...response.headers.entries()].filter(([name]) => name !== "date"),
  );
  return { status: response.status, headers, body: await response.text() };
}

beforeAll(async () => {
  server = await startTestServer({ env: { INSECURE_USER_EMAILS: `${ALICE},${BOB},${NOGIT}` } });
  alicePrivate = await createRepoFixture(server.backupsDir, slugs.alicePrivate);
  await createRepoFixture(server.backupsDir, slugs.bobPrivate);
  await createRepoFixture(server.backupsDir, slugs.bobPublic);
  own(insertRepoRow(server.db, { slug: slugs.alicePrivate }), ALICE, true);
  own(insertRepoRow(server.db, { slug: slugs.bobPrivate }), BOB, true);
  own(insertRepoRow(server.db, { slug: slugs.bobPublic }), BOB, false);
  // A row with no directory yet: its "not backed up yet" answer must only
  // ever reach someone who can view it.
  own(insertRepoRow(server.db, { slug: slugs.unsynced }), ALICE, true);

  alice = await enableRemote(server, asUser(ALICE));
  bob = await mintRemoteCredential(server, asUser(BOB));
});

afterAll(async () => {
  await server.close();
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(server.dataDir, { recursive: true, force: true });
});

describe("per-user credentials", () => {
  it("gives each user their own username", () => {
    expect(alice.username).toMatch(/^[a-z0-9]{10}$/);
    expect(bob.username).toMatch(/^[a-z0-9]{10}$/);
    expect(alice.username).not.toBe(bob.username);
  });

  it("clones a repository the user owns, with a real git client", async () => {
    const result = await clone(slugs.alicePrivate, alice);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(result.target, "README.md"), "utf8")).toBe(
      alicePrivate.files["README.md"],
    );
  });

  it("clones another user's public repository with view_others_public", async () => {
    const result = await clone(slugs.bobPublic, alice);
    expect(result.code, result.stderr).toBe(0);
  });

  it("does not clone another user's private repository", async () => {
    const result = await clone(slugs.bobPrivate, alice);
    expect(result.code).not.toBe(0);
    // And the owner still can.
    expect((await clone(slugs.bobPrivate, bob)).code).toBe(0);
  });

  it("answers an invisible repository exactly like an unknown slug", async () => {
    const headers = { authorization: basic(alice.username, alice.password) };
    const invisible = await observe(await fetch(advertisementUrl(slugs.bobPrivate), { headers }));
    const unknown = await observe(
      await fetch(advertisementUrl("fixtures-nope-e5e5e5e5"), { headers }),
    );
    expect(invisible.status).toBe(404);
    expect(invisible).toEqual(unknown);

    // The pack endpoint too, which a client could hit directly.
    const post = (slug: string) =>
      fetch(`${server.baseUrl}/git/${slug}.git/git-upload-pack`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-git-upload-pack-request" },
        body: "0000",
      });
    expect(await observe(await post(slugs.bobPrivate))).toEqual(
      await observe(await post("fixtures-nope-e5e5e5e5")),
    );
  });

  it("keeps an invisible repository's backup state to itself", async () => {
    const bobHeaders = { authorization: basic(bob.username, bob.password) };
    const unsynced = await observe(
      await fetch(advertisementUrl(slugs.unsynced), { headers: bobHeaders }),
    );
    const unknown = await observe(
      await fetch(advertisementUrl("fixtures-nope-e5e5e5e5"), { headers: bobHeaders }),
    );
    expect(unsynced).toEqual(unknown);

    // The owner is told the truth.
    const owner = await fetch(advertisementUrl(slugs.unsynced), {
      headers: { authorization: basic(alice.username, alice.password) },
    });
    expect(owner.status).toBe(404);
    expect(await owner.text()).toMatch(/not been backed up yet/);
  });

  it("does not let one user's password open another user's username", async () => {
    const response = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(bob.username, alice.password) },
    });
    expect(response.status).toBe(401);
  });
});

describe("refusals are indistinguishable", () => {
  it("answers an unknown username and a wrong password identically", async () => {
    const wrongPassword = await observe(
      await fetch(advertisementUrl(slugs.alicePrivate), {
        headers: { authorization: basic(alice.username, "not-the-password") },
      }),
    );
    const unknownUser = await observe(
      await fetch(advertisementUrl(slugs.alicePrivate), {
        headers: { authorization: basic("zzzzzzzzzz", alice.password) },
      }),
    );
    const malformedUser = await observe(
      await fetch(advertisementUrl(slugs.alicePrivate), {
        headers: { authorization: basic("intruder", alice.password) },
      }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.headers["www-authenticate"]).toMatch(/^Basic realm="Amber"/);
    expect(unknownUser).toEqual(wrongPassword);
    expect(malformedUser).toEqual(wrongPassword);
    // Success clears the address, so later tests start with a full budget.
    expect((await clone(slugs.alicePrivate, alice)).code).toBe(0);
  });

  it("refuses a user without git like a wrong password, and their API gets the coarse 403", async () => {
    const id = idOf(NOGIT);
    // Minted while they still had the permission, then it was taken away.
    const minted = mintGitCredential(server.db, id);
    updateUser(server.db, id, { permissions: { git: false } });

    const refused = await observe(
      await fetch(advertisementUrl(slugs.bobPublic), {
        headers: { authorization: basic(minted.username, minted.password) },
      }),
    );
    const wrong = await observe(
      await fetch(advertisementUrl(slugs.bobPublic), {
        headers: { authorization: basic(minted.username, "not-the-password") },
      }),
    );
    expect(refused.status).toBe(401);
    expect(refused).toEqual(wrong);

    for (const [method, url] of [
      ["GET", "/api/git-remote"],
      ["POST", "/api/git-remote/rotate"],
      ["POST", "/api/git-remote/revoke"],
    ] as const) {
      const response = await server.app.inject({ method, url, headers: asUser(NOGIT) });
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toMatchObject({ details: { permission: "git" } });
    }
    expect((await clone(slugs.alicePrivate, alice)).code).toBe(0);
  });

  it("refuses a non-member like a wrong password", async () => {
    // A row the stand-in list does not name: membership says not_member.
    const now = Date.now();
    const id = server.db.run(
      `INSERT INTO users (email, is_admin, permissions, created_at, updated_at)
       VALUES ('stray@example.com', 0, '{}', ?, ?)`,
      now,
      now,
    ).lastInsertRowid;
    const minted = mintGitCredential(server.db, id);
    const response = await observe(
      await fetch(advertisementUrl(slugs.bobPublic), {
        headers: { authorization: basic(minted.username, minted.password) },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.body).toBe("Authentication required.\n");
    expect((await clone(slugs.alicePrivate, alice)).code).toBe(0);
  });
});

describe("the credential lifecycle at the git layer", () => {
  it("stops the old password the moment the user rotates, and keeps the username", async () => {
    const before = await mintRemoteCredential(server, asUser(BOB));
    const after = await mintRemoteCredential(server, asUser(BOB));
    expect(after.username).toBe(before.username);
    expect(after.username).toBe(bob.username);

    const old = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(before.username, before.password) },
    });
    expect(old.status).toBe(401);
    const fresh = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(after.username, after.password) },
    });
    expect(fresh.status).toBe(200);
    bob = after;
  });

  it("stops a revoked credential", async () => {
    const revoke = await server.app.inject({
      method: "POST",
      url: "/api/git-remote/revoke",
      headers: asUser(BOB),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ username: bob.username, hasPassword: false });
    const response = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(bob.username, bob.password) },
    });
    expect(response.status).toBe(401);
    bob = await mintRemoteCredential(server, asUser(BOB));
  });

  it("kills the credential when the email leaves, and does not revive it when it returns", async () => {
    reconcileUsers(server.db, [ALICE, NOGIT]);
    const gone = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(bob.username, bob.password) },
    });
    expect(gone.status).toBe(401);

    reconcileUsers(server.db, [ALICE, BOB, NOGIT]);
    const back = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(bob.username, bob.password) },
    });
    expect(back.status).toBe(401);

    const renewed = await mintRemoteCredential(server, asUser(BOB));
    expect(renewed.username).toBe(bob.username);
    const ok = await fetch(advertisementUrl(slugs.bobPrivate), {
      headers: { authorization: basic(renewed.username, renewed.password) },
    });
    expect(ok.status).toBe(200);
    bob = renewed;
  });
});

describe("the kill switch", () => {
  it("needs manage_settings, and 404s everything while off", async () => {
    const refused = await server.app.inject({
      method: "POST",
      url: "/api/git-remote/disable",
      headers: asUser(ALICE),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ details: { permission: "manage_settings" } });

    const off = await server.app.inject({ method: "POST", url: "/api/git-remote/disable" });
    expect(off.statusCode).toBe(200);
    try {
      const response = await fetch(advertisementUrl(slugs.alicePrivate), {
        headers: { authorization: basic(alice.username, alice.password) },
      });
      expect(response.status).toBe(404);
      const me = await server.app.inject({
        method: "GET",
        url: "/api/git-remote",
        headers: asUser(ALICE),
      });
      expect(me.json()).toMatchObject({ enabled: false, hasPassword: true });
    } finally {
      await server.app.inject({ method: "POST", url: "/api/git-remote/enable" });
    }
    expect((await clone(slugs.alicePrivate, alice)).code).toBe(0);
  });
});

describe("the rest of the /git namespace", () => {
  const WRITE_SERVICE = ["git", "receive", "pack"].join("-");

  it("authenticates before explaining that the remote is read-only", async () => {
    for (const path of ["/git", "/git/", `/git/${slugs.alicePrivate}.git/${WRITE_SERVICE}`]) {
      const anonymous = await fetch(`${server.baseUrl}${path}`, { method: "POST", body: "0000" });
      expect(anonymous.status, path).toBe(401);
      expect(anonymous.headers.get("www-authenticate"), path).toMatch(/^Basic realm="Amber"/);

      const member = await fetch(`${server.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: basic(alice.username, alice.password) },
        body: "0000",
      });
      expect(member.status, path).toBe(403);
      expect(await member.text(), path).toMatch(/read-only/i);
    }
  });
});
