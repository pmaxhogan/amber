import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createAccount, deleteAccount } from "../src/domain/accounts.ts";
import { listForges } from "../src/domain/forges.ts";
import {
  commitImport,
  previewImport,
  redactLine,
  staggerStepFor,
  MAX_STAGGER_WINDOW_MS,
} from "../src/domain/importer.ts";
import { getRepo, listRepos } from "../src/domain/repos.ts";
import { createTempDb, TEST_SECRET_KEY, type TempDb } from "./helpers.ts";
import { adminOf } from "./helpers/users.ts";

const KEY = Buffer.from(TEST_SECRET_KEY, "hex");
const NOW = 1_700_000_000_000;

let temp: TempDb;
let db: Db;

beforeEach(async () => {
  temp = createTempDb();
  db = temp.db;
});

afterEach(() => {
  temp.close();
});

const all = () =>
  listRepos(db, adminOf(db), { page: 1, perPage: 200, sort: "created_at", dir: "asc" });

/** Migration 003 seeds these into every database before a test starts. */
const SEEDED_HOSTS = new Set(["github.com", "gitlab.com"]);

/** Only the forges an import created, so counts stay about the import. */
const imported = () => listForges(db).filter((forge) => !SEEDED_HOSTS.has(forge.host));

describe("previewImport", () => {
  it("parses a mixed block and summarizes it", async () => {
    const preview = previewImport(
      db,
      adminOf(db),
      [
        "https://github.com/nodejs/node",
        "github.com/facebook/react/",
        "",
        "# a comment",
        "git@github.com:torvalds/linux.git",
        "ssh://git@example.com/x/y",
      ].join("\n"),
    );

    expect(preview.results).toHaveLength(4);
    expect(preview.summary).toEqual({ total: 4, ok: 2, warning: 0, error: 2 });
    expect(preview.results[0]?.parsed?.path).toBe("nodejs/node");
    expect(preview.results[1]?.parsed?.host).toBe("github.com");
    expect(preview.results[2]?.message).toMatch(/SSH remotes are not supported/);
  });

  it("writes nothing", async () => {
    // Compared against the pre-call listing rather than zero: migration 003
    // seeds github.com, so a preview that did write would be invisible to a
    // bare length check.
    const before = listForges(db);
    previewImport(db, adminOf(db), "https://github.com/nodejs/node");
    expect(listForges(db)).toEqual(before);
    expect(all().total).toBe(0);
  });

  it("warns when a user prefix names an account that does not exist", async () => {
    const preview = previewImport(db, adminOf(db), "pmaxhogan@github.com/pmaxhogan/mkvid");
    expect(preview.results[0]?.status).toBe("warning");
    expect(preview.results[0]?.message).toMatch(/have no account named "pmaxhogan"/);
    expect(preview.summary.warning).toBe(1);
  });

  it("does not warn when the account exists on that forge", async () => {
    await commitImport(db, adminOf(db), "https://github.com/nodejs/node", { now: NOW });
    const forgeId = listForges(db)[0]!.id;
    createAccount(
      db,
      KEY,
      { forgeId, username: "pmaxhogan", secret: null, isDefault: false },
      adminOf(db).id,
    );

    const preview = previewImport(db, adminOf(db), "pmaxhogan@github.com/pmaxhogan/mkvid");
    expect(preview.results[0]?.status).toBe("ok");
    expect(preview.results[0]?.message).toBeUndefined();
  });

  it("warns when the account exists only on a different forge", async () => {
    await commitImport(db, adminOf(db), "https://gitlab.com/a/b", { now: NOW });
    const gitlabId = listForges(db).find((forge) => forge.host === "gitlab.com")!.id;
    createAccount(
      db,
      KEY,
      {
        forgeId: gitlabId,
        username: "pmaxhogan",
        secret: null,
        isDefault: false,
      },
      adminOf(db).id,
    );

    expect(previewImport(db, adminOf(db), "pmaxhogan@github.com/x/y").results[0]?.status).toBe(
      "warning",
    );
  });

  it("handles an empty blob", async () => {
    expect(previewImport(db, adminOf(db), "")).toEqual({
      results: [],
      summary: { total: 0, ok: 0, warning: 0, error: 0 },
    });
  });
});

