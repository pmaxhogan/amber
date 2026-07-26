import type { ExportFormat } from "@amber/shared";
import { notImplemented } from "../notImplemented.ts";

export interface TreeEntry {
  path: string;
  mode: string;
  size: number;
  oid: string;
}

/** The source tree at a ref, as zip / tar.gz / 7z. */
export function streamSourceArchive(
  _repoDir: string,
  _ref: string,
  _format: ExportFormat,
): Promise<NodeJS.ReadableStream> {
  return notImplemented("streamSourceArchive");
}

/** The whole backup directory, including refs/amber archives. */
export function streamGitDirArchive(
  _repoDir: string,
  _format: ExportFormat,
): Promise<NodeJS.ReadableStream> {
  return notImplemented("streamGitDirArchive");
}

/** Paged manifest backing the File System Access API folder download. */
export function listTree(_repoDir: string, _ref: string): Promise<TreeEntry[]> {
  return notImplemented("listTree");
}

/** One blob, with the path validated against the manifest first. */
export function streamBlob(
  _repoDir: string,
  _ref: string,
  _path: string,
): Promise<NodeJS.ReadableStream> {
  return notImplemented("streamBlob");
}
