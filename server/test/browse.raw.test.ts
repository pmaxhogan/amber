import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveGitProcessCount } from "../src/gitSpawn.ts";
import { type TestServer } from "./helpers/gitFixture.ts";
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

/** raw: the bytes, and every header that keeps a hostile file from running as the app. */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SVG_WITH_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>\n';

let server: TestServer;
let work: Work;
let repo: Published;
let commit: string;
const scratch: string[] = [];

function raw(path: string, extra: Record<string, string> = {}, rev: string = commit) {
  return get(server, browseUrl(repo.repoId, "raw", { rev, path, ...extra }));
}

function header(reply: Awaited<ReturnType<typeof raw>>, name: string): string | undefined {
  const value = reply.headers[name];
  return Array.isArray(value) ? value.join(", ") : value === undefined ? undefined : String(value);
}

/** The headers that hold on every raw answer, success or not. */
function expectSafety(reply: Awaited<ReturnType<typeof raw>>): void {
  expect(header(reply, "x-content-type-options")).toBe("nosniff");
  expect(header(reply, "content-security-policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(header(reply, "cross-origin-resource-policy")).toBe("same-origin");
}

beforeAll(async () => {
  server = await startServer();
  work = await createWork();
  scratch.push(dirname(work.dir));
  work.write("notes.txt", "plain text\n");
  work.write("page.html", "<script>alert(1)</script>\n");
  work.write("real.png", PNG);
  work.write("fake.png", "<script>alert(1)</script>\n");
  work.write("pic.svg", SVG_WITH_SCRIPT);
  work.write("bad.svg", "<html><script>alert(1)</script></html>\n");
  work.write("UPPER.PNG", PNG);
  work.write("dir/inner.txt", "inner\n");
  work.write("blob.bin", Buffer.from([0, 1, 2, 255, 254]));
  work.write('quo"te.txt', "q\n");
  work.write("new\r\nline.txt", "n\n");
  work.write("\u00fcn\u00ef\u2603.txt", "u\n");
  work.write("semi;colon filename.txt", "s\n");
  work.write("huge.bin", Buffer.alloc(40 * 1024 * 1024, 7));
  commit = await work.commit("raw");
  repo = await publish(server, work);
}, 60_000);

afterAll(async () => {
  await stopServer(server, ...scratch);
});

describe("raw downloads", () => {
  it("serves a file as an attachment with the full header set", async () => {
    const reply = await raw("notes.txt");
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe("plain text\n");
    expect(header(reply, "content-type")).toBe("application/octet-stream");
    expect(header(reply, "content-disposition")).toBe('attachment; filename="notes.txt"');
    expect(header(reply, "content-length")).toBe("11");
    expect(header(reply, "cache-control")).toBe("private, max-age=86400, immutable");
    expectSafety(reply);
  });

  it("serves HTML as a download, never as a page", async () => {
    const reply = await raw("page.html", { inline: "1" });
    expect(reply.status).toBe(200);
    expect(header(reply, "content-type")).toBe("application/octet-stream");
    expect(header(reply, "content-disposition")).toBe('attachment; filename="page.html"');
    expectSafety(reply);
  });

  it("serves a verified image inline with the type from its extension", async () => {
    const reply = await raw("real.png", { inline: "1" });
    expect(reply.status).toBe(200);
    expect(reply.body.equals(PNG)).toBe(true);
    expect(header(reply, "content-type")).toBe("image/png");
    expect(header(reply, "content-disposition")).toBe("inline");
    expect(header(reply, "content-length")).toBe(String(PNG.length));
    expect(header(reply, "cache-control")).toBe("private, max-age=86400, immutable");
    expectSafety(reply);
  });

  it("matches the extension case-insensitively", async () => {
    const reply = await raw("UPPER.PNG", { inline: "1" });
    expect(header(reply, "content-type")).toBe("image/png");
    expect(header(reply, "content-disposition")).toBe("inline");
  });

  it("downloads an image when inline is not asked for", async () => {
    const reply = await raw("real.png");
    expect(header(reply, "content-type")).toBe("application/octet-stream");
    expect(header(reply, "content-disposition")).toBe('attachment; filename="real.png"');
  });

  it("keeps a file that only claims to be an image an attachment", async () => {
    const reply = await raw("fake.png", { inline: "1" });
    expect(reply.status).toBe(200);
    expect(header(reply, "content-type")).toBe("application/octet-stream");
    expect(header(reply, "content-disposition")).toBe('attachment; filename="fake.png"');
    expectSafety(reply);
  });

  it("serves an SVG inline under the sandbox policy, and non-SVG text named .svg as a download", async () => {
    const svg = await raw("pic.svg", { inline: "1" });
    expect(svg.status).toBe(200);
    expect(header(svg, "content-type")).toBe("image/svg+xml");
    expect(header(svg, "content-disposition")).toBe("inline");
    expect(svg.body.toString("utf8")).toBe(SVG_WITH_SCRIPT);
    // The policy that stops the script above from running as the app.
    expect(header(svg, "content-security-policy")).toContain("sandbox");
    expect(header(svg, "content-security-policy")).toContain("default-src 'none'");
    expect(header(svg, "x-content-type-options")).toBe("nosniff");

    const bad = await raw("bad.svg", { inline: "1" });
    expect(header(bad, "content-type")).toBe("application/octet-stream");
    expect(header(bad, "content-disposition")).toBe('attachment; filename="bad.svg"');
  });

  it("serves binary bytes exactly", async () => {
    const reply = await raw("blob.bin");
    expect(reply.body.equals(Buffer.from([0, 1, 2, 255, 254]))).toBe(true);
  });

  it("sanitizes hostile names in Content-Disposition", async () => {
    const cases: [string, string][] = [
      ['quo"te.txt', "quo-te.txt"],
      ["new\r\nline.txt", "new-line.txt"],
      ["\u00fcn\u00ef\u2603.txt", "n-.txt"],
      ["semi;colon filename.txt", "semi-colon-filename.txt"],
    ];
    for (const [path, filename] of cases) {
      const reply = await raw(path);
      expect(reply.status, path).toBe(200);
      expect(header(reply, "content-disposition"), path).toBe(`attachment; filename="${filename}"`);
      expect(header(reply, "content-disposition"), path).not.toMatch(/[\r\n]/);
    }
  });

  it("serves a file in a directory under its own name", async () => {
    const reply = await raw("dir/inner.txt");
    expect(header(reply, "content-disposition")).toBe('attachment; filename="inner.txt"');
  });
});

describe("raw errors", () => {
  it("answers 404 for a missing path, a directory, and a missing commit, with the safety headers", async () => {
    for (const reply of [
      await raw("nope.txt"),
      await raw("dir"),
      await raw("notes.txt", {}, "0".repeat(40)),
    ]) {
      expect(reply.status).toBe(404);
      expectSafety(reply);
      expect(header(reply, "cache-control")).toBe("no-store");
    }
  });

  it("answers 400 for a bad path, a bad rev and a bad inline value, with the safety headers", async () => {
    for (const reply of [
      await raw("../notes.txt"),
      await raw("/notes.txt"),
      await raw("notes.txt", {}, "main"),
      await raw("notes.txt", { inline: "0" }),
      await raw("notes.txt", { inline: "true" }),
      await get(server, browseUrl(repo.repoId, "raw", { rev: commit })),
    ]) {
      expect(reply.status).toBe(400);
      expectSafety(reply);
    }
  });

  it("does not widen a glob", async () => {
    expect((await raw("*.txt")).status).toBe(404);
    expect((await raw("n*")).status).toBe(404);
  });
});

describe("raw and a client that goes away", () => {
  it("kills the git process when the download is abandoned", async () => {
    expect(liveGitProcessCount()).toBe(0);
    const controller = new AbortController();
    const url = `${server.baseUrl}${browseUrl(repo.repoId, "raw", { rev: commit, path: "huge.bin" })}`;
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.value?.length ?? 0).toBeGreaterThan(0);
    // Still streaming: the pipe and socket buffers hold a small part of 40 MB.
    expect(liveGitProcessCount()).toBeGreaterThan(0);
    controller.abort();
    await reader.cancel().catch(() => undefined);

    const deadline = Date.now() + 10_000;
    while (liveGitProcessCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(liveGitProcessCount()).toBe(0);
  }, 30_000);
});

describe("the older blob download", () => {
  it("kills git when a /blob download is abandoned", async () => {
    expect(liveGitProcessCount()).toBe(0);
    const controller = new AbortController();
    const url = `${server.baseUrl}/api/repos/${String(repo.repoId)}/blob?path=huge.bin`;
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.value?.length ?? 0).toBeGreaterThan(0);
    expect(liveGitProcessCount()).toBeGreaterThan(0);
    controller.abort();
    await reader.cancel().catch(() => undefined);

    const deadline = Date.now() + 10_000;
    while (liveGitProcessCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(liveGitProcessCount()).toBe(0);
  }, 30_000);
});
