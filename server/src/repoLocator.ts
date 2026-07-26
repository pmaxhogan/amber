import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";

/**
 * Minimal read side of the repos table for the serving paths.
 *
 * NOTE FOR A LATER MERGE: domain/repos.ts owns repo reads and will grow
 * getRepo/getRepoBySlug returning the full mapped Repo. These two helpers exist
 * so the git remote and the export endpoints do not block on that work; swap
 * them for the domain functions once they land. The column list here is
 * deliberately tiny: the serving paths only need identity plus the disk slug.
 */

export interface LocatedRepo {
  id: number;
  slug: string;
  displayName: string;
  defaultBranch: string | null;
}

interface RepoRow {
  id: number;
  slug: string;
  display_name: string;
  default_branch: string | null;
}

const SELECT = "SELECT id, slug, display_name, default_branch FROM repos";

function toLocated(row: RepoRow | undefined): LocatedRepo | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: Number(row.id),
    slug: row.slug,
    displayName: row.display_name,
    defaultBranch: row.default_branch,
  };
}

export function findRepoById(db: Db, id: number): LocatedRepo | undefined {
  return toLocated(db.get<RepoRow>(`${SELECT} WHERE id = ?`, id));
}

/**
 * Slug lookup for /git/:slug. The trailing ".git" that git clients append is
 * optional. The value is only ever used as a WHERE parameter; the directory
 * comes from the row that comes back, never from the request.
 */
export function findRepoBySlug(db: Db, slug: string): LocatedRepo | undefined {
  const normalized = slug.endsWith(".git") ? slug.slice(0, -".git".length) : slug;
  if (normalized === "") {
    return undefined;
  }
  return toLocated(db.get<RepoRow>(`${SELECT} WHERE slug = ?`, normalized));
}

/**
 * The backup directory for a repo row. Built from the stored slug, never from
 * a request parameter, so no user input reaches the path join.
 */
export function repoDirFor(config: Pick<Config, "backupsDir">, repo: LocatedRepo): string {
  return join(config.backupsDir, repo.slug);
}
