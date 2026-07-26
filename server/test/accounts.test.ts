import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import {
  createAccount,
  deleteAccount,
  findAccountByUsername,
  getAccount,
  getCredential,
  getDefaultAccount,
  listAccounts,
  markAccountUsed,
  setDefaultAccount,
  updateAccount,
} from "../src/domain/accounts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { SecretError } from "../src/security/secrets.ts";
import { createTempDb, seedForge, TEST_SECRET_KEY, type TempDb } from "./helpers.ts";

const KEY = Buffer.from(TEST_SECRET_KEY, "hex");
const SENTINEL = "SENTINEL-github_pat_11ABCDEF-do-not-leak";

let temp: TempDb;
let db: Db;
let forgeId: number;
let otherForgeId: number;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  forgeId = seedForge(db, "github.com");
  otherForgeId = seedForge(db, "gitlab.com", "gitlab");
});

afterEach(() => {
  temp.close();
});

const make = (username: string, overrides: Partial<Parameters<typeof createAccount>[2]> = {}) =>
  createAccount(db, KEY, {
    forgeId,
    username,
    secret: null,
    isDefault: false,
    ...overrides,
  });

describe("createAccount", () => {
  it("stores an account and reports whether it carries a secret", () => {
    const withSecret = make("pmaxhogan", { secret: SENTINEL });
    const without = make("readonly-bot");
    expect(withSecret.hasSecret).toBe(true);
    expect(without.hasSecret).toBe(false);
    expect(withSecret.username).toBe("pmaxhogan");
    expect(withSecret.forgeId).toBe(forgeId);
  });

  it("trims the username and rejects an empty one", () => {
    expect(make("  spaced  ").username).toBe("spaced");
    expect(() => make("   ")).toThrow(DomainError);
  });

  it("rejects a duplicate username on the same forge", () => {
    make("pmaxhogan");
    expect(() => make("pmaxhogan")).toThrow(DomainError);
    expect(() => make("pmaxhogan")).toThrow(/already exists on this forge/);
  });

  it("allows the same username on a different forge", () => {
    make("pmaxhogan");
    const elsewhere = createAccount(db, KEY, {
      forgeId: otherForgeId,
      username: "pmaxhogan",
      secret: null,
      isDefault: false,
    });
    expect(elsewhere.forgeId).toBe(otherForgeId);
    expect(elsewhere.isDefault).toBe(true);
  });

  it("refuses to store a secret without a usable key", () => {
    expect(() =>
      createAccount(db, null, { forgeId, username: "x", secret: SENTINEL, isDefault: false }),
    ).toThrow(SecretError);
    // The failed insert must not have left a row behind.
    expect(listAccounts(db, forgeId)).toHaveLength(0);
  });

  it("stores an account with no secret even when no key is configured", () => {
    const account = createAccount(db, null, {
      forgeId,
      username: "anon",
      secret: null,
      isDefault: false,
    });
    expect(account.hasSecret).toBe(false);
  });

  it("throws for an unknown forge", () => {
    expect(() =>
      createAccount(db, KEY, { forgeId: 999, username: "x", secret: null, isDefault: false }),
    ).toThrow(/does not exist/);
  });
});

