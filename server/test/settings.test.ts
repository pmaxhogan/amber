import { defaultSettings } from "@amber/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createAccount, setDefaultAccount } from "../src/domain/accounts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { createRepo, updateRepo } from "../src/domain/repos.ts";
import {
  explainSettings,
  getScopeSettings,
  putScopeSettings,
  resolveGlobalSettings,
  resolveSettings,
} from "../src/domain/settings.ts";
import { createTempDb, seedForge, TEST_SECRET_KEY, type TempDb } from "./helpers.ts";

const KEY = Buffer.from(TEST_SECRET_KEY, "hex");

let temp: TempDb;
let db: Db;
let forgeId: number;
let accountId: number;
let repoId: number;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  forgeId = seedForge(db, "github.com");
  accountId = createAccount(db, KEY, {
    forgeId,
    username: "pmaxhogan",
    secret: null,
    isDefault: false,
  }).id;
  repoId = createRepo(db, { forgeId, path: "nodejs/node" }).id;
});

afterEach(() => {
  temp.close();
});

describe("resolveSettings defaults", () => {
  it("returns every registry default when nothing is stored", () => {
    expect(resolveSettings(db, repoId)).toEqual(defaultSettings());
  });

  it("throws for an unknown repo", () => {
    expect(() => resolveSettings(db, 999)).toThrow(/does not exist/);
    expect(() => explainSettings(db, 999)).toThrow(/does not exist/);
  });
});

describe("layered resolution, narrowest wins", () => {
  it("lets global override the registry default", () => {
    putScopeSettings(db, "global", null, { clone_mode: "mirror" });
    expect(resolveSettings(db, repoId).clone_mode).toBe("mirror");
  });

  it("lets forge override global", () => {
    putScopeSettings(db, "global", null, { clone_mode: "mirror" });
    putScopeSettings(db, "forge", forgeId, { clone_mode: "shallow" });
    expect(resolveSettings(db, repoId).clone_mode).toBe("shallow");
  });

  it("lets the effective account override the forge", () => {
    putScopeSettings(db, "global", null, { clone_mode: "mirror" });
    putScopeSettings(db, "forge", forgeId, { clone_mode: "shallow" });
    putScopeSettings(db, "account", accountId, { clone_mode: "full" });
    expect(resolveSettings(db, repoId).clone_mode).toBe("full");
  });

  it("lets the repo override everything", () => {
    putScopeSettings(db, "global", null, { clone_mode: "mirror" });
    putScopeSettings(db, "forge", forgeId, { clone_mode: "shallow" });
    putScopeSettings(db, "account", accountId, { clone_mode: "full" });
    putScopeSettings(db, "repo", repoId, { clone_mode: "bare" });
    expect(resolveSettings(db, repoId).clone_mode).toBe("bare");
  });

  it("resolves each key independently", () => {
    putScopeSettings(db, "global", null, { clone_mode: "mirror", sync_interval_minutes: 60 });
    putScopeSettings(db, "forge", forgeId, { paranoid: true });
    putScopeSettings(db, "repo", repoId, { sync_interval_minutes: 15 });

    const resolved = resolveSettings(db, repoId);
    expect(resolved.clone_mode).toBe("mirror");
    expect(resolved.paranoid).toBe(true);
    expect(resolved.sync_interval_minutes).toBe(15);
    expect(resolved.lfs_enabled).toBe(true);
    expect(resolved.shallow_depth).toBe(1);
  });

  it("falls through a scope that stores nothing", () => {
    putScopeSettings(db, "global", null, { shallow_depth: 5 });
    putScopeSettings(db, "forge", forgeId, { clone_mode: "shallow" });
    expect(resolveSettings(db, repoId).shallow_depth).toBe(5);
  });
});

