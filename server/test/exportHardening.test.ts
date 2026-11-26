import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportError, setSevenZipCache, streamSourceArchive } from "../src/export/archive.ts";
import {
  createWork,
  get,
  publish,
  startServer,
  stopServer,
  type Published,
  type Work,
} from "./helpers/browseFixture.ts";
import { gitOk, tempDir, type TestServer } from "./helpers/gitFixture.ts";

/**
 * The export and blob paths against a hostile backup: a replace ref cannot
 * swap what an id names, and a failing tool does not leak where it ran.
 */

let server: TestServer;
const scratch: string[] = [];

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  setSevenZipCache();
  await stopServer(server, ...scratch);
});

describe("replace refs", () => {
  let work: Work;
  let repo: Published;
  let real: string;

  beforeAll(async () => {
    work = await createWork();
    scratch.push(dirname(work.dir));
    work.write("a.txt", "real\n");
    real = await work.commit("real");
    await work.git(["tag", "v1", real]);
    work.write("a.txt", "decoy\n");
    const decoy = await work.commit("decoy");
    repo = await publish(server, work);
    await gitOk(["update-ref", `refs/replace/${real}`, decoy], { cwd: repo.bareDir });
  });

  it("serves the real bytes from /blob at the replaced commit", async () => {
    const reply = await get(server, `/api/repos/${String(repo.repoId)}/blob?ref=v1&path=a.txt`);
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe("real\n");
  });

  it("exports the real tree for the replaced commit", async () => {
    const reply = await get(
      server,
      `/api/repos/${String(repo.repoId)}/export/source.tar.gz?ref=v1`,
    );
    expect(reply.status).toBe(200);
    const dir = tempDir("replace-export");
    scratch.push(dir);
    writeFileSync(join(dir, "source.tar.gz"), reply.body);
    execFileSync("tar", ["-xzf", "source.tar.gz"], { cwd: dir });
    const prefix = `${repo.slug}-v1`;
    expect(readFileSync(join(dir, prefix, "a.txt"), "utf8")).toBe("real\n");
  });
});

describe("a failing 7z", () => {
  it("keeps the tool's stderr and work directory out of the answer", async () => {
    const work = await createWork();
    scratch.push(dirname(work.dir));
    work.write("a.txt", "one\n");
    await work.commit("one");
    const repo = await publish(server, work);

    const fake = join(tempDir("fake7z"), "7z");
    scratch.push(dirname(fake));
    mkdirSync(dirname(fake), { recursive: true });
    writeFileSync(fake, "#!/bin/sh\necho 'cannot open /secret/work/dir-12345' >&2\nexit 2\n");
    chmodSync(fake, 0o755);
    setSevenZipCache(fake);
    try {
      const reply = await get(server, `/api/repos/${String(repo.repoId)}/export/source.7z`);
      expect(reply.status).toBe(500);
      const text = reply.body.toString("utf8");
      expect(text).toContain("Could not build the 7z archive.");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("dir-12345");
      expect(text).not.toContain("amber-export-");
      expect(text).not.toContain(fake);
    } finally {
      setSevenZipCache();
      rmSync(dirname(fake), { recursive: true, force: true });
    }
  });

  it("carries the command, exit code and stderr as detail for the log", async () => {
    const work = await createWork();
    scratch.push(dirname(work.dir));
    work.write("a.txt", "one\n");
    const oid = await work.commit("one");
    const repo = await publish(server, work);
    const fake = join(tempDir("fake7z"), "7z");
    scratch.push(dirname(fake));
    writeFileSync(fake, "#!/bin/sh\necho 'cannot open /secret/work/dir-12345' >&2\nexit 2\n");
    chmodSync(fake, 0o755);
    setSevenZipCache(fake);
    try {
      const error = (await streamSourceArchive(repo.bareDir, oid, "7z", "x").catch(
        (caught: unknown) => caught,
      )) as ExportError;
      expect(error).toBeInstanceOf(ExportError);
      expect(error.message).toBe("Could not build the 7z archive.");
      expect(error.detail).toContain("exited with 2");
      expect(error.detail).toContain("dir-12345");
    } finally {
      setSevenZipCache();
    }
  });
});
