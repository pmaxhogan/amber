import type { BrowseRef, BrowseRefs, BrowseResolved, BrowseRefKind } from "@amber/shared";
import { isOid, peelToOid, runGit, runGitOk, type GitCtx } from "./gitRun.ts";

/**
 * Ref names are hostile input and are only ever read OUT of git here, then
 * compared to the caller's text as plain strings. No name from a request
 * becomes a git argument: `resolve` turns free text into an object id, and
 * every other endpoint takes that id.
 */

const FORMAT = "%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)";
/** A repository with this many refs is cut off rather than buffered whole. */
const MAX_REF_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Tags of tags are rare; past this many the rest are skipped. */
const MAX_NESTED_TAG_PEELS = 200;

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";

interface RawRef {
  /** Full ref name. */
  name: string;
  /** The commit the ref ends at. */
  oid: string;
}

/**
 * Read refs under fixed patterns. Peels annotated tags and drops everything
 * that does not end at a commit (a tag on a tree or blob, a dangling ref).
 */
async function readRefs(
  ctx: GitCtx,
  patterns: readonly string[],
  sorts: readonly string[],
): Promise<RawRef[]> {
  const result = await runGitOk(
    ctx,
    ["for-each-ref", `--format=${FORMAT}`, ...sorts.map((sort) => `--sort=${sort}`), ...patterns],
    { maxBytes: MAX_REF_OUTPUT_BYTES },
  );
  const refs: RawRef[] = [];
  const nested: { index: number; tagOid: string }[] = [];
  for (const line of result.stdout.toString("utf8").split("\n")) {
    if (line === "") {
      continue;
    }
    const [name, objectName, peeledName, type, peeledType] = line.split("\0");
    if (name === undefined || objectName === undefined || !isOid(objectName)) {
      continue;
    }
    if (type === "commit") {
      refs.push({ name, oid: objectName });
    } else if (type === "tag" && peeledType === "commit" && peeledName !== undefined) {
      if (isOid(peeledName)) {
        refs.push({ name, oid: peeledName });
      }
    } else if (type === "tag" && peeledType === "tag" && nested.length < MAX_NESTED_TAG_PEELS) {
      // `*` peels one level; a tag of a tag needs git to finish the job.
      nested.push({ index: refs.length, tagOid: objectName });
      refs.push({ name, oid: "" });
    }
  }
  if (nested.length === 0) {
    return refs;
  }
  for (const entry of nested) {
    const commit = await peelToOid(ctx, entry.tagOid, "commit");
    const ref = refs[entry.index];
    if (ref !== undefined && commit !== null) {
      ref.oid = commit;
    }
  }
  return refs.filter((ref) => ref.oid !== "");
}

export interface BranchesAndTags {
  branches: BrowseRef[];
  tags: BrowseRef[];
}

/**
 * Branches newest first, tags newest first. The name is the short name. The
 * secondary sort on the ref name keeps ties stable between requests.
 */
export async function readBranchesAndTags(ctx: GitCtx): Promise<BranchesAndTags> {
  const [heads, tags] = await Promise.all([
    readRefs(ctx, ["refs/heads"], ["refname", "-committerdate"]),
    readRefs(ctx, ["refs/tags"], ["refname", "-creatordate"]),
  ]);
  return {
    branches: heads
      .filter((ref) => ref.name.startsWith(HEADS))
      .map((ref) => ({ kind: "branch", name: ref.name.slice(HEADS.length), oid: ref.oid })),
    tags: tags
      .filter((ref) => ref.name.startsWith(TAGS))
      .map((ref) => ({ kind: "tag", name: ref.name.slice(TAGS.length), oid: ref.oid })),
  };
}

/**
 * Tip of the default branch when it exists, else what HEAD points at, else
 * nothing (an empty backup, or a HEAD on an unborn branch).
 */
export async function findHead(
  ctx: GitCtx,
  branches: readonly BrowseRef[],
  defaultBranch: string | null,
): Promise<BrowseResolved | null> {
  if (defaultBranch !== null && defaultBranch !== "") {
    const branch = branches.find((candidate) => candidate.name === defaultBranch);
    if (branch !== undefined) {
      return { oid: branch.oid, kind: "branch", name: branch.name };
    }
  }
  const symbolic = await runGit(ctx, ["symbolic-ref", "--quiet", "HEAD"], { maxBytes: 4096 });
  if (symbolic.code === 0) {
    const target = symbolic.stdout.toString("utf8").trim();
    if (target.startsWith(HEADS)) {
      const branch = branches.find((candidate) => candidate.name === target.slice(HEADS.length));
      if (branch !== undefined) {
        return { oid: branch.oid, kind: "branch", name: branch.name };
      }
    }
  }
  const detached = await peelToOid(ctx, "HEAD", "commit").catch(() => null);
  return detached === null ? null : { oid: detached, kind: "commit", name: null };
}

