/**
 * Turns one file's unified-diff hunks (as sent by the browse API, starting at
 * the first `@@` line) into display rows with old and new line numbers.
 *
 * The text is hostile: nothing here interprets it beyond its first character
 * and the hunk header numbers, and every row keeps the original text to be
 * printed as plain text.
 */

export type DiffLineKind = "hunk" | "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** The whole line, including its leading `+`, `-` or space. */
  text: string;
  /** Line number in the old file; null for added lines, headers and notes. */
  oldNo: number | null;
  /** Line number in the new file; null for removed lines, headers and notes. */
  newNo: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Number of lines in a patch, without building rows for them. */
export function countPatchLines(patch: string): number {
  if (patch === "") return 0;
  let lines = 0;
  let from = 0;
  for (;;) {
    const next = patch.indexOf("\n", from);
    if (next === -1) {
      return from < patch.length ? lines + 1 : lines;
    }
    lines += 1;
    from = next + 1;
  }
}

export function parsePatch(patch: string): DiffLine[] {
  if (patch === "") return [];
  const raw = patch.split("\n");
  // A patch ends with a newline, which would otherwise read as one more
  // (empty) context line.
  if (raw[raw.length - 1] === "") raw.pop();

  const rows: DiffLine[] = [];
  let oldNo: number | null = null;
  let newNo: number | null = null;

  for (const line of raw) {
    if (line.startsWith("@@")) {
      const header = HUNK_HEADER.exec(line);
      oldNo = header === null ? null : Number(header[1]);
      newNo = header === null ? null : Number(header[2]);
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line, oldNo: null, newNo });
      if (newNo !== null) newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line, oldNo, newNo: null });
      if (oldNo !== null) oldNo += 1;
      continue;
    }
    rows.push({ kind: "context", text: line, oldNo, newNo });
    if (oldNo !== null) oldNo += 1;
    if (newNo !== null) newNo += 1;
  }
  return rows;
}

/** A single patch longer than this many lines starts collapsed. */
export const DIFF_COLLAPSE_LINES = 2000;
/** Rows a whole commit renders up front, all files together. */
export const DIFF_ROW_BUDGET = 5000;
/** Rows of one expanded file shown before "Show the rest". */
export const DIFF_MAX_FILE_ROWS = 5000;

/**
 * Which files of a commit start collapsed. The per-file rule alone does not
 * bound the page (hundreds of files just under the limit still paint a few
 * hundred thousand rows), so files are opened in order while a shared row
 * budget lasts; the first one that does not fit, and every file after it,
 * waits behind its button. A file over the per-file limit never spends budget.
 */
export function planCollapsed(lineCounts: readonly number[]): boolean[] {
  let used = 0;
  let exhausted = false;
  return lineCounts.map((lines) => {
    if (lines > DIFF_COLLAPSE_LINES || exhausted) return true;
    if (used + lines > DIFF_ROW_BUDGET) {
      exhausted = true;
      return true;
    }
    used += lines;
    return false;
  });
}
