import type { AmberEvent } from "@amber/shared";
import type { Db } from "../db/db.ts";
import type { User } from "../domain/users.ts";
import type { EventMeta } from "../events.ts";
import { canView, loadRepoAccessFacts, maySeeGone } from "./authz.ts";

/**
 * Whether `user` may receive `event` on their live stream. Decided at SEND
 * time from fresh rows, so a permission change, a path change or an owner
 * change takes effect on streams that are already open.
 *
 * Default deny: an event type nobody classified here is delivered to nobody,
 * so a new event cannot leak by being forgotten.
 */
export function mayReceiveEvent(db: Db, user: User, event: AmberEvent, meta: EventMeta): boolean {
  if (user.removedAt !== null) {
    return false;
  }
  switch (event.type) {
    case "status.changed":
      // Queue depth, active syncs and the breaker: instance-wide, about no repo.
      return true;
    case "sync.started":
    case "sync.finished":
    case "repo.created":
    case "repo.updated":
    case "repo.gone": {
      const repoId = event.payload.repoId;
      if (typeof repoId !== "number") {
        return false;
      }
      const facts = loadRepoAccessFacts(db, repoId);
      if (facts === undefined || !canView(user, facts)) {
        return false;
      }
      // That someone else's repo went gone is the Removed page's news.
      return event.type !== "repo.gone" || maySeeGone(user, facts);
    }
    case "repo.deleted":
      // The row is gone, so visibility was computed before it went.
      return meta.audience?.includes(user.id) === true;
    case "account_sync.finished": {
      if (user.isAdmin) {
        return true;
      }
      const syncId = event.payload.accountSyncId;
      if (typeof syncId !== "number") {
        return false;
      }
      const row = db.get<{ owner_user_id: number }>(
        "SELECT owner_user_id FROM account_syncs WHERE id = ?",
        syncId,
      );
      return row !== undefined && row.owner_user_id === user.id;
    }
    default:
      return false;
  }
}