describe("exactly one default per forge", () => {
  it("makes the first account the default even when it does not ask to be", () => {
    const first = make("first");
    expect(first.isDefault).toBe(true);
    expect(getDefaultAccount(db, forgeId)?.id).toBe(first.id);
  });

  it("does not promote later accounts automatically", () => {
    const first = make("first");
    const second = make("second");
    expect(second.isDefault).toBe(false);
    expect(getDefaultAccount(db, forgeId)?.id).toBe(first.id);
  });

  it("demotes the previous default when a new account asks to be default", () => {
    const first = make("first");
    const second = make("second", { isDefault: true });
    expect(second.isDefault).toBe(true);
    expect(getAccount(db, first.id)?.isDefault).toBe(false);
    expect(listAccounts(db, forgeId).filter((account) => account.isDefault)).toHaveLength(1);
  });

  it("promotes any account on request and keeps exactly one default", () => {
    const first = make("first");
    const second = make("second");
    const third = make("third");

    const promoted = setDefaultAccount(db, third.id);
    expect(promoted.isDefault).toBe(true);
    expect(getAccount(db, first.id)?.isDefault).toBe(false);
    expect(getAccount(db, second.id)?.isDefault).toBe(false);
    expect(listAccounts(db, forgeId).filter((account) => account.isDefault)).toHaveLength(1);
  });

  it("is a no-op when promoting the current default", () => {
    const first = make("first");
    expect(setDefaultAccount(db, first.id).id).toBe(first.id);
    expect(listAccounts(db, forgeId).filter((account) => account.isDefault)).toHaveLength(1);
  });

  it("promotes the oldest remaining account when the default is deleted", () => {
    const first = make("first");
    const second = make("second");
    const third = make("third");
    expect(first.isDefault).toBe(true);

    deleteAccount(db, first.id);
    expect(getDefaultAccount(db, forgeId)?.id).toBe(second.id);

    deleteAccount(db, second.id);
    expect(getDefaultAccount(db, forgeId)?.id).toBe(third.id);
  });

  it("does not disturb the default when a non-default account is deleted", () => {
    const first = make("first");
    const second = make("second");
    deleteAccount(db, second.id);
    expect(getDefaultAccount(db, forgeId)?.id).toBe(first.id);
  });

  it("leaves no default when the last account goes", () => {
    const only = make("only");
    deleteAccount(db, only.id);
    expect(getDefaultAccount(db, forgeId)).toBeUndefined();
    expect(listAccounts(db, forgeId)).toHaveLength(0);
  });

  it("keeps defaults independent per forge", () => {
    const githubDefault = make("gh");
    const gitlabDefault = createAccount(db, KEY, {
      forgeId: otherForgeId,
      username: "gl",
      secret: null,
      isDefault: false,
    });
    expect(getDefaultAccount(db, forgeId)?.id).toBe(githubDefault.id);
    expect(getDefaultAccount(db, otherForgeId)?.id).toBe(gitlabDefault.id);

    deleteAccount(db, githubDefault.id);
    expect(getDefaultAccount(db, otherForgeId)?.id).toBe(gitlabDefault.id);
  });

  it("survives a long churn of creates, promotions, and deletes", () => {
    const ids = ["a", "b", "c", "d", "e"].map((name) => make(name).id);
    setDefaultAccount(db, ids[3]!);
    deleteAccount(db, ids[3]!);
    setDefaultAccount(db, ids[4]!);
    deleteAccount(db, ids[0]!);
    deleteAccount(db, ids[4]!);

    const remaining = listAccounts(db, forgeId);
    expect(remaining).toHaveLength(2);
    expect(remaining.filter((account) => account.isDefault)).toHaveLength(1);
  });
});

describe("forge immutability", () => {
  it("has no forgeId on the update contract, and ignores one that is smuggled in", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    const attack = { username: "pmaxhogan", forgeId: otherForgeId } as Parameters<
      typeof updateAccount
    >[3];

    const updated = updateAccount(db, KEY, account.id, attack);
    expect(updated.forgeId).toBe(forgeId);
    expect(getAccount(db, account.id)?.forgeId).toBe(forgeId);
  });

  it("cannot move an account between forges through any exported function", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });

    updateAccount(db, KEY, account.id, { username: "renamed" });
    expect(getAccount(db, account.id)?.forgeId).toBe(forgeId);

    updateAccount(db, KEY, account.id, { secret: "replacement" });
    expect(getAccount(db, account.id)?.forgeId).toBe(forgeId);

    setDefaultAccount(db, account.id);
    expect(getAccount(db, account.id)?.forgeId).toBe(forgeId);

    // The credential still belongs to the forge it was created for.
    expect(listAccounts(db, otherForgeId)).toHaveLength(0);
    expect(listAccounts(db, forgeId).map((a) => a.id)).toContain(account.id);
  });
});

describe("updateAccount", () => {
  it("renames an account", () => {
    const account = make("old-name");
    expect(updateAccount(db, KEY, account.id, { username: "new-name" }).username).toBe("new-name");
  });

  it("rejects a rename onto an existing username", () => {
    make("taken");
    const account = make("free");
    expect(() => updateAccount(db, KEY, account.id, { username: "taken" })).toThrow(
      /already exists on this forge/,
    );
    expect(getAccount(db, account.id)?.username).toBe("free");
  });

  it("leaves the secret untouched when it is omitted", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    updateAccount(db, KEY, account.id, { username: "renamed" });
    expect(getAccount(db, account.id)?.hasSecret).toBe(true);
    expect(getCredential(db, KEY, account.id).secret).toBe(SENTINEL);
  });

  it("overwrites the secret in place", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    updateAccount(db, KEY, account.id, { secret: "second-value" });
    expect(getCredential(db, KEY, account.id).secret).toBe("second-value");
  });

  it("clears the secret when it is explicitly null", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    const updated = updateAccount(db, KEY, account.id, { secret: null });
    expect(updated.hasSecret).toBe(false);
    expect(getCredential(db, KEY, account.id).secret).toBeNull();
  });

  it("keeps the default flag across an update", () => {
    const account = make("only");
    expect(updateAccount(db, KEY, account.id, { username: "renamed" }).isDefault).toBe(true);
  });

  it("throws for an unknown account", () => {
    expect(() => updateAccount(db, KEY, 999, { username: "x" })).toThrow(/does not exist/);
    expect(() => setDefaultAccount(db, 999)).toThrow(/does not exist/);
    expect(() => deleteAccount(db, 999)).toThrow(/does not exist/);
  });
});

