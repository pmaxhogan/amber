import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/api/client.ts";
import { mountBrowser, press } from "./helpers/browseMount.ts";
import { flush } from "./helpers/dom.ts";
import {
  HEAD_OID,
  makeBrowseApi,
  makeCommitDetail,
  makeDiffFile,
  makeEntry,
  makeRefs,
  makeSummary,
  makeTree,
  oid,
} from "./helpers/browseStubs.ts";

vi.mock("../src/components/MarkdownFrame.vue", async () => {
  const { MarkdownFrameStub: stub } = await import("./helpers/markdownFrameStub.ts");
  return { default: stub };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const COMMITS = [
  makeSummary({ oid: oid("1"), subject: "third" }),
  makeSummary({ oid: oid("2"), subject: "second", authorName: "Grace Hopper" }),
];

function subjects(wrapper: Awaited<ReturnType<typeof mountBrowser>>): string[] {
  return wrapper.findAll(".history-pane__subject").map((row) => row.text());
}

describe("history mode", () => {
  it("lists commits from the current revision", async () => {
    const api = makeBrowseApi({ commits: COMMITS });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");

    expect(vi.mocked(api.browseCommits).mock.calls[0]?.slice(0, 2)).toEqual([1, { rev: HEAD_OID }]);
    expect(subjects(wrapper)).toEqual(["third", "second"]);
    const first = wrapper.find(".history-pane__row");
    expect(first.text()).toContain("Ada Lovelace");
    expect(first.find(".history-pane__sha").text()).toBe("1111111");
    // Relative in the text, absolute in the tooltip.
    expect(first.find("[title]").attributes("title")).not.toBe("");
    expect(wrapper.find(".history-pane__chip").exists()).toBe(false);
  });

  it("pages on with the server's cursor", async () => {
    const browseCommits = vi
      .fn()
      .mockResolvedValueOnce({ rows: [COMMITS[0]], next: 1 })
      .mockResolvedValueOnce({ rows: [COMMITS[1]], next: null });
    const api = makeBrowseApi({}, { browseCommits });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    expect(subjects(wrapper)).toEqual(["third"]);

    await press(wrapper, "Load more");

    // The walk keeps starting at the same commit; only the offset moves.
    expect(browseCommits.mock.calls[0]?.[1]).toEqual({ rev: HEAD_OID });
    expect(browseCommits.mock.calls[1]?.[1]).toEqual({ rev: HEAD_OID, skip: 1 });
    expect(subjects(wrapper)).toEqual(["third", "second"]);
    expect(wrapper.text()).not.toContain("Load more");
  });

  it("keeps the path filter and the start commit while paging", async () => {
    const browseCommits = vi
      .fn()
      .mockResolvedValueOnce({ rows: [COMMITS[0]], next: 1 })
      .mockResolvedValueOnce({ rows: [COMMITS[1]], next: 2 })
      .mockResolvedValueOnce({ rows: [], next: null });
    const api = makeBrowseApi(
      {
        contents: {
          "": makeTree([makeEntry({ name: "docs", type: "tree", size: null })]),
          docs: makeTree([], { path: "docs" }),
        },
      },
      { browseCommits },
    );
    const wrapper = await mountBrowser(api);
    await press(wrapper, "docs");
    await press(wrapper, "History");
    await press(wrapper, "Load more");
    await press(wrapper, "Load more");

    expect(browseCommits.mock.calls.map((call) => call[1])).toEqual([
      { rev: HEAD_OID, path: "docs" },
      { rev: HEAD_OID, path: "docs", skip: 1 },
      { rev: HEAD_OID, path: "docs", skip: 2 },
    ]);
    expect(subjects(wrapper)).toEqual(["third", "second"]);
    expect(wrapper.text()).not.toContain("Load more");
  });

  it("filters to a path, shows a chip, and clears it", async () => {
    const api = makeBrowseApi({
      commits: COMMITS,
      contents: { "": makeTree([makeEntry({ name: "docs", type: "tree", size: null })]) },
    });
    const wrapper = await mountBrowser(api);

    // From a directory: the directory view's own History button.
    vi.mocked(api.browseContents).mockImplementation((async (
      _id: number,
      _rev: string,
      path = "",
    ) =>
      path === "docs"
        ? makeTree([], { path: "docs" })
        : makeTree([makeEntry({ name: "docs", type: "tree", size: null })])) as never);
    await press(wrapper, "docs");
    await press(wrapper, "History");

    expect(vi.mocked(api.browseCommits).mock.calls.at(-1)?.[1]).toEqual({
      rev: HEAD_OID,
      path: "docs",
    });
    expect(wrapper.find(".history-pane__chip").text()).toContain("History of docs");

    await wrapper.find(".history-pane__clear").trigger("click");
    await flush();

    expect(vi.mocked(api.browseCommits).mock.calls.at(-1)?.[1]).toEqual({ rev: HEAD_OID });
    expect(wrapper.find(".history-pane__chip").exists()).toBe(false);
  });

  it("carries the path filter along when the Files / History switch is used inside a directory", async () => {
    const api = makeBrowseApi({
      commits: COMMITS,
      contents: {
        "": makeTree([makeEntry({ name: "docs", type: "tree", size: null })]),
        docs: makeTree([], { path: "docs" }),
      },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "docs");
    const toolbar = wrapper.find(".repo-browser__bar");
    await toolbar
      .findAll("button")
      .find((b) => b.text() === "History")
      ?.trigger("click");
    await flush();
    expect(wrapper.find(".history-pane__chip").text()).toContain("docs");
  });

  it("says when nothing touched the path", async () => {
    const api = makeBrowseApi({ commits: [] });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    expect(wrapper.text()).toContain("No commits");
  });

  it("notes that a shallow backup's history stops early", async () => {
    const api = makeBrowseApi({ refs: makeRefs({ shallow: true }), commits: COMMITS });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    expect(wrapper.text()).toContain("This is a shallow backup, so history stops early.");
  });

  it("does not mention shallowness for a full backup", async () => {
    const api = makeBrowseApi({ commits: COMMITS });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    expect(wrapper.text()).not.toContain("shallow");
  });

  it("shows a failure with a retry", async () => {
    const browseCommits = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("boom", "History broke", 500))
      .mockResolvedValue({ rows: COMMITS, next: null });
    const wrapper = await mountBrowser(makeBrowseApi({}, { browseCommits }));
    await press(wrapper, "History");
    expect(wrapper.find("[role=alert]").text()).toContain("History broke");
    await press(wrapper, "Try again");
    expect(subjects(wrapper)).toEqual(["third", "second"]);
  });

  it("opens a commit from its subject", async () => {
    const api = makeBrowseApi({
      commits: COMMITS,
      commitDetails: { [oid("1")]: makeCommitDetail({ oid: oid("1"), subject: "third" }) },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    await press(wrapper, "third");
    expect(vi.mocked(api.browseCommit).mock.calls[0]?.[1]).toBe(oid("1"));
    expect(wrapper.find(".commit-view__subject").text()).toBe("third");
  });

  it("browses files at a commit chosen from the history", async () => {
    const api = makeBrowseApi({
      commits: COMMITS,
      contents: { "": makeTree([makeEntry({ name: "old.txt" })]) },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Browse files")
      ?.trigger("click");
    await flush();

    expect(vi.mocked(api.browseContents).mock.calls.at(-1)?.slice(0, 3)).toEqual([1, oid("1"), ""]);
    expect(wrapper.find("button.ref-picker__button").text()).toBe("1111111");
    expect(wrapper.find(".file-list").exists()).toBe(true);
  });
});

describe("commit view", () => {
  async function openCommit(detail = makeCommitDetail(), extra: Record<string, unknown> = {}) {
    const api = makeBrowseApi(
      {
        commits: [makeSummary({ oid: detail.oid, subject: "the commit" })],
        commitDetails: { [detail.oid]: detail },
      },
      extra,
    );
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    await press(wrapper, "the commit");
    return { wrapper, api };
  }

  it("shows the message, people, full sha and totals", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({
        subject: "the commit",
        body: "Why it changed.\n\nSecond paragraph.",
        committerName: "Grace Hopper",
        committerEmail: "grace@example.com",
        filesChanged: 3,
        additions: 10,
        deletions: 2,
        parents: [oid("e"), oid("f")],
      }),
    );
    const text = wrapper.find(".commit-view").text();
    expect(text).toContain("the commit");
    expect(wrapper.find(".commit-view__body").text()).toBe("Why it changed.\n\nSecond paragraph.");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("<ada@example.com>");
    expect(text).toContain("Grace Hopper");
    expect(text).toContain(oid("d"));
    expect(text).toContain("3 files changed, +10 -2");
    expect(wrapper.findAll(".commit-view__parent").map((p) => p.text())).toEqual([
      "eeeeeee",
      "fffffff",
    ]);
  });

  it("follows a parent link to that commit", async () => {
    const parent = makeCommitDetail({ oid: oid("e"), subject: "the parent", parents: [] });
    const child = makeCommitDetail({ oid: oid("d"), subject: "the commit", parents: [oid("e")] });
    const api = makeBrowseApi({
      commits: [makeSummary({ oid: oid("d"), subject: "the commit" })],
      commitDetails: { [oid("d")]: child, [oid("e")]: parent },
    });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    await press(wrapper, "the commit");

    await wrapper.find(".commit-view__parent").trigger("click");
    await flush();

    expect(wrapper.find(".commit-view__subject").text()).toBe("the parent");
    expect(wrapper.text()).toContain("none (root commit)");
  });

  it("goes back to the history", async () => {
    const { wrapper } = await openCommit();
    await press(wrapper, "Back to history");
    expect(wrapper.find(".history-pane").exists()).toBe(true);
  });

  it("switches the browser to the commit from its own page", async () => {
    const { wrapper, api } = await openCommit();
    await press(wrapper, "Browse files at this commit");
    expect(vi.mocked(api.browseContents).mock.calls.at(-1)?.[1]).toBe(oid("d"));
    expect(wrapper.find("button.ref-picker__button").text()).toBe("ddddddd");
  });

  it("labels every status and shows a rename as old -> new", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({
        subject: "the commit",
        files: [
          makeDiffFile({ path: "a.ts", status: "added", additions: 3, deletions: 0 }),
          makeDiffFile({ path: "b.ts", status: "deleted", additions: 0, deletions: 4 }),
          makeDiffFile({ path: "c.ts", status: "modified" }),
          makeDiffFile({
            path: "new/name.ts",
            oldPath: "old/name.ts",
            status: "renamed",
            patch: null,
            additions: 0,
            deletions: 0,
          }),
          makeDiffFile({ path: "d.ts", oldPath: "src/d.ts", status: "copied" }),
          makeDiffFile({ path: "e.ts", status: "type_changed" }),
        ],
        filesChanged: 6,
      }),
    );
    const heads = wrapper.findAll(".diff-file__head").map((head) => head.text());
    expect(heads[0]).toContain("added");
    expect(heads[0]).toContain("+3");
    expect(heads[1]).toContain("deleted");
    expect(heads[1]).toContain("-4");
    expect(heads[2]).toContain("modified");
    expect(heads[3]).toContain("renamed");
    expect(heads[3]).toContain("old/name.ts -> new/name.ts");
    expect(heads[4]).toContain("copied");
    expect(heads[4]).toContain("src/d.ts -> d.ts");
    expect(heads[5]).toContain("type changed");
    expect(wrapper.text()).toContain("No textual changes");
  });

  it("colors lines by their first character with numbers from the hunk headers", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({
        subject: "the commit",
        files: [
          makeDiffFile({
            patch: "@@ -4,3 +4,3 @@ fn\n same\n-before\n+after\n tail\n",
          }),
        ],
      }),
    );
    const lines = wrapper.findAll(".diff-line");
    expect(lines.map((line) => line.classes().find((c) => c !== "diff-line"))).toEqual([
      "diff-line--hunk",
      "diff-line--context",
      "diff-line--del",
      "diff-line--add",
      "diff-line--context",
    ]);
    const numbers = lines.map((line) => line.findAll(".diff-line__no").map((cell) => cell.text()));
    expect(numbers).toEqual([
      ["", ""],
      ["4", "4"],
      ["5", ""],
      ["", "5"],
      ["6", "6"],
    ]);
    expect(lines[2]?.find(".diff-line__text").text()).toBe("-before");
  });

  it("notes a binary file and a patch cut for size", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({
        subject: "the commit",
        files: [
          makeDiffFile({
            path: "img.png",
            binary: true,
            patch: null,
            additions: null,
            deletions: null,
          }),
          makeDiffFile({ path: "huge.txt", patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: true }),
          makeDiffFile({ path: "gone.txt", patch: null, truncated: true }),
        ],
        filesChanged: 3,
      }),
    );
    const files = wrapper.findAll(".diff-file");
    expect(files[0]?.text()).toContain("Binary file, or too large to diff.");
    expect(files[0]?.text()).toContain("binary");
    expect(files[1]?.text()).toContain("This diff was cut for size.");
    expect(files[1]?.findAll(".diff-line")).toHaveLength(3);
    expect(files[2]?.text()).toContain("so none of it is shown");
  });

  it("says how many files are listed when there are more", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({ subject: "the commit", filesChanged: 5000, filesTruncated: true }),
    );
    expect(wrapper.text()).toContain("Showing 1 of 5000 files.");
  });

  it("explains a commit at the edge of a shallow backup", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({ subject: "the commit", missingParents: true, files: [], filesChanged: 0 }),
    );
    expect(wrapper.text()).toContain(
      "This commit is the edge of a shallow backup, so there is nothing earlier to compare it with.",
    );
  });

  it("collapses a very long patch behind a button", async () => {
    const body = Array.from({ length: 2500 }, (_, i) => `+line ${i}`).join("\n");
    const { wrapper } = await openCommit(
      makeCommitDetail({
        subject: "the commit",
        files: [
          makeDiffFile({ patch: `@@ -0,0 +1,2500 @@\n${body}\n`, additions: 2500, deletions: 0 }),
        ],
      }),
    );
    expect(wrapper.findAll(".diff-line")).toHaveLength(0);
    expect(wrapper.find(".diff-file__collapsed").text()).toContain("2501 lines");

    await press(wrapper, "Show diff");

    expect(wrapper.findAll(".diff-line")).toHaveLength(2501);
    expect(wrapper.find(".diff-file__collapsed").exists()).toBe(false);
  });

  function addedPatch(lines: number): string {
    const body = Array.from({ length: lines - 1 }, (_, i) => `+line ${i}`).join("\n");
    return `@@ -0,0 +1,${lines - 1} @@\n${body}\n`;
  }

  it("bounds the rows of a commit with many mid-sized files", async () => {
    const patch = addedPatch(1999);
    const files = Array.from({ length: 600 }, (_, i) =>
      makeDiffFile({ path: `f${i}.txt`, status: "added", patch, additions: 1998, deletions: 0 }),
    );
    const { wrapper } = await openCommit(
      makeCommitDetail({ subject: "the commit", files, filesChanged: 600 }),
    );

    // Two files fit the 5000 row budget; the other 598 wait behind a button.
    expect(wrapper.findAll(".diff-line")).toHaveLength(2 * 1999);
    expect(wrapper.findAll(".diff-file__collapsed")).toHaveLength(598);
    expect(wrapper.text()).toContain("598 files collapsed for size");
  });

  it("expands just one collapsed file on its button", async () => {
    const patch = addedPatch(1999);
    const files = Array.from({ length: 4 }, (_, i) =>
      makeDiffFile({ path: `f${i}.txt`, status: "added", patch, additions: 1998, deletions: 0 }),
    );
    const { wrapper } = await openCommit(
      makeCommitDetail({ subject: "the commit", files, filesChanged: 4 }),
    );
    expect(wrapper.findAll(".diff-line")).toHaveLength(2 * 1999);

    await wrapper.findAll(".diff-file")[3]?.find(".diff-file__collapsed button").trigger("click");
    await flush();

    expect(wrapper.findAll(".diff-line")).toHaveLength(3 * 1999);
    expect(wrapper.findAll(".diff-file")[3]?.findAll(".diff-line")).toHaveLength(1999);
    expect(wrapper.findAll(".diff-file")[2]?.findAll(".diff-line")).toHaveLength(0);
    expect(wrapper.text()).toContain("2 files collapsed for size");
  });

  it("shows only the first rows of a very long patch until asked for the rest", async () => {
    const { wrapper } = await openCommit(
      makeCommitDetail({
        subject: "the commit",
        files: [makeDiffFile({ patch: addedPatch(12_000), additions: 11_999, deletions: 0 })],
      }),
    );
    await press(wrapper, "Show diff");
    expect(wrapper.findAll(".diff-line")).toHaveLength(5000);
    expect(wrapper.text()).toContain("Show the rest (7000 more lines)");

    await press(wrapper, "Show the rest (7000 more lines)");

    expect(wrapper.findAll(".diff-line")).toHaveLength(12_000);
    expect(wrapper.text()).not.toContain("Show the rest");
  });

  it("does not show the size note for an ordinary commit", async () => {
    const { wrapper } = await openCommit(makeCommitDetail({ subject: "the commit" }));
    expect(wrapper.text()).not.toContain("collapsed for size");
  });

  it("does not collapse an ordinary patch", async () => {
    const { wrapper } = await openCommit(makeCommitDetail({ subject: "the commit" }));
    expect(wrapper.text()).not.toContain("Show diff");
    expect(wrapper.findAll(".diff-line").length).toBeGreaterThan(0);
  });

  it("shows a failure for a commit the backup does not hold", async () => {
    const api = makeBrowseApi({ commits: [makeSummary({ oid: oid("9"), subject: "ghost" })] });
    const wrapper = await mountBrowser(api);
    await press(wrapper, "History");
    await press(wrapper, "ghost");
    expect(wrapper.find("[role=alert]").exists()).toBe(true);
  });
});
