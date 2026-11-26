import { z } from "zod";

/**
 * The read-only repository browser: `GET /api/repos/:id/browse/*`.
 *
 * Two rules shape every endpoint here.
 *
 * 1. Free text is resolved exactly once. `resolve` turns whatever a person
 *    typed (a branch, a tag, a short or full sha) into a commit object id, and
 *    `refs` hands out the object id next to every name. Every other endpoint
 *    takes `rev` and accepts NOTHING but a full hex commit id, so a ref name
 *    never reaches git as an argument.
 * 2. Everything in a response that came out of the repository (names, paths,
 *    messages, file text, patch text) is hostile input to the web app. It is
 *    data to print as text, never markup.
 */

/** A full object id: sha1 (40 hex) or sha256 (64 hex). Lower case only. */
export const BROWSE_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const browseOidSchema = z.string().regex(BROWSE_OID_PATTERN);

/** Longest free-text revision `resolve` will look at. */
export const BROWSE_MAX_REV_CHARS = 255;
/** Longest path inside a tree. */
export const BROWSE_MAX_PATH_CHARS = 4096;
/** Text files larger than this are not sent as text; the viewer offers the download. */
export const BROWSE_MAX_TEXT_BYTES = 1024 * 1024;
/** Directory entries past this are dropped and `truncated` is set. */
export const BROWSE_MAX_TREE_ENTRIES = 5000;
/** Largest patch sent for one file of a commit. */
export const BROWSE_MAX_FILE_PATCH_BYTES = 256 * 1024;
/** Largest patch sent for one commit, all files together. */
export const BROWSE_MAX_COMMIT_PATCH_BYTES = 2 * 1024 * 1024;
/** Files listed for one commit; the rest are counted, not listed. */
export const BROWSE_MAX_COMMIT_FILES = 1000;
export const BROWSE_DEFAULT_REF_LIMIT = 200;
export const BROWSE_MAX_REF_LIMIT = 1000;
export const BROWSE_DEFAULT_COMMIT_LIMIT = 30;
export const BROWSE_MAX_COMMIT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export const browseRefKindSchema = z.enum(["branch", "tag"]);
export type BrowseRefKind = z.infer<typeof browseRefKindSchema>;

export const browseRefSchema = z.object({
  kind: browseRefKindSchema,
  /** Short name: `main`, `v1.2.3`, `dependabot/npm/@types/node-1.2.3`. */
  name: z.string().min(1),
  /** The commit it points at. An annotated tag is peeled to its commit. */
  oid: browseOidSchema,
});
export type BrowseRef = z.infer<typeof browseRefSchema>;

/** What `resolve` matched, and what a fresh browser opens on. */
export const browseResolvedSchema = z.object({
  oid: browseOidSchema,
  /** `commit` when the text was an object id rather than a ref name. */
  kind: z.enum(["branch", "tag", "commit"]),
  /** The matched ref's short name; null for `commit`. */
  name: z.string().nullable(),
});
export type BrowseResolved = z.infer<typeof browseResolvedSchema>;

export const browseRefsQuerySchema = z.object({
  kind: browseRefKindSchema.default("branch"),
  /** Case-insensitive substring of the short name. */
  q: z.string().trim().max(BROWSE_MAX_REV_CHARS).optional(),
  limit: z.coerce.number().int().min(1).max(BROWSE_MAX_REF_LIMIT).default(BROWSE_DEFAULT_REF_LIMIT),
});
export type BrowseRefsQuery = z.infer<typeof browseRefsQuerySchema>;

/**
 * `GET /api/repos/:id/browse/refs`
 *
 * `rows` are the refs of the asked `kind` that match `q`, newest first with
 * the default branch pinned on top, capped at `limit`. The counts are of the
 * whole backup, before `q` and `limit`, so the picker can tell "one branch in
 * total" from "one branch matches what you typed".
 */
export const browseRefsSchema = z.object({
  /** Tip of the default branch, else HEAD. Null when the backup has no commits. */
  head: browseResolvedSchema.nullable(),
  branchCount: z.number().int().nonnegative(),
  tagCount: z.number().int().nonnegative(),
  rows: z.array(browseRefSchema),
  /** More refs matched than `limit` allowed. */
  truncated: z.boolean(),
  /** The backup is a shallow clone, so history stops early. */
  shallow: z.boolean(),
});
export type BrowseRefs = z.infer<typeof browseRefsSchema>;

