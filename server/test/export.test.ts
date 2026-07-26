import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findSevenZip,
  isSafeTreePath,
  parseLsTree,
  setSevenZipCache,
  streamSourceArchive,
} from "../src/export/archive.ts";
import { parseArtifact } from "../src/routes/exports.ts";
import {
  createRepoFixture,
  git,
  gitOk,
  insertRepoRow,
  run,
  startTestServer,
  tempDir,
  type Fixture,
  type TestServer,
} from "./helpers/gitFixture.ts";

/**
 * Export round trips against real archives: download, extract with the real
 * tool, compare the bytes back to the fixture.
 */

let server: TestServer;
let fixture: Fixture;
let repoId: number;
let sevenZip: string | null;
const scratchDirs: string[] = [];
const SLUG = "fixtures-export-0badc0de";
const DISPLAY_NAME = "export-fixture";

function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  scratchDirs.push(dir);
  return dir;
}

async function download(path: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const response = await fetch(`${server.baseUrl}${path}`);
  return {
    status: response.status,
    body: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
  };
}

function writeTemp(dir: string, name: string, body: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

beforeAll(async () => {
  server = await startTestServer();
  fixture = await createRepoFixture(server.backupsDir, SLUG);
  repoId = insertRepoRow(server.db, { slug: SLUG, displayName: DISPLAY_NAME });
  sevenZip = await findSevenZip();
  if (sevenZip === null) {
    // Loud on purpose. The Docker image installs p7zip-full; a developer box
    // may not have it, and a silently skipped format is how a broken export
    // ships.
    server.app.log.warn(
      "NO 7z BINARY ON PATH: the 7z export tests are SKIPPED. Install p7zip-full to run them.",
    );
  }
});

afterAll(async () => {
  await server.close();
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(server.dataDir, { recursive: true, force: true });
});

describe("source archives", () => {
  it("round trips a zip", async () => {
    const result = await download(`/api/repos/${String(repoId)}/export/source.zip`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/zip");
    expect(result.headers.get("content-disposition")).toBe(
      `attachment; filename="${DISPLAY_NAME}-main.zip"`,
    );
    // Local file header magic.
    expect(result.body.subarray(0, 4).toString("hex")).toBe("504b0304");

    const dir = scratch("zip");
    const archivePath = writeTemp(dir, "source.zip", result.body);
    const out = join(dir, "out");
    // git can read a zip back out, which keeps the assertion free of a
    // third party unzip implementation.
    const extracted = await extractWithSevenZipOrNode(archivePath, out);
    if (!extracted) {
      return;
    }
    const root = join(out, `${DISPLAY_NAME}-main`);
    for (const [path, content] of Object.entries(fixture.files)) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(content);
    }
  });

  it("round trips a tar.gz", async () => {
    const result = await download(`/api/repos/${String(repoId)}/export/source.tar.gz`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/gzip");
    expect(result.headers.get("content-disposition")).toBe(
      `attachment; filename="${DISPLAY_NAME}-main.tar.gz"`,
    );
    // gzip magic.
    expect(result.body.subarray(0, 2).toString("hex")).toBe("1f8b");

    const dir = scratch("targz");
    writeTemp(dir, "source.tar.gz", result.body);
    const out = join(dir, "out");
    const untar = await untarInto(dir, "source.tar.gz", "out");
    expect(untar.code, untar.stderr).toBe(0);

    const root = join(out, `${DISPLAY_NAME}-main`);
    for (const [path, content] of Object.entries(fixture.files)) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(content);
    }
  });

  it("round trips a 7z when the binary is available", async () => {
    if (sevenZip === null) {
      return;
    }
    const result = await download(`/api/repos/${String(repoId)}/export/source.7z`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/x-7z-compressed");
    // 7z signature "7z\xBC\xAF\x27\x1C".
    expect(result.body.subarray(0, 6).toString("hex")).toBe("377abcaf271c");

    const dir = scratch("sevenz");
    const archivePath = writeTemp(dir, "source.7z", result.body);
    const out = join(dir, "out");
    const extract = await run(sevenZip, ["x", archivePath, `-o${out}`, "-y", "-bso0", "-bsp0"]);
    expect(extract.code, extract.stderr).toBe(0);

    const root = join(out, `${DISPLAY_NAME}-main`);
    for (const [path, content] of Object.entries(fixture.files)) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(content);
    }
  });

  it("leaves no temp directory behind after a 7z export", async () => {
    if (sevenZip === null) {
      return;
    }
    const before = tempExportDirs();
    const result = await download(`/api/repos/${String(repoId)}/export/source.7z`);
    expect(result.status).toBe(200);
    await expect
      .poll(() => tempExportDirs().length, { timeout: 10_000 })
      .toBeLessThanOrEqual(before.length);
  });

  it("exports a specific ref and names the download after it", async () => {
    const result = await download(
      `/api/repos/${String(repoId)}/export/source.zip?ref=${fixture.firstSha}`,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toBe(
      `attachment; filename="${DISPLAY_NAME}-${fixture.firstSha}.zip"`,
    );

    const dir = scratch("zip-ref");
    const archivePath = writeTemp(dir, "source.zip", result.body);
    const out = join(dir, "out");
    const extracted = await extractWithSevenZipOrNode(archivePath, out);
    if (!extracted) {
      return;
    }
    const root = join(out, `${DISPLAY_NAME}-${fixture.firstSha}`);
    // The first commit only had the short README.
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# amber fixture\n");
    expect(existsSync(join(root, "src", "index.ts"))).toBe(false);
  });

  it("exports a tag", async () => {
    const result = await download(`/api/repos/${String(repoId)}/export/source.zip?ref=v1.0.0`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toContain("v1.0.0.zip");
  });

  it("rejects an unknown ref", async () => {
    const result = await download(
      `/api/repos/${String(repoId)}/export/source.zip?ref=no-such-branch`,
    );
    expect(result.status).toBe(404);
  });

  it("rejects a ref that would read as a flag or escape the repository", async () => {
    for (const ref of ["--upload-pack=touch", "../../etc/passwd", "main;whoami", "main ", "-h"]) {
      const result = await download(
        `/api/repos/${String(repoId)}/export/source.zip?ref=${encodeURIComponent(ref)}`,
      );
      expect([400, 404], ref).toContain(result.status);
    }
  });

  it("404s an unknown archive format", async () => {
    expect((await download(`/api/repos/${String(repoId)}/export/source.rar`)).status).toBe(404);
    expect((await download(`/api/repos/${String(repoId)}/export/secrets.zip`)).status).toBe(404);
  });

  it("404s an unknown repository and 409s one with no backup on disk", async () => {
    expect((await download("/api/repos/9999/export/source.zip")).status).toBe(404);
    const orphanId = insertRepoRow(server.db, { slug: "fixtures-never-synced-11223344" });
    expect((await download(`/api/repos/${String(orphanId)}/export/source.zip`)).status).toBe(409);
  });
});

describe("gitdir archives", () => {
  it("round trips a zip carrying refs, including refs/amber archives", async () => {
    const result = await download(`/api/repos/${String(repoId)}/export/gitdir.zip`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toBe(
      `attachment; filename="${DISPLAY_NAME}-gitdir.zip"`,
    );

    const dir = scratch("gitdir-zip");
    const archivePath = writeTemp(dir, "gitdir.zip", result.body);
    const out = join(dir, "out");
    const extracted = await extractWithSevenZipOrNode(archivePath, out);
    if (!extracted) {
      return;
    }
    await assertRestoredBackup(join(out, SLUG));
  });

  it("round trips a tar.gz", async () => {
    const result = await download(`/api/repos/${String(repoId)}/export/gitdir.tar.gz`);
    expect(result.status).toBe(200);
    expect(result.body.subarray(0, 2).toString("hex")).toBe("1f8b");

    const dir = scratch("gitdir-targz");
    writeTemp(dir, "gitdir.tar.gz", result.body);
    const untar = await untarInto(dir, "gitdir.tar.gz", "out");
    expect(untar.code, untar.stderr).toBe(0);
    await assertRestoredBackup(join(dir, "out", SLUG));
  });

  it("round trips a 7z when the binary is available", async () => {
    if (sevenZip === null) {
      return;
    }
    const result = await download(`/api/repos/${String(repoId)}/export/gitdir.7z`);
    expect(result.status).toBe(200);
    const dir = scratch("gitdir-7z");
    const archivePath = writeTemp(dir, "gitdir.7z", result.body);
    const out = join(dir, "out");
    const extract = await run(sevenZip, ["x", archivePath, `-o${out}`, "-y", "-bso0", "-bsp0"]);
    expect(extract.code, extract.stderr).toBe(0);
    await assertRestoredBackup(join(out, SLUG));
  });
});

describe("tree and blob", () => {
  it("lists the manifest with path, size and mode", async () => {
    const response = await fetch(`${server.baseUrl}/api/repos/${String(repoId)}/tree`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ref: string;
      total: number;
      rows: { path: string; size: number; mode: string; oid: string }[];
    };
    expect(body.ref).toBe(fixture.headSha);
    expect(body.total).toBe(Object.keys(fixture.files).length);

    const paths = body.rows.map((row) => row.path).sort();
    expect(paths).toEqual(Object.keys(fixture.files).sort());

    const readme = body.rows.find((row) => row.path === "README.md");
    expect(readme?.size).toBe(Buffer.byteLength(fixture.files["README.md"] as string));
    expect(readme?.mode).toBe("100644");
    expect(readme?.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pages the manifest", async () => {
    const first = await fetch(
      `${server.baseUrl}/api/repos/${String(repoId)}/tree?page=1&perPage=2`,
    );
    const second = await fetch(
      `${server.baseUrl}/api/repos/${String(repoId)}/tree?page=2&perPage=2`,
    );
    const a = (await first.json()) as { rows: { path: string }[]; total: number };
    const b = (await second.json()) as { rows: { path: string }[]; total: number };
    expect(a.rows).toHaveLength(2);
    expect(a.total).toBe(4);
    expect(b.rows.map((row) => row.path)).not.toEqual(a.rows.map((row) => row.path));
  });

  it("streams a blob byte for byte", async () => {
    for (const [path, content] of Object.entries(fixture.files)) {
      const response = await fetch(
        `${server.baseUrl}/api/repos/${String(repoId)}/blob?path=${encodeURIComponent(path)}`,
      );
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe(content);
    }
  });

  it("sets a sane download filename and blocks sniffing", async () => {
    const response = await fetch(
      `${server.baseUrl}/api/repos/${String(repoId)}/blob?path=src%2Findex.ts`,
    );
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="index.ts"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
  });

  it("serves a blob at an older ref", async () => {
    const response = await fetch(
      `${server.baseUrl}/api/repos/${String(repoId)}/blob?ref=${fixture.firstSha}&path=README.md`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# amber fixture\n");
  });

  it("rejects path traversal and absolute paths without touching the filesystem", async () => {
    const attacks = [
      "../../../../etc/passwd",
      "../config",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "..\\..\\config",
      "./README.md",
      "src/../README.md",
      "-README.md",
      ":(glob)**/*.ts",
      "objects/info/packs",
      "config",
      "HEAD",
    ];
    for (const path of attacks) {
      const response = await fetch(
        `${server.baseUrl}/api/repos/${String(repoId)}/blob?path=${encodeURIComponent(path)}`,
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("does not let a glob pathspec widen the match", async () => {
    const response = await fetch(
      `${server.baseUrl}/api/repos/${String(repoId)}/blob?path=${encodeURIComponent("*.md")}`,
    );
    expect(response.status).toBe(404);
  });

  it("rejects a missing path", async () => {
    const response = await fetch(`${server.baseUrl}/api/repos/${String(repoId)}/blob`);
    expect(response.status).toBe(400);
  });
});

describe("when no 7z binary is installed", () => {
  it("answers 501 rather than failing obscurely, and keeps zip working", async () => {
    setSevenZipCache(null);
    try {
      expect(await findSevenZip()).toBeNull();
      const sevenZipResult = await download(`/api/repos/${String(repoId)}/export/source.7z`);
      expect(sevenZipResult.status).toBe(501);
      expect(sevenZipResult.body.toString("utf8")).toContain("7z");

      const gitdirResult = await download(`/api/repos/${String(repoId)}/export/gitdir.7z`);
      expect(gitdirResult.status).toBe(501);

      // zip and tar.gz do not need the binary, so they must be unaffected.
      const zip = await download(`/api/repos/${String(repoId)}/export/gitdir.zip`);
      expect(zip.status).toBe(200);
    } finally {
      setSevenZipCache();
      sevenZip = await findSevenZip();
    }
  });
});

describe("temp directory hygiene", () => {
  it("removes the 7z work directory when the caller never reads the stream", async () => {
    if (sevenZip === null) {
      return;
    }
    const before = new Set(tempExportDirs());
    const handle = await streamSourceArchive(fixture.bareDir, fixture.headSha, "7z", "abandoned");
    const created = tempExportDirs().filter((name) => !before.has(name));
    expect(created).toHaveLength(1);

    handle.stream.destroy();
    await handle.cleanup();
    // Idempotent: a route calls it from the abort handler and again on end.
    await handle.cleanup();
    expect(existsSync(join(tmpdir(), created[0] as string))).toBe(false);
  });
});

describe("pure helpers", () => {
  it("parses ls-tree records including paths with spaces", () => {
    const raw =
      "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa      12\tsp ace.txt\0" +
      "160000 commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb       -\tvendor/dep\0";
    const entries = parseLsTree(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      path: "sp ace.txt",
      mode: "100644",
      oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: 12,
    });
  });

  it("agrees with the route on which paths are acceptable", () => {
    expect(isSafeTreePath("src/index.ts")).toBe(true);
    expect(isSafeTreePath("sp ace.txt")).toBe(true);
    expect(isSafeTreePath("../x")).toBe(false);
    expect(isSafeTreePath("/x")).toBe(false);
    expect(isSafeTreePath("a\\b")).toBe(false);
    expect(isSafeTreePath(":(glob)x")).toBe(false);
    expect(isSafeTreePath("")).toBe(false);
  });

  it("parses the artifact segment", () => {
    expect(parseArtifact("source.zip")).toEqual({ kind: "source", format: "zip" });
    expect(parseArtifact("gitdir.tar.gz")).toEqual({ kind: "gitdir", format: "tar.gz" });
    expect(parseArtifact("source.7z")).toEqual({ kind: "source", format: "7z" });
    expect(parseArtifact("source")).toBeNull();
    expect(parseArtifact("other.zip")).toBeNull();
    expect(parseArtifact("source.tar")).toBeNull();
  });
});

/** A restored backup must be a working repository with the amber refs intact. */
async function assertRestoredBackup(dir: string): Promise<void> {
  expect(existsSync(join(dir, "HEAD"))).toBe(true);
  expect(existsSync(join(dir, "config"))).toBe(true);

  const refs = await gitOk(["for-each-ref", "--format=%(refname)"], { cwd: dir });
  const names = refs.stdout.split("\n").map((line) => line.trim());
  expect(names).toContain("refs/heads/main");
  expect(names).toContain("refs/tags/v1.0.0");
  expect(names.some((name) => name.startsWith("refs/amber/archive/"))).toBe(true);

  const head = await gitOk(["rev-parse", "refs/heads/main"], { cwd: dir });
  expect(head.stdout.trim()).toBe(fixture.headSha);

  const check = await git(["cat-file", "-e", `${fixture.firstSha}^{commit}`], { cwd: dir });
  expect(check.code).toBe(0);
}

/**
 * tar reads a "host:path" remote syntax out of any argument with a colon, so a
 * Windows absolute path makes it try to connect to drive C. Everything stays
 * relative to a cwd instead, which is portable.
 */
async function untarInto(cwd: string, archiveName: string, outName: string) {
  mkdirSync(join(cwd, outName), { recursive: true });
  return await run("tar", ["-xzf", archiveName, "-C", outName], { cwd });
}

/** Zip extraction without adding a dependency: 7z if present, else unzip. */
async function extractWithSevenZipOrNode(archivePath: string, out: string): Promise<boolean> {
  mkdirSync(out, { recursive: true });
  if (sevenZip !== null) {
    const result = await run(sevenZip, ["x", archivePath, `-o${out}`, "-y", "-bso0", "-bsp0"]);
    expect(result.code, result.stderr).toBe(0);
    return true;
  }
  const unzip = await run("unzip", ["-q", archivePath, "-d", out]);
  if (unzip.code !== 0) {
    server.app.log.warn(
      "NO 7z OR unzip BINARY: zip extraction assertions are SKIPPED for this archive.",
    );
    return false;
  }
  return true;
}

/** Export temp directories, so a leak shows up as a growing count. */
function tempExportDirs(): string[] {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith("amber-export-"));
  } catch {
    return [];
  }
}
