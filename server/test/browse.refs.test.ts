import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitOk, type TestServer } from "./helpers/gitFixture.ts";
import {
  browseUrl,
  createWork,
  get,
  importCommits,
  publish,
  register,
  startServer,
  stopServer,
  type Published,
  type Work,
} from "./helpers/browseFixture.ts";

/** refs and resolve against real repositories. */

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

interface Resolved {
  oid: string;
  kind: string;
  name: string | null;
}

interface RefsBody {
  head: Resolved | null;
  branchCount: number;
  tagCount: number;
  rows: { kind: string; name: string; oid: string }[];
  truncated: boolean;
  shallow: boolean;
}

function refs(repo: Published, query: Record<string, string> = {}): ReturnType<typeof get> {
  return get(server, browseUrl(repo.repoId, "refs", query));
}

function resolve(repo: Published, rev: string): ReturnType<typeof get> {
  return get(server, browseUrl(repo.repoId, "resolve", { rev }));
}

describe("refs", () => {
  let work: Work;
  let repo: Published;
  let first: string;
  let second: string;
  let third: string;

  beforeAll(async () => {
    work = track(await createWork());
    work.write("a.txt", "one\n");
    first = await work.commit("first");
    await work.git(["tag", "light", first]);
    work.write("a.txt", "two\n");
    second = await work.commit("second");
    await work.git(["tag", "-a", "-m", "annotated", "v1.0.0", second]);
    await work.git(["tag", "-a", "-m", "nested", "nested", "v1.0.0"]);
    await work.git(["branch", "older", first]);
    await work.git(["branch", "dependabot/npm_and_yarn/@types/node-1.2.3", first]);
    work.write("a.txt", "three\n");
    third = await work.commit("third");
    repo = await publish(server, work);
  });

  it("pins the default branch first even when it is the oldest", async () => {
    const other = track(await createWork());
    other.write("x", "1");
    await other.commit("root");
    await other.git(["checkout", "-q", "-b", "newer"]);
    other.write("x", "2");
    await other.commit("newer tip");
    const published = await publish(server, other);

    const body = (await refs(published)).json as RefsBody;
    expect(body.rows.map((row) => row.name)).toEqual(["main", "newer"]);
    expect(body.head?.name).toBe("main");
    expect(body.head?.kind).toBe("branch");
  });

  it("returns branches with commit ids and the default branch as head", async () => {
    const reply = await refs(repo);
    expect(reply.status).toBe(200);
    const body = reply.json as RefsBody;
    expect(body.head).toEqual({ oid: third, kind: "branch", name: "main" });
    expect(body.branchCount).toBe(3);
    expect(body.tagCount).toBe(3);
    expect(body.rows[0]).toEqual({ kind: "branch", name: "main", oid: third });
    expect(body.rows.map((row) => row.name)).toContain("dependabot/npm_and_yarn/@types/node-1.2.3");
    expect(body.truncated).toBe(false);
    expect(body.shallow).toBe(false);
  });

  it("peels annotated tags, including a tag of a tag, to their commit", async () => {
    const body = (await refs(repo, { kind: "tag" })).json as RefsBody;
    const byName = new Map(body.rows.map((row) => [row.name, row]));
    expect(byName.get("light")?.oid).toBe(first);
    expect(byName.get("v1.0.0")?.oid).toBe(second);
    expect(byName.get("nested")?.oid).toBe(second);
    expect(body.rows.every((row) => row.kind === "tag")).toBe(true);
  });

  it("filters by q case-insensitively and leaves the counts alone", async () => {
    const body = (await refs(repo, { q: "OLD" })).json as RefsBody;
    expect(body.rows.map((row) => row.name)).toEqual(["older"]);
    expect(body.branchCount).toBe(3);
    expect(body.tagCount).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it("applies limit to the rows and says so", async () => {
    const body = (await refs(repo, { limit: "2" })).json as RefsBody;
    expect(body.rows).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(body.branchCount).toBe(3);
  });

  it("rejects an out-of-range limit and an unknown kind", async () => {
    expect((await refs(repo, { limit: "0" })).status).toBe(400);
    expect((await refs(repo, { limit: "100000" })).status).toBe(400);
    expect((await refs(repo, { kind: "remote" })).status).toBe(400);
  });

  it("falls back to HEAD when the default branch does not exist", async () => {
    const published = await publish(server, work, { defaultBranch: "gone-upstream" });
    const body = (await refs(published)).json as RefsBody;
    expect(body.head).toEqual({ oid: third, kind: "branch", name: "main" });
  });

  it("answers an empty backup with no head and zero counts", async () => {
    const published = await publish(server, track(await createWork()));
    const reply = await refs(published);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      head: null,
      branchCount: 0,
      tagCount: 0,
      rows: [],
      truncated: false,
      shallow: false,
    });
  });

  it("flags a shallow clone", async () => {
    const slug = "browse-shallow-00000a01";
    await gitOk([
      "clone",
      "-q",
      "--bare",
      "--depth",
      "1",
      `file://${work.dir}`,
      `${server.backupsDir}/${slug}`,
    ]);
    const body = (await refs(register(server, slug))).json as RefsBody;
    expect(body.shallow).toBe(true);
    expect(body.head?.oid).toBe(third);
  });
});

