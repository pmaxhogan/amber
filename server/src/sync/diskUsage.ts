import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Recursive size of a backup directory, recorded on repos.disk_usage_bytes.
 * Pure node, no shell: `du` does not exist on every platform amber runs on and
 * shelling out to it would violate the no-shell rule the git wrapper enforces.
 *
 * Symlinks are counted by their own size and never followed, so a repository
 * that contains a link to / cannot make this walk the whole filesystem.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const pending: string[] = [dir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      // Vanished mid-walk (a concurrent sync repacking, say) or unreadable.
      continue;
    }
    for await (const entry of handle) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      try {
        const stats = await lstat(full);
        total += stats.size;
      } catch {
        // Same race as above: the file is gone, so it contributes nothing.
      }
    }
  }

  return total;
}
