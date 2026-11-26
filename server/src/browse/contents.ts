import {
  BROWSE_MAX_PATH_CHARS,
  BROWSE_MAX_TEXT_BYTES,
  BROWSE_MAX_TREE_ENTRIES,
  browseInlineImageType,
  isBrowseMarkdownPath,
  type BrowseBlob,
  type BrowseContents,
  type BrowseEntry,
  type BrowseEntryType,
  type BrowseTree,
} from "@amber/shared";
import { HEAD_READ_BYTES, looksBinary, matchInlineImage, readBlob } from "./blobKind.ts";
import { BrowseError, notFound, runGitOk, type GitCtx } from "./gitRun.ts";

/**
 * Directory listings and file metadata at one commit.
 *
 * A path from the request is a literal pathspec after `--` (GIT_LITERAL_PATHSPECS
 * is set for every browse git call) and only ever selects an entry; the entry
 * is accepted on exact string equality with what `ls-tree -z` printed, and
 * its bytes are then read by object id. The filesystem is never consulted.
 */

/** A listing past this many bytes is cut; about a quarter of a million entries. */
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
/** A symlink target longer than any path is not a path. */
const MAX_SYMLINK_BYTES = BROWSE_MAX_PATH_CHARS + 1;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const LFS_POINTER_MAX_BYTES = 1024;

export interface LsEntry {
  mode: string;
  type: BrowseEntryType;
  oid: string;
  size: number | null;
  /** Path from the root of the tree, or from the listed directory for a child listing. */
  path: string;
}

/**
 * Paths Amber will look up. Never a filesystem path, so the only things refused
 * are the shapes that cannot name a tree entry: absolute, empty or dot
 * segments, NUL, and over-long. A leading `-` or `:` is fine; the pathspec is
 * literal and follows `--`.
 */
