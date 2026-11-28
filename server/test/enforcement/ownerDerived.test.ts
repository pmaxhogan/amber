import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/domain/accounts.ts";
import { createRepo, OWNER_ONLY_ERROR } from "../../src/domain/repos.ts";
import type { User } from "../../src/domain/users.ts";
import { insertAccountSync } from "../../src/providers/discovery.ts";
import { asUser } from "../helpers/accessFixtures.ts";
import { createTempApp, seedForge, type TempApp } from "../helpers.ts";
import { makeUser } from "../helpers/users.ts";

/**
 * Fields learned or chosen with the OWNER's account (the pinned account, the
 * managing account sync, sync error text) are the owner's and the admin's.
 * Anyone else who can view the repo (view_others_*, modify_others) sees the
 * repo without them: ids nulled, the error replaced by a fixed marker.
 */

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const SECRET_ERROR = "fatal: could not read from alice-bot: private repo acme/hidden-thing";

let temp: TempApp;
let alice: User;
let repoId: number;
let accountId: number;
let syncId: number;

beforeEach(async () => {
  temp = await createTempApp({ INSECURE_USER_EMAILS: [ALICE, BOB].join(",") });
  alice = makeUser(temp.db, ALICE, { import_private: true });
  makeUser(temp.db, BOB, { view_others_private: true, modify_others: true });
  const forgeId = seedForge(temp.db);
  accountId = createAccount(
    temp.db,
    temp.config.secretKey,
    { forgeId, username: "alice-bot", secret: "s3cret", isDefault: true },
    alice.id,
  ).id;
  syncId = insertAccountSync(temp.db, {
    ownerUserId: alice.id,
    forgeId,
    accountId,
    source: "owned",
    namespace: null,
    visibility: "all",
    enabled: true,
    intervalMinutes: 60,
  }).id;
  repoId = createRepo(temp.db, {
    forgeId,
    path: "acme/thing",
    ownerUserId: alice.id,
    accountOverrideId: accountId,
  }).id;
  temp.db.run(
    "UPDATE repos SET managed_by_account_sync_id = ?, last_error = ? WHERE id = ?",
    syncId,
    SECRET_ERROR,
    repoId,
  );
  temp.db.run(
    `INSERT INTO sync_runs (repo_id, started_at, finished_at, outcome, error, error_kind,
                            created_at, updated_at)
     VALUES (?, 5, 6, 'error', ?, 'not_found', 5, 6)`,
    repoId,
    SECRET_ERROR,
  );
});

afterEach(async () => {
  await temp.close();
});

async function get(email: string | null, url: string): Promise<unknown> {
  const response = await temp.app.inject({
    method: "GET",
    url,
    headers: email === null ? {} : asUser(email),
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("owner-derived repo fields", () => {
  it("are hidden from a viewer who is neither the owner nor the admin", async () => {
    const detail = await get(BOB, `/api/repos/${String(repoId)}`);
    expect(detail).toMatchObject({
      id: repoId,
      accountOverrideId: null,
      managedByAccountSyncId: null,
      lastError: OWNER_ONLY_ERROR,
    });

    const list = (await get(BOB, "/api/repos")) as { rows: Record<string, unknown>[] };
    expect(list.rows.find((row) => row.id === repoId)).toMatchObject({
      accountOverrideId: null,
      managedByAccountSyncId: null,
      lastError: OWNER_ONLY_ERROR,
    });

    const runs = (await get(BOB, `/api/repos/${String(repoId)}/runs`)) as {
      rows: { error: string | null }[];
    };
    expect(runs.rows.map((run) => run.error)).toEqual([OWNER_ONLY_ERROR]);

    for (const body of [detail, list, runs]) {
      expect(JSON.stringify(body)).not.toContain("hidden-thing");
    }
  });

  it("are shown to the owner and to the admin", async () => {
    for (const email of [ALICE, null]) {
      expect(await get(email, `/api/repos/${String(repoId)}`)).toMatchObject({
        accountOverrideId: accountId,
        managedByAccountSyncId: syncId,
        lastError: SECRET_ERROR,
      });
      const runs = (await get(email, `/api/repos/${String(repoId)}/runs`)) as {
        rows: { error: string | null }[];
      };
      expect(runs.rows.map((run) => run.error)).toEqual([SECRET_ERROR]);
    }
  });

  it("hide another owner's gone state without view_removed, and ownerGone always", async () => {
    temp.db.run(
      "UPDATE repos SET gone_at = 100, owner_gone = 1, owner_checked_at = 200 WHERE id = ?",
      repoId,
    );
    const url = `/api/repos/${String(repoId)}`;
    expect(await get(ALICE, url)).toMatchObject({ goneAt: 100, ownerGone: true });
    expect(await get(null, url)).toMatchObject({ goneAt: 100, ownerGone: true });
    expect(await get(BOB, url)).toMatchObject({ goneAt: null, ownerGone: null });
    const list = (await get(BOB, "/api/repos")) as { rows: Record<string, unknown>[] };
    expect(list.rows.find((row) => row.id === repoId)).toMatchObject({
      goneAt: null,
      ownerGone: null,
    });

    // view_removed shows that it is gone; whether the upstream owner is gone
    // too was asked with Alice's account and stays hers.
    makeUser(temp.db, BOB, { view_removed: true });
    expect(await get(BOB, url)).toMatchObject({ goneAt: 100, ownerGone: null });
  });

  it("hide the error kind (how gone shows first) without view_removed, and refuse gone=", async () => {
    const runsUrl = `/api/repos/${String(repoId)}/runs`;
    type Runs = { rows: { errorKind: string | null }[] };
    expect(((await get(BOB, runsUrl)) as Runs).rows.map((run) => run.errorKind)).toEqual([null]);
    const listed = (await get(BOB, "/api/repos")) as { rows: Record<string, unknown>[] };
    expect(listed.rows.find((row) => row.id === repoId)?.lastErrorKind).toBeUndefined();
    for (const email of [ALICE, null]) {
      expect(((await get(email, runsUrl)) as Runs).rows.map((run) => run.errorKind)).toEqual([
        "not_found",
      ]);
    }

    // gone=false would diff out the gone repos just as well as gone=true.
    for (const query of ["gone=false", "gone=true"]) {
      const response = await temp.app.inject({
        method: "GET",
        url: `/api/repos?${query}`,
        headers: asUser(BOB),
      });
      expect(response.statusCode, query).toBe(403);
    }
    makeUser(temp.db, BOB, { view_removed: true });
    expect(((await get(BOB, runsUrl)) as Runs).rows.map((run) => run.errorKind)).toEqual([
      "not_found",
    ]);
    expect((await get(BOB, "/api/repos?gone=false")) as object).toBeDefined();
  });

  it("leave a repo without an error with a null lastError for everyone", async () => {
    temp.db.run("UPDATE repos SET last_error = NULL WHERE id = ?", repoId);
    expect(await get(BOB, `/api/repos/${String(repoId)}`)).toMatchObject({ lastError: null });
  });
});
