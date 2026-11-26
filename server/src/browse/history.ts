import {
  BROWSE_MAX_COMMIT_FILES,
  BROWSE_MAX_TEXT_BYTES,
  BROWSE_MAX_COMMIT_PATCH_BYTES,
  BROWSE_MAX_FILE_PATCH_BYTES,
  type BrowseCommitDetail,
  type BrowseCommits,
  type BrowseCommitSummary,
  type BrowseDiffFile,
  type BrowseDiffStatus,
} from "@amber/shared";
import { isOid, notFound, runGit, runGitOk, type GitCtx } from "./gitRun.ts";

/**
 * Commit history and one commit's diff.
 *
 * Everything git prints here is attacker controlled: names, messages, file
 * names, patch text. Fixed-shape fields (object ids, dates) are validated and
 * the free text is only ever decoded as text. File names come from NUL
 * delimited plumbing output, never from patch headers.
 */

/**
 * Fields are separated, and records ended, by NUL. A commit header cannot hold
 * one (git's own fsck rejects it) and the subject and body are read as C
 * strings, so no byte of attacker-controlled text can act as a delimiter. Every
 * record is read as exactly this many fields.
 */
const LOG_FIELDS = 9;
const DETAIL_FIELDS = 10;
const LOG_FORMAT = ["%H", "%P", "%at", "%ct", "%an", "%ae", "%cn", "%ce", "%s"].join("%x00");
const DETAIL_FORMAT = `${LOG_FORMAT}%x00%b`;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_PLUMBING_BYTES = 16 * 1024 * 1024;
/** Room for the file headers around the patch bodies, which the budget does not count. */
const PATCH_HEADER_ALLOWANCE = 512 * 1024;

interface ParsedCommit {
  summary: BrowseCommitSummary;
  body: string;
}

/** The range a JS Date can represent; also inside the safe-integer range. */
const MAX_DATE_MS = 8.64e15;

/**
 * Git accepts a commit time of any size. The client reads dates as safe
 * integers, so anything git printed is clamped into the range of a Date, and
 * anything that is not a number is 0.
 */
function epochMs(seconds: string | undefined): number {
  const value = Number.parseInt(seconds ?? "", 10);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value * 1000, -MAX_DATE_MS), MAX_DATE_MS);
}

function parseCommitFields(fields: readonly string[]): ParsedCommit | null {
  const [
    oid,
    parents,
    authored,
    committed,
    authorName,
    authorEmail,
    committerName,
    committerEmail,
  ] = fields;
  if (oid === undefined || !isOid(oid)) {
    return null;
  }
  const parentList = (parents ?? "").split(" ").filter((parent) => parent !== "");
  if (!parentList.every(isOid)) {
    return null;
  }
  return {
    summary: {
      oid,
      parents: parentList,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorDate: epochMs(authored),
      committerName: committerName ?? "",
      committerEmail: committerEmail ?? "",
      committerDate: epochMs(committed),
      subject: fields[8] ?? "",
    },
    body: (fields[9] ?? "").trim(),
  };
}

/** The `log -z` output as records of `count` NUL-terminated fields each. */
function parseCommitStream(raw: string, count: number): ParsedCommit[] {
  const tokens = raw.split("\0");
  const commits: ParsedCommit[] = [];
  for (let at = 0; at + count <= tokens.length; at += count) {
    const parsed = parseCommitFields(tokens.slice(at, at + count));
    if (parsed !== null) {
      commits.push(parsed);
    }
  }
  return commits;
}

/** `-- <path>` for a literal path filter, nothing for the whole history. */
function pathArgs(path: string): string[] {
  return path === "" ? [] : ["--", path];
}

/**
 * A page of history from `rev`, optionally only commits that touched `path`.
 *
 * Paging is by offset into one walk. A commit id always names the same walk, so
 * `--skip` is exact; restarting the walk at a cursor commit is not, because it
 * drops whatever was still queued on the other line of a merge. One extra row is
 * read: it is not returned, it only says there is a next page. Parents are the
 * rewritten ones (`--parents`), so under a path filter they are the parents in
 * the filtered history.
 */
