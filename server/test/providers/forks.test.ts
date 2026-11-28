import type { ForgeKind } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.ts";
import {
  FORK_BATCH_SIZE,
  FORK_RATE_LIMIT_COOLDOWN_MS,
  FORK_RECHECK_MS,
  resolvePendingForks,
  type ForkResolverDeps,
} from "../../src/providers/forks.ts";
import type {
  AccountSyncProvider,
  DiscoveryContext,
  ForkLookup,
} from "../../src/providers/types.ts";
import { createTempDb, seedForge, type TempDb } from "../helpers.ts";

let temp: TempDb;
let db: Db;
let github: number;
let gitlab: number;
let calls: { path: string; context: DiscoveryContext }[];
let answers: Map<string, ForkLookup | Error>;
let clock: number;

const NOW = 10 * FORK_RECHECK_MS;

interface Row {
  fork_parent: string | null;
  fork_known: number;
  fork_checked_at: number | null;
}

function repo(
  forgeId: number,
  path: string,
  extra: {
    known?: number;
    parent?: string | null;
    checkedAt?: number | null;
    override?: number | null;
    anonymous?: boolean;
  } = {},
): number {
  return db.run(
    `INSERT INTO repos (forge_id, path, display_name, slug, short_id, fork_known, fork_parent,
                        fork_checked_at, account_override_id, force_anonymous, created_at, updated_at, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, (SELECT id FROM users WHERE is_admin = 1))`,
    forgeId,
    path,
    path,
    `slug-${path.replace("/", "-")}-${String(forgeId)}`,
    `id-${path.replace("/", "-")}-${String(forgeId)}`,
    extra.known ?? 0,
    extra.parent ?? null,
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
  return db.get<Row>(
    "SELECT fork_parent, fork_known, fork_checked_at FROM repos WHERE id = ?",
    id,
  )!;
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
    provider.getForkParent = (context, path) => {
      calls.push({ path, context });
      const answer = answers.get(path) ?? ({ status: "not_fork" } as ForkLookup);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    };
  }
  return provider;
}

