import {
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
  getAccountSyncRow,
  insertAccountSync,
  mapAccountSync,
  runAccountSyncDetailed,
  supportsNamespaceSync,
  supportsStarredSync,
  type DiscoveryDeps,
} from "../providers/discovery.ts";
import { createBackupFileRemover } from "./repos.ts";

/** /api/account-syncs CRUD and manual run. */

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const listQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
});

interface AccountSyncRowShape {
  id: number;
  forge_id: number;
  account_id: number | null;
  source: "owned" | "starred" | "namespace";
  namespace: string | null;
  visibility: "all" | "public" | "private";
  enabled: number;
  interval_minutes: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  repos_discovered: number | null;
  created_at: number;
  updated_at: number;
}

function fail(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  return reply.code(status).send({ error, message });
}

function listAccountSyncs(db: Db, accountId?: number): AccountSync[] {
  const rows =
    accountId === undefined
      ? db.all<AccountSyncRowShape>("SELECT * FROM account_syncs ORDER BY id ASC")
      : db.all<AccountSyncRowShape>(
          "SELECT * FROM account_syncs WHERE account_id = ? ORDER BY id ASC",
          accountId,
        );
  return rows.map(mapAccountSync);
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

  app.get("/account-syncs", (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return fail(reply, 400, "invalid_query", z.prettifyError(query.error));
    }
    return { rows: listAccountSyncs(db, query.data.accountId) };
  });

  app.post("/account-syncs", (request, reply) => {
    const body = upsertAccountSyncSchema.safeParse(request.body);
    if (!body.success) {
      return fail(reply, 400, "invalid_body", z.prettifyError(body.error));
    }
    const input = body.data;

    let accountForgeId: number | undefined;
    if (input.accountId !== undefined) {
      const account = db.get<{ forge_id: number }>(
        "SELECT forge_id FROM accounts WHERE id = ?",
        input.accountId,
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

    const forge = db.get<{ kind: ForgeKind; host: string }>(
      "SELECT kind, host FROM forges WHERE id = ?",
      forgeId,
    );
    if (forge === undefined) {
      return input.forgeId === undefined
        ? fail(reply, 404, "forge_not_found", "The account's forge no longer exists")
        : fail(reply, 404, "forge_not_found", `Forge ${String(forgeId)} does not exist`);
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

    const namespace = input.source === "namespace" ? (input.namespace ?? null) : null;
    const duplicate =
      namespace === null
        ? db.get<{ id: number; namespace: string | null }>(
            "SELECT id, namespace FROM account_syncs WHERE account_id = ? AND source = ?",
            input.accountId ?? null,
            input.source,
          )
        : findNamespaceSync(db, forgeId, namespace);
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
      forgeId,
      accountId: input.accountId ?? null,
      source: input.source,
      namespace,
      visibility: input.source === "starred" ? "all" : input.visibility,
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes,
    });
    return reply.code(201).send(created);
  });

  app.patch("/account-syncs/:id", (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(reply, 400, "invalid_params", z.prettifyError(params.error));
    }
    const body = updateAccountSyncSchema.safeParse(request.body);
    if (!body.success) {
      return fail(reply, 400, "invalid_body", z.prettifyError(body.error));
    }

    const existing = getAccountSyncRow(db, params.data.id);
    if (existing === undefined) {
      return fail(reply, 404, "not_found", `Account sync ${String(params.data.id)} does not exist`);
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

    const now = Date.now();
    const visibility = patch.visibility ?? existing.visibility;
    const enabled = patch.enabled ?? existing.enabled === 1;
    const intervalMinutes = patch.intervalMinutes ?? existing.interval_minutes;
    // Re-enabling makes it due immediately; disabling clears the schedule.
    const nextRunAt = enabled ? (existing.enabled === 1 ? existing.next_run_at : now) : null;

    db.run(
      `UPDATE account_syncs
          SET visibility = ?, enabled = ?, interval_minutes = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
      visibility,
      enabled ? 1 : 0,
      intervalMinutes,
      nextRunAt,
      now,
      params.data.id,
    );

    const row = getAccountSyncRow(db, params.data.id);
    return row === undefined ? null : mapAccountSync(row);
  });

  app.delete("/account-syncs/:id", (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(reply, 400, "invalid_params", z.prettifyError(params.error));
    }
    const deleted = db.run("DELETE FROM account_syncs WHERE id = ?", params.data.id);
    if (deleted.changes === 0) {
      return fail(reply, 404, "not_found", `Account sync ${String(params.data.id)} does not exist`);
    }
    // repos.managed_by_account_sync_id is ON DELETE SET NULL: the backups stay,
    // they simply stop being managed by a sync.
    return reply.code(204).send();
  });

  app.post("/account-syncs/:id/run", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(reply, 400, "invalid_params", z.prettifyError(params.error));
    }
    if (getAccountSyncRow(db, params.data.id) === undefined) {
      return fail(reply, 404, "not_found", `Account sync ${String(params.data.id)} does not exist`);
    }

    const result: AccountSyncRunResult = await runAccountSyncDetailed(db, params.data.id, deps);
    events.publish("account_sync.finished", {
      accountSyncId: params.data.id,
      discovered: result.discovered,
      created: result.created,
      removed: result.removed,
      error: result.error,
    });
    return result;
  });
};