describe("commitImport creates forges and repos", () => {
  it("auto creates the forge with a detected kind", async () => {
    // bitbucket.org has a detected kind and is not one of the seeded hosts, so
    // the import is what brings the row into being.
    await commitImport(db, adminOf(db), "https://bitbucket.org/nodejs/node", { now: NOW });
    const forges = imported();
    expect(forges).toHaveLength(1);
    expect(forges[0]).toMatchObject({
      host: "bitbucket.org",
      kind: "bitbucket",
      protocol: "https",
    });
  });

  it("creates one forge for many repos on the same host", async () => {
    await commitImport(
      db,
      adminOf(db),
      ["bitbucket.org/a/b", "bitbucket.org/c/d", "bitbucket.org/e/f"].join("\n"),
      {
        now: NOW,
      },
    );
    expect(imported()).toHaveLength(1);
    expect(all().total).toBe(3);
  });

  it("keeps hosts, protocols, and ports apart", async () => {
    await commitImport(
      db,
      adminOf(db),
      [
        "https://bitbucket.org/a/b",
        "http://git.example.com/a/b",
        "https://git.example.com:8443/a/b",
      ].join("\n"),
      { now: NOW },
    );
    expect(imported()).toHaveLength(3);
    expect(all().total).toBe(3);
  });

  it("reports created, updated, and failed counts", async () => {
    const result = await commitImport(
      db,
      adminOf(db),
      ["github.com/a/b", "git@github.com:c/d.git", "github.com/a/b"].join("\n"),
      { now: NOW },
    );
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.map((line) => line.action)).toEqual(["created", "failed", "updated"]);
    expect(result.results[0]?.repoId).toBeGreaterThan(0);
    expect(result.results[1]?.repoId).toBeUndefined();
  });

  it("gives every repo its own slug and short id", async () => {
    // a/b and a-b sanitize alike on one forge. A generic host, because a single
    // segment on github.com names a namespace rather than a repository.
    await commitImport(
      db,
      adminOf(db),
      ["git.example.com/a/b", "gitlab.com/a/b", "git.example.com/a-b"].join("\n"),
      {
        now: NOW,
      },
    );
    const repos = all().rows;
    expect(new Set(repos.map((repo) => repo.slug)).size).toBe(3);
    expect(new Set(repos.map((repo) => repo.shortId)).size).toBe(3);
  });
});

describe("account matching on import", () => {
  it("sets the override when the named account exists on that forge", async () => {
    await commitImport(db, adminOf(db), "https://github.com/seed/seed", { now: NOW });
    const forgeId = listForges(db)[0]!.id;
    const account = createAccount(
      db,
      KEY,
      {
        forgeId,
        username: "pmaxhogan",
        secret: null,
        isDefault: false,
      },
      adminOf(db).id,
    );

    const result = await commitImport(db, adminOf(db), "pmaxhogan@github.com/pmaxhogan/mkvid", {
      now: NOW,
    });
    expect(result.results[0]?.status).toBe("ok");
    expect(getRepo(db, result.results[0]!.repoId!)?.accountOverrideId).toBe(account.id);
  });

  it("imports with a warning and no override when the account is unknown", async () => {
    const result = await commitImport(db, adminOf(db), "ghost@github.com/a/b", { now: NOW });
    expect(result.created).toBe(1);
    expect(result.results[0]?.status).toBe("warning");
    expect(result.results[0]?.message).toMatch(/have no account named "ghost"/);
    expect(getRepo(db, result.results[0]!.repoId!)?.accountOverrideId).toBeNull();
  });

  it("never creates an account implicitly", async () => {
    await commitImport(db, adminOf(db), "ghost@github.com/a/b", { now: NOW });
    expect(db.all("SELECT id FROM accounts")).toHaveLength(0);
  });

  it("rejects a password in the URL rather than storing it", async () => {
    const result = await commitImport(db, adminOf(db), "https://user:hunter2@github.com/a/b", {
      now: NOW,
    });
    expect(result.failed).toBe(1);
    expect(result.results[0]?.message).toMatch(/Passwords in URLs are not supported/);
    expect(result.results[0]?.message).not.toContain("hunter2");
    expect(all().total).toBe(0);
  });
});

