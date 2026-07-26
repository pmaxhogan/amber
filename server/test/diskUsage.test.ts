import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directorySizeBytes } from "../src/sync/diskUsage.ts";
import { tempDir } from "./helpers/gitFixtures.ts";

let root: string;

beforeEach(() => {
  root = tempDir("du");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("directorySizeBytes", () => {
  it("sums files recursively", async () => {
    writeFileSync(join(root, "a.bin"), Buffer.alloc(1024));
    mkdirSync(join(root, "objects", "ab"), { recursive: true });
    writeFileSync(join(root, "objects", "ab", "pack"), Buffer.alloc(2048));
    mkdirSync(join(root, "empty"), { recursive: true });

    expect(await directorySizeBytes(root)).toBe(3072);
  });

  it("returns zero for a directory that is not there", async () => {
    expect(await directorySizeBytes(join(root, "missing"))).toBe(0);
  });

  it("returns zero for an empty directory", async () => {
    expect(await directorySizeBytes(root)).toBe(0);
  });

  it("never follows a symlink out of the backup", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "huge.bin"), Buffer.alloc(4096));

    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "small.bin"), Buffer.alloc(16));
    try {
      symlinkSync(outside, join(repo, "link"), "dir");
    } catch {
      // Unprivileged Windows cannot create symlinks; the walk is the same.
      return;
    }

    // The link itself is counted, whatever it points at is not.
    expect(await directorySizeBytes(repo)).toBeLessThan(4096);
  });
});
