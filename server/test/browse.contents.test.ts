import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitOk, type TestServer } from "./helpers/gitFixture.ts";
import {
  browseUrl,
  createWork,
  get,
  publish,
  startServer,
  stopServer,
  type Published,
  type Work,
} from "./helpers/browseFixture.ts";

/** contents against real repositories, files of every kind included. */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect/></svg>\n';
const LFS =
  "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 12345\n";

let server: TestServer;
let work: Work;
let repo: Published;
let commit: string;
let treeOid: string;
const scratch: string[] = [];

interface Tree {
  type: "tree";
  commit: string;
  path: string;
  entries: {
    name: string;
    path: string;
    type: string;
    mode: string;
    oid: string;
    size: number | null;
  }[];
  truncated: boolean;
}

interface Blob {
  type: "blob";
  path: string;
  name: string;
  size: number;
  view: string;
  text: string | null;
  tooLarge: boolean;
  symlink: boolean;
  lfsPointer: boolean;
  mode: string;
}

function contents(path: string, rev: string = commit): ReturnType<typeof get> {
  return get(server, browseUrl(repo.repoId, "contents", { rev, path }));
}

async function blob(path: string): Promise<Blob> {
  const reply = await contents(path);
  expect(reply.status, path).toBe(200);
  const body = reply.json as Blob;
  expect(body.type, path).toBe("blob");
  return body;
}

beforeAll(async () => {
  server = await startServer();
  work = await createWork();
  scratch.push(dirname(work.dir));

  work.write("README.md", "# Title\n\nbody\n");
  work.write("a.md", "# a\n");
  work.write("*.md", "literal star\n");
  work.write(":(glob)*", "literal pathspec magic\n");
  work.write("-dash", "starts with a dash\n");
  work.write("sp ace.txt", "space\n");
  work.write("\u00fcn\u00ef.txt", "unicode\n");
  work.write("a\\b.txt", "backslash\n");
  work.write("empty.txt", "");
  work.write("src/index.ts", "export const value = 42;\n");
  work.write("src/deep/er/file.txt", "deep\n");
  work.write("adir/inner.txt", "x\n");
  work.write("zdir/inner.txt", "x\n");
  work.write("Z.txt", "z\n");
  work.write("a.txt", "a\n");
  work.write("\uff5e.txt", "fullwidth tilde, U+FF5E\n");
  work.write("\u{1f600}.txt", "emoji, U+1F600\n");
  work.write("real.png", PNG);
  work.write("fake.png", "this is not a png\n");
  work.write("mismatch.jpg", PNG);
  work.write("pic.svg", SVG);
  work.write("bad.svg", "just some text\n");
  work.write("blob.bin", Buffer.from([0x01, 0x02, 0x00, 0x03]));
  work.write("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  work.write("big.txt", "line of text\n".repeat(100_000));
  work.write("big.bin", Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(1_100_000, 7)]));
  work.write("big.png", Buffer.concat([PNG, Buffer.alloc(1_100_000, 0)]));
  work.write("model.bin", LFS);
  work.write("run.sh", "#!/bin/sh\n");
  symlinkSync("src/index.ts", join(work.dir, "link"));

  await work.git(["add", "-A"]);
  await work.git(["update-index", "--chmod=+x", "run.sh"]);
  await work.git([
    "update-index",
    "--add",
    "--cacheinfo",
    "160000,1234567890123456789012345678901234567890,vendor/sub",
  ]);
  await work.git(["commit", "-q", "-m", "everything"]);
  commit = await work.head();
  treeOid = (await work.git(["rev-parse", "HEAD^{tree}"])).trim();
  repo = await publish(server, work);
}, 60_000);

afterAll(async () => {
  await stopServer(server, ...scratch);
});