/** `GET /api/repos/:id/browse/resolve?rev=<free text>` answers BrowseResolved, or 404. */
export const browseResolveQuerySchema = z.object({
  rev: z.string().trim().min(1).max(BROWSE_MAX_REV_CHARS),
});

// ---------------------------------------------------------------------------
// Contents: one path at one commit, a directory or a file
// ---------------------------------------------------------------------------

/** Every endpoint below takes the commit as `rev`: a full object id, nothing else. */
export const browseContentsQuerySchema = z.object({
  rev: browseOidSchema,
  /** Empty or absent for the root directory. No leading slash. */
  path: z.string().max(BROWSE_MAX_PATH_CHARS).default(""),
});
export type BrowseContentsQuery = z.infer<typeof browseContentsQuerySchema>;

export const browseEntryTypeSchema = z.enum(["tree", "blob", "symlink", "submodule"]);
export type BrowseEntryType = z.infer<typeof browseEntryTypeSchema>;

export const browseEntrySchema = z.object({
  /** Last path segment. */
  name: z.string().min(1),
  /** Full path from the root of the tree. */
  path: z.string().min(1),
  type: browseEntryTypeSchema,
  mode: z.string(),
  oid: z.string().min(1),
  /** Bytes for a blob or symlink; null for a directory or submodule. */
  size: z.number().int().nonnegative().nullable(),
});
export type BrowseEntry = z.infer<typeof browseEntrySchema>;

export const browseTreeSchema = z.object({
  type: z.literal("tree"),
  commit: browseOidSchema,
  /** Empty string for the root. */
  path: z.string(),
  /** Directories first, then files, each group sorted by name. */
  entries: z.array(browseEntrySchema),
  truncated: z.boolean(),
});
export type BrowseTree = z.infer<typeof browseTreeSchema>;

/**
 * How the viewer should show a file.
 *
 * - `text`: `text` holds it (unless it was too large).
 * - `markdown`: a `.md` or `.markdown` text file; `text` holds the source.
 * - `image`: something the `raw` endpoint will serve inline. `text` holds the
 *   source for an SVG and is null for a raster image.
 * - `binary`: not valid UTF-8 text and not a supported image. Download only.
 */
export const browseBlobViewSchema = z.enum(["text", "markdown", "image", "binary"]);
export type BrowseBlobView = z.infer<typeof browseBlobViewSchema>;

export const browseBlobSchema = z.object({
  type: z.literal("blob"),
  commit: browseOidSchema,
  path: z.string().min(1),
  name: z.string().min(1),
  oid: z.string().min(1),
  mode: z.string(),
  size: z.number().int().nonnegative(),
  view: browseBlobViewSchema,
  /** UTF-8 text. Null for binary and raster files, and when `tooLarge`. */
  text: z.string().nullable(),
  /** A text file over BROWSE_MAX_TEXT_BYTES: `text` is null, offer the download. */
  tooLarge: z.boolean(),
  /** Mode 120000: `text` is the link target, not file contents. */
  symlink: z.boolean(),
  /** The blob is a Git LFS pointer; the real bytes are not in the tree. */
  lfsPointer: z.boolean(),
});
export type BrowseBlob = z.infer<typeof browseBlobSchema>;

/**
 * `GET /api/repos/:id/browse/contents?rev=&path=`
 *
 * A submodule entry has nothing to show: asking for its path is a 404.
 */
export const browseContentsSchema = z.discriminatedUnion("type", [
  browseTreeSchema,
  browseBlobSchema,
]);
export type BrowseContents = z.infer<typeof browseContentsSchema>;

/**
 * `GET /api/repos/:id/browse/raw?rev=&path=&inline=1` streams the bytes.
 *
 * Always an attachment with `application/octet-stream`, except that
 * `inline=1` on one of BROWSE_INLINE_IMAGE_TYPES answers with that image type
 * so an `<img>` can show it. Every response carries `nosniff` and a
 * `sandbox` Content-Security-Policy, so a file opened in its own tab can
 * never run script against the app's origin.
 */
export const browseRawQuerySchema = z.object({
  rev: browseOidSchema,
  path: z.string().min(1).max(BROWSE_MAX_PATH_CHARS),
  inline: z.enum(["1"]).optional(),
});

