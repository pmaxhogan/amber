import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  buildCloneUrlTemplate,
  disableGitRemote,
  enableGitRemote,
  GitRemoteDisabledError,
  KV_ENABLED,
  readGitRemoteState,
  rotateGitRemotePassword,
  toGitRemoteConfig,
} from "../src/gitremote/config.ts";
import {
  parseBasicAuth,
  pktLine,
  sanitizeGitProtocol,
  serviceAnnouncement,
} from "../src/gitremote/routes.ts";
import { AuthThrottle } from "../src/gitremote/throttle.ts";
import { buildGitEnv, GitSpawnError, liveGitProcessCount, runGitCapture } from "../src/gitSpawn.ts";
import { getRepo, getRepoBySlug } from "../src/domain/repos.ts";
import { repoDirFor } from "../src/repoDir.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { insertRepoRow } from "./helpers/gitFixture.ts";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, createConsoleLogger("silent"));
});

afterEach(() => {
  db.close();
});

describe("pkt-line framing", () => {
  it("prefixes the payload with its total length in hex", () => {
    expect(pktLine("a\n").toString("utf8")).toBe("0006a\n");
    expect(pktLine("").toString("utf8")).toBe("0004");
    expect(pktLine("x".repeat(100)).toString("utf8").slice(0, 4)).toBe("0068");
  });

  it("emits the advertisement header git clients validate", () => {
    expect(serviceAnnouncement().toString("utf8")).toBe("001e# service=git-upload-pack\n0000");
  });
});

describe("sanitizeGitProtocol", () => {
  it("passes through the shapes git actually sends", () => {
    expect(sanitizeGitProtocol("version=2")).toBe("version=2");
    expect(sanitizeGitProtocol("version=0")).toBe("version=0");
    expect(sanitizeGitProtocol("version=2:key=value")).toBe("version=2:key=value");
  });

  it("drops anything else rather than putting it in a child environment", () => {
    for (const bad of [
      "",
      "version",
      "version=two",
      "version=2 ; rm -rf /",
      "VERSION=2",
      "version=2\nGIT_DIR=/etc",
      "x".repeat(200),
      undefined,
      42,
      ["version=2"],
    ]) {
      expect(sanitizeGitProtocol(bad)).toBeUndefined();
    }
  });
});

describe("parseBasicAuth", () => {
  it("decodes a well formed header", () => {
    const header = `Basic ${Buffer.from("amber:secret").toString("base64")}`;
    expect(parseBasicAuth(header)).toEqual({ username: "amber", password: "secret" });
  });

  it("keeps colons in the password, which base58 will never produce but clients may send", () => {
    const header = `Basic ${Buffer.from("amber:a:b:c").toString("base64")}`;
    expect(parseBasicAuth(header)).toEqual({ username: "amber", password: "a:b:c" });
  });

  it("accepts the scheme case insensitively and tolerates padding whitespace", () => {
    const header = `  basic   ${Buffer.from("u:p").toString("base64")}  `;
    expect(parseBasicAuth(header)).toEqual({ username: "u", password: "p" });
  });

  it("returns null for anything it cannot parse", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "Bearer abc",
      "Basic",
      "Basic !!!not base64!!!",
      `Basic ${Buffer.from("nocolon").toString("base64")}`,
    ]) {
      expect(parseBasicAuth(bad)).toBeNull();
    }
  });
});

describe("AuthThrottle", () => {
  it("allows a burst, then refuses, then refills over time", () => {
    let now = 1_000_000;
    const throttle = new AuthThrottle({ capacity: 3, refillMs: 1000, now: () => now });

    expect(throttle.allow("a")).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      throttle.recordFailure("a");
    }
    expect(throttle.allow("a")).toBe(false);
    expect(throttle.retryAfterSeconds("a")).toBe(1);

    now += 1000;
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.retryAfterSeconds("a")).toBe(0);

    now += 60_000;
    for (let i = 0; i < 3; i += 1) {
      throttle.recordFailure("a");
    }
    expect(throttle.allow("a")).toBe(false);
  });

  it("keeps buckets per address", () => {
    const throttle = new AuthThrottle({ capacity: 1, refillMs: 1000 });
    throttle.recordFailure("a");
    expect(throttle.allow("a")).toBe(false);
    expect(throttle.allow("b")).toBe(true);
  });

  it("forgets an address that authenticates successfully", () => {
    const throttle = new AuthThrottle({ capacity: 1, refillMs: 1000 });
    throttle.recordFailure("a");
    expect(throttle.allow("a")).toBe(false);
    throttle.recordSuccess("a");
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.size).toBe(1);
  });

  it("evicts the oldest entry rather than growing without bound", () => {
    const throttle = new AuthThrottle({ capacity: 1, refillMs: 1000, maxEntries: 3 });
    for (const key of ["a", "b", "c", "d", "e"]) {
      throttle.recordFailure(key);
    }
    expect(throttle.size).toBeLessThanOrEqual(3);
    throttle.clear();
    expect(throttle.size).toBe(0);
  });

  it("reports no wait for an address it has never seen", () => {
    expect(new AuthThrottle().retryAfterSeconds("nobody")).toBe(0);
  });
});

