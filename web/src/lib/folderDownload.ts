import type { ApiClient } from "../api/client.ts";
import type { TreeEntry } from "../api/types.ts";

/**
 * "Download to folder" via the File System Access API.
 *
 * Chromium only, so every entry point is feature-detected and the button is
 * hidden where it would not work. Structural types are declared locally rather
 * than relying on the DOM lib, which does not carry showDirectoryPicker in
 * every TypeScript version.
 */

interface FsWritable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface FsFileHandle {
  createWritable: () => Promise<FsWritable>;
}

interface FsDirectoryHandle {
  name: string;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<FsDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FsFileHandle>;
}

type DirectoryPicker = (options?: { mode?: "read" | "readwrite" }) => Promise<FsDirectoryHandle>;

export function supportsDirectoryPicker(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).showDirectoryPicker === "function"
  );
}

export async function pickDirectory(): Promise<FsDirectoryHandle | null> {
  const picker = (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
  if (picker === undefined) return null;
  try {
    return await picker({ mode: "readwrite" });
  } catch {
    // The user dismissed the picker. Not an error worth surfacing.
    return null;
  }
}

export interface FolderDownloadProgress {
  /** Files written so far. */
  done: number;
  /** Files discovered so far; grows while the manifest is still paging. */
  total: number;
  path: string;
}

const TREE_PAGE_SIZE = 200;

/** Fetch the whole file manifest, paging until the reported total is covered. */
export async function fetchManifest(
  api: ApiClient,
  repoId: number,
  ref?: string,
  signal?: AbortSignal,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let page = 1;
  for (;;) {
    const result = await api.listTree(repoId, { ref, page, perPage: TREE_PAGE_SIZE }, signal);
    entries.push(...result.rows);
    if (entries.length >= result.total || result.rows.length === 0) break;
    page += 1;
  }
  return entries.filter((entry) => entry.type === "blob");
}

/** Create every intermediate directory for a repo-relative path. */
async function ensureParent(
  root: FsDirectoryHandle,
  segments: string[],
): Promise<FsDirectoryHandle> {
  let handle = root;
  for (const segment of segments) {
    handle = await handle.getDirectoryHandle(segment, { create: true });
  }
  return handle;
}

export interface FolderDownloadResult {
  written: number;
  failed: { path: string; message: string }[];
}

export async function downloadToDirectory(options: {
  api: ApiClient;
  repoId: number;
  directory: FsDirectoryHandle;
  entries: TreeEntry[];
  ref?: string;
  signal?: AbortSignal;
  onProgress?: (progress: FolderDownloadProgress) => void;
}): Promise<FolderDownloadResult> {
  const { api, repoId, directory, entries, ref, signal, onProgress } = options;
  const failed: FolderDownloadResult["failed"] = [];
  let written = 0;

  for (const entry of entries) {
    if (signal?.aborted === true) break;
    onProgress?.({ done: written, total: entries.length, path: entry.path });
    const segments = entry.path.split("/").filter((part) => part !== "");
    const fileName = segments.pop();
    if (fileName === undefined) continue;
    try {
      const parent = await ensureParent(directory, segments);
      const blob = await api.getBlob(repoId, entry.path, ref, signal);
      const handle = await parent.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
      } finally {
        await writable.close();
      }
      written += 1;
    } catch (cause) {
      failed.push({
        path: entry.path,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  onProgress?.({ done: written, total: entries.length, path: "" });
  return { written, failed };
}

/** Trigger a browser download for an already-fetched blob. */
export function saveBlob(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoking immediately is safe: the download has already been handed off.
    URL.revokeObjectURL(href);
  }
}