/** File extension (lower case, no dot) to the type `raw?inline=1` answers with. */
export const BROWSE_INLINE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** The inline image type for a path, by extension. Null: not shown as an image. */
export function browseInlineImageType(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return BROWSE_INLINE_IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Whether a path is shown through the markdown renderer. */
export function isBrowseMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const browseCommitSummarySchema = z.object({
  oid: browseOidSchema,
  parents: z.array(browseOidSchema),
  authorName: z.string(),
  authorEmail: z.string(),
  /** Epoch ms. */
  authorDate: z.number().int(),
  committerName: z.string(),
  committerEmail: z.string(),
  /** Epoch ms. */
  committerDate: z.number().int(),
  /** First line of the message. */
  subject: z.string(),
});
export type BrowseCommitSummary = z.infer<typeof browseCommitSummarySchema>;

/** Deepest offset the history will page to. */
export const BROWSE_MAX_COMMIT_SKIP = 1_000_000;

export const browseCommitsQuerySchema = z.object({
  /** Where the walk starts. The same for every page of one history. */
  rev: browseOidSchema,
  /** Only commits that touched this file or directory. */
  path: z.string().max(BROWSE_MAX_PATH_CHARS).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BROWSE_MAX_COMMIT_LIMIT)
    .default(BROWSE_DEFAULT_COMMIT_LIMIT),
  /** How many commits of the walk to pass over: the previous answer's `next`. */
  skip: z.coerce.number().int().min(0).max(BROWSE_MAX_COMMIT_SKIP).default(0),
});
export type BrowseCommitsQuery = z.infer<typeof browseCommitsQuerySchema>;

/**
 * `GET /api/repos/:id/browse/commits?rev=&path=&limit=&skip=`
 *
 * Pages by offset into one walk rather than by restarting the walk at a
 * cursor commit. A commit id never changes what it names, so the walk from
 * `rev` is the same every time and an offset into it is exact. Restarting at
 * the last commit of a page is not: across a merge it drops whatever was
 * still queued on the other line.
 *
 * `rows` never holds more than `limit` commits and never repeats one. Under a
 * `path` filter `parents` are the parents in the filtered history, not the
 * commit's real ones.
 */
export const browseCommitsSchema = z.object({
  rows: z.array(browseCommitSummarySchema),
  /** The `skip` of the next page; null at the end of the history. */
  next: z.number().int().positive().nullable(),
});
export type BrowseCommits = z.infer<typeof browseCommitsSchema>;

export const browseDiffStatusSchema = z.enum([
  "added",
  "deleted",
  "modified",
  "renamed",
  "copied",
  "type_changed",
]);
export type BrowseDiffStatus = z.infer<typeof browseDiffStatusSchema>;

export const browseDiffFileSchema = z.object({
  path: z.string().min(1),
  /** The previous path of a renamed or copied file. */
  oldPath: z.string().nullable(),
  status: browseDiffStatusSchema,
  /** Null for a binary file. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  /**
   * Unified diff hunks for this file, from its first `@@` line on. Null for a
   * binary file, for a change with no content difference (a pure rename or a
   * mode change), and when the patch was dropped for size.
   */
  patch: z.string().nullable(),
  /** The patch was cut or dropped for size. */
  truncated: z.boolean(),
});
export type BrowseDiffFile = z.infer<typeof browseDiffFileSchema>;

export const browseCommitQuerySchema = z.object({ rev: browseOidSchema });

/**
 * `GET /api/repos/:id/browse/commit?rev=`
 *
 * The diff is against the first parent (a merge shows what it brought in), and
 * a root commit shows everything as added.
 */
export const browseCommitDetailSchema = browseCommitSummarySchema.extend({
  /** The message after the subject line, trimmed. May be empty. */
  body: z.string(),
  files: z.array(browseDiffFileSchema),
  /** Files changed in total, which can exceed `files.length`. */
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** More files changed than were listed. */
  filesTruncated: z.boolean(),
  /**
   * The commit has parents the backup does not hold (the edge of a shallow
   * clone). Nothing to diff against, so `files` is empty rather than showing
   * the whole tree as added.
   */
  missingParents: z.boolean(),
});
export type BrowseCommitDetail = z.infer<typeof browseCommitDetailSchema>;
