import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { DomainError } from "../src/domain/errors.ts";
import {
  deleteForge,
  detectForgeKind,
  findForge,
  getForge,
  listForges,
  normalizeHost,
  normalizePort,
  updateForge,
  upsertForge,
} from "../src/domain/forges.ts";
import { createRepo } from "../src/domain/repos.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

let temp: TempDb;
let db: Db;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
});

afterEach(() => {
  temp.close();
});

describe("detectForgeKind", () => {
  it("recognizes the three hosted forges", () => {
    expect(detectForgeKind("github.com")).toBe("github");
    expect(detectForgeKind("gitlab.com")).toBe("gitlab");
    expect(detectForgeKind("bitbucket.org")).toBe("bitbucket");
  });

  it("is case and whitespace insensitive", () => {
    expect(detectForgeKind("GitHub.COM")).toBe("github");
    expect(detectForgeKind("  gitlab.com  ")).toBe("gitlab");
  });

  it("falls back to generic for self hosted and unknown hosts", () => {
    expect(detectForgeKind("git.example.com")).toBe("generic");
    expect(detectForgeKind("gitea.internal")).toBe("generic");
    expect(detectForgeKind("notgithub.com")).toBe("generic");
    expect(detectForgeKind("github.com.evil.example")).toBe("generic");
  });
});

describe("normalizeHost and normalizePort", () => {
  it("lowercases and trims hosts", () => {
    expect(normalizeHost("  GitHub.com ")).toBe("github.com");
  });

  it("stores the protocol default port as null", () => {
    expect(normalizePort("https", 443)).toBeNull();
    expect(normalizePort("http", 80)).toBeNull();
    expect(normalizePort("https", 8443)).toBe(8443);
    expect(normalizePort("http", 443)).toBe(443);
    expect(normalizePort("https", null)).toBeNull();
  });
});

describe("upsertForge", () => {
  it("creates a forge and detects its kind", () => {
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    expect(forge.kind).toBe("github");
    expect(forge.host).toBe("github.com");
    expect(forge.port).toBeNull();
    expect(forge.id).toBeGreaterThan(0);
  });

  it("honors an explicit kind for self hosted forges", () => {
    const forge = upsertForge(db, {
      protocol: "https",
      host: "git.example.com",
      port: null,
      kind: "gitea",
    });
    expect(forge.kind).toBe("gitea");
  });

  it("is idempotent for the same origin", () => {
    const first = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    const second = upsertForge(db, { protocol: "https", host: "GitHub.com", port: null });
    expect(second.id).toBe(first.id);
    expect(listForges(db)).toHaveLength(1);
  });

  it("treats the default port and no port as the same origin", () => {
    const first = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    const second = upsertForge(db, { protocol: "https", host: "github.com", port: 443 });
    expect(second.id).toBe(first.id);
  });

  it("keeps a corrected kind when the same origin is imported again", () => {
    const forge = upsertForge(db, { protocol: "https", host: "git.example.com", port: null });
    updateForge(db, forge.id, { kind: "gitea" });
    const again = upsertForge(db, {
      protocol: "https",
      host: "git.example.com",
      port: null,
      kind: "generic",
    });
    expect(again.kind).toBe("gitea");
  });

  it("keeps different protocols, hosts, and ports apart", () => {
    upsertForge(db, { protocol: "https", host: "git.example.com", port: null });
    upsertForge(db, { protocol: "http", host: "git.example.com", port: null });
    upsertForge(db, { protocol: "https", host: "git.example.com", port: 8443 });
    upsertForge(db, { protocol: "https", host: "other.example.com", port: null });
    expect(listForges(db)).toHaveLength(4);
  });
});

describe("findForge and getForge", () => {
  it("finds an origin without creating it", () => {
    expect(findForge(db, "https", "github.com", null)).toBeUndefined();
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    expect(findForge(db, "https", "github.com", null)?.id).toBe(forge.id);
    expect(findForge(db, "https", "github.com", 443)?.id).toBe(forge.id);
    expect(findForge(db, "http", "github.com", null)).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    expect(getForge(db, 999)).toBeUndefined();
  });
});

describe("host immutability", () => {
  it("changes only the kind", () => {
    const forge = upsertForge(db, { protocol: "https", host: "git.example.com", port: 8443 });
    const updated = updateForge(db, forge.id, { kind: "gitlab" });
    expect(updated.kind).toBe("gitlab");
    expect(updated.protocol).toBe(forge.protocol);
    expect(updated.host).toBe(forge.host);
    expect(updated.port).toBe(forge.port);
  });

  it("ignores protocol, host, and port however they are smuggled into the patch", () => {
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    const attack = {
      kind: "github",
      host: "evil.example.com",
      protocol: "http",
      port: 1337,
    } as Parameters<typeof updateForge>[2];

    const updated = updateForge(db, forge.id, attack);
    expect(updated.host).toBe("github.com");
    expect(updated.protocol).toBe("https");
    expect(updated.port).toBeNull();

    // And the row itself, not just the returned object.
    expect(getForge(db, forge.id)).toMatchObject({
      host: "github.com",
      protocol: "https",
      port: null,
    });
  });

  it("is a no-op when the kind is unchanged or absent", () => {
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    expect(updateForge(db, forge.id, {}).updatedAt).toBe(forge.updatedAt);
    expect(updateForge(db, forge.id, { kind: "github" }).updatedAt).toBe(forge.updatedAt);
  });

  it("throws for an unknown forge", () => {
    expect(() => updateForge(db, 999, { kind: "gitea" })).toThrow(DomainError);
    expect(() => updateForge(db, 999, { kind: "gitea" })).toThrow(/does not exist/);
  });
});

describe("deleteForge", () => {
  it("removes a forge with no repositories", () => {
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    deleteForge(db, forge.id);
    expect(getForge(db, forge.id)).toBeUndefined();
  });

  it("cascades its accounts away", () => {
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    const now = Date.now();
    db.run(
      "INSERT INTO accounts (forge_id, username, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
      forge.id,
      "pmaxhogan",
      now,
      now,
    );
    deleteForge(db, forge.id);
    expect(db.all("SELECT id FROM accounts")).toHaveLength(0);
  });

  it("refuses while repositories still reference it", () => {
    const forge = upsertForge(db, { protocol: "https", host: "github.com", port: null });
    createRepo(db, { forgeId: forge.id, path: "nodejs/node" });
    expect(() => deleteForge(db, forge.id)).toThrow(DomainError);
    expect(() => deleteForge(db, forge.id)).toThrow(/still has 1 repositories/);
    expect(getForge(db, forge.id)).toBeDefined();
  });

  it("throws for an unknown forge", () => {
    expect(() => deleteForge(db, 999)).toThrow(/does not exist/);
  });
});

describe("listForges", () => {
  it("sorts by host", () => {
    upsertForge(db, { protocol: "https", host: "zeta.example.com", port: null });
    upsertForge(db, { protocol: "https", host: "alpha.example.com", port: null });
    expect(listForges(db).map((forge) => forge.host)).toEqual([
      "alpha.example.com",
      "zeta.example.com",
    ]);
  });
});
