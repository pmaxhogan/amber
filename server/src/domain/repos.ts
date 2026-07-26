import type { Page, Repo, RepoListQuery, UpdateRepo } from "@amber/shared";
import type { Db } from "../db/db.ts";
import { notImplemented } from "../notImplemented.ts";

/** 8 characters of base36 from crypto.randomBytes. Unique per repo. */
export function generateShortId(): string {
  return notImplemented("generateShortId");
}

/**
 * Disk directory name: sanitized path + "-" + short_id. The short id makes
 * collisions impossible regardless of how two paths sanitize.
 */
export function buildSlug(_path: string, _shortId: string): string {
  return notImplemented("buildSlug");
}

export function listRepos(_db: Db, _query: RepoListQuery): Page<Repo> {
  return notImplemented("listRepos");
}

export function getRepo(_db: Db, _id: number): Repo | undefined {
  return notImplemented("getRepo");
}

export function getRepoBySlug(_db: Db, _slug: string): Repo | undefined {
  return notImplemented("getRepoBySlug");
}

export function updateRepo(_db: Db, _id: number, _patch: UpdateRepo): Repo {
  return notImplemented("updateRepo");
}

export function deleteRepo(_db: Db, _id: number, _withFiles: boolean): Promise<void> {
  return notImplemented("deleteRepo");
}
