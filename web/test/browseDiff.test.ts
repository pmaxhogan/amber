import { describe, expect, it } from "vitest";
import {
  DIFF_COLLAPSE_LINES,
  DIFF_ROW_BUDGET,
  countPatchLines,
  parsePatch,
  planCollapsed,
} from "../src/lib/diff.ts";

describe("parsePatch", () => {
  it("numbers old and new lines from the hunk header", () => {
    const rows = parsePatch("@@ -10,3 +20,4 @@ fn()\n keep\n-gone\n+new one\n+new two\n tail\n");
    expect(rows.map((row) => [row.kind, row.oldNo, row.newNo])).toEqual([
      ["hunk", null, null],
      ["context", 10, 20],
      ["del", 11, null],
      ["add", null, 21],
      ["add", null, 22],
      ["context", 12, 23],
    ]);
  });

  it("keeps the leading character in the text", () => {
    const rows = parsePatch("@@ -1 +1 @@\n-a\n+b\n");
    expect(rows.map((row) => row.text)).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
  });

  it("restarts the numbers at every hunk", () => {
    const rows = parsePatch("@@ -1,1 +1,1 @@\n a\n@@ -50,1 +60,1 @@\n b\n");
    expect(rows[1]).toMatchObject({ kind: "context", oldNo: 1, newNo: 1 });
    expect(rows[3]).toMatchObject({ kind: "context", oldNo: 50, newNo: 60 });
  });

  it("treats a header without counts as a one line hunk", () => {
    const rows = parsePatch("@@ -7 +9 @@\n+x\n");
    expect(rows[1]).toMatchObject({ kind: "add", newNo: 9 });
  });

  it("gives no numbers to the no-newline note and does not advance past it", () => {
    const rows = parsePatch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    expect(rows[2]).toMatchObject({ kind: "meta", oldNo: null, newNo: null });
    expect(rows[3]).toMatchObject({ kind: "add", newNo: 1 });
  });

  it("reads an empty line inside a hunk as context", () => {
    const rows = parsePatch("@@ -1,2 +1,2 @@\n\n x\n");
    expect(rows[1]).toMatchObject({ kind: "context", text: "", oldNo: 1, newNo: 1 });
    expect(rows[2]).toMatchObject({ kind: "context", oldNo: 2, newNo: 2 });
  });

  it("does not invent numbers for a malformed header", () => {
    const rows = parsePatch("@@ nonsense @@\n+x\n y\n");
    expect(rows[0]?.kind).toBe("hunk");
    expect(rows[1]).toMatchObject({ kind: "add", newNo: null });
    expect(rows[2]).toMatchObject({ kind: "context", oldNo: null, newNo: null });
  });

  it("classifies hostile text by its first character only", () => {
    const rows = parsePatch("@@ -1 +1 @@\n+<script>alert(1)</script>\n-<img src=x onerror=1>\n");
    expect(rows[1]).toMatchObject({ kind: "add", text: "+<script>alert(1)</script>" });
    expect(rows[2]).toMatchObject({ kind: "del", text: "-<img src=x onerror=1>" });
  });

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });

  it("does not turn the final newline into a row", () => {
    expect(parsePatch("@@ -1 +1 @@\n+a\n")).toHaveLength(2);
    expect(parsePatch("@@ -1 +1 @@\n+a")).toHaveLength(2);
  });
});

describe("countPatchLines", () => {
  it("counts the rows parsePatch would build", () => {
    for (const patch of ["", "a", "a\n", "a\nb", "a\nb\n", "\n", "\n\n"]) {
      expect(countPatchLines(patch)).toBe(
        patch === ""
          ? 0
          : patch.endsWith("\n")
            ? patch.split("\n").length - 1
            : patch.split("\n").length,
      );
    }
  });
});

describe("planCollapsed", () => {
  it("opens files in order while the shared budget lasts", () => {
    expect(planCollapsed([1999, 1999, 1999, 10])).toEqual([false, false, true, true]);
  });

  it("collapses a file over the per-file limit without spending budget", () => {
    expect(planCollapsed([DIFF_COLLAPSE_LINES + 1, 100, 100])).toEqual([true, false, false]);
  });

  it("lets a commit that fits open everything", () => {
    expect(planCollapsed([0, 1999, 1999, DIFF_ROW_BUDGET - 3998])).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(planCollapsed([])).toEqual([]);
  });

  it("does not reopen a small file after the budget has run out", () => {
    expect(planCollapsed([1999, 1999, 1500, 1])).toEqual([false, false, true, true]);
  });
});
