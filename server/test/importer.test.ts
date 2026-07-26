import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createAccount } from "../src/domain/accounts.ts";
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

const KEY = Buffer.from(TEST_SECRET_KEY, "hex");
const NOW = 1_700_000_000_000;

let temp: TempDb;
let db: Db;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
});

afterEach(() => {
  temp.close();
});

const all = () => listRepos(db, { page: 1, perPage: 200, sort: "created_at", dir: "asc" });

describe("previewImport", () => {
  it("parses a mixed block and summarizes it", () => {
    const preview = previewImport(
      db,
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

  it("writes nothing", () => {
    previewImport(db, "https://github.com/nodejs/node");
    expect(listForges(db)).toHaveLength(0);
    expect(all().total).toBe(0);
  });

  it("warns when a user prefix names an account that does not exist", () => {
    const preview = previewImport(db, "pmaxhogan@github.com/pmaxhogan/mkvid");
    expect(preview.results[0]?.status).toBe("warning");
    expect(preview.results[0]?.message).toMatch(/No account named "pmaxhogan"/);
    expect(preview.summary.warning).toBe(1);
  });

  it("does not warn when the account exists on that forge", () => {
    commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const forgeId = listForges(db)[0]!.id;
    createAccount(db, KEY, { forgeId, username: "pmaxhogan", secret: null, isDefault: false });

    const preview = previewImport(db, "pmaxhogan@github.com/pmaxhogan/mkvid");
    expect(preview.results[0]?.status).toBe("ok");
    expect(preview.results[0]?.message).toBeUndefined();
  });

  it("warns when the account exists only on a different forge", () => {
    commitImport(db, "https://gitlab.com/a/b", { now: NOW });
    const gitlabId = listForges(db)[0]!.id;
    createAccount(db, KEY, {
      forgeId: gitlabId,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });

    expect(previewImport(db, "pmaxhogan@github.com/x/y").results[0]?.status).toBe("warning");
  });

  it("handles an empty blob", () => {
    expect(previewImport(db, "")).toEqual({
      results: [],
      summary: { total: 0, ok: 0, warning: 0, error: 0 },
    });
  });
});

describe("commitImport creates forges and repos", () => {
  it("auto creates the forge with a detected kind", () => {
    commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const forges = listForges(db);
    expect(forges).toHaveLength(1);
    expect(forges[0]).toMatchObject({ host: "github.com", kind: "github", protocol: "https" });
  });

  it("creates one forge for many repos on the same host", () => {
    commitImport(db, ["github.com/a/b", "github.com/c/d", "github.com/e/f"].join("\n"), {
      now: NOW,
    });
    expect(listForges(db)).toHaveLength(1);
    expect(all().total).toBe(3);
  });

  it("keeps hosts, protocols, and ports apart", () => {
    commitImport(
      db,
      [
        "https://github.com/a/b",
        "http://git.example.com/a/b",
        "https://git.example.com:8443/a/b",
      ].join("\n"),
      { now: NOW },
    );
    expect(listForges(db)).toHaveLength(3);
    expect(all().total).toBe(3);
  });

  it("reports created, updated, and failed counts", () => {
    const result = commitImport(
      db,
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

  it("gives every repo its own slug and short id", () => {
    commitImport(db, ["github.com/a/b", "gitlab.com/a/b", "github.com/a-b"].join("\n"), {
      now: NOW,
    });
    const repos = all().rows;
    expect(new Set(repos.map((repo) => repo.slug)).size).toBe(3);
    expect(new Set(repos.map((repo) => repo.shortId)).size).toBe(3);
  });
});

describe("account matching on import", () => {
  it("sets the override when the named account exists on that forge", () => {
    commitImport(db, "https://github.com/seed/seed", { now: NOW });
    const forgeId = listForges(db)[0]!.id;
    const account = createAccount(db, KEY, {
      forgeId,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });

    const result = commitImport(db, "pmaxhogan@github.com/pmaxhogan/mkvid", { now: NOW });
    expect(result.results[0]?.status).toBe("ok");
    expect(getRepo(db, result.results[0]!.repoId!)?.accountOverrideId).toBe(account.id);
  });

  it("imports with a warning and no override when the account is unknown", () => {
    const result = commitImport(db, "ghost@github.com/a/b", { now: NOW });
    expect(result.created).toBe(1);
    expect(result.results[0]?.status).toBe("warning");
    expect(result.results[0]?.message).toMatch(/No account named "ghost"/);
    expect(getRepo(db, result.results[0]!.repoId!)?.accountOverrideId).toBeNull();
  });

  it("never creates an account implicitly", () => {
    commitImport(db, "ghost@github.com/a/b", { now: NOW });
    expect(db.all("SELECT id FROM accounts")).toHaveLength(0);
  });

  it("rejects a password in the URL rather than storing it", () => {
    const result = commitImport(db, "https://user:hunter2@github.com/a/b", { now: NOW });
    expect(result.failed).toBe(1);
    expect(result.results[0]?.message).toMatch(/Passwords in URLs are not supported/);
    expect(result.results[0]?.message).not.toContain("hunter2");
    expect(all().total).toBe(0);
  });
});

describe("password redaction in echoed lines", () => {
  it("masks a password rather than echoing it back", () => {
    expect(redactLine("https://user:hunter2@github.com/a/b")).toBe(
      "https://user:***@github.com/a/b",
    );
    expect(redactLine("user:hunter2@github.com/a/b")).toBe("user:***@github.com/a/b");
    expect(redactLine("http://u:p@host:8080/a/b")).toBe("http://u:***@host:8080/a/b");
    expect(redactLine("https://user:@github.com/a/b")).toBe("https://user:***@github.com/a/b");
  });

  it("leaves lines with no password alone", () => {
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

  it("redacts the echoed line in both preview and commit", () => {
    const line = "https://user:hunter2@github.com/a/b";

    const preview = previewImport(db, line);
    expect(JSON.stringify(preview)).not.toContain("hunter2");
    expect(preview.results[0]?.line).toBe("https://user:***@github.com/a/b");

    const committed = commitImport(db, line, { now: NOW });
    expect(JSON.stringify(committed)).not.toContain("hunter2");
    expect(committed.results[0]?.line).toBe("https://user:***@github.com/a/b");
  });

  it("redacts only the offending line in a mixed block", () => {
    const preview = previewImport(
      db,
      ["https://github.com/ok/one", "https://user:hunter2@github.com/a/b"].join("\n"),
    );
    expect(preview.results[0]?.line).toBe("https://github.com/ok/one");
    expect(preview.results[1]?.line).not.toContain("hunter2");
  });
});

describe("idempotent re-import", () => {
  it("updates rather than duplicating", () => {
    const first = commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const second = commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.results[0]?.repoId).toBe(first.results[0]?.repoId);
    expect(all().total).toBe(1);
  });

  it("treats a trailing .git and slash as the same repo", () => {
    commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const again = commitImport(
      db,
      ["https://github.com/nodejs/node.git", "github.com/nodejs/node/"].join("\n"),
      { now: NOW },
    );
    expect(again.created).toBe(0);
    expect(again.updated).toBe(2);
    expect(all().total).toBe(1);
  });

  it("sets the override on re-import once the account exists", () => {
    const first = commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const repoId = first.results[0]!.repoId!;
    expect(getRepo(db, repoId)?.accountOverrideId).toBeNull();

    const forgeId = listForges(db)[0]!.id;
    const account = createAccount(db, KEY, {
      forgeId,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });

    commitImport(db, "pmaxhogan@github.com/nodejs/node", { now: NOW });
    expect(getRepo(db, repoId)?.accountOverrideId).toBe(account.id);
  });

  it("does not clear an existing override when the line carries no user prefix", () => {
    const first = commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const repoId = first.results[0]!.repoId!;
    const account = createAccount(db, KEY, {
      forgeId: listForges(db)[0]!.id,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });
    commitImport(db, "pmaxhogan@github.com/nodejs/node", { now: NOW });

    commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    expect(getRepo(db, repoId)?.accountOverrideId).toBe(account.id);
  });

  it("does not reschedule an existing repo", () => {
    const first = commitImport(db, "https://github.com/nodejs/node", { now: NOW });
    const repoId = first.results[0]!.repoId!;
    const scheduled = getRepo(db, repoId)!.nextSyncAt;

    commitImport(db, "https://github.com/nodejs/node", { now: NOW + 10_000_000 });
    expect(getRepo(db, repoId)?.nextSyncAt).toBe(scheduled);
  });
});

describe("staggering", () => {
  it("spreads new repos a few seconds apart from the given clock", () => {
    const result = commitImport(
      db,
      ["github.com/a/one", "github.com/b/two", "github.com/c/three"].join("\n"),
      { now: NOW, staggerStepMs: 3_000 },
    );
    const times = result.results.map((line) => getRepo(db, line.repoId!)!.nextSyncAt);
    expect(times).toEqual([NOW, NOW + 3_000, NOW + 6_000]);
  });

  it("does not stagger a single repo", () => {
    const result = commitImport(db, "github.com/a/one", { now: NOW });
    expect(getRepo(db, result.results[0]!.repoId!)?.nextSyncAt).toBe(NOW);
  });

  it("only advances the offset for repos that were actually created", () => {
    commitImport(db, "github.com/a/one", { now: NOW });
    const result = commitImport(
      db,
      ["github.com/a/one", "github.com/b/two", "github.com/c/three"].join("\n"),
      { now: NOW, staggerStepMs: 3_000 },
    );
    const created = result.results.filter((line) => line.action === "created");
    expect(created.map((line) => getRepo(db, line.repoId!)!.nextSyncAt)).toEqual([
      NOW,
      NOW + 3_000,
    ]);
  });

  it("keeps the whole first wave inside the stagger window", () => {
    expect(staggerStepFor(0)).toBe(0);
    expect(staggerStepFor(1)).toBe(0);
    expect(staggerStepFor(2)).toBe(3_000);
    expect(staggerStepFor(101)).toBe(3_000);

    const many = 5_000;
    expect(staggerStepFor(many) * (many - 1)).toBeLessThanOrEqual(MAX_STAGGER_WINDOW_MS);
  });

  it("stays inside the window for a large import", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `github.com/org/repo-${String(i)}`);
    const result = commitImport(db, lines.join("\n"), { now: NOW });
    expect(result.created).toBe(400);

    const times = result.results.map((line) => getRepo(db, line.repoId!)!.nextSyncAt!);
    expect(Math.min(...times)).toBe(NOW);
    expect(Math.max(...times) - NOW).toBeLessThanOrEqual(MAX_STAGGER_WINDOW_MS);
  });
});

describe("commitImport error handling", () => {
  it("reports per line and keeps going", () => {
    const result = commitImport(
      db,
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

  it("keeps the original line and line number on every result", () => {
    const result = commitImport(
      db,
      ["", "github.com/a/b", "# comment", "bad line here"].join("\n"),
      {
        now: NOW,
      },
    );
    expect(result.results.map((line) => line.lineNumber)).toEqual([2, 4]);
    expect(result.results[0]?.line).toBe("github.com/a/b");
  });

  it("handles a blob of only comments and blanks", () => {
    expect(commitImport(db, "\n# nothing\n\n   \n", { now: NOW })).toEqual({
      results: [],
      created: 0,
      updated: 0,
      failed: 0,
    });
  });
});
