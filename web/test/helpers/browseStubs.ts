import { vi } from "vitest";
import type {
  BrowseBlob,
  BrowseCommitDetail,
  BrowseCommitSummary,
  BrowseContents,
  BrowseDiffFile,
  BrowseEntry,
  BrowseRefs,
  BrowseTree,
} from "@amber/shared";
import { ApiClientError, type ApiClient } from "../../src/api/client.ts";
import { stubApi } from "./stubApi.ts";

/** A full sha1 made of one repeated hex digit, so fixtures are easy to read in failures. */
export function oid(digit: string): string {
  return digit.repeat(40);
}

export const HEAD_OID = oid("a");

export function notFound(message = "Not found"): ApiClientError {
  return new ApiClientError("not_found", message, 404);
}

export function makeRefs(overrides: Partial<BrowseRefs> = {}): BrowseRefs {
  return {
    head: { oid: HEAD_OID, kind: "branch", name: "main" },
    branchCount: 3,
    tagCount: 2,
    rows: [
      { kind: "branch", name: "main", oid: HEAD_OID },
      { kind: "branch", name: "dev", oid: oid("b") },
      { kind: "branch", name: "release/1.x", oid: oid("c") },
    ],
    truncated: false,
    shallow: false,
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<BrowseEntry> & { name: string }): BrowseEntry {
  const base: BrowseEntry = {
    name: overrides.name,
    path: overrides.path ?? overrides.name,
    type: "blob",
    mode: "100644",
    oid: oid("1"),
    size: 120,
  };
  return { ...base, ...overrides };
}

export function makeTree(entries: BrowseEntry[], overrides: Partial<BrowseTree> = {}): BrowseTree {
  return { type: "tree", commit: HEAD_OID, path: "", entries, truncated: false, ...overrides };
}

export function makeBlob(overrides: Partial<BrowseBlob> = {}): BrowseBlob {
  const path = overrides.path ?? "src/index.ts";
  return {
    type: "blob",
    commit: HEAD_OID,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    oid: oid("2"),
    mode: "100644",
    size: 42,
    view: "text",
    text: "const a = 1;\nconst b = 2;\n",
    tooLarge: false,
    symlink: false,
    lfsPointer: false,
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<BrowseCommitSummary> = {}): BrowseCommitSummary {
  return {
    oid: oid("d"),
    parents: [oid("e")],
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    authorDate: 1_700_000_000_000,
    committerName: "Ada Lovelace",
    committerEmail: "ada@example.com",
    committerDate: 1_700_000_000_000,
    subject: "fix: handle empty input",
    ...overrides,
  };
}

export function makeDiffFile(overrides: Partial<BrowseDiffFile> = {}): BrowseDiffFile {
  return {
    path: "src/index.ts",
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: "@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n",
    truncated: false,
    ...overrides,
  };
}

export function makeCommitDetail(overrides: Partial<BrowseCommitDetail> = {}): BrowseCommitDetail {
  return {
    ...makeSummary(),
    body: "Longer explanation\nover two lines.",
    files: [makeDiffFile()],
    filesChanged: 1,
    additions: 1,
    deletions: 1,
    filesTruncated: false,
    missingParents: false,
    ...overrides,
  };
}

/** What a stubbed repository holds, keyed by the `path` the contents endpoint is asked for. */
export interface BrowseFixture {
  refs?: BrowseRefs;
  contents?: Record<string, BrowseContents>;
  commits?: BrowseCommitSummary[];
  commitDetails?: Record<string, BrowseCommitDetail>;
}

/**
 * A stubbed ApiClient with the browse methods answering from a fixture.
 * Unknown paths and commits answer 404, like the server.
 */
export function makeBrowseApi(
  fixture: BrowseFixture = {},
  overrides: Record<string, unknown> = {},
): ApiClient {
  const refs = fixture.refs ?? makeRefs();
  const contents = fixture.contents ?? { "": makeTree([makeEntry({ name: "a.txt" })]) };
  return stubApi({
    browseRefs: vi.fn().mockResolvedValue(refs),
    browseResolve: vi.fn(async (_repoId: number, rev: string) => {
      const hit = refs.rows.find((row) => row.name === rev);
      if (hit === undefined) throw notFound();
      return { oid: hit.oid, kind: hit.kind, name: hit.name };
    }),
    browseContents: vi.fn(async (_repoId: number, _rev: string, path = "") => {
      const hit = contents[path];
      if (hit === undefined) throw notFound();
      return hit;
    }),
    browseCommits: vi.fn().mockResolvedValue({ rows: fixture.commits ?? [], next: null }),
    browseCommit: vi.fn(async (_repoId: number, rev: string) => {
      const hit = fixture.commitDetails?.[rev];
      if (hit === undefined) throw notFound();
      return hit;
    }),
    browseRawUrl: vi.fn(
      (repoId: number, rev: string, path: string, inline = false) =>
        `/api/repos/${repoId}/browse/raw?rev=${rev}&path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`,
    ),
    downloadExport: vi.fn().mockResolvedValue(new Blob(["zip"])),
    ...overrides,
  } as never);
}
