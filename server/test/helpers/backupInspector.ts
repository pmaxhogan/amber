import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { runGit, type GitRunOptions } from "../../src/sync/gitCli.ts";
import { ARCHIVE_REF_PREFIX } from "../../src/sync/syncRepo.ts";

/**
 * Observation and assertion helpers for the paranoid torture suite. Everything
 * here reads the backup only: the whole point is that the backup outlives
 * whatever the origin does to itself.
 */
export class BackupInspector {
  /** Every object sha the backup has ever held, reachable or not. */
  readonly objects = new Set<string>();
  /** Every ref tip ever observed, keyed by the ref it was seen on. */
  readonly tips = new Map<string, Set<string>>();

  constructor(
    private readonly dir: string,
    private readonly options: GitRunOptions = {},
  ) {}

  async git(args: string[], stdin?: string): Promise<string> {
    const result = await runGit(args, {
      ...this.options,
      cwd: this.dir,
      stdin,
      allowFailure: true,
    });
    return result.stdout;
  }

  async refs(): Promise<Map<string, string>> {
    const out = await this.git(["for-each-ref", "--format=%(objectname) %(refname)"]);
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) {
        map.set(line.slice(space + 1).trim(), line.slice(0, space));
      }
    }
    return map;
  }

  /** Record everything the backup currently holds. Call after every sync. */
  async observe(): Promise<void> {
    const listed = await this.git([
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    ]);
    for (const line of listed.split("\n")) {
      const sha = line.trim();
      if (/^[0-9a-f]{40}$/.test(sha)) {
        this.objects.add(sha);
      }
    }
    for (const [ref, sha] of await this.refs()) {
      if (ref.startsWith(`${ARCHIVE_REF_PREFIX}/`)) {
        continue;
      }
      let seen = this.tips.get(ref);
      if (seen === undefined) {
        seen = new Set<string>();
        this.tips.set(ref, seen);
      }
      seen.add(sha);
    }
  }

  /** Object shas that are missing from the backup right now. */
  async missingObjects(): Promise<string[]> {
    const shas = [...this.objects];
    if (shas.length === 0) {
      return [];
    }
    // One process for every object ever seen: per-object cat-file -e would be
    // hundreds of spawns and would dominate the suite's runtime.
    const out = await this.git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      `${shas.join("\n")}\n`,
    );
    const found = new Set<string>();
    for (const line of out.split("\n")) {
      const [sha, type] = line.trim().split(" ");
      if (sha !== undefined && type !== undefined && /^[0-9a-f]{40}$/.test(sha)) {
        found.add(sha);
      }
    }
    return shas.filter((sha) => !found.has(sha));
  }

  /** Everything reachable from any ref, including the amber archives. */
  async reachable(): Promise<Set<string>> {
    const set = new Set<string>();
    for (const line of (await this.git(["rev-list", "--all"])).split("\n")) {
      const sha = line.trim();
      if (sha !== "") {
        set.add(sha);
      }
    }
    for (const sha of (await this.refs()).values()) {
      set.add(sha);
      // An annotated tag is reachable through its own ref; so is what it peels to.
      const peeled = (await this.git(["rev-parse", `${sha}^{commit}`])).trim();
      if (/^[0-9a-f]{40}$/.test(peeled)) {
        set.add(peeled);
      }
    }
    return set;
  }

  /** Ref tips that are no longer reachable from anything. */
  async unreachableTips(): Promise<{ ref: string; sha: string }[]> {
    const reachable = await this.reachable();
    const lost: { ref: string; sha: string }[] = [];
    for (const [ref, shas] of this.tips) {
      for (const sha of shas) {
        if (!reachable.has(sha)) {
          lost.push({ ref, sha });
        }
      }
    }
    return lost;
  }

  async archiveRefs(): Promise<Map<string, string>> {
    const all = await this.refs();
    return new Map([...all].filter(([ref]) => ref.startsWith(`${ARCHIVE_REF_PREFIX}/`)));
  }

  async hasObject(sha: string): Promise<boolean> {
    const result = await runGit(["cat-file", "-e", `${sha}^{object}`], {
      ...this.options,
      cwd: this.dir,
      allowFailure: true,
    });
    return result.code === 0;
  }
}

/**
 * Object files with more than one link would mean git hardlinked the origin's
 * objects into the backup, which happens with a bare filesystem path instead of
 * a file:// url. Every durability assertion would then be meaningless.
 */
export async function hardlinkedFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [join(dir, "objects")];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      const stats = await lstat(full);
      if (stats.nlink > 1) {
        found.push(full);
      }
    }
  }
  return found;
}
