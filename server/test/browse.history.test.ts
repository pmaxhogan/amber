import { execFileSync } from "node:child_process";
import { chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanGitEnv, gitOk, type TestServer } from "./helpers/gitFixture.ts";
import {
  browseUrl,
  createWork,
  get,
  publish,
  register,
  startServer,
  stopServer,
  type Published,
  type Work,
} from "./helpers/browseFixture.ts";

/** commits and commit against real repositories. */

let server: TestServer;
const scratch: string[] = [];

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await stopServer(server, ...scratch);
});

function track(work: Work): Work {
  scratch.push(dirname(work.dir));
  return work;
}

interface Summary {
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerEmail: string;
  committerDate: number;
  subject: string;
}

interface Commits {
  rows: Summary[];
  next: number | null;
}

interface DiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch: string | null;
  truncated: boolean;
}

interface Detail extends Summary {
  body: string;
  files: DiffFile[];
  filesChanged: number;
  additions: number;
  deletions: number;
  filesTruncated: boolean;
  missingParents: boolean;
}

function commits(
  repo: Published,
  rev: string,
  query: Record<string, string> = {},
): ReturnType<typeof get> {
  return get(server, browseUrl(repo.repoId, "commits", { rev, ...query }));
}

async function detail(repo: Published, rev: string): Promise<Detail> {
  const reply = await get(server, browseUrl(repo.repoId, "commit", { rev }));
  expect(reply.status).toBe(200);
  return reply.json as Detail;
}

function file(body: Detail, path: string): DiffFile {
  const found = body.files.find((candidate) => candidate.path === path);
  expect(found, `${path} in ${body.files.map((f) => f.path).join(", ")}`).toBeDefined();
  return found as DiffFile;
}

interface RawCommit {
  author?: string;
  committer?: string;
  authorName?: string;
  authorEmail?: string;
  committerName?: string;
  committerEmail?: string;
  message?: string;
}

/** A commit written straight to the object store, which porcelain would refuse or rewrite. */
async function rawCommit(work: Work, fields: RawCommit): Promise<string> {
  const tree = (await work.git(["rev-parse", "HEAD^{tree}"])).trim();
  const parent = await work.head();
  const body =
    `tree ${tree}\nparent ${parent}\n` +
    `author ${fields.authorName ?? "A"} <${fields.authorEmail ?? "a@b.invalid"}> ${fields.author ?? "1700000000"} +0000\n` +
    `committer ${fields.committerName ?? "C"} <${fields.committerEmail ?? "c@b.invalid"}> ${fields.committer ?? "1700000000"} +0000\n\n` +
    (fields.message ?? "odd\n");
  const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
    cwd: work.dir,
    input: body,
    env: cleanGitEnv(),
  })
    .toString("utf8")
    .trim();
  await work.git(["update-ref", "refs/heads/odd", oid]);
  return oid;
}

