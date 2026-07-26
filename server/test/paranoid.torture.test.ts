import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedSettings } from "@amber/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { ARCHIVE_REF_PREFIX, repoDir, syncRepo } from "../src/sync/syncRepo.ts";
import { BackupInspector, hardlinkedFiles } from "./helpers/backupInspector.ts";
import {
  createOrigin,
  createTestDb,
  fixedSettings,
  insertForge,
  insertRepo,
  repoSlug,
  silentLog,
  tempDir,
  type OriginRepo,
} from "./helpers/gitFixtures.ts";

/**
 * The paranoid mode acceptance gate.
 *
 * A local origin is subjected to every way a forge can destroy history, and
 * after each atrocity the backup must still hold every object and every ref tip
 * it has ever seen. The origin is reached over file:// rather than as a bare
 * path so git uses the real upload-pack transport: with a bare path git
 * hardlinks objects into the backup and the origin could not delete them even
 * if amber did nothing at all.
 */

const TIMEOUT = 60_000;

/**
 * git-lfs is present in CI and in the docker image. When a developer machine
 * lacks it the LFS atrocity is skipped rather than failed, but loudly: a silent
 * skip on a durability gate is worse than no test at all.
 */
const HAS_GIT_LFS = ((): boolean => {
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
    return true;
  } catch {
    createConsoleLogger("warn").warn(
      "git-lfs is not installed: SKIPPING the LFS half of the paranoid torture suite. " +
        "Install git-lfs to run the full acceptance gate locally.",
    );
    return false;
  }
})();

let root: string;
let db: Db;
let origin: OriginRepo;
let backup: BackupInspector;
let repoId: number;
let backupsDir: string;
let stateDir: string;
let dir: string;

/** Commits made in the fixture, by name, so atrocities can target them. */
const commits = new Map<string, string>();

async function sync(settings: Partial<ResolvedSettings> = {}): Promise<void> {
  const run = await syncRepo({
    repoId,
    db,
    backupsDir,
    stateDir,
    logger: silentLog,
    settings: fixedSettings({ paranoid: true, lfs_enabled: false, ...settings }),
    credentials: () => undefined,
    remoteUrl: origin.url,
    allowFileProtocol: true,
  });
  expect(run.error).toBeNull();
  expect(run.outcome).toBe("success");
  await backup.observe();
}

/** A commit built with plumbing, so no checkout or index is disturbed. */
async function commitWithFile(
  name: string,
  content: string,
  message: string,
  parents: string[] = [],
): Promise<string> {
  const blob = (
    await origin.git(["hash-object", "-w", "--stdin"], { stdin: content })
  ).stdout.trim();
  const tree = (
    await origin.git(["mktree"], { stdin: `100644 blob ${blob}\t${name}\n` })
  ).stdout.trim();
  const args = ["commit-tree", tree];
  for (const parent of parents) {
    args.push("-p", parent);
  }
  args.push("-m", message);
  return (await origin.git(args)).stdout.trim();
}

/** A commit with no parents at all: the shape a hostile force push takes. */
async function orphanCommit(message: string, content: string): Promise<string> {
  return commitWithFile("file.txt", content, message);
}

async function assertNothingLost(): Promise<void> {
  expect(await backup.missingObjects()).toEqual([]);
  expect(await backup.unreachableTips()).toEqual([]);
}