export async function isShallow(ctx: GitCtx): Promise<boolean> {
  const result = await runGit(ctx, ["rev-parse", "--is-shallow-repository"], { maxBytes: 64 });
  return result.code === 0 && result.stdout.toString("utf8").trim() === "true";
}

export interface RefsQuery {
  kind: BrowseRefKind;
  q?: string | undefined;
  limit: number;
}

export async function listRefs(
  ctx: GitCtx,
  query: RefsQuery,
  defaultBranch: string | null,
): Promise<BrowseRefs> {
  const [{ branches: found, tags }, shallow] = await Promise.all([
    readBranchesAndTags(ctx),
    isShallow(ctx),
  ]);

  // The default branch leads the branch list, whatever its date.
  const pinned = found.findIndex((branch) => branch.name === defaultBranch);
  const branches =
    pinned > 0
      ? [found[pinned] as BrowseRef, ...found.slice(0, pinned), ...found.slice(pinned + 1)]
      : found;

  const head = await findHead(ctx, branches, defaultBranch);
  const needle = query.q?.toLowerCase() ?? "";
  const matching = (query.kind === "branch" ? branches : tags).filter(
    (ref) => needle === "" || ref.name.toLowerCase().includes(needle),
  );
  return {
    head,
    branchCount: branches.length,
    tagCount: tags.length,
    rows: matching.slice(0, query.limit),
    truncated: matching.length > query.limit,
    shallow,
  };
}

const HEX_REV = /^[0-9a-fA-F]{4,64}$/;
const FULL_HEX_REV = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * Turn what a person typed into a commit. Order: HEAD, a full-length object id
 * that names a commit, a branch, a tag, a full ref name, then a short hex id.
 * Names are string compares against git's own listing; the only text that
 * reaches git is hex, and only after a pattern has matched it.
 */
export async function resolveRevision(
  ctx: GitCtx,
  text: string,
  defaultBranch: string | null,
): Promise<BrowseResolved | null> {
  const { branches, tags } = await readBranchesAndTags(ctx);

  if (text === "HEAD") {
    const head = await findHead(ctx, branches, defaultBranch);
    if (head !== null) {
      return head;
    }
  }
  // A full-length object id names that object, whatever a ref is called: a
  // branch named like another commit's sha must not take its place.
  if (FULL_HEX_REV.test(text)) {
    const hex = text.toLowerCase();
    if ((await peelToOid(ctx, hex, "commit")) === hex) {
      return { oid: hex, kind: "commit", name: null };
    }
  }
  const branch = branches.find((candidate) => candidate.name === text);
  if (branch !== undefined) {
    return { oid: branch.oid, kind: "branch", name: branch.name };
  }
  const tag = tags.find((candidate) => candidate.name === text);
  if (tag !== undefined) {
    return { oid: tag.oid, kind: "tag", name: tag.name };
  }

  if (text.startsWith("refs/")) {
    // Anything under refs/, including refs/amber/archive/... and refs/pull/...
    const all = await readRefs(ctx, [], ["refname"]);
    const ref = all.find((candidate) => candidate.name === text);
    if (ref !== undefined) {
      if (ref.name.startsWith(HEADS)) {
        return { oid: ref.oid, kind: "branch", name: ref.name.slice(HEADS.length) };
      }
      if (ref.name.startsWith(TAGS)) {
        return { oid: ref.oid, kind: "tag", name: ref.name.slice(TAGS.length) };
      }
      return { oid: ref.oid, kind: "commit", name: null };
    }
  }

  if (HEX_REV.test(text)) {
    const hex = text.toLowerCase();
    const oid = await peelToOid(ctx, hex, "commit");
    // git also resolves a short hex string as a ref name (refs/remotes/<hex>)
    // before it tries objects; the answer has to actually start with the hex.
    if (oid !== null && oid.startsWith(hex)) {
      return { oid, kind: "commit", name: null };
    }
  }
  return null;
}
