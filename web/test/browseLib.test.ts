import { describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client.ts";
import {
  breadcrumbs,
  countLines,
  gutterText,
  isNotBackedUp,
  isNotFound,
  parentPath,
  pickReadme,
  shortOid,
} from "../src/lib/browse.ts";
import { makeEntry } from "./helpers/browseStubs.ts";

describe("paths", () => {
  it("finds the parent directory", () => {
    expect(parentPath("a/b/c.txt")).toBe("a/b");
    expect(parentPath("a")).toBe("");
    expect(parentPath("")).toBe("");
  });

  it("builds one crumb per segment, each opening its own directory", () => {
    expect(breadcrumbs("")).toEqual([]);
    expect(breadcrumbs("a/b/c")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
      { name: "c", path: "a/b/c" },
    ]);
  });

  it("abbreviates object ids to seven characters", () => {
    expect(shortOid("0123456789abcdef")).toBe("0123456");
  });
});

describe("line counting", () => {
  it("counts a final newline as ending the last line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\n")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\n\n")).toBe(2);
    expect(countLines("\n")).toBe(1);
  });

  it("writes the gutter as one number per line", () => {
    expect(gutterText(0)).toBe("");
    expect(gutterText(3)).toBe("1\n2\n3");
  });
});

describe("pickReadme", () => {
  it("matches case-insensitively and prefers README.md", () => {
    const entries = [
      makeEntry({ name: "readme.txt" }),
      makeEntry({ name: "ReadMe.MD" }),
      makeEntry({ name: "README" }),
    ];
    expect(pickReadme(entries)?.name).toBe("ReadMe.MD");
  });

  it("falls back down the list in order", () => {
    expect(
      pickReadme([makeEntry({ name: "README.rst" }), makeEntry({ name: "README" })])?.name,
    ).toBe("README");
    expect(pickReadme([makeEntry({ name: "README.rst" })])?.name).toBe("README.rst");
  });

  it("ignores directories, symlinks and look-alikes", () => {
    expect(
      pickReadme([
        makeEntry({ name: "README.md", type: "tree", size: null }),
        makeEntry({ name: "README", type: "symlink" }),
        makeEntry({ name: "README.md.bak" }),
        makeEntry({ name: "READMEs" }),
      ]),
    ).toBeNull();
  });
});

describe("error predicates", () => {
  it("recognizes a repository that is not backed up yet", () => {
    expect(isNotBackedUp(new ApiClientError("not_backed_up", "x", 409))).toBe(true);
    expect(isNotBackedUp(new ApiClientError("conflict", "x", 409))).toBe(true);
    expect(isNotBackedUp(new ApiClientError("not_found", "x", 404))).toBe(false);
    expect(isNotBackedUp(null)).toBe(false);
  });

  it("recognizes a 404", () => {
    expect(isNotFound(new ApiClientError("not_found", "x", 404))).toBe(true);
    expect(isNotFound(new ApiClientError("boom", "x", 500))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});
