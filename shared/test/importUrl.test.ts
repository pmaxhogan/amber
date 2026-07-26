import { describe, expect, it } from "vitest";
import {
  parseImportLine,
  parseImportText,
  summarizeImport,
  withWarning,
  type ImportLineResult,
  type ParsedRepoUrl,
} from "../src/importUrl.ts";

function parsedOf(line: string): ParsedRepoUrl {
  const result = parseImportLine(line);
  expect(result, `expected ${line} to produce a result`).not.toBeNull();
  const nonNull = result as ImportLineResult;
  expect(nonNull.status, `expected ${line} to parse, got: ${nonNull.message ?? ""}`).toBe("ok");
  expect(nonNull.parsed).toBeDefined();
  return nonNull.parsed as ParsedRepoUrl;
}

function errorOf(line: string): string {
  const result = parseImportLine(line);
  expect(result, `expected ${line} to produce a result`).not.toBeNull();
  const nonNull = result as ImportLineResult;
  expect(nonNull.status, `expected ${line} to be rejected`).toBe("error");
  return nonNull.message ?? "";
}

describe("parseImportLine - ignorable lines", () => {
  it("returns null for blank lines and whitespace", () => {
    expect(parseImportLine("")).toBeNull();
    expect(parseImportLine("   ")).toBeNull();
    expect(parseImportLine("\t")).toBeNull();
  });

  it("returns null for comment lines", () => {
    expect(parseImportLine("# a comment")).toBeNull();
    expect(parseImportLine("   # indented comment")).toBeNull();
  });
});

describe("parseImportLine - full URLs", () => {
  it("parses a plain https URL", () => {
    expect(parsedOf("https://github.com/nodejs/node")).toEqual({
      protocol: "https",
      host: "github.com",
      port: null,
      path: "nodejs/node",
      username: null,
      displayName: "node",
      canonicalUrl: "https://github.com/nodejs/node",
    });
  });

  it("parses an http URL with a port and strips .git", () => {
    expect(parsedOf("http://host:8080/x/y.git")).toEqual({
      protocol: "http",
      host: "host",
      port: 8080,
      path: "x/y",
      username: null,
      displayName: "y",
      canonicalUrl: "http://host:8080/x/y",
    });
  });

  it("keeps a deep path intact (kernel.org)", () => {
    const parsed = parsedOf("https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git");
    expect(parsed.host).toBe("git.kernel.org");
    expect(parsed.path).toBe("pub/scm/linux/kernel/git/torvalds/linux");
    expect(parsed.displayName).toBe("linux");
    expect(parsed.port).toBeNull();
  });

  it("lowercases the scheme and host", () => {
    const parsed = parsedOf("HTTPS://GitHub.COM/NodeJS/Node");
    expect(parsed.protocol).toBe("https");
    expect(parsed.host).toBe("github.com");
    // The path is case sensitive on the forge, so it is preserved verbatim.
    expect(parsed.path).toBe("NodeJS/Node");
  });

  it("normalizes default ports away", () => {
    expect(parsedOf("https://github.com:443/a/b").port).toBeNull();
    expect(parsedOf("http://github.com:80/a/b").port).toBeNull();
    expect(parsedOf("https://github.com:8443/a/b").port).toBe(8443);
  });

  it("drops query strings and fragments", () => {
    expect(parsedOf("https://github.com/a/b?tab=readme").path).toBe("a/b");
    expect(parsedOf("https://github.com/a/b#readme").path).toBe("a/b");
  });

  it("ignores a trailing comment after a URL", () => {
    expect(parsedOf("https://github.com/a/b # my fork").path).toBe("a/b");
  });

  it("collapses repeated and trailing slashes", () => {
    expect(parsedOf("https://github.com//a//b//").path).toBe("a/b");
  });
});

describe("parseImportLine - proto-less lines", () => {
  it("assumes https and the default port", () => {
    expect(parsedOf("github.com/nodejs/node/")).toEqual({
      protocol: "https",
      host: "github.com",
      port: null,
      path: "nodejs/node",
      username: null,
      displayName: "node",
      canonicalUrl: "https://github.com/nodejs/node",
    });
  });

  it("accepts a port on a proto-less line", () => {
    const parsed = parsedOf("gitea.example.com:3000/team/project.git");
    expect(parsed.protocol).toBe("https");
    expect(parsed.port).toBe(3000);
    expect(parsed.path).toBe("team/project");
  });

  it("accepts localhost", () => {
    expect(parsedOf("localhost:8080/a/b").host).toBe("localhost");
  });
});

