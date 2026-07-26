import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { ExportFormat } from "@amber/shared";
import { TarArchive, ZipArchive } from "archiver";
import { runGitOk, spawnGit } from "../gitSpawn.ts";

/**
 * Export paths. Everything here reads: it runs git plumbing against a backup
 * directory and streams bytes out. No user supplied string ever becomes a
 * filesystem path or a git flag:
 *
 * - a ref is shape checked, then resolved to a commit object id, and only the
 *   object id is passed to later commands;
 * - a file path is matched against the tree listing and then read by object id,
 *   so the filesystem is never consulted for it;
 * - the repository directory always comes from the database row.
 */

export interface TreeEntry {
  path: string;
  mode: string;
  size: number;
  oid: string;
}

export class ExportError extends Error {
  override readonly name = "ExportError";
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface ArchiveHandle {
  stream: Readable;
  contentType: string;
  /** Idempotent. Safe to call from a route's abort handler and again on end. */
  cleanup: () => Promise<void>;
}

export const ARCHIVE_EXTENSIONS: Record<ExportFormat, string> = {
  zip: "zip",
  "tar.gz": "tar.gz",
  "7z": "7z",
};

export const ARCHIVE_CONTENT_TYPES: Record<ExportFormat, string> = {
  zip: "application/zip",
  "tar.gz": "application/gzip",
  "7z": "application/x-7z-compressed",
};

/**
 * Ref names Amber will look up. Deliberately narrower than git's own rules: no
 * leading dash (which would be read as a flag), no "..", no whitespace, no
 * shell or pathspec metacharacters.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function isPlausibleRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.includes("..") && !ref.endsWith("/");
}

export interface ResolvedRef {
  /** Commit object id. Everything downstream uses this, not the input. */
  oid: string;
  /** What the caller asked for, for the download filename. */
  label: string;
}

/**
 * Resolve a caller supplied ref (or the repo default branch, or HEAD) to a
 * commit object id.
 */