describe("password redaction in echoed lines", () => {
  it("masks a password rather than echoing it back", async () => {
    expect(redactLine("https://user:hunter2@github.com/a/b")).toBe(
      "https://user:***@github.com/a/b",
    );
    expect(redactLine("user:hunter2@github.com/a/b")).toBe("user:***@github.com/a/b");
    expect(redactLine("http://u:p@host:8080/a/b")).toBe("http://u:***@host:8080/a/b");
    expect(redactLine("https://user:@github.com/a/b")).toBe("https://user:***@github.com/a/b");
  });

  it("leaves lines with no password alone", async () => {
    for (const line of [
      "https://github.com/nodejs/node",
      "github.com/nodejs/node",
      "pmaxhogan@github.com/a/b",
      "https://host:8443/a/b",
      "git@github.com:torvalds/linux.git",
      "",
    ]) {
      expect(redactLine(line)).toBe(line);
    }
  });

  it("redacts the echoed line in both preview and commit", async () => {
    const line = "https://user:hunter2@github.com/a/b";

    const preview = previewImport(db, adminOf(db), line);
    expect(JSON.stringify(preview)).not.toContain("hunter2");
    expect(preview.results[0]?.line).toBe("https://user:***@github.com/a/b");

    const committed = await commitImport(db, adminOf(db), line, { now: NOW });
    expect(JSON.stringify(committed)).not.toContain("hunter2");
    expect(committed.results[0]?.line).toBe("https://user:***@github.com/a/b");
  });

  it("redacts only the offending line in a mixed block", async () => {
    const preview = previewImport(
      db,
      adminOf(db),
      ["https://github.com/ok/one", "https://user:hunter2@github.com/a/b"].join("\n"),
    );
    expect(preview.results[0]?.line).toBe("https://github.com/ok/one");
    expect(preview.results[1]?.line).not.toContain("hunter2");
  });
});

describe("idempotent re-import", () => {
  it("updates rather than duplicating", async () => {
    const first = await commitImport(db, adminOf(db), "https://github.com/nodejs/node", {
      now: NOW,
    });
    const second = await commitImport(db, adminOf(db), "https://github.com/nodejs/node", {
      now: NOW,
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.results[0]?.repoId).toBe(first.results[0]?.repoId);
    expect(all().total).toBe(1);
  });

  it("treats a trailing .git and slash as the same repo", async () => {
    await commitImport(db, adminOf(db), "https://github.com/nodejs/node", { now: NOW });
    const again = await commitImport(
      db,
      adminOf(db),
      ["https://github.com/nodejs/node.git", "github.com/nodejs/node/"].join("\n"),
      { now: NOW },
    );
    expect(again.created).toBe(0);
    expect(again.updated).toBe(2);
    expect(all().total).toBe(1);
  });

  // Multi-user: a re-import never changes anything, the override included
  // ("Importing something Amber already has"). The override is set with
  // PATCH /api/repos/:id by the owner instead.
  it("leaves the override alone on re-import, even once the account exists", async () => {
    const first = await commitImport(db, adminOf(db), "https://github.com/nodejs/node", {
      now: NOW,
    });
    const repoId = first.results[0]!.repoId!;
    expect(getRepo(db, repoId)?.accountOverrideId).toBeNull();

    const forgeId = listForges(db)[0]!.id;
    const account = createAccount(
      db,
      KEY,
      {
        forgeId,
        username: "pmaxhogan",
        secret: null,
        isDefault: false,
      },
      adminOf(db).id,
    );

    const again = await commitImport(db, adminOf(db), "pmaxhogan@github.com/nodejs/node", {
      now: NOW,
    });
    expect(again.results[0]).toMatchObject({ action: "updated", status: "ok", repoId });
    expect(again.results[0]?.message).toMatch(/Already backed up/);
    expect(getRepo(db, repoId)?.accountOverrideId).toBeNull();
    expect(account.id).toBeGreaterThan(0);
  });

  it("does not clear an existing override when the line carries no user prefix", async () => {
    const first = await commitImport(db, adminOf(db), "https://github.com/nodejs/node", {
      now: NOW,
    });
    const repoId = first.results[0]!.repoId!;
    const account = createAccount(
      db,
      KEY,
      {
        forgeId: listForges(db)[0]!.id,
        username: "pmaxhogan",
        secret: null,
        isDefault: false,
      },
      adminOf(db).id,
    );
    db.run("UPDATE repos SET account_override_id = ? WHERE id = ?", account.id, repoId);

    await commitImport(db, adminOf(db), "https://github.com/nodejs/node", { now: NOW });
    expect(getRepo(db, repoId)?.accountOverrideId).toBe(account.id);
  });

  it("does not reschedule an existing repo", async () => {
    const first = await commitImport(db, adminOf(db), "https://github.com/nodejs/node", {
      now: NOW,
    });
    const repoId = first.results[0]!.repoId!;
    const scheduled = getRepo(db, repoId)!.nextSyncAt;

    await commitImport(db, adminOf(db), "https://github.com/nodejs/node", {
      now: NOW + 10_000_000,
    });
    expect(getRepo(db, repoId)?.nextSyncAt).toBe(scheduled);
  });
});

describe("staggering", () => {
  it("spreads new repos a few seconds apart from the given clock", async () => {
    const result = await commitImport(
      db,
      adminOf(db),
      ["github.com/a/one", "github.com/b/two", "github.com/c/three"].join("\n"),
      { now: NOW, staggerStepMs: 3_000 },
    );
    const times = result.results.map((line) => getRepo(db, line.repoId!)!.nextSyncAt);
    expect(times).toEqual([NOW, NOW + 3_000, NOW + 6_000]);
  });

  it("does not stagger a single repo", async () => {
    const result = await commitImport(db, adminOf(db), "github.com/a/one", { now: NOW });
    expect(getRepo(db, result.results[0]!.repoId!)?.nextSyncAt).toBe(NOW);
  });

  it("only advances the offset for repos that were actually created", async () => {
    await commitImport(db, adminOf(db), "github.com/a/one", { now: NOW });
    const result = await commitImport(
      db,
      adminOf(db),
      ["github.com/a/one", "github.com/b/two", "github.com/c/three"].join("\n"),
      { now: NOW, staggerStepMs: 3_000 },
    );
    const created = result.results.filter((line) => line.action === "created");
    expect(created.map((line) => getRepo(db, line.repoId!)!.nextSyncAt)).toEqual([
      NOW,
      NOW + 3_000,
    ]);
  });

  it("keeps the whole first wave inside the stagger window", async () => {
    expect(staggerStepFor(0)).toBe(0);
    expect(staggerStepFor(1)).toBe(0);
    expect(staggerStepFor(2)).toBe(3_000);
    expect(staggerStepFor(101)).toBe(3_000);

    const many = 5_000;
    expect(staggerStepFor(many) * (many - 1)).toBeLessThanOrEqual(MAX_STAGGER_WINDOW_MS);
  });

  it("stays inside the window for a large import", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `github.com/org/repo-${String(i)}`);
    const result = await commitImport(db, adminOf(db), lines.join("\n"), { now: NOW });
    expect(result.created).toBe(400);

    const times = result.results.map((line) => getRepo(db, line.repoId!)!.nextSyncAt!);
    expect(Math.min(...times)).toBe(NOW);
    expect(Math.max(...times) - NOW).toBeLessThanOrEqual(MAX_STAGGER_WINDOW_MS);
  });
});