describe("secrets never leave through the account API", () => {
  it("returns no secret material on any account shaped result", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    const surfaces = [
      account,
      getAccount(db, account.id),
      getDefaultAccount(db, forgeId),
      findAccountByUsername(db, forgeId, "pmaxhogan"),
      listAccounts(db),
      listAccounts(db, forgeId),
      updateAccount(db, KEY, account.id, { username: "pmaxhogan" }),
      setDefaultAccount(db, account.id),
    ];

    for (const surface of surfaces) {
      const serialized = JSON.stringify(surface);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain("secret_enc");
      expect(serialized).not.toContain("secretEnc");
    }
    expect(Object.keys(account)).not.toContain("secret");
  });

  it("keeps the secret out of a duplicate-username conflict message", () => {
    make("pmaxhogan", { secret: SENTINEL });
    try {
      createAccount(db, KEY, {
        forgeId,
        username: "pmaxhogan",
        secret: SENTINEL,
        isDefault: false,
      });
      throw new Error("expected a conflict");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("already exists");
      expect(message).not.toContain(SENTINEL);
    }
  });

  it("stores the credential encrypted rather than in the clear", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    const row = db.get<{ secret_enc: Uint8Array }>(
      "SELECT secret_enc FROM accounts WHERE id = ?",
      account.id,
    );
    const blob = Buffer.from(row!.secret_enc);
    expect(blob.toString("utf8")).not.toContain(SENTINEL);
    expect(blob.length).toBeGreaterThan(SENTINEL.length);
  });
});

describe("getCredential", () => {
  it("returns the username and decrypted secret for the sync engine", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    expect(getCredential(db, KEY, account.id)).toEqual({
      username: "pmaxhogan",
      secret: SENTINEL,
    });
  });

  it("returns a null secret for an anonymous account", () => {
    const account = make("anon");
    expect(getCredential(db, KEY, account.id)).toEqual({ username: "anon", secret: null });
  });

  it("throws for an unknown account", () => {
    expect(() => getCredential(db, KEY, 999)).toThrow(/does not exist/);
  });

  it("throws rather than returning garbage under the wrong key", () => {
    const account = make("pmaxhogan", { secret: SENTINEL });
    expect(() => getCredential(db, Buffer.from("b".repeat(64), "hex"), account.id)).toThrow(
      SecretError,
    );
  });
});

describe("markAccountUsed", () => {
  it("stamps last_used_at", () => {
    const account = make("pmaxhogan");
    expect(account.lastUsedAt).toBeNull();
    markAccountUsed(db, account.id, 1_700_000_000_000);
    expect(getAccount(db, account.id)?.lastUsedAt).toBe(1_700_000_000_000);
  });
});

describe("listAccounts", () => {
  it("filters by forge and orders oldest first", () => {
    make("a");
    make("b");
    createAccount(db, KEY, {
      forgeId: otherForgeId,
      username: "c",
      secret: null,
      isDefault: false,
    });
    expect(listAccounts(db, forgeId).map((account) => account.username)).toEqual(["a", "b"]);
    expect(listAccounts(db)).toHaveLength(3);
  });

  it("finds an account by username on a forge only", () => {
    make("pmaxhogan");
    expect(findAccountByUsername(db, forgeId, "pmaxhogan")).toBeDefined();
    expect(findAccountByUsername(db, otherForgeId, "pmaxhogan")).toBeUndefined();
    expect(findAccountByUsername(db, forgeId, "  pmaxhogan ")).toBeDefined();
    expect(findAccountByUsername(db, forgeId, "nobody")).toBeUndefined();
  });
});