describe("git remote kv state", () => {
  it("defaults to disabled with no password", () => {
    expect(readGitRemoteState(db)).toEqual({
      enabled: false,
      username: "amber",
      passwordHash: null,
      rotatedAt: null,
    });
  });

  it("enables with a fresh hash and a rotation timestamp", () => {
    const { state, password } = enableGitRemote(db);
    expect(state.enabled).toBe(true);
    expect(state.passwordHash).toMatch(/^scrypt\$/);
    expect(state.passwordHash).not.toContain(password);
    expect(state.rotatedAt).toBeGreaterThan(0);
  });

  it("rotates while enabled and refuses while disabled", () => {
    const first = enableGitRemote(db);
    const second = rotateGitRemotePassword(db);
    expect(second.password).not.toBe(first.password);
    expect(second.state.enabled).toBe(true);
    expect(second.state.passwordHash).not.toBe(first.state.passwordHash);

    disableGitRemote(db);
    expect(() => rotateGitRemotePassword(db)).toThrow(GitRemoteDisabledError);
    // The invariant holds: a disabled remote stores no credential at all.
    expect(readGitRemoteState(db).passwordHash).toBeNull();
  });

  it("destroys the hash on disable", () => {
    enableGitRemote(db);
    const state = disableGitRemote(db);
    expect(state.enabled).toBe(false);
    expect(state.passwordHash).toBeNull();
  });

  it("treats an enabled flag with no password as disabled", () => {
    const now = Date.now();
    db.run(
      "INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, 'true', ?, ?)",
      KV_ENABLED,
      now,
      now,
    );
    expect(readGitRemoteState(db).enabled).toBe(false);
  });

  it("builds a clone URL template with placeholders, never a real password", () => {
    expect(buildCloneUrlTemplate("https://amber.example.com", "amber")).toBe(
      "https://amber:{password}@amber.example.com/git/{slug}.git",
    );
    expect(buildCloneUrlTemplate("http://localhost:8080", "amber")).toBe(
      "http://amber:{password}@localhost:8080/git/{slug}.git",
    );
    expect(buildCloneUrlTemplate("https://x.test", "user name")).toContain("user%20name");
    // A malformed origin degrades instead of throwing during a settings read.
    expect(buildCloneUrlTemplate("not a url", "amber")).toBe("not a url/git/{slug}.git");
  });

  it("never puts the hash into the API view", () => {
    const { state } = enableGitRemote(db);
    const view = toGitRemoteConfig(state, "https://amber.example.com");
    expect(JSON.stringify(view)).not.toContain(state.passwordHash as string);
    expect(view).not.toHaveProperty("passwordHash");
  });
});

describe("repo lookup for the serving paths", () => {
  it("finds a repo by id and by slug, with or without the .git suffix", () => {
    const id = insertRepoRow(db, { slug: "my-repo-abcd1234", displayName: "my-repo" });
    expect(getRepo(db, id)?.slug).toBe("my-repo-abcd1234");
    expect(getRepoBySlug(db, "my-repo-abcd1234")?.id).toBe(id);
    expect(getRepoBySlug(db, "my-repo-abcd1234.git")?.id).toBe(id);
  });

  it("returns undefined rather than guessing", () => {
    expect(getRepo(db, 12345)).toBeUndefined();
    expect(getRepoBySlug(db, "nope")).toBeUndefined();
    expect(getRepoBySlug(db, "")).toBeUndefined();
    expect(getRepoBySlug(db, ".git")).toBeUndefined();
  });

  it("builds the directory from the stored slug, so a traversing slug cannot escape", () => {
    // Even if a row somehow held a traversing slug, the lookup is by exact
    // match on a column, so a request cannot introduce one.
    expect(getRepoBySlug(db, "../../etc")).toBeUndefined();
    const id = insertRepoRow(db, { slug: "safe-slug-00001111" });
    const repo = getRepo(db, id);
    expect(repo).toBeDefined();
    const backupsDir = resolve(join("/data", "backups"));
    expect(repoDirFor({ backupsDir }, repo!)).toBe(join(backupsDir, "safe-slug-00001111"));
  });

  it("rejects a slug that the generator could never have produced", () => {
    // repoDirFor is the only way any code names a backup directory, so the
    // guard here covers the git remote, the exports, and the file remover.
    expect(() =>
      repoDirFor({ backupsDir: resolve("/data/backups") }, { slug: "../escape" }),
    ).toThrow();
  });

  it("names the same directory that the backup file remover deletes", () => {
    // The serving paths and the delete path must never disagree about which
    // directory belongs to a repo. They agree because both call repoDirFor.
    const backupsDir = resolve(join("/data", "backups"));
    const repo = { slug: "shared-path-22223333" };
    const removerRoot = resolve(backupsDir);
    const dir = repoDirFor({ backupsDir }, repo);
    expect(dir.startsWith(removerRoot + sep)).toBe(true);
    expect(dir).toBe(join(removerRoot, repo.slug));
  });
});

describe("gitSpawn", () => {
  it("scrubs inherited GIT_ variables and pins config discovery off", () => {
    const original = process.env.GIT_DIR;
    process.env.GIT_DIR = "/somewhere/evil";
    try {
      const env = buildGitEnv();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_ALLOW_PROTOCOL).toBe("https:http");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (original === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = original;
      }
    }
  });

  it("lets an explicit override through", () => {
    expect(buildGitEnv({ GIT_PROTOCOL: "version=2" }).GIT_PROTOCOL).toBe("version=2");
  });

  it("captures output and reports a non zero exit without throwing", async () => {
    const ok = await runGitCapture(["--version"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout.toString("utf8")).toContain("git version");

    const bad = await runGitCapture(["cat-file", "-e", "nope"], { cwd: process.cwd() });
    expect(bad.code).not.toBe(0);
  });

  it("kills a process whose output exceeds the buffer cap", async () => {
    await expect(runGitCapture(["--version"], { maxBufferBytes: 1 })).rejects.toBeInstanceOf(
      GitSpawnError,
    );
  });

  it("drains its live process registry", async () => {
    await runGitCapture(["--version"]);
    await expect.poll(() => liveGitProcessCount(), { timeout: 5000 }).toBe(0);
  });
});