describe("commitImport error handling", () => {
  it("reports per line and keeps going", async () => {
    const result = await commitImport(
      db,
      adminOf(db),
      [
        "https://github.com/ok/one",
        "ssh://git@github.com/bad/one",
        "git://github.com/bad/two",
        "ftp://github.com/bad/three",
        "https://github.com/ok/two",
      ].join("\n"),
      { now: NOW },
    );
    expect(result.created).toBe(2);
    expect(result.failed).toBe(3);
    expect(result.results.map((line) => line.status)).toEqual([
      "ok",
      "error",
      "error",
      "error",
      "ok",
    ]);
    expect(all().total).toBe(2);
  });

  it("keeps the original line and line number on every result", async () => {
    const result = await commitImport(
      db,
      adminOf(db),
      ["", "github.com/a/b", "# comment", "bad line here"].join("\n"),
      {
        now: NOW,
      },
    );
    expect(result.results.map((line) => line.lineNumber)).toEqual([2, 4]);
    expect(result.results[0]?.line).toBe("github.com/a/b");
  });

  it("handles a blob of only comments and blanks", async () => {
    expect(await commitImport(db, adminOf(db), "\n# nothing\n\n   \n", { now: NOW })).toEqual({
      results: [],
      created: 0,
      updated: 0,
      failed: 0,
    });
  });
});

