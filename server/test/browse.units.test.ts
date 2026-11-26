import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchInlineImage, isUtf8, looksBinary, sniffRasterType } from "../src/browse/blobKind.ts";
import {
  compareCodePoints,
  isBrowsePath,
  normalizeBrowsePath,
  parseListing,
} from "../src/browse/contents.ts";
import {
  BROWSE_MAX_GIT_PROCESSES,
  BrowseError,
  browseGitQueueLength,
  runGit,
  type GitCtx,
} from "../src/browse/gitRun.ts";
import {
  DEFAULT_COMMIT_LIMITS,
  parseNumstat,
  parseRawChanges,
  readCommit,
  splitPatch,
} from "../src/browse/history.ts";
import { liveGitProcessCount } from "../src/gitSpawn.ts";
import { createWork, type Work } from "./helpers/browseFixture.ts";

/** The pure parts of the browser, and the process limits that need a stuck git. */

let work: Work;
let ctx: GitCtx;

beforeAll(async () => {
  work = await createWork();
  work.write("a.txt", "one\n");
  await work.commit("one");
  ctx = { dir: work.dir };
});

afterAll(() => {
  rmSync(dirname(work.dir), { recursive: true, force: true });
});

describe("process limits", () => {
  it("answers a git that does not finish with a 504 timeout and leaves no process behind", async () => {
    const fifo = join(dirname(work.dir), "stuck.fifo");
    execFileSync("mkfifo", [fifo]);
    // Opening a FIFO with no writer blocks forever, which is a git that hangs.
    const started = Date.now();
    const error = await runGit({ ...ctx, timeoutMs: 400 }, ["hash-object", fifo], {
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowseError);
    expect(error).toMatchObject({ statusCode: 504, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(liveGitProcessCount()).toBe(0);
  });

  it("kills git when the client goes away", async () => {
    const fifo = join(dirname(work.dir), "stuck2.fifo");
    execFileSync("mkfifo", [fifo]);
    const controller = new AbortController();
    const pending = runGit({ ...ctx, signal: controller.signal }, ["hash-object", fifo], {
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(liveGitProcessCount()).toBe(1);
    controller.abort();
    expect(await pending).toMatchObject({ statusCode: 499, code: "aborted" });
    expect(liveGitProcessCount()).toBe(0);
  });

  it("does not start git for a request that is already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGit({ ...ctx, signal: controller.signal }, ["rev-parse", "HEAD"], { maxBytes: 1024 }),
    ).rejects.toMatchObject({ statusCode: 499 });
    expect(liveGitProcessCount()).toBe(0);
  });

  it("cuts output at the byte cap, flags it, and stops git", async () => {
    const result = await runGit(ctx, ["log", "--format=%H%n%B"], { maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(10);
    expect(result.code).toBeNull();
    const whole = await runGit(ctx, ["log", "--format=%H"], { maxBytes: 1024 });
    expect(whole.truncated).toBe(false);
    expect(whole.code).toBe(0);
  });

  it("applies the per-file and per-commit patch caps it is given", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${String(index)}\n`).join("");
    for (let index = 0; index < 5; index += 1) {
      work.write(`cap${String(index)}.txt`, lines);
    }
    const sha = await work.commit("caps");
    const limits = { maxFiles: 3, maxFilePatchBytes: 1000, maxCommitPatchBytes: 1800 };
    const body = await readCommit(ctx, sha, limits);

    expect(body.filesChanged).toBe(5);
    expect(body.files).toHaveLength(3);
    expect(body.filesTruncated).toBe(true);
    const [first, second, third] = body.files;
    expect(first?.truncated).toBe(true);
    expect(Buffer.byteLength(first?.patch ?? "")).toBeLessThanOrEqual(1000);
    expect(first?.patch?.endsWith("\n")).toBe(true);
    // 1800 minus what the first file took leaves part of the second.
    expect(second?.truncated).toBe(true);
    expect(second?.patch).not.toBeNull();
    expect(
      Buffer.byteLength(first?.patch ?? "") + Buffer.byteLength(second?.patch ?? ""),
    ).toBeLessThanOrEqual(1800);
    expect(third).toMatchObject({ patch: null, truncated: true, additions: 400 });
    expect(DEFAULT_COMMIT_LIMITS.maxFiles).toBe(1000);
  });
});

describe("paths", () => {
  it("accepts shapes that can name a tree entry, including dash and colon names", () => {
    for (const path of [
      "a",
      "a/b",
      "-dash",
      ":(glob)x",
      "*.md",
      "a b/c d",
      "a\\b",
      "\u00fc/\u{1f600}",
    ]) {
      expect(isBrowsePath(path), path).toBe(true);
    }
  });

  it("refuses shapes that cannot", () => {
    for (const path of [
      "",
      "/",
      "/a",
      "a//b",
      "a/",
      "../a",
      "a/..",
      "a/./b",
      ".",
      "..",
      "a\0b",
      "a".repeat(4097),
    ]) {
      expect(isBrowsePath(path), JSON.stringify(path.slice(0, 20))).toBe(false);
    }
  });

  it("normalizes one trailing slash and the empty root", () => {
    expect(normalizeBrowsePath("")).toBe("");
    expect(normalizeBrowsePath("src/")).toBe("src");
    expect(normalizeBrowsePath("src//")).toBeNull();
    expect(normalizeBrowsePath("/")).toBeNull();
    expect(normalizeBrowsePath("../x")).toBeNull();
  });

  it("compares by code point, not UTF-16 unit", () => {
    expect(compareCodePoints("a", "b")).toBeLessThan(0);
    expect(compareCodePoints("Z", "a")).toBeLessThan(0);
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("a", "a")).toBe(0);
    expect(compareCodePoints("\uff5e", "\u{1f600}")).toBeLessThan(0);
  });
});

describe("listing parser", () => {
  const oid = "a".repeat(40);

  it("keeps names with tabs, newlines and spaces whole", () => {
    const raw = Buffer.from(
      [
        `100644 blob ${oid}      12\ttab\tname`,
        `100644 blob ${oid}       3\tline\nbreak`,
        `040000 tree ${oid}       -\tdir`,
        "garbage",
        "",
      ].join("\0"),
    );
    expect(parseListing(raw, "p").map((entry) => [entry.path, entry.type, entry.size])).toEqual([
      ["p/tab\tname", "blob", 12],
      ["p/line\nbreak", "blob", 3],
      ["p/dir", "tree", null],
    ]);
  });
});

describe("blob sniffing", () => {
  it("recognizes the raster formats by magic bytes", () => {
    const cases: [string, Buffer][] = [
      ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ["image/gif", Buffer.from("GIF89a....")],
      ["image/gif", Buffer.from("GIF87a....")],
      [
        "image/webp",
        Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]),
      ],
      ["image/avif", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif")])],
      ["image/avif", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavis")])],
      ["image/bmp", Buffer.from("BM......")],
      ["image/x-icon", Buffer.from([0, 0, 1, 0, 1, 0])],
    ];
    for (const [type, bytes] of cases) {
      expect(sniffRasterType(bytes), type).toBe(type);
    }
    expect(sniffRasterType(Buffer.from("plain text"))).toBeNull();
    expect(sniffRasterType(Buffer.alloc(0))).toBeNull();
    expect(sniffRasterType(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42")]))).toBeNull();
  });

  it("matches an image only when the extension and the bytes agree", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(matchInlineImage("a/b.PNG", png, false)).toBe("image/png");
    expect(matchInlineImage("b.jpg", png, false)).toBeNull();
    expect(matchInlineImage("b.txt", png, false)).toBeNull();
    expect(matchInlineImage("png", png, false)).toBeNull();
  });

  it("accepts an SVG only as a whole UTF-8 file with an svg element", () => {
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(matchInlineImage("x.svg", svg, true)).toBe("image/svg+xml");
    expect(matchInlineImage("x.svg", svg, false)).toBeNull();
    expect(matchInlineImage("x.svg", Buffer.from("<html></html>"), true)).toBeNull();
    expect(matchInlineImage("x.svg", Buffer.from("<svg>\0</svg>"), true)).toBeNull();
    expect(
      matchInlineImage("x.svg", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x3e, 0xff]), true),
    ).toBeNull();
    expect(matchInlineImage("x.svg", Buffer.from("<svg:svg xmlns:svg='x'/>"), true)).toBe(
      "image/svg+xml",
    );
  });

  it("tells text from binary", () => {
    expect(looksBinary(Buffer.from("hello\n"), false)).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00]), false)).toBe(true);
    expect(looksBinary(Buffer.from([0x61, 0xe9]), false)).toBe(true);
    // A character cut in half at the end of a head read is not binary.
    const cut = Buffer.from("a\u00e9").subarray(0, 2);
    expect(isUtf8(cut, false)).toBe(false);
    expect(isUtf8(cut, true)).toBe(true);
    expect(looksBinary(Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])]), false)).toBe(
      false,
    );
  });
});

describe("diff parsers", () => {
  it("reads --raw -z including renames and copies", () => {
    const raw = [
      ":100644 100644 aaa bbb M",
      "a.txt",
      ":000000 100644 000 ccc A",
      ":weird name",
      ":100644 100644 aaa bbb R086",
      "old.txt",
      "new.txt",
      ":100644 100644 aaa bbb C100",
      "src.txt",
      "dst.txt",
      ":100644 120000 aaa bbb T",
      "swap",
      "",
    ].join("\0");
    expect(parseRawChanges(raw)).toEqual([
      { status: "modified", path: "a.txt", oldPath: null },
      { status: "added", path: ":weird name", oldPath: null },
      { status: "renamed", path: "new.txt", oldPath: "old.txt" },
      { status: "copied", path: "dst.txt", oldPath: "src.txt" },
      { status: "type_changed", path: "swap", oldPath: null },
    ]);
  });

  it("reads --numstat -z including binary and rename rows", () => {
    const raw = [
      "3\t1\ta.txt",
      "-\t-\tbin.dat",
      "0\t0\t",
      "old.txt",
      "new.txt",
      "2\t0\twith\ttab",
      "",
    ].join("\0");
    const counts = parseNumstat(raw);
    expect(counts.get("\0a.txt")).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(counts.get("\0bin.dat")).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(counts.get("old.txt\0new.txt")).toEqual({ additions: 0, deletions: 0, binary: false });
    expect(counts.get("\0with\ttab")).toEqual({ additions: 2, deletions: 0, binary: false });
  });

  it("splits a patch at file boundaries and starts each at its first hunk", () => {
    const patch = Buffer.from(
      [
        "diff --git a/a b/a",
        "index 1..2 100644",
        "--- a/a",
        "+++ b/a",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "diff --git a/b b/b",
        "similarity index 100%",
        "rename from b",
        "rename to c",
        "diff --git a/d b/d",
        "Binary files a/d and b/d differ",
        "diff --git a/e b/e",
        "--- a/e",
        "+++ b/e",
        "@@ -0,0 +1 @@",
        "+diff --git not a boundary",
        "",
      ].join("\n"),
    );
    const sections = splitPatch(patch).map((section) => section?.toString("utf8") ?? null);
    expect(sections).toEqual([
      "@@ -1 +1 @@\n-x\n+y\n",
      null,
      null,
      "@@ -0,0 +1 @@\n+diff --git not a boundary\n",
    ]);
  });
});

describe("concurrency gate", () => {
  let fifo: string;

  beforeAll(() => {
    fifo = join(dirname(work.dir), "gate.fifo");
    execFileSync("mkfifo", [fifo]);
  });

  /** A run that blocks until its budget ends. */
  function stuck(timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return runGit({ ...ctx, timeoutMs, signal }, ["hash-object", fifo], { maxBytes: 1024 }).catch(
      (caught: unknown) => caught,
    );
  }

  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("never runs more than the limit at once, and starts queued runs as slots free", async () => {
    expect(BROWSE_MAX_GIT_PROCESSES).toBe(4);
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, liveGitProcessCount());
    }, 10);
    const first = [1, 2, 3, 4].map(() => stuck(700));
    const queued = [stuck(2500), stuck(2500)];
    await pause(250);
    expect(liveGitProcessCount()).toBe(4);
    expect(browseGitQueueLength()).toBe(2);

    // The first four time out at 700 ms; the queued two then start.
    await pause(750);
    expect(liveGitProcessCount()).toBe(2);
    expect(browseGitQueueLength()).toBe(0);

    const results = await Promise.all([...first, ...queued]);
    clearInterval(sampler);
    expect(peak).toBeLessThanOrEqual(4);
    expect(results.every((r) => r instanceof BrowseError && r.statusCode === 504)).toBe(true);
    expect(liveGitProcessCount()).toBe(0);
  });

  it("drops a waiter whose client leaves without ever starting git", async () => {
    const holders = [1, 2, 3, 4].map(() => stuck(600));
    await pause(100);
    const controller = new AbortController();
    const waiter = stuck(5000, controller.signal);
    await pause(50);
    expect(browseGitQueueLength()).toBe(1);
    controller.abort();
    expect(await waiter).toMatchObject({ statusCode: 499, code: "aborted" });
    expect(browseGitQueueLength()).toBe(0);
    expect(liveGitProcessCount()).toBe(4);

    await Promise.all(holders);
    await pause(100);
    // The slots freed and nothing replaced them: the waiter never spawned.
    expect(liveGitProcessCount()).toBe(0);
  });

  it("drops a waiter whose budget runs out in the queue without starting git", async () => {
    const holders = [1, 2, 3, 4].map(() => stuck(700));
    await pause(100);
    const started = Date.now();
    const waiter = await stuck(250);
    expect(waiter).toMatchObject({ statusCode: 504, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(600);
    expect(browseGitQueueLength()).toBe(0);
    expect(liveGitProcessCount()).toBe(4);
    await Promise.all(holders);
    await pause(100);
    expect(liveGitProcessCount()).toBe(0);
  });

  it("does not start git for a waiter that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await stuck(1000, controller.signal)).toMatchObject({ statusCode: 499 });
    expect(liveGitProcessCount()).toBe(0);
  });
});
