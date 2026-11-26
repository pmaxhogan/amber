import type { BrowseEntry } from "@amber/shared";
import type { ApiClientError } from "../api/client.ts";

/** Pure helpers for the repository browser. Nothing here touches the DOM. */

/** Abbreviated object id, as git prints it by default. */
export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/** The directory containing `path`; the root for a top-level entry. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export interface Crumb {
  name: string;
  /** Path of the directory this crumb opens. Empty for the root. */
  path: string;
}

/** `a/b/c` as the crumbs `a`, `a/b`, `a/b/c`. The root is not included. */
export function breadcrumbs(path: string): Crumb[] {
  if (path === "") return [];
  const names = path.split("/");
  return names.map((name, index) => ({ name, path: names.slice(0, index + 1).join("/") }));
}

/**
 * Lines a text file shows in the gutter: a final newline ends the last line
 * rather than starting an empty one.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  let newlines = 0;
  let from = text.indexOf("\n");
  while (from !== -1) {
    newlines += 1;
    from = text.indexOf("\n", from + 1);
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** "1\n2\n...\nN", the whole gutter as one text node. */
export function gutterText(lines: number): string {
  const numbers = new Array<number>(lines);
  for (let index = 0; index < lines; index += 1) numbers[index] = index + 1;
  return numbers.join("\n");
}

/** File names that count as a directory's README, most preferred first. */
const README_NAMES = ["README.md", "README.markdown", "README", "README.txt", "README.rst"];

/** The README of a directory listing, matched case-insensitively. */
export function pickReadme(entries: readonly BrowseEntry[]): BrowseEntry | null {
  for (const wanted of README_NAMES) {
    const lower = wanted.toLowerCase();
    const hit = entries.find(
      (entry) => entry.type === "blob" && entry.name.toLowerCase() === lower,
    );
    if (hit !== undefined) return hit;
  }
  return null;
}

/** The backup has no repository on disk yet (a 409 `not_backed_up`). */
export function isNotBackedUp(error: ApiClientError | null): boolean {
  return error !== null && (error.problem === "not_backed_up" || error.status === 409);
}

export function isNotFound(error: ApiClientError | null): boolean {
  return error !== null && error.status === 404;
}