function deps(extra: Partial<ForkResolverDeps> = {}): ForkResolverDeps {
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

describe("resolvePendingForks", () => {
  it("writes a parent, and writes not-a-fork as a known answer with a null parent", async () => {
    const forked = repo(github, "me/forked");
    const plain = repo(github, "me/plain");
    answers.set("me/forked", { status: "fork", parent: "up/stream" });

    const result = await resolvePendingForks(db, deps());

    expect(row(forked)).toEqual({ fork_parent: "up/stream", fork_known: 1, fork_checked_at: NOW });
    expect(row(plain)).toEqual({ fork_parent: null, fork_known: 1, fork_checked_at: NOW });
    expect(result).toMatchObject({ asked: 2, resolved: 2, unknown: 0 });
  });

  it("never asks about a repo that already has an answer", async () => {
    const id = repo(github, "me/known", { known: 1, parent: "a/b", checkedAt: 5 });
    // Its visibility was asked just now too, so nothing about it is due.
    db.run("UPDATE repos SET visibility_checked_at = ? WHERE id = ?", NOW, id);

    await resolvePendingForks(db, deps());

    expect(calls).toEqual([]);
  });

  it("asks never-asked repos before ones that were asked long ago", async () => {
    repo(github, "me/old", { checkedAt: NOW - 3 * FORK_RECHECK_MS });
    repo(github, "me/older", { checkedAt: NOW - 5 * FORK_RECHECK_MS });
    repo(github, "me/new");

    await resolvePendingForks(db, deps());

    expect(calls.map((call) => call.path)).toEqual(["me/new", "me/older", "me/old"]);
  });

  it("takes a bounded batch, 20 by default", async () => {
    for (let index = 0; index < FORK_BATCH_SIZE + 5; index += 1) {
      repo(github, `me/r${String(index).padStart(2, "0")}`);
    }

    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(FORK_BATCH_SIZE);

    calls = [];
    await resolvePendingForks(db, deps(), { batchSize: 2 });
    expect(calls).toHaveLength(2);
  });

  it("records unknown as a check time only, and retries it after 24 hours and not before", async () => {
    const id = repo(github, "me/private");
    answers.set("me/private", { status: "unknown", rateLimited: false });

    const first = await resolvePendingForks(db, deps());
    expect(row(id)).toEqual({ fork_parent: null, fork_known: 0, fork_checked_at: NOW });
    expect(first.unknown).toBe(1);

    clock = NOW + FORK_RECHECK_MS - 1;
    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(1);

    clock = NOW + FORK_RECHECK_MS;
    answers.set("me/private", { status: "fork", parent: "a/b" });
    await resolvePendingForks(db, deps());
    expect(calls).toHaveLength(2);
    expect(row(id)).toMatchObject({ fork_parent: "a/b", fork_known: 1 });
  });

  it("stops asking a rate limited forge for the pass and leaves the repo's check time alone", async () => {
    const limited = repo(github, "me/a");
    repo(github, "me/b");
    const other = repo(gitlab, "me/c");
    answers.set("me/a", { status: "unknown", rateLimited: true });

    const result = await resolvePendingForks(db, deps());

    expect(calls.map((call) => call.path)).toEqual(["me/a", "me/c"]);
    expect(row(limited).fork_checked_at).toBeNull();
    expect(row(other).fork_known).toBe(1);
    expect(result.rateLimitedForges).toBe(1);
  });

  it("keeps the cooldown across passes for an hour, then asks again", async () => {
    repo(github, "me/a");
    answers.set("me/a", { status: "unknown", rateLimited: true });
    const cooldowns = new Map<string, number>();

    await resolvePendingForks(db, deps({ cooldowns }));
    // Keyed by forge AND credential: an anonymous limit must not stall a token.
    expect(cooldowns.get(`${String(github)}:anon`)).toBe(NOW + FORK_RATE_LIMIT_COOLDOWN_MS);

    clock = NOW + FORK_RATE_LIMIT_COOLDOWN_MS - 1;
    await resolvePendingForks(db, deps({ cooldowns }));
    expect(calls).toHaveLength(1);

    clock = NOW + FORK_RATE_LIMIT_COOLDOWN_MS;
    answers.set("me/a", { status: "fork", parent: "x/y" });
    await resolvePendingForks(db, deps({ cooldowns }));
    expect(calls).toHaveLength(2);
    expect(cooldowns.has(`${String(github)}:anon`)).toBe(false);
  });

  it("only asks forges whose provider can answer", async () => {
    const gitea = seedForge(db, "gitea.example.com", "gitea");
    const unsupported = repo(gitea, "me/x");

    await resolvePendingForks(db, deps());

    expect(calls).toEqual([]);
    expect(row(unsupported)).toEqual({ fork_parent: null, fork_known: 0, fork_checked_at: null });
  });

  it("never throws: a provider that rejects is just unknown", async () => {
    const id = repo(github, "me/a");
    answers.set("me/a", new Error("socket exploded"));

    await expect(resolvePendingForks(db, deps())).resolves.toMatchObject({ unknown: 1 });
    expect(row(id)).toEqual({ fork_parent: null, fork_known: 0, fork_checked_at: NOW });
  });

  it("never throws when the database itself fails", async () => {
    db.exec("ALTER TABLE repos RENAME TO repos_gone");

    await expect(resolvePendingForks(db, deps())).resolves.toMatchObject({ asked: 0 });
  });

  it("treats a stored credential it cannot decrypt as unknown, not as an answer", async () => {
    account(github, "bot", true);
    const id = repo(github, "me/a");

    await resolvePendingForks(db, deps({ secretKey: null }));

    expect(calls).toEqual([]);
    expect(row(id)).toEqual({ fork_parent: null, fork_known: 0, fork_checked_at: NOW });
  });

  it("does not overwrite an answer that landed while the forge was being asked", async () => {
    const id = repo(github, "me/a");
    const provider = providerOf("github");
    provider.getForkParent = () => {
      db.run("UPDATE repos SET fork_known = 1, fork_parent = 'listing/said' WHERE id = ?", id);
      return Promise.resolve({ status: "fork", parent: "late/answer" });
    };

    const result = await resolvePendingForks(db, deps({ providerFor: () => provider }));

    expect(row(id).fork_parent).toBe("listing/said");
    expect(result.resolved).toBe(0);
  });

  it("tells the caller which repos changed", async () => {
    const id = repo(github, "me/a");
    const seen: number[] = [];

    await resolvePendingForks(db, deps({ onResolved: (repoId) => seen.push(repoId) }));

    expect(seen).toEqual([id]);
  });

  describe("credential selection", () => {
    it("uses the forge default account when the repo has no override", async () => {
      account(github, "default-bot", true);
      repo(github, "me/a");

      await resolvePendingForks(db, deps());

      expect(calls[0]?.context).toMatchObject({
        username: "default-bot",
        token: "secret-3",
        baseUrl: "https://github.com",
      });
    });

    it("prefers the repo's own override", async () => {
      account(github, "default-bot", true);
      const other = account(github, "override-bot", false);
      repo(github, "me/a", { override: other });

      await resolvePendingForks(db, deps());

      expect(calls[0]?.context.username).toBe("override-bot");
    });

    it("goes anonymous when the repo forces it, and when no account exists", async () => {
      account(github, "default-bot", true);
      repo(github, "me/a", { anonymous: true });
      repo(gitlab, "me/b");

      await resolvePendingForks(db, deps());

      expect(calls.map((call) => call.context.token)).toEqual([null, null]);
    });

    it("never presents another forge's account as an override", async () => {
      const foreign = account(gitlab, "gitlab-bot", false);
      repo(github, "me/a", { override: foreign });

      await resolvePendingForks(db, deps());

      expect(calls[0]?.context.token).toBeNull();
    });
  });
});