describe("resolve", () => {
  let work: Work;
  let repo: Published;
  let first: string;
  let second: string;

  beforeAll(async () => {
    work = track(await createWork());
    work.write("a.txt", "one\n");
    first = await work.commit("first");
    work.write("a.txt", "two\n");
    second = await work.commit("second");
    for (const name of ["feat@x", "a+b", "c#d", "dependabot/npm_and_yarn/@types/node-1.2.3"]) {
      await work.git(["branch", name, first]);
    }
    await work.git(["tag", "v1.0+build", first]);
    await work.git(["tag", "-a", "-m", "annotated", "v2", second]);
    // The same short name as a branch and as a tag, on different commits.
    await work.git(["branch", "dup", first]);
    await work.git(["tag", "dup", second]);
    repo = await publish(server, work);
    await gitOk(["update-ref", "refs/amber/archive/20260101T000000Z/refs/heads/main", first], {
      cwd: repo.bareDir,
    });
    await gitOk(["update-ref", "refs/pull/7/head", second], { cwd: repo.bareDir });
  });

  async function expectResolved(rev: string, expected: Resolved): Promise<void> {
    const reply = await resolve(repo, rev);
    expect(reply.status, rev).toBe(200);
    expect(reply.json, rev).toEqual(expected);
  }

  it("resolves HEAD to the head of the backup", async () => {
    await expectResolved("HEAD", { oid: second, kind: "branch", name: "main" });
  });

  it("resolves branch names that contain @, + and #", async () => {
    await expectResolved("feat@x", { oid: first, kind: "branch", name: "feat@x" });
    await expectResolved("a+b", { oid: first, kind: "branch", name: "a+b" });
    await expectResolved("c#d", { oid: first, kind: "branch", name: "c#d" });
    await expectResolved("dependabot/npm_and_yarn/@types/node-1.2.3", {
      oid: first,
      kind: "branch",
      name: "dependabot/npm_and_yarn/@types/node-1.2.3",
    });
  });

  it("resolves tags, peeling an annotated one", async () => {
    await expectResolved("v1.0+build", { oid: first, kind: "tag", name: "v1.0+build" });
    await expectResolved("v2", { oid: second, kind: "tag", name: "v2" });
  });

  it("prefers the branch when a branch and a tag share a name", async () => {
    await expectResolved("dup", { oid: first, kind: "branch", name: "dup" });
  });

  it("resolves a short sha, a full sha and an upper-case sha", async () => {
    await expectResolved(first.slice(0, 7), { oid: first, kind: "commit", name: null });
    await expectResolved(first, { oid: first, kind: "commit", name: null });
    await expectResolved(second.toUpperCase(), { oid: second, kind: "commit", name: null });
    await expectResolved(`  ${second.slice(0, 10)}  `, { oid: second, kind: "commit", name: null });
  });

  it("resolves full ref names, including refs that are not heads or tags", async () => {
    await expectResolved("refs/heads/a+b", { oid: first, kind: "branch", name: "a+b" });
    await expectResolved("refs/tags/v2", { oid: second, kind: "tag", name: "v2" });
    await expectResolved("refs/amber/archive/20260101T000000Z/refs/heads/main", {
      oid: first,
      kind: "commit",
      name: null,
    });
    await expectResolved("refs/pull/7/head", { oid: second, kind: "commit", name: null });
  });

  it("lets a full object id win over a ref named like another commit's id", async () => {
    // A mirror carries any ref name, including one that is a sha.
    await gitOk(["update-ref", `refs/heads/${second}`, first], { cwd: repo.bareDir });
    await gitOk(["update-ref", `refs/tags/${first}`, second], { cwd: repo.bareDir });
    await expectResolved(second, { oid: second, kind: "commit", name: null });
    await expectResolved(second.toUpperCase(), { oid: second, kind: "commit", name: null });
    await expectResolved(first, { oid: first, kind: "commit", name: null });
    // A short id still goes through the ref names first, so the same text does not.
    await gitOk(["update-ref", `refs/heads/${second.slice(0, 8)}`, first], { cwd: repo.bareDir });
    await expectResolved(second.slice(0, 8), {
      oid: first,
      kind: "branch",
      name: second.slice(0, 8),
    });
    // A 40 character name that is not an object in the backup is still a name.
    const unknown = "e".repeat(40);
    await gitOk(["update-ref", `refs/heads/${unknown}`, second], { cwd: repo.bareDir });
    await expectResolved(unknown, { oid: second, kind: "branch", name: unknown });
  });

  it("answers 404 for anything unknown", async () => {
    for (const rev of ["nope", "refs/heads/nope", "deadbeef", "ffff"]) {
      const reply = await resolve(repo, rev);
      expect(reply.status, rev).toBe(404);
      expect(reply.json).toMatchObject({ error: "not_found" });
    }
  });

  it("treats git syntax and option-looking text as plain names that do not exist", async () => {
    const hostile = [
      "--help",
      "-1",
      "--output=/tmp/amber-should-not-exist",
      "--upload-pack=x",
      "main..dup",
      "main...dup",
      "main@{1}",
      "main@{upstream}",
      "main^",
      "main^{commit}",
      "main~1",
      "HEAD~1",
      "HEAD^",
      "main:a.txt",
      ":/first",
      "@",
      "@{-1}",
      `${second}^`,
      `${second}~1`,
      `${second}:a.txt`,
      "refs/heads/main^",
      "refs/heads/../heads/main",
      "main\u0000",
    ];
    for (const rev of hostile) {
      const reply = await resolve(repo, rev);
      expect(reply.status, JSON.stringify(rev)).toBe(404);
    }
  });

  it("rejects an empty or over-long revision", async () => {
    expect((await resolve(repo, "")).status).toBe(400);
    expect((await resolve(repo, "   ")).status).toBe(400);
    expect((await resolve(repo, "a".repeat(256))).status).toBe(400);
  });

  it("answers 404 for a short sha that matches more than one commit", async () => {
    const many = track(await createWork());
    many.write("x", "1");
    await many.commit("root");
    await importCommits(many, 3000);
    const all = (await many.git(["rev-list", "bulk"])).trim().split("\n");
    const seen = new Map<string, string>();
    let shared: string | null = null;
    for (const oid of all) {
      const prefix = oid.slice(0, 4);
      if (seen.has(prefix)) {
        shared = prefix;
        break;
      }
      seen.set(prefix, oid);
    }
    expect(shared, "3000 commits should share a 4 character prefix").not.toBeNull();
    const published = await publish(server, many);

    const ambiguous = await resolve(published, shared as string);
    expect(ambiguous.status).toBe(404);
    const known = seen.get(shared as string) as string;
    const exact = await resolve(published, known);
    expect(exact.json).toEqual({ oid: known, kind: "commit", name: null });
  }, 60_000);

  it("resolves a sha256 repository's full and short ids", async () => {
    const wide = track(await createWork({ objectFormat: "sha256" }));
    wide.write("a", "1");
    const oid = await wide.commit("wide");
    expect(oid).toHaveLength(64);
    const published = await publish(server, wide);

    expect((await resolve(published, oid)).json).toEqual({ oid, kind: "commit", name: null });
    expect((await resolve(published, oid.slice(0, 12))).json).toEqual({
      oid,
      kind: "commit",
      name: null,
    });
    const body = (await refs(published)).json as RefsBody;
    expect(body.head?.oid).toBe(oid);
  });
});

describe("repository lookup", () => {
  it("answers 404 for an unknown repo id", async () => {
    expect((await get(server, browseUrl(99999, "refs", {}))).status).toBe(404);
    expect((await get(server, browseUrl(99999, "resolve", { rev: "main" }))).status).toBe(404);
  });

  it("answers 409 for a row with no backup directory", async () => {
    const repo = register(server, "browse-nodir-00000a02");
    const reply = await refs(repo);
    expect(reply.status).toBe(409);
    expect(reply.json).toMatchObject({ error: "not_backed_up" });
  });

  it("answers 400 for a non-numeric repo id", async () => {
    expect((await get(server, "/api/repos/abc/browse/refs")).status).toBe(400);
  });
});