describe("history of a small repository", () => {
  let work: Work;
  let repo: Published;
  let root: string;
  let second: string;
  let third: string;
  let fourth: string;
  let topicTip: string;
  let merge: string;
  let all: string[];

  beforeAll(async () => {
    work = track(await createWork());
    work.write("a.txt", "alpha\nbeta\ngamma\n");
    work.write("old.txt", "going away\n");
    work.write("keep.txt", "the same words in a file that will be renamed, long enough to match\n");
    work.write("bin.dat", Buffer.from([0, 1, 2, 3]));
    work.write("sp ace.txt", "one\n");
    root = await work.commit("root commit");

    work.write("a.txt", "alpha\nBETA\ngamma\ndelta\n");
    work.write("b.txt", "new file\n");
    second = await work.commit("second: modify and add\n\nA body line.\n\nSecond paragraph.");

    unlinkSync(join(work.dir, "old.txt"));
    await work.git(["mv", "keep.txt", "kept.txt"]);
    third = await work.commit("third: delete and rename");

    work.write("bin.dat", Buffer.from([0, 1, 2, 3, 4, 5]));
    fourth = await work.commit("fourth: binary change");

    await work.git(["checkout", "-q", "-b", "topic", second]);
    work.write("topic.txt", "from topic\n");
    topicTip = await work.commit("topic work");
    await work.git(["checkout", "-q", "main"]);
    work.write("main-only.txt", "main\n");
    await work.commit("main work");
    await work.git(["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    merge = await work.head();

    all = (await work.git(["rev-list", "main"])).trim().split("\n");
    repo = await publish(server, work);
  });

  it("lists commits newest first with their fields", async () => {
    const reply = await commits(repo, merge);
    expect(reply.status).toBe(200);
    const body = reply.json as Commits;
    expect(body.next).toBeNull();
    expect(body.rows.map((row) => row.oid)).toEqual(all);
    const mergeRow = body.rows[0] as Summary;
    expect(mergeRow.parents).toHaveLength(2);
    expect(mergeRow.subject).toBe("merge topic");
    const rootRow = body.rows.at(-1) as Summary;
    expect(rootRow).toMatchObject({
      oid: root,
      parents: [],
      authorName: "Amber Test",
      authorEmail: "test@example.invalid",
      committerName: "Amber Test",
      committerEmail: "test@example.invalid",
      subject: "root commit",
    });
    const seconds = Number((await work.git(["show", "-s", "--format=%at", root])).trim());
    expect(rootRow.authorDate).toBe(seconds * 1000);
    expect(rootRow.committerDate).toBe(rootRow.authorDate);
  });

  async function walk(start: string, limit: number, query: Record<string, string> = {}) {
    const seen: string[] = [];
    const sizes: number[] = [];
    let skip = 0;
    for (;;) {
      const reply = await commits(repo, start, {
        limit: String(limit),
        skip: String(skip),
        ...query,
      });
      expect(reply.status).toBe(200);
      const page = reply.json as Commits;
      expect(page.rows.length).toBeLessThanOrEqual(limit);
      seen.push(...page.rows.map((row) => row.oid));
      sizes.push(page.rows.length);
      expect(sizes.length).toBeLessThan(30);
      if (page.next === null) {
        return { seen, sizes };
      }
      expect(page.next).toBe(skip + limit);
      skip = page.next;
    }
  }

  it("pages a linear history in exact pages and ends with a null next", async () => {
    const linear = (await work.git(["rev-list", fourth])).trim().split("\n");
    const { seen, sizes } = await walk(fourth, 2);
    expect(seen).toEqual(linear);
    expect(sizes).toEqual([2, 2]);
  });

  it("returns exactly the history of a merge, in order, with no repeats, at any page size", async () => {
    for (const limit of [1, 2, 3, 7, 8]) {
      const { seen, sizes } = await walk(merge, limit);
      expect(seen, `limit ${String(limit)}`).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      expect(sizes.slice(0, -1).every((size) => size === limit)).toBe(true);
    }
  });

  it("ends with a null next on a page that exactly fills the history", async () => {
    const page = (await commits(repo, merge, { limit: String(all.length) })).json as Commits;
    expect(page.rows).toHaveLength(all.length);
    expect(page.next).toBeNull();
  });

  it("pages a path-filtered history the same way", async () => {
    for (const path of ["a.txt", "topic.txt", "bin.dat"]) {
      const expected = (await work.git(["rev-list", merge, "--", path])).trim().split("\n");
      for (const limit of [1, 2]) {
        const { seen } = await walk(merge, limit, { path });
        expect(seen, `${path} limit ${String(limit)}`).toEqual(expected);
      }
    }
  });

  it("answers a skip past the end with no rows and no next", async () => {
    const past = (await commits(repo, merge, { skip: String(all.length) })).json as Commits;
    expect(past).toEqual({ rows: [], next: null });
    const far = (await commits(repo, merge, { skip: "1000000" })).json as Commits;
    expect(far).toEqual({ rows: [], next: null });
  });

  it("rejects a skip out of range", async () => {
    for (const skip of ["-1", "1000001", "abc", "1.5"]) {
      expect((await commits(repo, merge, { skip })).status, skip).toBe(400);
    }
  });

  it("filters by path, for a file and for a directory", async () => {
    const forFile = (await commits(repo, merge, { path: "a.txt" })).json as Commits;
    expect(forFile.rows.map((row) => row.oid)).toEqual([second, root]);
    const forMissing = (await commits(repo, merge, { path: "never/was/here" })).json as Commits;
    expect(forMissing.rows).toEqual([]);
    expect(forMissing.next).toBeNull();
    const withSpace = (await commits(repo, merge, { path: "sp ace.txt" })).json as Commits;
    expect(withSpace.rows.map((row) => row.oid)).toEqual([root]);
    const trailing = (await commits(repo, merge, { path: "a.txt/" })).json as Commits;
    expect(trailing.rows).toHaveLength(2);
  });

  it("treats a glob in the path as a plain name", async () => {
    const reply = (await commits(repo, merge, { path: "*.txt" })).json as Commits;
    expect(reply.rows).toEqual([]);
  });

  it("enforces the limit bounds", async () => {
    expect((await commits(repo, merge, { limit: "0" })).status).toBe(400);
    expect((await commits(repo, merge, { limit: "101" })).status).toBe(400);
    expect((await commits(repo, merge, { limit: "abc" })).status).toBe(400);
    expect(((await commits(repo, merge, { limit: "100" })).json as Commits).rows).toHaveLength(
      all.length,
    );
    expect(((await commits(repo, fourth, { limit: "1" })).json as Commits).rows).toHaveLength(1);
  });

  it("refuses a bad rev, a malformed path and an unknown commit", async () => {
    expect((await commits(repo, "main")).status).toBe(400);
    expect((await commits(repo, merge, { path: "../x" })).status).toBe(400);
    expect((await commits(repo, "0".repeat(40))).status).toBe(404);
  });

  it("shows an added and a modified file with counts and patches", async () => {
    const body = await detail(repo, second);
    expect(body.subject).toBe("second: modify and add");
    expect(body.body).toBe("A body line.\n\nSecond paragraph.");
    expect(body.parents).toEqual([root]);
    expect(body.missingParents).toBe(false);
    expect(body.filesChanged).toBe(2);
    expect(body.filesTruncated).toBe(false);

    const added = file(body, "b.txt");
    expect(added).toMatchObject({
      status: "added",
      oldPath: null,
      additions: 1,
      deletions: 0,
      binary: false,
      truncated: false,
    });
    expect(added.patch).toBe("@@ -0,0 +1 @@\n+new file\n");

    const modified = file(body, "a.txt");
    expect(modified).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(modified.patch?.startsWith("@@ ")).toBe(true);
    expect(modified.patch).toContain("-beta\n+BETA\n");
    expect(modified.patch).not.toContain("diff --git");
    expect(body.additions).toBe(3);
    expect(body.deletions).toBe(1);
  });

  it("shows a delete and a rename from the plumbing, not from patch text", async () => {
    const body = await detail(repo, third);
    expect(body.filesChanged).toBe(2);
    expect(file(body, "old.txt")).toMatchObject({
      status: "deleted",
      additions: 0,
      deletions: 1,
      oldPath: null,
    });
    const renamed = file(body, "kept.txt");
    expect(renamed).toMatchObject({
      status: "renamed",
      oldPath: "keep.txt",
      additions: 0,
      deletions: 0,
      binary: false,
      patch: null,
      truncated: false,
    });
  });

  it("marks a binary change binary with no patch and no counts", async () => {
    const body = await detail(repo, fourth);
    expect(file(body, "bin.dat")).toMatchObject({
      status: "modified",
      binary: true,
      additions: null,
      deletions: null,
      patch: null,
      truncated: false,
    });
    expect(body.additions).toBe(0);
  });

  it("shows a root commit as everything added", async () => {
    const body = await detail(repo, root);
    expect(body.parents).toEqual([]);
    expect(body.missingParents).toBe(false);
    expect(body.files.map((f) => f.path).sort()).toEqual([
      "a.txt",
      "bin.dat",
      "keep.txt",
      "old.txt",
      "sp ace.txt",
    ]);
    expect(body.files.every((f) => f.status === "added")).toBe(true);
    expect(file(body, "sp ace.txt").patch).toBe("@@ -0,0 +1 @@\n+one\n");
  });

  it("diffs a merge against its first parent", async () => {
    const body = await detail(repo, merge);
    expect(body.parents).toHaveLength(2);
    // The first parent is main's own work, so the merge brought in topic.txt only.
    expect(body.files.map((f) => f.path)).toEqual(["topic.txt"]);
    expect(file(body, "topic.txt").status).toBe("added");
    expect(topicTip).toHaveLength(40);
  });

  it("answers 404 for an unknown commit and 400 for a bad rev", async () => {
    const unknown = await get(server, browseUrl(repo.repoId, "commit", { rev: "0".repeat(40) }));
    expect(unknown.status).toBe(404);
    const bad = await get(server, browseUrl(repo.repoId, "commit", { rev: "main" }));
    expect(bad.status).toBe(400);
  });
});

describe("tricky diffs", () => {
  it("keeps patches aligned with files when content looks like a diff header", async () => {
    const work = track(await createWork());
    work.write("base.txt", "base\n");
    await work.commit("base");
    work.write("evil.txt", "diff --git a/zzz b/zzz\n@@ -1 +1 @@\n--- a/zzz\n+++ b/zzz\n");
    work.write("zzz.txt", "z\n");
    const sha = await work.commit("evil");
    const repo = await publish(server, work);
    const body = await detail(repo, sha);
    expect(body.files.map((f) => f.path)).toEqual(["evil.txt", "zzz.txt"]);
    expect(file(body, "evil.txt").patch).toContain("+diff --git a/zzz b/zzz\n");
    expect(file(body, "zzz.txt").patch).toBe("@@ -0,0 +1 @@\n+z\n");
  });

  it("handles a mode change, a type change and odd names", async () => {
    const work = track(await createWork());
    work.write("script.sh", "#!/bin/sh\n");
    work.write("swap.txt", "was a file\n");
    work.write('q"uote and space.txt', "one\n");
    work.write("\u00fcn\u00ef.txt", "one\n");
    await work.commit("base");
    chmodSync(join(work.dir, "script.sh"), 0o755);
    unlinkSync(join(work.dir, "swap.txt"));
    symlinkSync("script.sh", join(work.dir, "swap.txt"));
    work.write('q"uote and space.txt', "two\n");
    work.write("\u00fcn\u00ef.txt", "two\n");
    const sha = await work.commit("changes");
    const repo = await publish(server, work);
    const body = await detail(repo, sha);

    expect(file(body, "script.sh")).toMatchObject({
      status: "modified",
      additions: 0,
      deletions: 0,
      patch: null,
      binary: false,
    });
    const swapped = file(body, "swap.txt");
    expect(swapped.status).toBe("type_changed");
    expect(swapped.patch).toContain("-was a file");
    expect(swapped.patch).toContain("+script.sh");
    expect(file(body, 'q"uote and space.txt').patch).toBe("@@ -1 +1 @@\n-one\n+two\n");
    expect(file(body, "\u00fcn\u00ef.txt").patch).toBe("@@ -1 +1 @@\n-one\n+two\n");
    expect(body.filesChanged).toBe(4);
  });

  it("decodes invalid UTF-8 in a patch with replacement characters", async () => {
    const work = track(await createWork());
    work.write("latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await work.commit("base");
    work.write("latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]));
    const sha = await work.commit("change");
    const repo = await publish(server, work);
    const patch = file(await detail(repo, sha), "latin.txt").patch;
    expect(patch).toContain("-caf\ufffd\n");
    expect(patch).toContain("+caf\ufffd\n");
  });

  it("ignores a .gitattributes in the repository when judging a file binary", async () => {
    const work = track(await createWork());
    work.write(".gitattributes", "*.txt -diff\n");
    work.write("plain.txt", "one\n");
    await work.commit("base");
    work.write("plain.txt", "two\n");
    const sha = await work.commit("change");

    // A working tree backup (full clone mode) reads its own .gitattributes.
    const slug = "browse-worktree-00000b01";
    await gitOk(["clone", "-q", work.dir, `${server.backupsDir}/${slug}`]);
    const repo = register(server, slug);
    const body = await detail(repo, sha);
    if (gitHasAttrSource()) {
      expect(file(body, "plain.txt")).toMatchObject({
        binary: false,
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-one\n+two\n",
      });
    } else {
      // Before git 2.41 nothing can point attributes away from the working
      // tree, so the file reads as binary. That hides a diff; it runs nothing.
      expect(file(body, "plain.txt")).toMatchObject({ binary: true, patch: null });
    }
    // And the browser can walk a working tree backup at all.
    const tree = await get(server, browseUrl(repo.repoId, "contents", { rev: sha, path: "" }));
    expect(tree.status).toBe(200);
  });
});

/** GIT_ATTR_SOURCE arrived in git 2.41; an older git ignores it without a word. */
function gitHasAttrSource(): boolean {
  const match = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 41);
}

describe("caps", () => {
  const LINE = "0123456789 the quick brown fox jumps over the lazy dog\n";

  it("cuts one file's patch at a line and keeps the true counts", async () => {
    const work = track(await createWork());
    work.write("base.txt", "x\n");
    await work.commit("base");
    const lines = 8000;
    work.write("big.txt", LINE.repeat(lines));
    const sha = await work.commit("big");
    const repo = await publish(server, work);
    const body = await detail(repo, sha);
    const big = file(body, "big.txt");
    expect(big.truncated).toBe(true);
    expect(big.additions).toBe(lines);
    expect(big.patch).not.toBeNull();
    const patch = big.patch as string;
    expect(Buffer.byteLength(patch)).toBeLessThanOrEqual(256 * 1024);
    expect(patch.endsWith("\n")).toBe(true);
    expect(patch.startsWith(`@@ -0,0 +1,${String(lines)} @@\n`)).toBe(true);
    expect(body.additions).toBe(lines);
  });

  it("drops the patches of later files once the commit budget is spent", async () => {
    const work = track(await createWork());
    work.write("base.txt", "x\n");
    await work.commit("base");
    const count = 12;
    for (let index = 0; index < count; index += 1) {
      work.write(`f${String(index).padStart(2, "0")}.txt`, LINE.repeat(4300));
    }
    const sha = await work.commit("many big files");
    const repo = await publish(server, work);
    const body = await detail(repo, sha);

    expect(body.filesChanged).toBe(count);
    expect(body.files).toHaveLength(count);
    expect(body.additions).toBe(count * 4300);
    const withPatch = body.files.filter((f) => f.patch !== null);
    const dropped = body.files.filter((f) => f.patch === null);
    expect(withPatch.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((f) => f.truncated)).toBe(true);
    // Files that lost their patch are the later ones.
    expect(body.files.slice(0, withPatch.length).every((f) => f.patch !== null)).toBe(true);
    const total = withPatch.reduce((sum, f) => sum + Buffer.byteLength(f.patch as string), 0);
    expect(total).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(withPatch[0]?.truncated).toBe(false);
  });

  it("lists at most 1000 files and counts the rest", async () => {
    const work = track(await createWork());
    work.write("base.txt", "x\n");
    await work.commit("base");
    for (let index = 0; index < 1100; index += 1) {
      work.write(`many/f${String(index).padStart(4, "0")}.txt`, `${String(index)}\n`);
    }
    const sha = await work.commit("many files");
    const repo = await publish(server, work);
    const body = await detail(repo, sha);
    expect(body.filesChanged).toBe(1100);
    expect(body.files).toHaveLength(1000);
    expect(body.filesTruncated).toBe(true);
    expect(body.additions).toBe(1100);
    expect(file(body, "many/f0999.txt").patch).toBe("@@ -0,0 +1 @@\n+999\n");
  }, 60_000);
});

describe("shallow clones", () => {
  it("reports missing parents instead of showing the whole tree as added", async () => {
    const work = track(await createWork());
    work.write("a.txt", "one\n");
    await work.commit("first");
    work.write("a.txt", "two\n");
    work.write("b.txt", "b\n");
    const tip = await work.commit("second");

    const slug = "browse-shallow-00000b02";
    await gitOk([
      "clone",
      "-q",
      "--bare",
      "--depth",
      "1",
      `file://${work.dir}`,
      `${server.backupsDir}/${slug}`,
    ]);
    const repo = register(server, slug);
    const body = await detail(repo, tip);
    expect(body.missingParents).toBe(true);
    expect(body.files).toEqual([]);
    expect(body.filesChanged).toBe(0);
    expect(body.filesTruncated).toBe(false);
    expect(body.subject).toBe("second");

    const list = (await commits(repo, tip)).json as Commits;
    expect(list.rows.map((row) => row.oid)).toEqual([tip]);
  });
});

describe("big files", () => {
  it("does not diff a file over the text threshold, and reports it binary", async () => {
    const work = track(await createWork());
    const line = "0123456789 the quick brown fox jumps over the lazy dog\n";
    const big = (tail: string): string => line.repeat(20_000) + tail;
    const under = (tail: string): string => line.repeat(15_000) + tail;
    expect(Buffer.byteLength(big("a\n"))).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(under("a\n"))).toBeLessThan(1024 * 1024);
    work.write("big.txt", big("before\n"));
    work.write("under.txt", under("before\n"));
    work.write("small.txt", "before\n");
    await work.commit("base");
    work.write("big.txt", big("after\n"));
    work.write("under.txt", under("after\n"));
    work.write("small.txt", "after\n");
    const sha = await work.commit("change");
    const repo = await publish(server, work);
    const body = await detail(repo, sha);

    expect(file(body, "big.txt")).toMatchObject({
      binary: true,
      patch: null,
      additions: null,
      deletions: null,
      truncated: false,
    });
    expect(file(body, "under.txt")).toMatchObject({ binary: false, additions: 1, deletions: 1 });
    expect(file(body, "under.txt").patch).toContain("-before\n+after\n");
    expect(file(body, "small.txt").patch).toBe("@@ -1 +1 @@\n-before\n+after\n");
  });
});

describe("commit dates", () => {
  it("clamps a time past what a Date can hold and keeps every date a safe integer", async () => {
    const work = track(await createWork());
    work.write("a.txt", "one\n");
    await work.commit("base");
    const oid = await rawCommit(work, {
      author: "9999999999999",
      committer: "99999999999999999999",
    });
    const repo = await publish(server, work);

    const list = (await commits(repo, oid)).json as Commits;
    const row = list.rows[0] as Summary;
    expect(row.oid).toBe(oid);
    const limit = 8.64e15;
    for (const value of [row.authorDate, row.committerDate]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(limit);
    }
    expect(row.authorDate).toBe(limit);

    const body = await detail(repo, oid);
    expect(Number.isSafeInteger(body.authorDate)).toBe(true);
    expect(Number.isSafeInteger(body.committerDate)).toBe(true);
    expect(Math.abs(body.committerDate)).toBeLessThanOrEqual(limit);
  });
});

describe("separators in commit text", () => {
  const CONTROLS = Array.from({ length: 31 }, (_, index) => index + 1)
    .filter((code) => code !== 10)
    .map((code) => String.fromCharCode(code))
    .join("");

  it("keeps every field in place when text holds control bytes, including the old separator", async () => {
    const work = track(await createWork());
    work.write("a.txt", "one\n");
    await work.commit("base");
    const subject = `s${CONTROLS}e`;
    const oid = await rawCommit(work, {
      authorName: "Al\u001fice\u001f",
      authorEmail: "a\u001f@b.invalid",
      committerName: "Bo\u001fb",
      committerEmail: "c@b.invalid",
      message: `${subject}\n\nbody\u001fwith\u001fseparators\n`,
    });
    const repo = await publish(server, work);

    const list = (await commits(repo, oid, { limit: "2" })).json as Commits;
    expect(list.rows).toHaveLength(2);
    const row = list.rows[0] as Summary;
    expect(row).toMatchObject({
      oid,
      authorName: "Al\u001fice\u001f",
      authorEmail: "a\u001f@b.invalid",
      committerName: "Bo\u001fb",
      committerEmail: "c@b.invalid",
      subject,
    });
    expect(row.authorDate).toBe(1_700_000_000_000);
    expect(list.rows[1]?.subject).toBe("base");

    const body = await detail(repo, oid);
    expect(body).toMatchObject({
      oid,
      authorName: "Al\u001fice\u001f",
      committerName: "Bo\u001fb",
      subject,
      body: "body\u001fwith\u001fseparators",
    });
  });
});