export async function listCommits(
  ctx: GitCtx,
  rev: string,
  path: string,
  limit: number,
  skip: number,
): Promise<BrowseCommits> {
  const result = await runGitOk(
    ctx,
    [
      "log",
      "-z",
      "--parents",
      "--no-color",
      "--no-show-signature",
      `--format=${LOG_FORMAT}`,
      `--skip=${String(skip)}`,
      "-n",
      String(limit + 1),
      rev,
      ...pathArgs(path),
    ],
    { maxBytes: MAX_LOG_BYTES },
  );
  const rows = parseCommitStream(result.stdout.toString("utf8"), LOG_FIELDS).map(
    (commit) => commit.summary,
  );
  return { rows: rows.slice(0, limit), next: rows.length > limit ? skip + limit : null };
}

// ---------------------------------------------------------------------------
// One commit
// ---------------------------------------------------------------------------

export interface CommitLimits {
  maxFiles: number;
  maxFilePatchBytes: number;
  maxCommitPatchBytes: number;
}

export const DEFAULT_COMMIT_LIMITS: CommitLimits = {
  maxFiles: BROWSE_MAX_COMMIT_FILES,
  maxFilePatchBytes: BROWSE_MAX_FILE_PATCH_BYTES,
  maxCommitPatchBytes: BROWSE_MAX_COMMIT_PATCH_BYTES,
};

interface RawChange {
  status: BrowseDiffStatus;
  path: string;
  oldPath: string | null;
}

const STATUS_BY_LETTER: Record<string, BrowseDiffStatus> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

/** `--raw -z`: `:modes oids STATUS NUL path NUL`, with two paths for R and C. */
export function parseRawChanges(raw: string): RawChange[] {
  const records = raw.split("\0");
  const changes: RawChange[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index] as string;
    if (!record.startsWith(":")) {
      index += 1;
      continue;
    }
    const letter = (record.split(" ").pop() ?? "").charAt(0);
    const status = STATUS_BY_LETTER[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      const oldPath = records[index + 1];
      const path = records[index + 2];
      index += 3;
      if (oldPath !== undefined && path !== undefined && path !== "") {
        changes.push({ status, path, oldPath });
      }
    } else {
      const path = records[index + 1];
      index += 2;
      if (path !== undefined && path !== "") {
        changes.push({ status, path, oldPath: null });
      }
    }
  }
  return changes;
}

interface Counts {
  additions: number;
  deletions: number;
  binary: boolean;
}

const NUMSTAT = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

function changeKey(oldPath: string | null, path: string): string {
  return `${oldPath ?? ""}\0${path}`;
}

/** `--numstat -z`: `adds TAB dels TAB path NUL`, or an empty path then NUL old NUL new. */
export function parseNumstat(raw: string): Map<string, Counts> {
  const records = raw.split("\0");
  const counts = new Map<string, Counts>();
  let index = 0;
  while (index < records.length) {
    const match = NUMSTAT.exec(records[index] as string);
    if (match === null) {
      index += 1;
      continue;
    }
    const [, adds, dels, named] = match as unknown as [string, string, string, string];
    let oldPath: string | null = null;
    let path = named;
    if (named === "") {
      oldPath = records[index + 1] ?? "";
      path = records[index + 2] ?? "";
      index += 3;
    } else {
      index += 1;
    }
    const key = changeKey(oldPath, path);
    const binary = adds === "-" || dels === "-";
    const previous = counts.get(key);
    counts.set(key, {
      additions: (previous?.additions ?? 0) + (binary ? 0 : Number.parseInt(adds, 10)),
      deletions: (previous?.deletions ?? 0) + (binary ? 0 : Number.parseInt(dels, 10)),
      binary: (previous?.binary ?? false) || binary,
    });
  }
  return counts;
}