beforeAll(async () => {
  root = tempDir("torture");
  backupsDir = join(root, "backups");
  stateDir = join(root, "state");
  db = createTestDb(root);
  const forgeId = insertForge(db, { host: "torture.test" });
  repoId = insertRepo(db, { forgeId, path: "acme/history" });
  dir = repoDir(backupsDir, repoSlug(db, repoId));
  backup = new BackupInspector(dir, { stateDir, allowFileProtocol: true });

  origin = await createOrigin(join(root, "origin"));
  commits.set("one", await origin.commitFile("a.txt", "one\n", "commit one"));
  commits.set("two", await origin.commitFile("b.txt", "two\n", "commit two"));
  commits.set("three", await origin.commitFile("c.txt", "three\n", "commit three"));
  await origin.git(["branch", "feature/keep", "HEAD~1"]);
  await origin.git(["branch", "feature/doomed"]);
  await origin.git(["tag", "-a", "v1.0.0", "-m", "release one", commits.get("one") ?? ""]);
  await origin.git(["tag", "-a", "v2.0.0", "-m", "release two", commits.get("two") ?? ""]);
  await origin.git(["tag", "lightweight-1", commits.get("one") ?? ""]);

  await sync();
}, TIMEOUT);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the backup is a real copy", () => {
  it(
    "fetched over a transport that does not share objects with the origin",
    async () => {
      expect(await hardlinkedFiles(dir)).toEqual([]);
      expect(backup.objects.size).toBeGreaterThan(5);
    },
    TIMEOUT,
  );

  it(
    "applies the paranoid repository config",
    async () => {
      const config = await backup.git(["config", "--local", "--list"]);
      expect(config).toContain("gc.auto=0");
      expect(config).toContain("gc.pruneexpire=never");
      expect(config).toContain("gc.reflogexpireunreachable=never");
      expect(config).toContain("gc.reflogexpire=never");
      expect(config).toContain("core.logallrefupdates=always");
      expect(config).toContain("fetch.prune=false");
    },
    TIMEOUT,
  );
});

describe("atrocity 1: force push of completely unrelated history over main", () => {
  it(
    "keeps every commit of the discarded history and archives the old tip",
    async () => {
      const oldMain = await origin.revParse("main");
      const unrelated = await orphanCommit("unrelated history", "nothing to do with you\n");
      await origin.git(["update-ref", "refs/heads/main", unrelated]);
      expect(await origin.revParse("main")).toBe(unrelated);

      await sync();

      expect((await backup.refs()).get("refs/heads/main")).toBe(unrelated);
      expect(await backup.hasObject(oldMain)).toBe(true);
      const archives = await backup.archiveRefs();
      const archived = [...archives].find(([ref]) => ref.endsWith("/refs/heads/main"));
      expect(archived?.[1]).toBe(oldMain);
      await assertNothingLost();
    },
    TIMEOUT,
  );
});

describe("atrocity 2: branch deletion", () => {
  it(
    "keeps a branch the origin deleted",
    async () => {
      const doomed = (await origin.refs()).get("refs/heads/feature/doomed");
      expect(doomed).toBeDefined();
      await origin.git(["branch", "-D", "feature/doomed"]);
      expect((await origin.refs()).has("refs/heads/feature/doomed")).toBe(false);

      await sync();

      expect((await backup.refs()).get("refs/heads/feature/doomed")).toBe(doomed);
      await assertNothingLost();
    },
    TIMEOUT,
  );
});

describe("atrocity 3: tag deletion", () => {
  it(
    "keeps a tag the origin deleted, including its tag object",
    async () => {
      const tagObject = (await origin.refs()).get("refs/tags/v1.0.0");
      expect(tagObject).toBeDefined();
      await origin.git(["tag", "-d", "v1.0.0"]);
      await origin.git(["tag", "-d", "lightweight-1"]);

      await sync();

      expect((await backup.refs()).get("refs/tags/v1.0.0")).toBe(tagObject);
      expect((await backup.refs()).has("refs/tags/lightweight-1")).toBe(true);
      await assertNothingLost();
    },
    TIMEOUT,
  );
});

describe("atrocity 4: a tag moved to a different commit", () => {
  it(
    "archives the tag object the origin overwrote",
    async () => {
      const before = (await origin.refs()).get("refs/tags/v2.0.0");
      expect(before).toBeDefined();
      await origin.git([
        "tag",
        "-f",
        "-a",
        "v2.0.0",
        "-m",
        "moved somewhere else",
        commits.get("three") ?? "",
      ]);
      const after = (await origin.refs()).get("refs/tags/v2.0.0");
      expect(after).not.toBe(before);

      await sync();

      expect((await backup.refs()).get("refs/tags/v2.0.0")).toBe(after);
      expect(await backup.hasObject(before ?? "")).toBe(true);
      const archived = [...(await backup.archiveRefs())].find(([ref]) =>
        ref.endsWith("/refs/tags/v2.0.0"),
      );
      expect(archived?.[1]).toBe(before);
      await assertNothingLost();
    },
    TIMEOUT,
  );
});

