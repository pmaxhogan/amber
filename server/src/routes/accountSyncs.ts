import {
  TRENDING_INTERVAL_MINUTES_DEFAULT,
  TRENDING_TOP_N_DEFAULT,
  TRENDING_WINDOW_DAYS_DEFAULT,
  updateAccountSyncSchema,
  upsertAccountSyncSchema,
  type AccountSync,
  type AccountSyncRunResult,
  type ForgeKind,
} from "@amber/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import {
  findNamespaceSync,
  findTrendingSync,
  getAccountSyncRow,
  insertAccountSync,
  mapAccountSync,
  ownerMayRunAccountSync,
  runAccountSyncDetailed,
  supportsNamespaceSync,
  supportsStarredSync,
  supportsTrendingSync,
  type DiscoveryDeps,
} from "../providers/discovery.ts";
import { hostNotEnabled, mayUseForge } from "../domain/forges.ts";
import { getUser, type User } from "../domain/users.ts";
import { hasPermission, requireRequestUser } from "../security/authz.ts";
import { createBackupFileRemover } from "./repos.ts";

/**
 * /api/account-syncs CRUD and manual run.
 *
 * Authorization:
 * - A sync belongs to its creator, and so does every repository it creates.
 * - Creating one needs `import`. Owned and starred syncs need an account the
 *   caller OWNS; a namespace sync's account is the caller's own or none (none
 *   means the owner's default account at run time, when they may use
 *   accounts). Another user's account reads exactly like no account at all.
 * - A trending sync is instance-level: everyone sees them, and creating,
 *   editing, deleting or running one needs `manage_settings` (anyone holding
 *   it may manage all of them).
 * - Every other sync is visible to, and editable by, its owner and the admin
 *   only. Anyone else gets the same 404 as a sync that does not exist.
 */

/** What the create schema used to default to, before trending brought its own. */
const DEFAULT_INTERVAL_MINUTES = 360;

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const listQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
});

interface AccountSyncRowShape {
  id: number;
  forge_id: number;
  account_id: number | null;
  source: "owned" | "starred" | "namespace" | "trending";
  namespace: string | null;
  top_n: number | null;
  window_days: number | null;
  visibility: "all" | "public" | "private";
  enabled: number;
  interval_minutes: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  repos_discovered: number | null;
  owner_user_id: number;
  created_at: number;
  updated_at: number;
}

function fail(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  return reply.code(status).send({ error, message });
}

function trendingForbidden(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({
    error: "forbidden",
    message: 'Trending syncs need the "manage_settings" permission.',
    details: { permission: "manage_settings" },
  });
}

/**
 * Whether `user` may see this sync at all. A trending sync is instance-level
 * (it lists what is popular on a public forge, nothing of anyone's), so
 * everyone sees those; changing one still needs manage_settings. Every other
 * sync is its owner's and the admin's only.
 */
function maySee(user: User, row: Pick<AccountSyncRowShape, "owner_user_id" | "source">): boolean {
  return user.isAdmin || row.owner_user_id === user.id || row.source === "trending";
}

/** The owner's address, for the admin only. */
function withOwnerEmail(db: Db, user: User, sync: AccountSync): AccountSync {
  if (!user.isAdmin || sync.ownerUserId === undefined) {
    return sync;
  }
  const owner = getUser(db, sync.ownerUserId);
  return owner === undefined ? sync : { ...sync, ownerEmail: owner.email };
}

function listAccountSyncs(db: Db, user: User, accountId?: number): AccountSync[] {
  const rows =
    accountId === undefined
      ? db.all<AccountSyncRowShape>("SELECT * FROM account_syncs ORDER BY id ASC")
      : db.all<AccountSyncRowShape>(
          "SELECT * FROM account_syncs WHERE account_id = ? ORDER BY id ASC",
          accountId,
        );
  return rows
    .filter((row) => maySee(user, row))
    .map((row) => withOwnerEmail(db, user, mapAccountSync(row)));
}

function notFoundSync(reply: FastifyReply, id: number): FastifyReply {
  return fail(reply, 404, "not_found", `Account sync ${String(id)} does not exist`);
}

