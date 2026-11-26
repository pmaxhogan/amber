import { createReadStream, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { git, removeDir, scratchDir } from "./helpers.ts";

/**
 * Git repositories built with the real git binary and served over "dumb HTTP"
 * (static files plus `git update-server-info`) from a loopback server, so a
 * test can import them into Amber without touching the network.
 */

export interface LocalGitServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The URL to paste into the import box for a repository built as `name`. */
  urlFor: (name: string) => string;
  /** Build `<name>.git` from a work tree that `build` fills in, then publish it. */
  addRepo: (name: string, build: (work: string) => Promise<void>) => Promise<void>;
  close: () => Promise<void>;
}

const IDENTITY = ["-c", "user.name=Amber E2E", "-c", "user.email=e2e@example.invalid"];

/** Run git and throw with its stderr when it fails, so fixture bugs are loud. */
export async function must(args: string[], cwd: string): Promise<string> {
  const result = await git([...IDENTITY, "-c", "commit.gpgsign=false", ...args], cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Resolve a request path to a file under `root`, or null. The decoded path is
 * resolved and must stay inside the root, so `..` and encoded separators can
 * never reach anything else on the machine.
 */
export function resolveServedFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "");
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const file = resolve(base, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export async function startLocalGitServer(): Promise<LocalGitServer> {
  const work = scratchDir("git-server");
  const root = join(work, "served");
  const bareDir = join(root, "t");
  mkdirSync(bareDir, { recursive: true });

  const server: Server = createServer((request, response) => {
    const file = resolveServedFile(root, request.url ?? "/");
    if (file === null) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    urlFor: (name) => `${origin}/t/${name}.git`,
    addRepo: async (name, build) => {
      const tree = join(work, "trees", name);
      mkdirSync(tree, { recursive: true });
      await must(["init", "--quiet", "--initial-branch=main"], tree);
      await build(tree);
      const bare = join(bareDir, `${name}.git`);
      await must(["clone", "--bare", "--quiet", tree, bare], work);
      await must(["update-server-info"], bare);
    },
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      removeDir(work);
    },
  };
}

// A real 1x1 PNG and a small SVG with explicit dimensions (an SVG without them
// has no natural width and would look unloaded to naturalWidth).
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const SVG_LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<rect width="24" height="24" fill="#c80"/></svg>\n';

export const RICH_README = `# Fixture Title

A table of things:

| Name | Value |
| ---- | ----- |
| alpha | 1 |
| beta | 2 |

- [the docs directory](docs/)
- [the guide](docs/guide.md)
- [an external link](https://example.invalid/outside)

![pixel](assets/pixel.png)
![logo](assets/logo.svg)
![remote badge](https://remote-badge.invalid/badge.png)

<p align="center">centered html paragraph</p>
`;

export const RICH = {
  name: "browse-rich",
  featureBranch: "feature@x+y",
  lightTag: "v0.1",
  annotatedTag: "v1.0",
  symlinkTarget: "docs/guide.md",
  mainSource: [
    "export const answer = 42;",
    "export function greet(name: string): string {",
    '  return "hello " + name;',
    "}",
    "// last line",
    "",
  ].join("\n"),
} as const;

/** A repository with everything the Browse tab has to cope with. */
export async function buildRichRepo(work: string): Promise<{ firstSha: string }> {
  mkdirSync(join(work, "docs"));
  mkdirSync(join(work, "src"));
  mkdirSync(join(work, "assets"));
  writeFileSync(join(work, "README.md"), RICH_README);
  writeFileSync(join(work, "docs", "README.md"), "# Docs Title\n\nNested readme body.\n");
  writeFileSync(join(work, "docs", "guide.md"), "# Guide Title\n\nThe guide body.\n");
  writeFileSync(join(work, "src", "main.ts"), RICH.mainSource);
  writeFileSync(join(work, "assets", "pixel.png"), PNG_1X1);
  writeFileSync(join(work, "assets", "logo.svg"), SVG_LOGO);
  writeFileSync(join(work, "data.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 8, 7]));
  symlinkSync(RICH.symlinkTarget, join(work, "link-to-guide"));
  await must(["add", "-A"], work);
  await must(["commit", "--quiet", "-m", "initial import"], work);
  const firstSha = await must(["rev-parse", "--short=7", "HEAD"], work);

  // A pure rename, so git reports it as one.
  await must(["mv", "src/main.ts", "src/app.ts"], work);
  await must(["commit", "--quiet", "-m", "rename main to app"], work);

  writeFileSync(join(work, "src", "app.ts"), `${RICH.mainSource}export const added = true;\n`);
  await must(["commit", "--quiet", "-am", "modify app"], work);

  await must(["tag", RICH.lightTag, firstSha], work);
  await must(["tag", "-a", RICH.annotatedTag, "-m", "first release"], work);

  await must(["checkout", "--quiet", "-b", RICH.featureBranch], work);
  writeFileSync(join(work, "feature-only.txt"), "only on the feature branch\n");
  await must(["add", "-A"], work);
  await must(["commit", "--quiet", "-m", "feature work"], work);
  await must(["checkout", "--quiet", "main"], work);
  return { firstSha };
}

export const SINGLE = { name: "browse-single" } as const;

/** One branch, no tags: the ref picker has nothing to offer. */
export async function buildSingleRepo(work: string): Promise<void> {
  writeFileSync(join(work, "notes.txt"), "just one branch\n");
  await must(["add", "-A"], work);
  await must(["commit", "--quiet", "-m", "only commit"], work);
}