describe("atrocity 5: a commit dropped by a rewrite, then an aggressive gc on the origin", () => {
  it(
    "keeps the dropped commit even after the origin has garbage collected it",
    async () => {
      // A branch nothing else points into, so dropping a commit from it really
      // does make that commit unreachable upstream.
      const dropped = await commitWithFile("dropme.txt", "doomed\n", "to be dropped", [
        commits.get("one") ?? "",
      ]);
      const tip = await commitWithFile("kept.txt", "survivor\n", "keeps going", [dropped]);
      await origin.git(["update-ref", "refs/heads/rewrite-me", tip]);
      await sync();
      expect(await backup.hasObject(dropped)).toBe(true);

      // The interactive rebase equivalent: the same tree, reparented onto the
      // commit before the one that was dropped.
      const tree = (await origin.git(["rev-parse", `${tip}^{tree}`])).stdout.trim();
      const rewritten = (
        await origin.git([
          "commit-tree",
          tree,
          "-p",
          commits.get("one") ?? "",
          "-m",
          "keeps going, rewritten",
        ])
      ).stdout.trim();
      await origin.git(["update-ref", "refs/heads/rewrite-me", rewritten]);

      // Make the origin forget the old commits completely.
      await origin.git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
      await origin.git(["gc", "--prune=now", "--aggressive", "--quiet"]);
      for (const gone of [dropped, tip]) {
        const probe = await origin.git(["cat-file", "-e", gone], { allowFailure: true });
        expect(probe.code).not.toBe(0);
      }

      await sync();

      expect(await backup.hasObject(dropped)).toBe(true);
      expect(await backup.hasObject(tip)).toBe(true);
      const archived = [...(await backup.archiveRefs())].find(([ref]) =>
        ref.endsWith("/refs/heads/rewrite-me"),
      );
      expect(archived?.[1]).toBe(tip);
      await assertNothingLost();
    },
    TIMEOUT,
  );
});

describe("atrocity 6: a branch moved backwards to an ancestor", () => {
  it(
    "archives the tip the origin rewound past",
    async () => {
      await origin.git(["update-ref", "refs/heads/rewind", commits.get("three") ?? ""]);
      await sync();
      const forward = (await backup.refs()).get("refs/heads/rewind");
      expect(forward).toBe(commits.get("three"));

      await origin.git(["update-ref", "refs/heads/rewind", commits.get("one") ?? ""]);
      await sync();

      expect((await backup.refs()).get("refs/heads/rewind")).toBe(commits.get("one"));
      const archived = [...(await backup.archiveRefs())].find(([ref]) =>
        ref.endsWith("/refs/heads/rewind"),
      );
      expect(archived?.[1]).toBe(commits.get("three"));
      await assertNothingLost();
    },
    TIMEOUT,
  );
});