describe("namespace lines", () => {
  const githubId = () => listForges(db).find((forge) => forge.host === "github.com")!.id;
  const syncs = () =>
    db.all<{ id: number; forge_id: number; account_id: number | null; namespace: string }>(
      "SELECT id, forge_id, account_id, namespace FROM account_syncs WHERE source = 'namespace' ORDER BY id",
    );

  it("previews a bare GitHub owner as a namespace and a repo URL as a repo", async () => {
    const preview = previewImport(
      db,
      adminOf(db),
      ["https://github.com/nodejs", "github.com/vuejs/", "https://github.com/nodejs/node"].join(
        "\n",
      ),
    );

    expect(preview.results.map((line) => line.target)).toEqual(["namespace", "namespace", "repo"]);
    expect(preview.results[0]?.status).toBe("ok");
    expect(preview.results[0]?.message).toMatch(/every repository nodejs owns on github.com/);
    expect(syncs()).toEqual([]);
  });

  it("treats a host GitHub detection would claim as a namespace even before the forge exists", async () => {
    db.run("DELETE FROM forges WHERE host = 'github.com'");

    const preview = previewImport(db, adminOf(db), "https://github.com/nodejs");

    expect(preview.results[0]?.target).toBe("namespace");
  });

  it("keeps a single segment on any other forge kind a repository", async () => {
    const preview = previewImport(
      db,
      adminOf(db),
      ["https://git.example.com/solo", "gitlab.com/group"].join("\n"),
    );

    expect(preview.results.map((line) => line.target)).toEqual(["repo", "repo"]);
  });

  it("commits a namespace line as an enabled namespace sync, not a repo", async () => {
    const result = await commitImport(db, adminOf(db), "https://github.com/nodejs", { now: NOW });

    expect(result.created).toBe(1);
    expect(result.results[0]).toMatchObject({ action: "created", target: "namespace" });
    expect(result.results[0]?.repoId).toBeUndefined();
    expect(result.results[0]?.accountSyncId).toBe(syncs()[0]?.id);
    expect(all().total).toBe(0);
    expect(syncs()).toEqual([
      { id: expect.any(Number), forge_id: githubId(), account_id: null, namespace: "nodejs" },
    ]);
    const due = db.get<{ enabled: number; next_run_at: number }>(
      "SELECT enabled, next_run_at FROM account_syncs",
    );
    expect(due).toEqual({ enabled: 1, next_run_at: NOW });
  });

  it("does not let namespace lines stretch the stagger of the repos around them", async () => {
    const result = await commitImport(
      db,
      adminOf(db),
      ["github.com/nodejs", "github.com/a/one", "github.com/vuejs", "github.com/a/two"].join("\n"),
      { now: NOW, staggerStepMs: 1000 },
    );

    const repos = all().rows;
    expect(repos.map((repo) => repo.nextSyncAt)).toEqual([NOW, NOW + 1000]);
    expect(result.created).toBe(4);
  });

  it("is idempotent, case-insensitively, and pins a named account on re-import", async () => {
    await commitImport(db, adminOf(db), "https://github.com/nodejs", { now: NOW });
    const account = createAccount(
      db,
      KEY,
      {
        forgeId: githubId(),
        username: "org-bot",
        secret: null,
        isDefault: false,
      },
      adminOf(db).id,
    );

    const again = await commitImport(db, adminOf(db), "https://github.com/NodeJS", { now: NOW });
    expect(again.results[0]?.action).toBe("updated");
    expect(syncs()[0]?.account_id).toBeNull();

    const pinned = await commitImport(db, adminOf(db), "org-bot@github.com/nodejs", { now: NOW });
    expect(pinned.results[0]).toMatchObject({ action: "updated", status: "ok" });
    expect(syncs()).toHaveLength(1);
    expect(syncs()[0]?.account_id).toBe(account.id);

    // A later prefix-less line never clears the pin.
    await commitImport(db, adminOf(db), "github.com/nodejs", { now: NOW });
    expect(syncs()[0]?.account_id).toBe(account.id);
  });

  it("warns and falls back to the forge default when a user@ prefix names no account", async () => {
    const preview = previewImport(db, adminOf(db), "ghost@github.com/nodejs");
    const result = await commitImport(db, adminOf(db), "ghost@github.com/nodejs", { now: NOW });

    // The preview has to say exactly what the commit then does.
    expect(preview.results[0]).toMatchObject({ status: "warning", target: "namespace" });
    expect(preview.results[0]?.message).toBe(result.results[0]?.message);

    expect(result.results[0]).toMatchObject({ action: "created", status: "warning" });
    expect(result.results[0]?.message).toMatch(/default account/);
    expect(syncs()[0]?.account_id).toBeNull();
  });
});

describe("deleting an account a namespace sync is pinned to", () => {
  it("keeps the sync and lets it fall back to the forge default", async () => {
    await commitImport(db, adminOf(db), "github.com/nodejs", { now: NOW });
    const forgeId = listForges(db).find((forge) => forge.host === "github.com")!.id;
    const account = createAccount(
      db,
      KEY,
      {
        forgeId,
        username: "org-bot",
        secret: null,
        isDefault: false,
      },
      adminOf(db).id,
    );
    await commitImport(db, adminOf(db), "org-bot@github.com/nodejs", { now: NOW });

    deleteAccount(db, account.id);

    expect(
      db.all<{ account_id: number | null }>(
        "SELECT account_id FROM account_syncs WHERE source = 'namespace'",
      ),
    ).toEqual([{ account_id: null }]);
  });
});