describe("directories", () => {
  it("lists the root, directories first, then files in code point order", async () => {
    const reply = await contents("");
    expect(reply.status).toBe(200);
    const tree = reply.json as Tree;
    expect(tree.type).toBe("tree");
    expect(tree.commit).toBe(commit);
    expect(tree.path).toBe("");
    expect(tree.truncated).toBe(false);

    const names = tree.entries.map((entry) => entry.name);
    const dirs = tree.entries.filter((entry) => entry.type === "tree").map((entry) => entry.name);
    expect(dirs).toEqual(["adir", "src", "vendor", "zdir"]);
    expect(names.slice(0, dirs.length)).toEqual(dirs);

    const files = names.slice(dirs.length);
    const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(files).toEqual(sorted);
    // UTF-16 order would put the emoji (a surrogate pair) before U+FF5E.
    expect(files.indexOf("\uff5e.txt")).toBeLessThan(files.indexOf("\u{1f600}.txt"));
    expect(files.indexOf("Z.txt")).toBeLessThan(files.indexOf("a.txt"));
  });

  it("describes entries by mode: blob, symlink, executable, submodule", async () => {
    const tree = (await contents("")).json as Tree;
    const entry = (name: string) => tree.entries.find((candidate) => candidate.name === name);
    expect(entry("README.md")).toMatchObject({ type: "blob", mode: "100644", path: "README.md" });
    expect(entry("run.sh")).toMatchObject({ type: "blob", mode: "100755" });
    expect(entry("link")).toMatchObject({ type: "symlink", mode: "120000", size: 12 });
    expect(entry("adir")).toMatchObject({ type: "tree", mode: "040000", size: null });
    const vendor = (await contents("vendor")).json as Tree;
    expect(vendor.entries).toEqual([
      expect.objectContaining({
        name: "sub",
        path: "vendor/sub",
        type: "submodule",
        mode: "160000",
        size: null,
        oid: "1234567890123456789012345678901234567890",
      }),
    ]);
  });

  it("lists a nested directory with full paths", async () => {
    const tree = (await contents("src")).json as Tree;
    expect(tree.path).toBe("src");
    expect(tree.entries.map((entry) => [entry.name, entry.path, entry.type])).toEqual([
      ["deep", "src/deep", "tree"],
      ["index.ts", "src/index.ts", "blob"],
    ]);
    const deeper = (await contents("src/deep/er")).json as Tree;
    expect(deeper.entries.map((entry) => entry.path)).toEqual(["src/deep/er/file.txt"]);
  });

  it("accepts one trailing slash on a directory", async () => {
    const tree = (await contents("src/")).json as Tree;
    expect(tree.type).toBe("tree");
    expect(tree.path).toBe("src");
  });
});

describe("files", () => {
  it("reads text", async () => {
    const body = await blob("src/index.ts");
    expect(body).toMatchObject({
      name: "index.ts",
      view: "text",
      text: "export const value = 42;\n",
      tooLarge: false,
      symlink: false,
      lfsPointer: false,
    });
    expect(body.size).toBe(25);
  });

  it("shows markdown as markdown", async () => {
    expect(await blob("README.md")).toMatchObject({ view: "markdown", text: "# Title\n\nbody\n" });
  });

  it("treats an empty file as empty text", async () => {
    expect(await blob("empty.txt")).toMatchObject({ view: "text", text: "", size: 0 });
  });

  it("calls a real PNG an image and sends no text", async () => {
    expect(await blob("real.png")).toMatchObject({ view: "image", text: null });
  });

  it("does not trust an extension: a .png of text is text, a .jpg of PNG bytes is binary", async () => {
    expect(await blob("fake.png")).toMatchObject({ view: "text", text: "this is not a png\n" });
    expect(await blob("mismatch.jpg")).toMatchObject({ view: "binary", text: null });
  });

  it("shows an SVG as an image with its source, and plain text named .svg as text", async () => {
    expect(await blob("pic.svg")).toMatchObject({ view: "image", text: SVG });
    expect(await blob("bad.svg")).toMatchObject({ view: "text", text: "just some text\n" });
  });

  it("calls a NUL byte or invalid UTF-8 binary", async () => {
    expect(await blob("blob.bin")).toMatchObject({ view: "binary", text: null, tooLarge: false });
    expect(await blob("latin1.txt")).toMatchObject({ view: "binary", text: null });
  });

  it("does not send a text file over the size cap", async () => {
    const body = await blob("big.txt");
    expect(body).toMatchObject({ view: "text", text: null, tooLarge: true });
    expect(body.size).toBe(1_300_000);
  });

  it("calls a big binary binary, and a big real image an image", async () => {
    expect(await blob("big.bin")).toMatchObject({ view: "binary", text: null, tooLarge: false });
    expect(await blob("big.png")).toMatchObject({ view: "image", text: null });
  });

  it("reports a symlink and its target", async () => {
    expect(await blob("link")).toMatchObject({
      view: "text",
      text: "src/index.ts",
      symlink: true,
      mode: "120000",
    });
  });

  it("flags a Git LFS pointer", async () => {
    expect(await blob("model.bin")).toMatchObject({ view: "text", lfsPointer: true, text: LFS });
  });

  it("serves names with spaces, unicode, a leading dash and a backslash", async () => {
    expect(await blob("sp ace.txt")).toMatchObject({ text: "space\n", name: "sp ace.txt" });
    expect(await blob("\u00fcn\u00ef.txt")).toMatchObject({ text: "unicode\n" });
    expect(await blob("-dash")).toMatchObject({ text: "starts with a dash\n" });
    expect(await blob("a\\b.txt")).toMatchObject({ text: "backslash\n" });
  });
});