/** Offsets of every line that starts a file's section of the patch. */
function fileBoundaries(patch: Buffer): number[] {
  const marker = Buffer.from("diff --git ");
  const starts: number[] = [];
  let from = 0;
  while (from <= patch.length) {
    const at = patch.indexOf(marker, from);
    if (at < 0) {
      break;
    }
    if (at === 0 || patch[at - 1] === 0x0a) {
      starts.push(at);
    }
    from = at + 1;
  }
  return starts;
}

/** The per-file sections of a `-p` run, each cut down to start at its first hunk. */
export function splitPatch(patch: Buffer): (Buffer | null)[] {
  const starts = fileBoundaries(patch);
  return starts.map((start, index) => {
    const section = patch.subarray(start, starts[index + 1] ?? patch.length);
    const hunk = /(?:^|\n)@@ /.exec(section.toString("latin1"));
    if (hunk === null) {
      return null;
    }
    return section.subarray(hunk.index + (hunk[0].startsWith("\n") ? 1 : 0));
  });
}

/** Cut at the last whole line inside `limit` bytes. */
function cutAtLine(patch: Buffer, limit: number): Buffer {
  if (patch.length <= limit) {
    return patch;
  }
  const end = patch.subarray(0, limit).lastIndexOf(0x0a);
  return end < 0 ? Buffer.alloc(0) : patch.subarray(0, end + 1);
}

function decodePatch(patch: Buffer): string {
  return new TextDecoder("utf-8").decode(patch);
}

interface Parents {
  /** The commit's own first parent, ignoring a shallow graft. Null for a root commit. */
  first: string | null;
}

/**
 * Parents as the commit object records them. `git log` hides them at the edge
 * of a shallow clone, which would make that commit look like a root and its
 * whole tree look added.
 */
async function recordedParents(ctx: GitCtx, oid: string): Promise<Parents> {
  const result = await runGitOk(ctx, ["cat-file", "commit", oid], { maxBytes: 64 * 1024 });
  const header = result.stdout.toString("utf8").split("\n\n", 1)[0] ?? "";
  for (const line of header.split("\n")) {
    const match = /^parent ([0-9a-f]+)$/.exec(line);
    if (match !== null && isOid(match[1] as string)) {
      return { first: match[1] as string };
    }
  }
  return { first: null };
}

async function objectExists(ctx: GitCtx, oid: string): Promise<boolean> {
  const result = await runGit(ctx, ["cat-file", "-e", oid], { maxBytes: 256 });
  return result.code === 0;
}

/**
 * The empty tree of this repository's hash algorithm. Used as the attribute
 * source so a `.gitattributes` in the (hostile) repository cannot decide that
 * a file is binary or pick a diff driver.
 */
async function emptyTree(ctx: GitCtx): Promise<string | null> {
  const result = await runGit(ctx, ["hash-object", "-t", "tree", "--stdin"], { maxBytes: 256 });
  const oid = result.stdout.toString("utf8").trim();
  return result.code === 0 && isOid(oid) ? oid : null;
}