export const accountSyncRoutes: FastifyPluginAsync = async (app) => {
  const { db, log, config, events } = app.amber;

  // A starred sync that confirms an unstar upstream deletes the backup files
  // too, so it needs the same remover the repo delete route uses.
  const deps: DiscoveryDeps = {
    log,
    secretKey: config.secretKey,
    removeFiles: createBackupFileRemover(config),
  };

  app.get("/account-syncs", { config: { authz: "user" } }, (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return fail(reply, 400, "invalid_query", z.prettifyError(query.error));
    }
    return { rows: listAccountSyncs(db, requireRequestUser(request), query.data.accountId) };
  });

  app.post("/account-syncs", { config: { authz: "import" } }, (request, reply) => {
    const body = upsertAccountSyncSchema.safeParse(request.body);
    if (!body.success) {
      return fail(reply, 400, "invalid_body", z.prettifyError(body.error));
    }
    const input = body.data;
    const user = requireRequestUser(request);
    if (input.source === "trending" && !hasPermission(user, "manage_settings")) {
      return trendingForbidden(reply);
    }

    let accountForgeId: number | undefined;
    if (input.accountId !== undefined) {
      // Only the caller's OWN account: another user's answers exactly like
      // one that does not exist, so account ids cannot be probed here.
      const account = db.get<{ forge_id: number }>(
        "SELECT forge_id FROM accounts WHERE id = ? AND owner_user_id = ?",
        input.accountId,
        user.id,
      );
      if (account === undefined) {
        return fail(
          reply,
          404,
          "account_not_found",
          `Account ${String(input.accountId)} does not exist`,
        );
      }
      accountForgeId = account.forge_id;
    }
    if (
      input.forgeId !== undefined &&
      accountForgeId !== undefined &&
      input.forgeId !== accountForgeId
    ) {
      return fail(reply, 400, "invalid_body", "That account belongs to a different forge");
    }
    // The schema guarantees one of the two is present.
    const forgeId = input.forgeId ?? accountForgeId ?? 0;

    const forge = db.get<{ kind: ForgeKind; host: string; allow_private_network: number }>(
      "SELECT kind, host, allow_private_network FROM forges WHERE id = ?",
      forgeId,
    );
    if (forge === undefined) {
      return input.forgeId === undefined
        ? fail(reply, 404, "forge_not_found", "The account's forge no longer exists")
        : fail(reply, 404, "forge_not_found", `Forge ${String(forgeId)} does not exist`);
    }
    // An unrestricted forge is the admin's alone (domain/forges.ts mayUseForge).
    if (!mayUseForge(user, { allowPrivateNetwork: forge.allow_private_network === 1 })) {
      throw hostNotEnabled();
    }
    if (forge.kind === "generic") {
      return fail(
        reply,
        400,
        "unsupported_forge",
        "Account sync does not support generic forges. Import those repositories manually.",
      );
    }
    if (input.source === "starred") {
      if (!supportsStarredSync(forge.kind)) {
        return fail(reply, 400, "unsupported_source", "Starred sync is GitHub-only for now");
      }
      // The schema defaults visibility, so "did the caller ask for one" has to
      // be answered against the raw body rather than the parsed value.
      const raw = request.body as Record<string, unknown> | null | undefined;
      if (raw?.visibility !== undefined) {
        return fail(
          reply,
          400,
          "invalid_body",
          "visibility applies to owned syncs only; a starred sync always takes the full list",
        );
      }
    }
    if (input.source === "namespace" && !supportsNamespaceSync(forge.kind)) {
      return fail(
        reply,
        400,
        "unsupported_source",
        "Syncing a whole user or organization is GitHub-only for now",
      );
    }

    if (input.source === "trending") {
      if (!supportsTrendingSync(forge.kind)) {
        return fail(reply, 400, "unsupported_source", "Trending sync is GitHub-only for now");
      }
      const raw = request.body as Record<string, unknown> | null | undefined;
      if (raw?.visibility !== undefined) {
        return fail(
          reply,
          400,
          "invalid_body",
          "visibility does not apply to a trending sync; search results are always public",
        );
      }
      // account_id is NULL here, and "account_id = NULL" never matches, so the
      // generic duplicate lookup below cannot see an existing trending sync.
      const windowDays = input.windowDays ?? TRENDING_WINDOW_DAYS_DEFAULT;
      const existing = findTrendingSync(db, forgeId, windowDays);
      if (existing !== undefined) {
        return fail(
          reply,
          409,
          "account_sync_exists",
          `${forge.host} already has a trending sync over ${String(windowDays)} days (id ${String(existing.id)})`,
        );
      }
      const created = insertAccountSync(db, {
        ownerUserId: user.id,
        forgeId,
        accountId: null,
        source: "trending",
        namespace: null,
        topN: input.topN ?? TRENDING_TOP_N_DEFAULT,
        windowDays,
        visibility: "all",
        enabled: input.enabled,
        intervalMinutes: input.intervalMinutes ?? TRENDING_INTERVAL_MINUTES_DEFAULT,
      });
      return reply.code(201).send(created);
    }

    const namespace = input.source === "namespace" ? (input.namespace ?? null) : null;
    const duplicate =
      namespace === null
        ? db.get<{ id: number; namespace: string | null }>(
            "SELECT id, namespace FROM account_syncs WHERE owner_user_id = ? AND account_id = ? AND source = ?",
            user.id,
            input.accountId ?? null,
            input.source,
          )
        : findNamespaceSync(db, user.id, forgeId, namespace);
    if (duplicate !== undefined) {
      return fail(
        reply,
        409,
        "account_sync_exists",
        namespace === null
          ? `That account already has a ${input.source} sync (id ${String(duplicate.id)})`
          : // The stored spelling, not the caller's, so the conflict is recognisable.
            `${duplicate.namespace ?? namespace} on ${forge.host} is already synced (id ${String(duplicate.id)})`,
      );
    }

    const created = insertAccountSync(db, {
      ownerUserId: user.id,
      forgeId,
      accountId: input.accountId ?? null,
      source: input.source,
      namespace,
      visibility: input.source === "starred" ? "all" : input.visibility,
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    });
    return reply.code(201).send(created);
  });

  app.patch("/account-syncs/:id", { config: { authz: "user" } }, (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(reply, 400, "invalid_params", z.prettifyError(params.error));
    }
    const body = updateAccountSyncSchema.safeParse(request.body);
    if (!body.success) {
      return fail(reply, 400, "invalid_body", z.prettifyError(body.error));
    }

    const user = requireRequestUser(request);
    const existing = getAccountSyncRow(db, params.data.id);
    if (existing === undefined || !maySee(user, existing)) {
      return notFoundSync(reply, params.data.id);
    }
    if (existing.source === "trending" && !hasPermission(user, "manage_settings")) {
      return trendingForbidden(reply);
    }
    const patch = body.data;
    if (existing.source === "starred" && patch.visibility !== undefined) {
      return fail(
        reply,
        400,
        "invalid_body",
        "visibility applies to owned syncs only; a starred sync always takes the full list",
      );
    }
    if (existing.source === "trending" && patch.visibility !== undefined) {
      return fail(
        reply,
        400,
        "invalid_body",
        "visibility does not apply to a trending sync; search results are always public",
      );
    }
    if (existing.source !== "trending" && patch.topN !== undefined) {
      return fail(reply, 400, "invalid_body", "topN applies to trending syncs only");
    }

    const now = Date.now();
    const visibility = patch.visibility ?? existing.visibility;
    const enabled = patch.enabled ?? existing.enabled === 1;
    const intervalMinutes = patch.intervalMinutes ?? existing.interval_minutes;
    const topN = patch.topN ?? existing.top_n;
    // Re-enabling makes it due immediately; disabling clears the schedule.
    const nextRunAt = enabled ? (existing.enabled === 1 ? existing.next_run_at : now) : null;

    db.run(
      `UPDATE account_syncs
          SET visibility = ?, top_n = ?, enabled = ?, interval_minutes = ?, next_run_at = ?,
              updated_at = ?
        WHERE id = ?`,
      visibility,
      topN,
      enabled ? 1 : 0,
      intervalMinutes,
      nextRunAt,
      now,
      params.data.id,
    );

    const row = getAccountSyncRow(db, params.data.id);
    return row === undefined ? null : withOwnerEmail(db, user, mapAccountSync(row));
  });

  app.delete("/account-syncs/:id", { config: { authz: "user" } }, (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(reply, 400, "invalid_params", z.prettifyError(params.error));
    }
    const user = requireRequestUser(request);
    const target = getAccountSyncRow(db, params.data.id);
    if (target === undefined || !maySee(user, target)) {
      return notFoundSync(reply, params.data.id);
    }
    if (target.source === "trending" && !hasPermission(user, "manage_settings")) {
      return trendingForbidden(reply);
    }
    const deleted = db.run("DELETE FROM account_syncs WHERE id = ?", params.data.id);
    if (deleted.changes === 0) {
      return notFoundSync(reply, params.data.id);
    }
    // repos.managed_by_account_sync_id is ON DELETE SET NULL: the backups stay,
    // they simply stop being managed by a sync.
    return reply.code(204).send();
  });

  app.post("/account-syncs/:id/run", { config: { authz: "user" } }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(reply, 400, "invalid_params", z.prettifyError(params.error));
    }
    const user = requireRequestUser(request);
    const target = getAccountSyncRow(db, params.data.id);
    if (target === undefined || !maySee(user, target)) {
      return notFoundSync(reply, params.data.id);
    }
    if (target.source === "trending" && !hasPermission(user, "manage_settings")) {
      return trendingForbidden(reply);
    }
    if (!ownerMayRunAccountSync(getUser(db, target.owner_user_id))) {
      // The scheduler skips it too (listDueAccountSyncs); a manual run must
      // not be the way around a revoked `import`.
      return fail(
        reply,
        409,
        "owner_cannot_import",
        "This sync's owner can no longer import repositories, so it does not run.",
      );
    }

    const result: AccountSyncRunResult = await runAccountSyncDetailed(db, params.data.id, deps);
    events.publish("account_sync.finished", {
      accountSyncId: params.data.id,
      discovered: result.discovered,
      created: result.created,
      removed: result.removed,
      error: result.error,
    });
    return { ...result, accountSync: withOwnerEmail(db, user, result.accountSync) };
  });
};