export function isBrowsePath(path: string): boolean {
  if (path === "" || path.length > BROWSE_MAX_PATH_CHARS) {
    return false;
  }
  if (path.startsWith("/") || path.includes("\0")) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * The tree path a request named: "" for the root, one trailing slash allowed
 * and dropped. Null when it cannot be a path at all.
 */
export function normalizeBrowsePath(raw: string): string | null {
  if (raw === "") {
    return "";
  }
  const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return isBrowsePath(trimmed) ? trimmed : null;
}

export function badPath(): BrowseError {
  return new BrowseError(400, "bad_request", "Invalid path");
}

function entryType(mode: string, gitType: string): BrowseEntryType {
  if (mode === "040000" || gitType === "tree") {
    return "tree";
  }
  if (mode === "160000" || gitType === "commit") {
    return "submodule";
  }
  if (mode === "120000") {
    return "symlink";
  }
  return "blob";
}

const LS_RECORD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(-|\d+)\t([\s\S]*)$/;

export function parseListing(raw: Buffer, prefix: string): LsEntry[] {
  const entries: LsEntry[] = [];
  for (const record of raw.toString("utf8").split("\0")) {
    const match = LS_RECORD.exec(record);
    if (match === null) {
      continue;
    }
    const [, mode, gitType, oid, size, name] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (name === "") {
      continue;
    }
    entries.push({
      mode,
      type: entryType(mode, gitType),
      oid,
      size: size === "-" ? null : Number.parseInt(size, 10),
      path: prefix === "" ? name : `${prefix}/${name}`,
    });
  }
  return entries;
}

/** Plain code point order, which is also UTF-8 byte order. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a.codePointAt(i) as number;
    const right = b.codePointAt(j) as number;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
    i += left > 0xffff ? 2 : 1;
    j += right > 0xffff ? 2 : 1;
  }
  if (i < a.length) {
    return 1;
  }
  return j < b.length ? -1 : 0;
}

/** The entry at exactly `path` in a commit, or null. */
export async function findEntry(
  ctx: GitCtx,
  commit: string,
  path: string,
): Promise<LsEntry | null> {
  const result = await runGitOk(
    ctx,
    ["ls-tree", "-z", "--long", "--full-tree", commit, "--", path],
    { maxBytes: 1024 * 1024 },
  );
  return parseListing(result.stdout, "").find((entry) => entry.path === path) ?? null;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function toBrowseEntry(entry: LsEntry): BrowseEntry {
  return {
    name: lastSegment(entry.path),
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    oid: entry.oid,
    size: entry.type === "blob" || entry.type === "symlink" ? entry.size : null,
  };
}

async function listDirectory(
  ctx: GitCtx,
  commit: string,
  treeSpec: string,
  path: string,
): Promise<BrowseTree> {
  const result = await runGitOk(ctx, ["ls-tree", "-z", "--long", treeSpec], {
    maxBytes: MAX_LISTING_BYTES,
  });
  const entries = parseListing(result.stdout, path).map(toBrowseEntry);
  entries.sort((a, b) => {
    const aDir = a.type === "tree" ? 0 : 1;
    const bDir = b.type === "tree" ? 0 : 1;
    return aDir !== bDir ? aDir - bDir : compareCodePoints(a.name, b.name);
  });
  return {
    type: "tree",
    commit,
    path,
    entries: entries.slice(0, BROWSE_MAX_TREE_ENTRIES),
    truncated: result.truncated || entries.length > BROWSE_MAX_TREE_ENTRIES,
  };
}

async function describeBlob(
  ctx: GitCtx,
  commit: string,
  path: string,
  entry: LsEntry,
): Promise<BrowseBlob> {
  const size = entry.size ?? 0;
  const base = {
    type: "blob" as const,
    commit,
    path,
    name: lastSegment(path),
    oid: entry.oid,
    mode: entry.mode,
    size,
    tooLarge: false,
    symlink: false,
    lfsPointer: false,
  };

  if (entry.type === "symlink") {
    const { bytes } = await readBlob(ctx, entry.oid, MAX_SYMLINK_BYTES);
    return { ...base, view: "text", text: bytes.toString("utf8"), symlink: true };
  }

  // A raster image is judged by its first bytes whatever its size; an
  // extension that lies falls through to the text and binary checks below.
  const imageType = browseInlineImageType(path);
  if (imageType !== null && imageType !== "image/svg+xml") {
    const { bytes } = await readBlob(ctx, entry.oid, 32);
    if (matchInlineImage(path, bytes, false) !== null) {
      return { ...base, view: "image", text: null };
    }
  }

  const markdown = isBrowseMarkdownPath(path);

  if (size > BROWSE_MAX_TEXT_BYTES) {
    // Never read the whole thing: the head is enough to tell text from binary.
    const { bytes } = await readBlob(ctx, entry.oid, HEAD_READ_BYTES);
    if (looksBinary(bytes, true)) {
      return { ...base, view: "binary", text: null };
    }
    return { ...base, view: markdown ? "markdown" : "text", text: null, tooLarge: true };
  }

  const { bytes, truncated } = await readBlob(ctx, entry.oid, BROWSE_MAX_TEXT_BYTES);
  if (looksBinary(bytes, truncated)) {
    return { ...base, view: "binary", text: null };
  }
  const text = bytes.toString("utf8");
  if (imageType === "image/svg+xml" && matchInlineImage(path, bytes, !truncated) !== null) {
    return { ...base, view: "image", text };
  }
  const lfsPointer = size < LFS_POINTER_MAX_BYTES && text.startsWith(LFS_POINTER_PREFIX);
  return { ...base, view: markdown ? "markdown" : "text", text, lfsPointer };
}

/**
 * One path at one commit: a directory listing, or a file's metadata and, for
 * text, its contents. `commit` has already been confirmed to be a commit.
 */
export async function readContents(
  ctx: GitCtx,
  commit: string,
  path: string,
): Promise<BrowseContents> {
  if (path === "") {
    return await listDirectory(ctx, commit, commit, "");
  }
  const entry = await findEntry(ctx, commit, path);
  if (entry === null || entry.type === "submodule") {
    throw notFound("No such file or directory at that commit.");
  }
  if (entry.type === "tree") {
    return await listDirectory(ctx, commit, entry.oid, path);
  }
  return await describeBlob(ctx, commit, path, entry);
}
