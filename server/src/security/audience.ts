import type { Db } from "../db/db.ts";
import { listUsers } from "../domain/users.ts";
import { canView, loadRepoAccessFacts } from "./authz.ts";

/**
 * Who can view a repository right now: the ids of every non-removed user for
 * whom canView holds. Computed BEFORE a delete, because once the row is gone
 * there is nothing left to decide visibility on. Amber has a handful of
 * users, so this is a short loop, not a query plan.
 */
export function repoAudience(db: Db, repoId: number): number[] {
  const facts = loadRepoAccessFacts(db, repoId);
  if (facts === undefined) {
    return [];
  }
  return listUsers(db)
    .filter((user) => canView(user, facts))
    .map((user) => user.id);
}