describe("the effective account layer", () => {
  it("uses the forge default account when the repo has no override", () => {
    setDefaultAccount(db, accountId);
    putScopeSettings(db, "account", accountId, { paranoid: true });
    expect(resolveSettings(db, repoId).paranoid).toBe(true);
    expect(explainSettings(db, repoId).paranoid).toMatchObject({
      source: "account",
      sourceId: accountId,
    });
  });

  it("uses the override account rather than the forge default", () => {
    const override = createAccount(db, KEY, {
      forgeId,
      username: "second",
      secret: null,
      isDefault: false,
    }).id;
    putScopeSettings(db, "account", accountId, { clone_mode: "mirror" });
    putScopeSettings(db, "account", override, { clone_mode: "full" });
    updateRepo(db, repoId, { accountOverrideId: override });

    expect(resolveSettings(db, repoId).clone_mode).toBe("full");
    expect(explainSettings(db, repoId).clone_mode.sourceId).toBe(override);
  });

  it("skips the account layer entirely when force_anonymous is set", () => {
    setDefaultAccount(db, accountId);
    putScopeSettings(db, "forge", forgeId, { clone_mode: "shallow" });
    putScopeSettings(db, "account", accountId, { clone_mode: "full" });
    expect(resolveSettings(db, repoId).clone_mode).toBe("full");

    updateRepo(db, repoId, { forceAnonymous: true });
    // The account value must NOT win; resolution falls through to the forge.
    expect(resolveSettings(db, repoId).clone_mode).toBe("shallow");
    expect(explainSettings(db, repoId).clone_mode).toMatchObject({
      source: "forge",
      sourceId: forgeId,
    });
  });

  it("skips the account layer even when an explicit override is set, if anonymous", () => {
    putScopeSettings(db, "account", accountId, { clone_mode: "full" });
    updateRepo(db, repoId, { accountOverrideId: accountId, forceAnonymous: true });
    expect(resolveSettings(db, repoId).clone_mode).toBe("bare");
    expect(explainSettings(db, repoId).clone_mode.source).toBe("default");
  });

  it("skips the account layer when the forge has no accounts at all", () => {
    const bareForgeId = seedForge(db, "git.example.com", "generic");
    const bareRepoId = createRepo(db, { forgeId: bareForgeId, path: "team/thing" }).id;
    putScopeSettings(db, "account", accountId, { clone_mode: "full" });
    putScopeSettings(db, "forge", bareForgeId, { clone_mode: "mirror" });
    expect(resolveSettings(db, bareRepoId).clone_mode).toBe("mirror");
    expect(explainSettings(db, bareRepoId).clone_mode.source).toBe("forge");
  });
});

describe("explainSettings", () => {
  it("reports the default source when nothing is stored", () => {
    const explanation = explainSettings(db, repoId);
    expect(explanation.clone_mode).toEqual({ value: "bare", source: "default", sourceId: null });
    expect(explanation.max_concurrent_syncs).toEqual({
      value: 8,
      source: "default",
      sourceId: null,
    });
  });

  it("reports the winning scope and its id for each key", () => {
    setDefaultAccount(db, accountId);
    putScopeSettings(db, "global", null, { sync_interval_minutes: 60 });
    putScopeSettings(db, "forge", forgeId, { lfs_enabled: false });
    putScopeSettings(db, "account", accountId, { paranoid: true });
    putScopeSettings(db, "repo", repoId, { clone_mode: "mirror" });

    const explanation = explainSettings(db, repoId);
    expect(explanation.sync_interval_minutes).toEqual({
      value: 60,
      source: "global",
      sourceId: null,
    });
    expect(explanation.lfs_enabled).toEqual({ value: false, source: "forge", sourceId: forgeId });
    expect(explanation.paranoid).toEqual({ value: true, source: "account", sourceId: accountId });
    expect(explanation.clone_mode).toEqual({ value: "mirror", source: "repo", sourceId: repoId });
    expect(explanation.shallow_depth).toEqual({ value: 1, source: "default", sourceId: null });
  });

  it("agrees with resolveSettings on every key", () => {
    putScopeSettings(db, "global", null, { clone_mode: "shallow", shallow_depth: 3 });
    putScopeSettings(db, "repo", repoId, { paranoid: true });

    const resolved = resolveSettings(db, repoId);
    const explanation = explainSettings(db, repoId);
    for (const key of Object.keys(resolved) as (keyof typeof resolved)[]) {
      expect(explanation[key].value).toEqual(resolved[key]);
    }
  });
});

describe("resolveGlobalSettings", () => {
  it("merges only the global scope over the defaults", () => {
    putScopeSettings(db, "global", null, { max_concurrent_syncs: 3 });
    putScopeSettings(db, "forge", forgeId, { clone_mode: "mirror" });

    const resolved = resolveGlobalSettings(db);
    expect(resolved.max_concurrent_syncs).toBe(3);
    expect(resolved.max_concurrent_per_forge).toBe(4);
    // The forge value must not leak into the process wide view.
    expect(resolved.clone_mode).toBe("bare");
  });
});

describe("putScopeSettings validation", () => {
  it("rejects unknown keys without writing anything", () => {
    expect(() => putScopeSettings(db, "global", null, { not_a_setting: 1 })).toThrow(DomainError);
    try {
      putScopeSettings(db, "global", null, { clone_mode: "mirror", not_a_setting: 1 });
    } catch (error) {
      expect((error as DomainError).details).toEqual({
        settings: { not_a_setting: "Unknown setting" },
      });
    }
    expect(getScopeSettings(db, "global", null)).toEqual({});
  });

  it("rejects a value that fails the registry schema", () => {
    expect(() => putScopeSettings(db, "global", null, { clone_mode: "nonsense" })).toThrow(
      DomainError,
    );
    expect(() => putScopeSettings(db, "global", null, { shallow_depth: 0 })).toThrow(DomainError);
    expect(() => putScopeSettings(db, "global", null, { sync_enabled: "yes" })).toThrow(
      DomainError,
    );
    expect(getScopeSettings(db, "global", null)).toEqual({});
  });

  it("rejects a global only key at a narrower scope", () => {
    expect(() => putScopeSettings(db, "repo", repoId, { max_concurrent_syncs: 2 })).toThrow(
      /could not be saved/,
    );
    expect(() => putScopeSettings(db, "forge", forgeId, { max_concurrent_per_forge: 2 })).toThrow(
      DomainError,
    );
    expect(putScopeSettings(db, "global", null, { max_concurrent_syncs: 2 })).toEqual({
      max_concurrent_syncs: 2,
    });
  });

  it("rejects a scope id that names nothing", () => {
    expect(() => putScopeSettings(db, "forge", 999, { clone_mode: "mirror" })).toThrow(
      /does not exist/,
    );
    expect(() => putScopeSettings(db, "account", 999, { clone_mode: "mirror" })).toThrow(
      /does not exist/,
    );
    expect(() => putScopeSettings(db, "repo", 999, { clone_mode: "mirror" })).toThrow(
      /does not exist/,
    );
  });

  it("insists global carries no scope id and the others do", () => {
    expect(() => putScopeSettings(db, "global", forgeId, { clone_mode: "mirror" })).toThrow(
      /take no scope id/,
    );
    expect(() => putScopeSettings(db, "forge", null, { clone_mode: "mirror" })).toThrow(
      /needs a scope id/,
    );
    expect(() => getScopeSettings(db, "repo", null)).toThrow(/needs a scope id/);
  });
});