describe("parseImportLine - user@ prefixes", () => {
  it("parses a proto-less user prefix", () => {
    const parsed = parsedOf("pmaxhogan@github.com/pmaxhogan/mkvid");
    expect(parsed.username).toBe("pmaxhogan");
    expect(parsed.host).toBe("github.com");
    expect(parsed.path).toBe("pmaxhogan/mkvid");
    // The canonical URL never carries credentials.
    expect(parsed.canonicalUrl).toBe("https://github.com/pmaxhogan/mkvid");
  });

  it("parses a user prefix inside a full URL", () => {
    const parsed = parsedOf("https://b@github.com/d/e");
    expect(parsed.username).toBe("b");
    expect(parsed.path).toBe("d/e");
  });

  it("parses a user prefix with a port", () => {
    const parsed = parsedOf("https://bob@gitea.example.com:3000/team/project");
    expect(parsed.username).toBe("bob");
    expect(parsed.port).toBe(3000);
  });

  it("treats git@host/path (slash, no colon) as a user prefix, not scp syntax", () => {
    const parsed = parsedOf("git@github.com/foo/bar");
    expect(parsed.username).toBe("git");
    expect(parsed.host).toBe("github.com");
    expect(parsed.path).toBe("foo/bar");
  });

  it("rejects a password in the URL", () => {
    expect(errorOf("https://bob:hunter2@github.com/a/b")).toMatch(/Passwords in URLs/);
  });

  it("rejects an empty username", () => {
    expect(errorOf("@github.com/a/b")).toMatch(/Empty username/);
  });
});

describe("parseImportLine - rejected remotes", () => {
  it("rejects ssh:// URLs", () => {
    expect(errorOf("ssh://git@github.com/nodejs/node.git")).toBe(
      "SSH remotes are not supported yet",
    );
  });

  it("rejects scp syntax", () => {
    expect(errorOf("git@github.com:nodejs/node.git")).toBe("SSH remotes are not supported yet");
    expect(errorOf("git@github.com:nodejs/node")).toBe("SSH remotes are not supported yet");
    expect(errorOf("github.com:nodejs/node")).toBe("SSH remotes are not supported yet");
  });

  it("rejects git:// URLs", () => {
    expect(errorOf("git://github.com/a/b")).toMatch(/git:\/\/ remotes are not supported/);
  });

  it("rejects other protocols", () => {
    expect(errorOf("ftp://example.com/a/b")).toMatch(/Unsupported protocol "ftp"/);
    expect(errorOf("file:///srv/git/a")).toMatch(/Unsupported protocol "file"/);
  });
});

describe("parseImportLine - malformed lines", () => {
  it("rejects a host with no path", () => {
    expect(errorOf("https://github.com")).toMatch(/Missing repository path/);
    expect(errorOf("github.com/")).toMatch(/Missing repository path/);
  });

  it("rejects an out of range port", () => {
    expect(errorOf("https://github.com:99999/a/b")).toMatch(/out of range/);
  });

  it("rejects an invalid host", () => {
    expect(errorOf("https://not a host/a/b")).toMatch(/whitespace|Invalid host/);
    expect(errorOf("https://-bad-.com/a/b")).toMatch(/Invalid host/);
  });

  it("rejects relative path segments", () => {
    expect(errorOf("https://github.com/a/../b")).toMatch(/Relative path segments/);
    expect(errorOf("https://github.com/a/./b")).toMatch(/Relative path segments/);
  });

  it("rejects a bare .git path", () => {
    expect(errorOf("https://github.com/.git")).toMatch(/Missing repository path|Relative path/);
  });
});

describe("parseImportLine - IPv6", () => {
  it("parses a bracketed IPv6 host with a port", () => {
    const parsed = parsedOf("http://[::1]:3000/a/b.git");
    expect(parsed.host).toBe("::1");
    expect(parsed.port).toBe(3000);
    expect(parsed.canonicalUrl).toBe("http://[::1]:3000/a/b");
  });

  it("rejects an unterminated IPv6 literal", () => {
    expect(errorOf("http://[::1/a/b")).toMatch(/Unterminated IPv6/);
  });
});

describe("parseImportText", () => {
  it("numbers lines from the original text and skips blanks and comments", () => {
    const results = parseImportText(
      ["# forges", "", "https://github.com/a/b", "git://bad/x/y", "  ", "github.com/c/d"].join(
        "\n",
      ),
    );
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.lineNumber)).toEqual([3, 4, 6]);
    expect(results.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
  });

  it("handles CRLF input", () => {
    const results = parseImportText("https://github.com/a/b\r\nhttps://github.com/c/d\r\n");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("distinguishes same path on different forges", () => {
    const [a, b] = parseImportText("https://github.com/a/b\nhttps://gitlab.com/a/b");
    expect(a?.parsed?.host).toBe("github.com");
    expect(b?.parsed?.host).toBe("gitlab.com");
    expect(a?.parsed?.path).toBe(b?.parsed?.path);
  });
});

describe("withWarning and summarizeImport", () => {
  it("downgrades ok to warning but leaves errors alone", () => {
    const ok = parseImportLine("https://github.com/a/b") as ImportLineResult;
    const warned = withWarning(ok, "No account named bob on this forge");
    expect(warned.status).toBe("warning");
    expect(warned.message).toBe("No account named bob on this forge");
    expect(warned.parsed).toEqual(ok.parsed);

    const bad = parseImportLine("git://github.com/a/b") as ImportLineResult;
    expect(withWarning(bad, "ignored")).toBe(bad);
  });

  it("counts each status", () => {
    const results = parseImportText("https://github.com/a/b\ngit://x/y/z");
    const withOneWarning = [withWarning(results[0] as ImportLineResult, "w"), results[1]];
    expect(summarizeImport(withOneWarning as ImportLineResult[])).toEqual({
      total: 2,
      ok: 0,
      warning: 1,
      error: 1,
    });
  });
});