export async function resolveRef(
  repoDir: string,
  ref: string | undefined,
  defaultBranch: string | null,
): Promise<ResolvedRef> {
  const candidates: string[] = [];
  if (ref !== undefined && ref !== "") {
    if (!isPlausibleRef(ref)) {
      throw new ExportError(`Invalid ref: ${JSON.stringify(ref)}`, 400);
    }
    candidates.push(ref);
  } else {
    if (defaultBranch !== null && defaultBranch !== "" && isPlausibleRef(defaultBranch)) {
      candidates.push(defaultBranch);
    }
    candidates.push("HEAD");
  }

  for (const candidate of candidates) {
    const result = await runGitOk(
      [
        "-C",
        repoDir,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${candidate}^{commit}`,
      ],
      { maxBufferBytes: 4096 },
    ).catch(() => null);
    const oid = result?.stdout.toString("utf8").trim() ?? "";
    if (/^[0-9a-f]{40,64}$/.test(oid)) {
      return { oid, label: candidate };
    }
  }

  throw new ExportError(
    ref === undefined || ref === ""
      ? "This backup has no commits yet."
      : `Unknown ref: ${JSON.stringify(ref)}`,
    404,
  );
}

/**
 * Paged manifest backing the File System Access API folder download.
 *
 * -z keeps paths raw: without it git C-quotes anything with a space or a non
 * ASCII byte, and the blob endpoint's exact match would then never find them.
 */
export async function listTree(repoDir: string, commitOid: string): Promise<TreeEntry[]> {
  const result = await runGitOk([
    "-C",
    repoDir,
    "ls-tree",
    "-r",
    "--long",
    "-z",
    "--full-tree",
    commitOid,
  ]);
  return parseLsTree(result.stdout.toString("utf8"));
}

export function parseLsTree(raw: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (record === "") {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const meta = record.slice(0, tab).split(/\s+/).filter(Boolean);
    const [mode, type, oid, size] = meta;
    if (mode === undefined || type === undefined || oid === undefined) {
      continue;
    }
    if (type !== "blob") {
      // Submodule entries (type commit) have no bytes to serve.
      continue;
    }
    entries.push({
      path: record.slice(tab + 1),
      mode,
      oid,
      size: Number.parseInt(size ?? "0", 10) || 0,
    });
  }
  return entries;
}

/**
 * Paths Amber will look up inside a tree. Rejects absolute paths, traversal,
 * pathspec magic (a leading colon) and anything that would read as a flag.
 */
export function isSafeTreePath(path: string): boolean {
  if (path === "" || path.length > 4096) {
    return false;
  }
  if (path.startsWith("/") || path.startsWith("-") || path.startsWith(":")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) {
    return false;
  }
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return false;
  }
  return !path.split("/").some((segment) => segment === ".." || segment === ".");
}

/**
 * Look a single path up in the tree. The pathspec is only a filter: the entry
 * that comes back is compared for exact equality, so a glob cannot widen it.
 */
export async function findTreeEntry(
  repoDir: string,
  commitOid: string,
  path: string,
): Promise<TreeEntry | null> {
  if (!isSafeTreePath(path)) {
    return null;
  }
  const result = await runGitOk([
    "-C",
    repoDir,
    "ls-tree",
    "-r",
    "--long",
    "-z",
    "--full-tree",
    commitOid,
    "--",
    path,
  ]);
  const entries = parseLsTree(result.stdout.toString("utf8"));
  return entries.find((entry) => entry.path === path) ?? null;
}

/**
 * One blob, streamed. Reached only through an object id that came out of the
 * tree listing, so the caller's string never addresses anything by itself.
 */
export function streamBlob(repoDir: string, oid: string): Readable {
  if (!/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new ExportError("Invalid object id", 400);
  }
  const child = spawnGit(["-C", repoDir, "cat-file", "blob", oid]);
  const out = new PassThrough();
  child.stdout.pipe(out);
  child.on("error", (error: Error) => out.destroy(error));
  child.stderr.resume();
  return out;
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | null = null;
  return () => {
    promise ??= fn();
    return promise;
  };
}

const noCleanup = async (): Promise<void> => undefined;

/** The source tree at a commit, as zip / tar.gz / 7z. */
export async function streamSourceArchive(
  repoDir: string,
  commitOid: string,
  format: ExportFormat,
  prefix: string,
): Promise<ArchiveHandle> {
  const contentType = ARCHIVE_CONTENT_TYPES[format];

  if (format === "zip" || format === "tar.gz") {
    // git archive writes both formats natively; gzip is a zlib stream on top.
    const gitFormat = format === "zip" ? "zip" : "tar";
    const child = spawnGit([
      "-C",
      repoDir,
      "archive",
      `--format=${gitFormat}`,
      `--prefix=${prefix}/`,
      commitOid,
    ]);
    const out = new PassThrough();
    child.on("error", (error: Error) => out.destroy(error));
    child.stderr.resume();
    if (format === "zip") {
      child.stdout.pipe(out);
    } else {
      const gzip = createGzip();
      gzip.on("error", (error: Error) => out.destroy(error));
      child.stdout.pipe(gzip).pipe(out);
    }
    return {
      stream: out,
      contentType,
      cleanup: once(async () => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }),
    };
  }

  const sevenZip = await findSevenZip();
  if (sevenZip === null) {
    throw new ExportError("7z export is unavailable: no 7z binary on PATH.", 501);
  }

  const work = await mkdtemp(join(tmpdir(), "amber-export-"));
  const cleanup = once(async () => {
    await rm(work, { recursive: true, force: true });
  });
  try {
    const tarPath = join(work, "source.tar");
    // -o writes the tar to disk rather than stdout, which keeps the two step
    // 7z pipeline free of shell plumbing.
    await runGitOk([
      "-C",
      repoDir,
      "archive",
      `--format=tar`,
      `--prefix=${prefix}/`,
      "-o",
      tarPath,
      commitOid,
    ]);
    const extractDir = join(work, "x");
    await runProcessOk(sevenZip, ["x", tarPath, `-o${extractDir}`, "-y", "-bso0", "-bsp0"]);
    const outPath = join(work, "source.7z");
    await runProcessOk(sevenZip, ["a", "-t7z", "-y", "-bso0", "-bsp0", outPath, prefix], {
      cwd: extractDir,
    });
    return finishedFile(outPath, contentType, cleanup);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** The whole backup directory, including refs/amber archives. */
export async function streamGitDirArchive(
  repoDir: string,
  format: ExportFormat,
): Promise<ArchiveHandle> {
  const contentType = ARCHIVE_CONTENT_TYPES[format];
  const folder = basename(repoDir);

  if (format === "zip" || format === "tar.gz") {
    const archive =
      format === "zip"
        ? new ZipArchive({ zlib: { level: 6 } })
        : new TarArchive({ gzip: true, gzipOptions: { level: 6 } });
    archive.directory(repoDir, folder);
    // finalize resolves when the last entry is queued, not when the consumer
    // has read it, so it is fired and forgotten while the stream is returned.
    void archive.finalize();
    return { stream: archive, contentType, cleanup: noCleanup };
  }

  const sevenZip = await findSevenZip();
  if (sevenZip === null) {
    throw new ExportError("7z export is unavailable: no 7z binary on PATH.", 501);
  }

  const work = await mkdtemp(join(tmpdir(), "amber-export-"));
  const cleanup = once(async () => {
    await rm(work, { recursive: true, force: true });
  });
  try {
    const outPath = join(work, "gitdir.7z");
    await runProcessOk(sevenZip, ["a", "-t7z", "-y", "-bso0", "-bsp0", outPath, folder], {
      cwd: dirname(repoDir),
    });
    return finishedFile(outPath, contentType, cleanup);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Stream a produced temp file and drop the temp directory when it is done. */
function finishedFile(
  path: string,
  contentType: string,
  cleanup: () => Promise<void>,
): ArchiveHandle {
  const stream = createReadStream(path);
  const drop = (): void => {
    void cleanup();
  };
  stream.on("close", drop);
  stream.on("error", drop);
  return { stream, contentType, cleanup };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnFailed: boolean;
}

/** execFile style helper for the 7z binary. Argument array, never a shell. */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
      },
      options.timeoutMs ?? 30 * 60 * 1000,
    );
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 32768) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 32768) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: error.message, code: null, spawnFailed: true });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, spawnFailed: false });
    });
  });
}

async function runProcessOk(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) {
    throw new ExportError(
      `${command} failed with ${String(result.code)}: ${result.stderr.trim().slice(0, 500)}`,
      500,
    );
  }
  return result;
}

let sevenZipCache: string | null | undefined;

/**
 * The 7z binary name, or null when the image or host does not have one. The
 * Dockerfile installs p7zip-full; a developer machine may not have it, and the
 * 7z routes answer 501 rather than failing obscurely.
 */
export async function findSevenZip(): Promise<string | null> {
  if (sevenZipCache !== undefined) {
    return sevenZipCache;
  }
  for (const candidate of ["7z", "7zz", "7za"]) {
    const result = await runProcess(candidate, ["i"], { timeoutMs: 20_000 });
    if (!result.spawnFailed) {
      sevenZipCache = candidate;
      return candidate;
    }
  }
  sevenZipCache = null;
  return null;
}

/**
 * Test seam. Pass null to force the missing-binary path, or nothing to make the
 * next call probe again. Emptying PATH is not a workable substitute: it would
 * take git out with it.
 */
export function setSevenZipCache(value?: string | null): void {
  sevenZipCache = value === undefined ? undefined : value;
}