export async function readCommit(
  ctx: GitCtx,
  oid: string,
  limits: CommitLimits = DEFAULT_COMMIT_LIMITS,
): Promise<BrowseCommitDetail> {
  const meta = await runGitOk(
    ctx,
    ["log", "-1", "-z", "--no-color", "--no-show-signature", `--format=${DETAIL_FORMAT}`, oid],
    { maxBytes: 4 * 1024 * 1024 },
  );
  const parsed = parseCommitStream(meta.stdout.toString("utf8"), DETAIL_FIELDS)[0] ?? null;
  if (parsed === null) {
    throw notFound("No such commit in this backup.");
  }
  const detail = {
    ...parsed.summary,
    body: parsed.body,
    files: [] as BrowseDiffFile[],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    filesTruncated: false,
    missingParents: false,
  };

  const { first } = await recordedParents(ctx, oid);
  if (first !== null && !(await objectExists(ctx, first))) {
    return { ...detail, missingParents: true };
  }

  const attrSource = await emptyTree(ctx);
  const env: Record<string, string> = attrSource === null ? {} : { GIT_ATTR_SOURCE: attrSource };
  const target = first === null ? ["--root", oid] : [first, oid];
  const common = [
    // Past this size git treats a file as binary and never loads it to diff,
    // which bounds the memory one commit can cost.
    "-c",
    `core.bigFileThreshold=${String(BROWSE_MAX_TEXT_BYTES)}`,
    "diff-tree",
    "-r",
    "-M",
    "--no-commit-id",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ];

  const [rawRun, numstatRun, patchRun] = await Promise.all([
    runGitOk(ctx, [...common, "-z", "--raw", ...target], { maxBytes: MAX_PLUMBING_BYTES, env }),
    runGitOk(ctx, [...common, "-z", "--numstat", ...target], {
      maxBytes: MAX_PLUMBING_BYTES,
      env,
    }),
    runGitOk(ctx, [...common, "-p", ...target], {
      maxBytes: limits.maxCommitPatchBytes + PATCH_HEADER_ALLOWANCE,
      env,
    }),
  ]);

  const changes = parseRawChanges(rawRun.stdout.toString("utf8"));
  const counts = parseNumstat(numstatRun.stdout.toString("utf8"));

  let additions = 0;
  let deletions = 0;
  for (const value of counts.values()) {
    additions += value.additions;
    deletions += value.deletions;
  }

  // A type change prints as two sections (a delete and an add) of one path.
  const sections = splitPatch(patchRun.stdout);
  const expectedSections = changes.reduce(
    (total, change) => total + (change.status === "type_changed" ? 2 : 1),
    0,
  );
  const aligned = sections.length === expectedSections;
  if (!aligned && !patchRun.truncated) {
    ctx.log
      ?.child({ mod: "browse" })
      .warn({ sections: sections.length, expectedSections }, "patch sections do not match files");
  }

  let section = 0;
  let budget = limits.maxCommitPatchBytes;
  const files: BrowseDiffFile[] = [];
  for (const change of changes) {
    const take = change.status === "type_changed" ? 2 : 1;
    const own = sections.slice(section, section + take);
    const missing = own.length < take;
    section += take;
    if (files.length >= limits.maxFiles) {
      continue;
    }
    const count = counts.get(changeKey(change.oldPath, change.path));
    const binary = count?.binary ?? false;
    const pieces = own.filter((piece): piece is Buffer => piece !== null);
    let patch: string | null = null;
    let truncated = false;

    if (binary) {
      // Nothing to show; a patch section may exist but is only a notice.
    } else if (!aligned && !patchRun.truncated) {
      truncated = true;
    } else if (missing) {
      // The run was cut off before this file, so its patch was dropped.
      truncated = true;
    } else if (pieces.length > 0) {
      let whole = pieces.length === 1 ? (pieces[0] as Buffer) : Buffer.concat(pieces);
      if (patchRun.truncated && section === sections.length) {
        // The read cap ended inside this file; drop the line it may have split.
        whole = cutAtLine(whole, whole.length - 1);
        truncated = true;
      }
      const allowed = Math.min(limits.maxFilePatchBytes, budget);
      const cut = allowed > 0 ? cutAtLine(whole, allowed) : Buffer.alloc(0);
      truncated = truncated || cut.length < whole.length;
      if (cut.length > 0) {
        budget -= cut.length;
        patch = decodePatch(cut);
      }
    }

    files.push({
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      additions: binary ? null : (count?.additions ?? 0),
      deletions: binary ? null : (count?.deletions ?? 0),
      binary,
      patch,
      truncated,
    });
  }

  return {
    ...detail,
    files,
    filesChanged: changes.length,
    additions,
    deletions,
    filesTruncated: changes.length > limits.maxFiles || rawRun.truncated,
  };
}
