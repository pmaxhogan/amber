import type { ForgeKind } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.ts";
import {
  OWNER_BATCH_SIZE,
  OWNER_RATE_LIMIT_COOLDOWN_MS,
  OWNER_RECHECK_MS,
  resolveGoneOwners,
  type OwnerResolverDeps,
} from "../../src/providers/owners.ts";
import type {
  AccountSyncProvider,
  DiscoveryContext,
  OwnerLookup,
} from "../../src/providers/types.ts";
import { createTempDb, seedForge, type TempDb } from "../helpers.ts";

let temp: TempDb;
let db: Db;
let github: number;
let gitlab: number;
let calls: { owner: string; context: DiscoveryContext }[];
let answers: Map<string, OwnerLookup | Error>;
let clock: number;

const NOW = 100 * OWNER_RECHECK_MS;
const GONE_AT = NOW - 1_000;

interface Row {
  owner_gone: number | null;
  owner_checked_at: number | null;
}

function repo(
  forgeId: number,
  path: string,
  extra: {
    goneAt?: number | null;
    ownerGone?: number | null;
    checkedAt?: number | null;
    override?: number | null;
    anonymous?: boolean;
  } = {},
): number {
  return db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, gone_at, owner_gone,
                        owner_checked_at, account_override_id, force_anonymous, created_at, updated_at, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, (SELECT id FROM users WHERE is_admin = 1))`,
    forgeId,
    path,
    path,
    `slug-${path.replace("/", "-")}-${String(forgeId)}`,
    `id-${path.replace("/", "-")}-${String(forgeId)}`,
    "goneAt" in extra ? (extra.goneAt ?? null) : GONE_AT,
    extra.ownerGone ?? null,
    extra.checkedAt ?? null,
    extra.override ?? null,
    extra.anonymous === true ? 1 : 0,
  ).lastInsertRowid;
}

function account(forgeId: number, username: string, isDefault: boolean): number {
  return db.run(
    "INSERT INTO accounts (forge_id, username, secret_enc, is_default, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, 1, 1, (SELECT id FROM users WHERE is_admin = 1))",
    forgeId,
    username,
    new Uint8Array([1, 2, 3]),
    isDefault ? 1 : 0,
  ).lastInsertRowid;
}

function row(id: number): Row {
  return db.get<Row>("SELECT owner_gone, owner_checked_at FROM repos WHERE id = ?", id)!;
}

function providerOf(kind: ForgeKind, withLookup = true): AccountSyncProvider {
  const provider: AccountSyncProvider = {
    kind,
    async *listRepos() {
      await Promise.resolve();
      yield* [];
    },
  };
  if (withLookup) {
    provider.checkOwner = (context, owner) => {
      calls.push({ owner, context });
      const answer =
        answers.get(`${kind}:${owner}`) ??
        answers.get(owner) ??
        ({ status: "exists" } as OwnerLookup);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    };
  }
  return provider;
}

function deps(extra: Partial<OwnerResolverDeps> = {}): OwnerResolverDeps {
  return {
    now: () => clock,
    secretKey: Buffer.alloc(32, 1),
    decryptSecret: (_key, blob) => `secret-${String(blob.byteLength)}`,
    providerFor: (kind) => providerOf(kind, kind !== "gitea"),
    ...extra,
  };
}

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  github = seedForge(db, "github.com");
  gitlab = seedForge(db, "gitlab.com", "gitlab");
  calls = [];
  answers = new Map();
  clock = NOW;
});

afterEach(() => {
  temp.close();
});

describe("resolveGoneOwners", () => {
  it("writes missing as 1 and exists as 0", async () => {
    const lost = repo(github, "deleted/one");
    const kept = repo(github, "alive/one");
    answers.set("deleted", { status: "missing" });

    const result = await resolveGoneOwners(db, deps());

    expect(row(lost)).toEqual({ owner_gone: 1, owner_checked_at: NOW });
    expect(row(kept)).toEqual({ owner_gone: 0, owner_checked_at: NOW });
    expect(result).toMatchObject({ asked: 2, resolved: 2, unknown: 0 });
  });

  it("asks once per owner, case-insensitively, and writes the answer to every gone repo of it", async () => {
    const a = repo(github, "Acme/one");
    const b = repo(github, "acme/two");
    const c = repo(github, "ACME/three");
    // Not gone: not asked about, not written.
    const live = repo(github, "acme/live", { goneAt: null });
    // Another forge with the same owner name is another owner.
    const other = repo(gitlab, "acme/one");
    answers.set("Acme", { status: "missing" });
    answers.set("acme", { status: "missing" });
    answers.set("gitlab:acme", { status: "exists" });

    await resolveGoneOwners(db, deps());

    expect(calls.filter((call) => call.context.baseUrl === "https://github.com")).toHaveLength(1);
    expect([a, b, c].map((id) => row(id).owner_gone)).toEqual([1, 1, 1]);
    expect(row(live)).toEqual({ owner_gone: null, owner_checked_at: null });
    expect(row(other).owner_gone).toBe(0);
  });

  it("also answers a gone sibling that was not due itself", async () => {
    const due = repo(github, "acme/due");
    const fresh = repo(github, "acme/fresh", { checkedAt: NOW - 1000, ownerGone: 0 });
    answers.set("acme", { status: "missing" });

    await resolveGoneOwners(db, deps());

    expect(row(due).owner_gone).toBe(1);
    expect(row(fresh)).toEqual({ owner_gone: 1, owner_checked_at: NOW });
  });

  it("never looks at a repo that is not gone", async () => {
    repo(github, "acme/live", { goneAt: null });

    await resolveGoneOwners(db, deps());

    expect(calls).toEqual([]);
  });

  it("rechecks after 6 hours and not before", async () => {
    const id = repo(github, "acme/one", { checkedAt: NOW, ownerGone: 0 });

    clock = NOW + OWNER_RECHECK_MS - 1;
    await resolveGoneOwners(db, deps());
    expect(calls).toHaveLength(0);

    clock = NOW + OWNER_RECHECK_MS;
    answers.set("acme", { status: "missing" });
    await resolveGoneOwners(db, deps());
    expect(calls).toHaveLength(1);
    expect(row(id).owner_gone).toBe(1);
  });

  it("asks again at once when the repo went gone after the owner was last asked", async () => {
    repo(github, "acme/one", { checkedAt: GONE_AT - 5000, ownerGone: 1 });

    await resolveGoneOwners(db, deps());

    expect(calls).toHaveLength(1);
  });

  it("flips an owner that came back from 1 to 0 and says so", async () => {
    const id = repo(github, "acme/one", {
      ownerGone: 1,
      checkedAt: NOW - OWNER_RECHECK_MS - 1,
      goneAt: NOW - 2 * OWNER_RECHECK_MS,
    });
    const seen: number[] = [];

    await resolveGoneOwners(db, deps({ onResolved: (repoId) => seen.push(repoId) }));

    expect(row(id)).toEqual({ owner_gone: 0, owner_checked_at: NOW });
    expect(seen).toEqual([id]);
  });

  it("reports only rows whose value changed", async () => {
    const same = repo(github, "acme/same", {
      ownerGone: 0,
      checkedAt: NOW - OWNER_RECHECK_MS - 1,
      goneAt: NOW - 2 * OWNER_RECHECK_MS,
    });
    const fresh = repo(github, "acme/fresh", { goneAt: NOW - 2 * OWNER_RECHECK_MS });
    const seen: number[] = [];

    await resolveGoneOwners(db, deps({ onResolved: (repoId) => seen.push(repoId) }));

    expect(seen).toEqual([fresh]);
    expect(row(same).owner_checked_at).toBe(NOW);
  });

  it("stamps unknown without ever overwriting an answer", async () => {
    const id = repo(github, "acme/one", {
      ownerGone: 1,
      checkedAt: NOW - OWNER_RECHECK_MS - 1,
      goneAt: NOW - 2 * OWNER_RECHECK_MS,
    });
    answers.set("acme", { status: "unknown", rateLimited: false });
    const seen: number[] = [];

    const result = await resolveGoneOwners(db, deps({ onResolved: (r) => seen.push(r) }));

    expect(row(id)).toEqual({ owner_gone: 1, owner_checked_at: NOW });
    expect(result.unknown).toBe(1);
    expect(seen).toEqual([]);
  });

  it("takes owners, not repos, in a bounded batch, never-asked first", async () => {
    for (let index = 0; index < OWNER_BATCH_SIZE + 5; index += 1) {
      repo(github, `owner${String(index).padStart(2, "0")}/a`);
      repo(github, `owner${String(index).padStart(2, "0")}/b`);
    }
    await resolveGoneOwners(db, deps());
    expect(calls).toHaveLength(OWNER_BATCH_SIZE);

    calls = [];
    await resolveGoneOwners(db, deps(), { batchSize: 2 });
    expect(calls).toHaveLength(2);
  });

  it("asks the never-asked before the long-ago asked", async () => {
    repo(github, "old/a", { checkedAt: NOW - 3 * OWNER_RECHECK_MS, ownerGone: 0 });
    repo(github, "new/a");

    await resolveGoneOwners(db, deps());

    expect(calls.map((call) => call.owner)).toEqual(["new", "old"]);
  });

  it("stops asking a rate limited forge for the pass, leaves its repos unstamped, and keeps the cooldown", async () => {
    const limited = repo(github, "a/x");
    repo(github, "b/x");
    const other = repo(gitlab, "c/x");
    answers.set("a", { status: "unknown", rateLimited: true });
    const cooldowns = new Map<number, number>();

    const result = await resolveGoneOwners(db, deps({ cooldowns }));

    expect(calls.map((call) => call.owner)).toEqual(["a", "c"]);
    expect(row(limited).owner_checked_at).toBeNull();
    expect(row(other).owner_gone).toBe(0);
    expect(result.rateLimitedForges).toBe(1);
    expect(cooldowns.get(github)).toBe(NOW + OWNER_RATE_LIMIT_COOLDOWN_MS);

    calls = [];
    clock = NOW + OWNER_RATE_LIMIT_COOLDOWN_MS - 1;
    await resolveGoneOwners(db, deps({ cooldowns }));
    expect(calls).toEqual([]);

    clock = NOW + OWNER_RATE_LIMIT_COOLDOWN_MS;
    answers.set("a", { status: "missing" });
    await resolveGoneOwners(db, deps({ cooldowns }));
    expect(calls.map((call) => call.owner)).toContain("a");
    expect(cooldowns.has(github)).toBe(false);
  });

  it("only asks forges whose provider can answer, and skips paths with no owner", async () => {
    const gitea = seedForge(db, "gitea.example.com", "gitea");
    const unsupported = repo(gitea, "a/x");
    repo(github, "noslash");

    await resolveGoneOwners(db, deps());

    expect(calls).toEqual([]);
    expect(row(unsupported)).toEqual({ owner_gone: null, owner_checked_at: null });
  });

  it("never throws: a provider that rejects is unknown, and a broken database is logged", async () => {
    const id = repo(github, "a/x");
    answers.set("a", new Error("socket exploded"));

    await expect(resolveGoneOwners(db, deps())).resolves.toMatchObject({ unknown: 1 });
    expect(row(id)).toEqual({ owner_gone: null, owner_checked_at: NOW });

    db.exec("ALTER TABLE repos RENAME TO repos_gone");
    await expect(resolveGoneOwners(db, deps())).resolves.toMatchObject({ asked: 0 });
  });

  it("treats a credential it cannot decrypt as unknown, not as an answer", async () => {
    account(github, "bot", true);
    const id = repo(github, "a/x");

    await resolveGoneOwners(db, deps({ secretKey: null }));

    expect(calls).toEqual([]);
    expect(row(id)).toEqual({ owner_gone: null, owner_checked_at: NOW });
  });

  describe("credential selection", () => {
    it("uses the forge default account, then the repo's override", async () => {
      account(github, "default-bot", true);
      const other = account(github, "override-bot", false);
      repo(github, "a/x");
      repo(github, "b/x", { override: other });

      await resolveGoneOwners(db, deps());

      expect(calls.map((call) => [call.owner, call.context.username, call.context.token])).toEqual([
        ["a", "default-bot", "secret-3"],
        ["b", "override-bot", "secret-3"],
      ]);
    });

    it("goes anonymous when the repo forces it, and never uses another forge's account", async () => {
      account(github, "default-bot", true);
      const foreign = account(gitlab, "gitlab-bot", false);
      repo(github, "a/x", { anonymous: true });
      repo(github, "b/x", { override: foreign });

      await resolveGoneOwners(db, deps());

      expect(calls.map((call) => call.context.token)).toEqual([null, null]);
    });
  });
});