describe("atrocity 7: every branch and tag deleted, replaced by one orphan commit", () => {
  it(
    "still holds everything it ever saw",
    async () => {
      const before = await origin.refs();
      for (const ref of before.keys()) {
        await origin.git(["update-ref", "-d", ref]);
      }
      const scorched = await orphanCommit("scorched earth", "only this survives upstream\n");
      await origin.git(["update-ref", "refs/heads/main", scorched]);
      const after = await origin.refs();
      expect([...after.keys()]).toEqual(["refs/heads/main"]);

      await sync();

      expect((await backup.refs()).get("refs/heads/main")).toBe(scorched);
      for (const [ref, sha] of before) {
        if (ref === "refs/heads/main") {
          continue;
        }
        expect(await backup.hasObject(sha)).toBe(true);
        expect((await backup.refs()).get(ref)).toBe(sha);
      }
      await assertNothingLost();
    },
    TIMEOUT,
  );

  it(
    "has never garbage collected the backup",
    async () => {
      // Everything observed across every atrocity is still readable, which is
      // the whole promise of paranoid mode.
      expect(await backup.missingObjects()).toEqual([]);
      expect(backup.objects.size).toBeGreaterThan(15);
      const archives = await backup.archiveRefs();
      expect(archives.size).toBeGreaterThanOrEqual(4);
      for (const ref of archives.keys()) {
        expect(ref).toMatch(new RegExp(`^${ARCHIVE_REF_PREFIX}/\\d{8}T\\d{6}Z/refs/(heads|tags)/`));
      }
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// LFS: the same guarantee for objects that never live in the git odb.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_GIT_LFS)("atrocity 8: an LFS object deleted upstream", () => {
  let lfsRoot: string;
  let lfsDb: Db;
  let lfsOrigin: OriginRepo;
  let lfsRepoId: number;
  let lfsDir: string;

  const OLD_BYTES = Buffer.alloc(4096, 7);
  const NEW_BYTES = Buffer.alloc(4096, 9);

  const lfsSync = async (): Promise<void> => {
    const run = await syncRepo({
      repoId: lfsRepoId,
      db: lfsDb,
      backupsDir: join(lfsRoot, "backups"),
      stateDir: join(lfsRoot, "state"),
      logger: silentLog,
      settings: fixedSettings({ paranoid: true, lfs_enabled: true }),
      credentials: () => undefined,
      remoteUrl: lfsOrigin.url,
      allowFileProtocol: true,
    });
    expect(run.outcome).toBe("success");
  };

  /** The oid a pointer blob refers to, read out of a commit in the origin. */
  const pointerOid = async (rev: string): Promise<string> => {
    const pointer = (await lfsOrigin.git(["show", `${rev}:big.bin`])).stdout;
    const match = /oid sha256:([0-9a-f]{64})/.exec(pointer);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  };

  const lfsObjectPath = (base: string, oid: string): string =>
    join(base, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);

  beforeAll(async () => {
    lfsRoot = tempDir("lfs");
    lfsDb = createTestDb(lfsRoot);
    const forgeId = insertForge(lfsDb, { host: "lfs.test" });
    lfsRepoId = insertRepo(lfsDb, { forgeId, path: "acme/binaries" });
    lfsDir = repoDir(join(lfsRoot, "backups"), repoSlug(lfsDb, lfsRepoId));

    lfsOrigin = await createOrigin(join(lfsRoot, "origin"));
    await lfsOrigin.git(["lfs", "install", "--local"]);
    await lfsOrigin.git(["lfs", "track", "*.bin"]);
    writeFileSync(join(lfsOrigin.dir, "big.bin"), OLD_BYTES);
    await lfsOrigin.commit("add a large binary");
    await lfsSync();
  }, TIMEOUT);

  afterAll(() => {
    lfsDb.close();
    rmSync(lfsRoot, { recursive: true, force: true });
  });

  it(
    "keeps the bytes of an LFS object the origin rewrote away",
    async () => {
      const oldOid = await pointerOid("refs/heads/main");
      const backedUp = lfsObjectPath(lfsDir, oldOid);
      expect(existsSync(backedUp)).toBe(true);
      expect(readFileSync(backedUp).equals(OLD_BYTES)).toBe(true);

      // Replace the file and rewrite history so the old commit, its pointer and
      // its object are all unreferenced upstream.
      writeFileSync(join(lfsOrigin.dir, "big.bin"), NEW_BYTES);
      await lfsOrigin.commit("replace the large binary");
      const newOid = await pointerOid("refs/heads/main");
      expect(newOid).not.toBe(oldOid);

      const tree = (await lfsOrigin.git(["rev-parse", "refs/heads/main^{tree}"])).stdout.trim();
      const rewritten = (
        await lfsOrigin.git(["commit-tree", tree, "-m", "rewritten history"])
      ).stdout.trim();
      await lfsOrigin.git(["update-ref", "refs/heads/main", rewritten]);
      rmSync(lfsObjectPath(join(lfsOrigin.dir, ".git"), oldOid), { force: true });
      await lfsOrigin.git(["reflog", "expire", "--expire=now", "--all"]);
      await lfsOrigin.git(["gc", "--prune=now", "--quiet"]);
      expect(existsSync(lfsObjectPath(join(lfsOrigin.dir, ".git"), oldOid))).toBe(false);

      // The origin can no longer serve the old object, and git-lfs says so.
      // That must not fail the sync: the git history is still being captured.
      await lfsSync();

      expect(existsSync(backedUp)).toBe(true);
      expect(readFileSync(backedUp).equals(OLD_BYTES)).toBe(true);
      expect(existsSync(lfsObjectPath(lfsDir, newOid))).toBe(true);
      expect(readFileSync(lfsObjectPath(lfsDir, newOid)).equals(NEW_BYTES)).toBe(true);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// The other half of the contract: without paranoid mode, deletions land.
// ---------------------------------------------------------------------------

describe("non paranoid mode reflects upstream deletions", () => {
  let plainRoot: string;
  let plainDb: Db;
  let plainOrigin: OriginRepo;
  let plainRepoId: number;
  let plainDir: string;
  let plainBackup: BackupInspector;

  const plainSync = async (): Promise<void> => {
    const run = await syncRepo({
      repoId: plainRepoId,
      db: plainDb,
      backupsDir: join(plainRoot, "backups"),
      stateDir: join(plainRoot, "state"),
      logger: silentLog,
      settings: fixedSettings({ paranoid: false, lfs_enabled: false }),
      credentials: () => undefined,
      remoteUrl: plainOrigin.url,
      allowFileProtocol: true,
    });
    expect(run.outcome).toBe("success");
  };

  beforeAll(async () => {
    plainRoot = tempDir("plain");
    plainDb = createTestDb(plainRoot);
    const forgeId = insertForge(plainDb, { host: "plain.test" });
    plainRepoId = insertRepo(plainDb, { forgeId, path: "acme/plain" });
    plainDir = repoDir(join(plainRoot, "backups"), repoSlug(plainDb, plainRepoId));
    plainBackup = new BackupInspector(plainDir, {
      stateDir: join(plainRoot, "state"),
      allowFileProtocol: true,
    });
    plainOrigin = await createOrigin(join(plainRoot, "origin"));
    await plainOrigin.commitFile("a.txt", "one\n", "commit one");
    await plainOrigin.git(["branch", "doomed"]);
    await plainOrigin.git(["tag", "-a", "v1", "-m", "one"]);
    await plainSync();
  }, TIMEOUT);

  afterAll(() => {
    plainDb.close();
    rmSync(plainRoot, { recursive: true, force: true });
  });

  it(
    "prunes deleted branches and tags instead of archiving them",
    async () => {
      expect((await plainBackup.refs()).has("refs/heads/doomed")).toBe(true);

      await plainOrigin.git(["branch", "-D", "doomed"]);
      await plainOrigin.git(["tag", "-d", "v1"]);
      await plainSync();

      const refs = await plainBackup.refs();
      expect(refs.has("refs/heads/doomed")).toBe(false);
      expect(refs.has("refs/tags/v1")).toBe(false);
      expect([...refs.keys()].some((ref) => ref.startsWith(ARCHIVE_REF_PREFIX))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "lets a force push replace history with no archive ref",
    async () => {
      const oldTip = await plainOrigin.revParse("main");
      const blob = (
        await plainOrigin.git(["hash-object", "-w", "--stdin"], { stdin: "replacement\n" })
      ).stdout.trim();
      const tree = (
        await plainOrigin.git(["mktree"], { stdin: `100644 blob ${blob}\tfile.txt\n` })
      ).stdout.trim();
      const replacement = (
        await plainOrigin.git(["commit-tree", tree, "-m", "replacement"])
      ).stdout.trim();
      await plainOrigin.git(["update-ref", "refs/heads/main", replacement]);

      await plainSync();

      const refs = await plainBackup.refs();
      expect(refs.get("refs/heads/main")).toBe(replacement);
      expect([...refs.keys()].some((ref) => ref.startsWith(ARCHIVE_REF_PREFIX))).toBe(false);
      // The old tip is still on disk (nothing gc'd it) but nothing points at it,
      // which is exactly the difference paranoid mode buys.
      const reachable = await plainBackup.reachable();
      expect(reachable.has(oldTip)).toBe(false);
    },
    TIMEOUT,
  );
});
