import { notImplemented } from "../notImplemented.ts";

/** Recursive size of a backup directory, recorded on repos.disk_usage_bytes. */
export function directorySizeBytes(_dir: string): Promise<number> {
  return notImplemented("directorySizeBytes");
}
