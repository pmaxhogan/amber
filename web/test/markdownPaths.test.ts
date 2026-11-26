import { describe, expect, it } from "vitest";
import {
  classifyImage,
  classifyLink,
  externalHref,
  isNormalizedTreePath,
  resolveTreeReference,
} from "../src/lib/markdown/paths.ts";

const FILE = "docs/guide/README.md";

describe("resolveTreeReference", () => {
  it.each([
    ["./a.png", "docs/guide/a.png"],
    ["a.png", "docs/guide/a.png"],
    ["img/a.png", "docs/guide/img/a.png"],
    ["../x", "docs/x"],
    ["../../x", "x"],
    ["../..", ""],
    ["sub/./a//b", "docs/guide/sub/a/b"],
    ["My%20File.md", "docs/guide/My File.md"],
    ["%2e%2e/x", "docs/x"],
    ["intro.md#setup", "docs/guide/intro.md"],
    ["intro.md?plain=1", "docs/guide/intro.md"],
    ["dir/", "docs/guide/dir"],
  ])("resolves %s to %s", (reference, expected) => {
    expect(resolveTreeReference(FILE, reference)).toBe(expected);
  });

  it.each([
    "",
    "../../../x",
    "%2e%2e/%2e%2e/%2e%2e/x",
    "/etc/passwd",
    "/api/repos/1/browse/raw?rev=a&path=b",
    "//evil.example/x.png",
    "\\\\evil\\x.png",
    "a\\b.png",
    "https://evil.example/x.png",
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:image/png;base64,AAAA",
    "mailto:a@b.c",
    "a b.png",
    "a%2fb.png",
    "a%5cb.png",
    "a%00b.png",
    "bad%zz.png",
    "#frag",
    "?q=1",
    " a.png",
  ])("refuses %j", (reference) => {
    expect(resolveTreeReference(FILE, reference)).toBeNull();
  });

  it("resolves against the root for a top-level file", () => {
    expect(resolveTreeReference("README.md", "docs/a.md")).toBe("docs/a.md");
    expect(resolveTreeReference("README.md", "../a.md")).toBeNull();
  });

  it("throws when the file path itself is not normalized", () => {
    expect(() => resolveTreeReference("/README.md", "a.md")).toThrow();
    expect(() => resolveTreeReference("docs/../README.md", "a.md")).toThrow();
    expect(() => resolveTreeReference("", "a.md")).toThrow();
  });
});

describe("isNormalizedTreePath", () => {
  it("accepts normalized paths and the root", () => {
    expect(isNormalizedTreePath("")).toBe(true);
    expect(isNormalizedTreePath("a/b c/d.md")).toBe(true);
  });

  it.each(["/a", "a/", "a//b", "./a", "a/../b", "a\\b", "a\nb"])("refuses %j", (path) => {
    expect(isNormalizedTreePath(path)).toBe(false);
  });
});

describe("externalHref", () => {
  it("keeps http, https and mailto, re-serialized", () => {
    expect(externalHref("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(externalHref("HTTP://Example.com")).toBe("http://example.com/");
    expect(externalHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it.each([
    null,
    "",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    " javascript:alert(1)",
    "vbscript:x",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com",
    "//example.com",
    "/api/repos",
    "relative.md",
  ])("refuses %j", (value) => {
    expect(externalHref(value)).toBeNull();
  });
});

describe("classifyLink", () => {
  it("classifies external, tree and dead links", () => {
    expect(classifyLink(FILE, "https://example.com")).toEqual({
      kind: "external",
      href: "https://example.com/",
    });
    expect(classifyLink(FILE, "../CONTRIBUTING.md#how")).toEqual({
      kind: "tree",
      path: "docs/CONTRIBUTING.md",
    });
    expect(classifyLink(FILE, "#install")).toEqual({ kind: "none" });
    expect(classifyLink(FILE, "javascript:alert(1)")).toEqual({ kind: "none" });
    expect(classifyLink(FILE, "/api/repos/1")).toEqual({ kind: "none" });
    expect(classifyLink(FILE, null)).toEqual({ kind: "none" });
  });
});

describe("classifyImage", () => {
  it("shows only tree images with an inline image extension", () => {
    expect(classifyImage(FILE, "./shot.PNG")).toEqual({
      kind: "tree",
      path: "docs/guide/shot.PNG",
    });
    expect(classifyImage(FILE, "../logo.svg")).toEqual({ kind: "tree", path: "docs/logo.svg" });
  });

  it.each([
    "https://img.shields.io/badge.svg",
    "//cdn.example/x.png",
    "/api/repos/1/browse/raw?rev=x&path=a.png",
    "data:image/png;base64,AAAA",
    "notes.txt",
    "page.html",
    "noext",
    "../../../x.png",
    "",
    null,
  ])("blocks %j", (src) => {
    expect(classifyImage(FILE, src)).toEqual({ kind: "blocked" });
  });
});

describe("classifyLink with the app origin", () => {
  it("drops an absolute link to the app's own origin and keeps others", () => {
    const origin = "https://amber.test";
    expect(classifyLink(FILE, "https://amber.test/api/repos/1/export/tree.zip", origin)).toEqual({
      kind: "none",
    });
    expect(classifyLink(FILE, "HTTPS://AMBER.TEST:443/x", origin)).toEqual({ kind: "none" });
    expect(classifyLink(FILE, "http://amber.test/x", origin)).toEqual({
      kind: "external",
      href: "http://amber.test/x",
    });
    expect(classifyLink(FILE, "mailto:a@amber.test", origin)).toEqual({
      kind: "external",
      href: "mailto:a@amber.test",
    });
  });
});