describe("putScopeSettings writes", () => {
  it("stores, updates, and returns the scope values", () => {
    expect(putScopeSettings(db, "repo", repoId, { clone_mode: "mirror" })).toEqual({
      clone_mode: "mirror",
    });
    expect(
      putScopeSettings(db, "repo", repoId, { clone_mode: "shallow", shallow_depth: 7 }),
    ).toEqual({ clone_mode: "shallow", shallow_depth: 7 });
    expect(getScopeSettings(db, "repo", repoId)).toEqual({
      clone_mode: "shallow",
      shallow_depth: 7,
    });
  });

  it("clears an override when the value is null, falling through again", () => {
    putScopeSettings(db, "global", null, { clone_mode: "mirror" });
    putScopeSettings(db, "repo", repoId, { clone_mode: "bare" });
    expect(resolveSettings(db, repoId).clone_mode).toBe("bare");

    putScopeSettings(db, "repo", repoId, { clone_mode: null });
    expect(getScopeSettings(db, "repo", repoId)).toEqual({});
    expect(resolveSettings(db, repoId).clone_mode).toBe("mirror");
  });

  it("clearing a key that was never set is harmless", () => {
    expect(putScopeSettings(db, "repo", repoId, { clone_mode: null })).toEqual({});
  });

  it("keeps scopes and scope ids apart", () => {
    const otherRepoId = createRepo(db, { forgeId, path: "facebook/react" }).id;
    putScopeSettings(db, "repo", repoId, { clone_mode: "mirror" });
    putScopeSettings(db, "repo", otherRepoId, { clone_mode: "full" });
    putScopeSettings(db, "global", null, { clone_mode: "shallow" });

    expect(getScopeSettings(db, "repo", repoId)).toEqual({ clone_mode: "mirror" });
    expect(getScopeSettings(db, "repo", otherRepoId)).toEqual({ clone_mode: "full" });
    expect(getScopeSettings(db, "global", null)).toEqual({ clone_mode: "shallow" });
  });

  it("stores every registry type faithfully", () => {
    const written = putScopeSettings(db, "repo", repoId, {
      clone_mode: "shallow",
      shallow_depth: 42,
      sync_interval_minutes: 15,
      sync_enabled: false,
      lfs_enabled: false,
      paranoid: true,
    });
    expect(written).toEqual({
      clone_mode: "shallow",
      shallow_depth: 42,
      sync_interval_minutes: 15,
      sync_enabled: false,
      lfs_enabled: false,
      paranoid: true,
    });
    expect(resolveSettings(db, repoId)).toMatchObject(written);
  });

  it("survives a stored row that no longer validates", () => {
    putScopeSettings(db, "repo", repoId, { clone_mode: "mirror" });
    db.run("UPDATE settings SET value = ? WHERE key = 'clone_mode'", '"no-such-mode"');
    // The bad row is skipped rather than breaking every other key.
    expect(resolveSettings(db, repoId).clone_mode).toBe("bare");
    expect(getScopeSettings(db, "repo", repoId)).toEqual({});
  });

  it("survives a stored row whose key left the registry", () => {
    const now = Date.now();
    db.run(
      "INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at) VALUES ('repo', ?, 'retired_key', '1', ?, ?)",
      repoId,
      now,
      now,
    );
    expect(getScopeSettings(db, "repo", repoId)).toEqual({});
    expect(resolveSettings(db, repoId)).toEqual(defaultSettings());
  });

  it("survives a stored row that is not valid JSON", () => {
    const now = Date.now();
    db.run(
      "INSERT INTO settings (scope_type, scope_id, key, value, created_at, updated_at) VALUES ('repo', ?, 'clone_mode', 'not json', ?, ?)",
      repoId,
      now,
      now,
    );
    expect(resolveSettings(db, repoId).clone_mode).toBe("bare");
  });
});