describe("literal paths", () => {
  it("reaches files named like pathspec magic as themselves", async () => {
    expect(await blob("*.md")).toMatchObject({ text: "literal star\n", path: "*.md" });
    expect(await blob("a.md")).toMatchObject({ text: "# a\n", path: "a.md" });
    expect(await blob(":(glob)*")).toMatchObject({ text: "literal pathspec magic\n" });
  });

  it("does not let a glob widen a match", async () => {
    for (const path of [
      "*",
      "src/*",
      "*.txt",
      "**/index.ts",
      ":(glob)src/**",
      ":(top)a.md",
      "s?c",
    ]) {
      const reply = await contents(path);
      expect(reply.status, path).toBe(404);
    }
  });

  it("refuses traversal, absolute and malformed paths", async () => {
    for (const path of [
      "../x",
      "a/../b",
      "src/..",
      "./a.md",
      "src/./index.ts",
      "/etc/passwd",
      "/",
      "src//index.ts",
      "a\u0000b",
    ]) {
      const reply = await contents(path);
      expect(reply.status, JSON.stringify(path)).toBe(400);
    }
  });

  it("answers 404 for a path that is not in the tree", async () => {
    expect((await contents("nope")).status).toBe(404);
    expect((await contents("src/nope.ts")).status).toBe(404);
    expect((await contents("README.md/inside")).status).toBe(404);
  });

  it("answers 404 when asked for a submodule", async () => {
    expect((await contents("vendor/sub")).status).toBe(404);
  });
});

describe("rev", () => {
  it("accepts only a full commit id", async () => {
    expect((await contents("", "main")).status).toBe(400);
    expect((await contents("", commit.slice(0, 7))).status).toBe(400);
    expect((await contents("", commit.toUpperCase())).status).toBe(400);
    expect((await contents("", "")).status).toBe(400);
    expect((await get(server, browseUrl(repo.repoId, "contents", { path: "" }))).status).toBe(400);
  });

  it("answers 404 for an id that is not a commit in this backup", async () => {
    expect((await contents("", treeOid)).status).toBe(404);
    expect((await contents("", "0".repeat(40))).status).toBe(404);
    expect((await contents("", "a".repeat(64))).status).toBe(404);
  });

  it("answers 404 for a tag object id, which names a commit only after peeling", async () => {
    await work.git(["tag", "-a", "-m", "t", "annotated", "HEAD"]);
    const tagObject = (await work.git(["rev-parse", "annotated"])).trim();
    const tagged = await publish(server, work);
    const reply = await get(
      server,
      browseUrl(tagged.repoId, "contents", { rev: tagObject, path: "" }),
    );
    expect(reply.status).toBe(404);
  });
});

describe("large directories", () => {
  it("cuts a directory at the entry cap and says so", async () => {
    const many = await createWork();
    scratch.push(dirname(many.dir));
    for (let index = 0; index < 5100; index += 1) {
      many.write(`d/f${String(index).padStart(5, "0")}.txt`, "x");
    }
    const sha = await many.commit("many");
    const published = await publish(server, many);
    const reply = await get(
      server,
      browseUrl(published.repoId, "contents", { rev: sha, path: "d" }),
    );
    const tree = reply.json as Tree;
    expect(tree.entries).toHaveLength(5000);
    expect(tree.truncated).toBe(true);
    expect(tree.entries[0]?.name).toBe("f00000.txt");
  }, 60_000);
});

describe("sha256", () => {
  it("browses a sha256 repository", async () => {
    const wide = await createWork({ objectFormat: "sha256" });
    scratch.push(dirname(wide.dir));
    wide.write("dir/a.txt", "wide\n");
    const sha = await wide.commit("wide");
    const published = await publish(server, wide);

    const root = (
      await get(server, browseUrl(published.repoId, "contents", { rev: sha, path: "" }))
    ).json as Tree;
    expect(root.entries[0]?.oid).toHaveLength(64);
    const file = (
      await get(server, browseUrl(published.repoId, "contents", { rev: sha, path: "dir/a.txt" }))
    ).json as Blob;
    expect(file.text).toBe("wide\n");
    // A 40 character id is not a prefix of anything here.
    const short = await get(
      server,
      browseUrl(published.repoId, "contents", { rev: sha.slice(0, 40), path: "" }),
    );
    expect(short.status).toBe(404);
  });
});

describe("replace refs", () => {
  it("does not let a refs/replace ref change what a commit id names", async () => {
    const swapped = await createWork();
    scratch.push(dirname(swapped.dir));
    swapped.write("a.txt", "real\n");
    const real = await swapped.commit("real");
    swapped.write("a.txt", "decoy\n");
    const decoy = await swapped.commit("decoy");
    const published = await publish(server, swapped);
    // A mirrored repository carries every ref, so this one can arrive.
    await gitOk(["update-ref", `refs/replace/${real}`, decoy], { cwd: published.bareDir });

    const file = (
      await get(server, browseUrl(published.repoId, "contents", { rev: real, path: "a.txt" }))
    ).json as Blob;
    expect(file.text).toBe("real\n");
    const raw = await get(server, browseUrl(published.repoId, "raw", { rev: real, path: "a.txt" }));
    expect(raw.body.toString("utf8")).toBe("real\n");
  });
});
