import {
  idParamsSchema,
  settingsPatchSchema,
  settingsScopeParamsSchema,
  type EffectiveSettingsResponse,
  type ScopeSettingsResponse,
  type SettingScope,
} from "@amber/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  explainSettings,
  getScopeSettings,
  putScopeSettings,
  resolveSettings,
} from "../domain/settings.ts";
import { getAccount } from "../domain/accounts.ts";
import { notFound } from "../domain/errors.ts";
import {
  hasPermission,
  requirePermission,
  requireRepoEdit,
  requireRepoView,
  requireRequestUser,
} from "../security/authz.ts";
import { parseBody, parseParams } from "./validate.ts";

/**
 * /api/settings/:scopeType/:scopeId and effective-settings explain.
 *
 * Values are validated per key against shared/src/settingsRegistry.ts, which
 * also decides which scopes a key may be stored at. Unknown keys are rejected
 * rather than dropped, so a typo cannot look like it saved.
 *
 * Writes are authorized by scope, and each scope that has a coarse rule has a
 * route of its own so the route table says so: global settings need
 * `manage_settings`, forge settings `manage_forges`. The generic routes take
 * account and repo scopes only (whose checks are per object: the account's or
 * the repo's owner) and refuse global and forge outright, so a path that
 * somehow reaches them with one of those scopes cannot skip the permission.
 *
 * Object level, on top of that:
 * - repo scope: reading needs that the caller can view the repo; writing
 *   needs the owner, the admin, or modify_others on a repo they can view
 *   (requireRepoEdit). An invisible repo is a 404 either way.
 * - account scope: the account's owner, or manage_forges (and the admin), to
 *   read or write. Anyone else gets the 404 of an account that does not exist.
 * - effective-settings: the same as reading the repo.
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.amber;

  const scopeOf = (request: FastifyRequest) => {
    const params = parseParams(settingsScopeParamsSchema, request);
    return { scopeType: params.scopeType, scopeId: params.scopeId ?? null };
  };

  /** An account's settings belong to its owner; manage_forges may see and edit everyone's. */
  const requireAccountScope = (request: FastifyRequest, accountId: number): void => {
    const user = requireRequestUser(request);
    const account = getAccount(db, accountId);
    if (
      account === undefined ||
      (account.ownerUserId !== user.id && !hasPermission(user, "manage_forges"))
    ) {
      throw notFound("Account", accountId);
    }
  };

  /** The object-level check for one scope, before any read or write touches it. */
  const authorizeScope = (
    request: FastifyRequest,
    scopeType: SettingScope,
    scopeId: number | null,
    mode: "read" | "write",
  ): void => {
    if (scopeId === null) {
      return;
    }
    if (scopeType === "repo") {
      if (mode === "read") {
        requireRepoView(request, scopeId);
      } else {
        requireRepoEdit(request, scopeId);
      }
    } else if (scopeType === "account") {
      requireAccountScope(request, scopeId);
    }
  };

  const read = (request: FastifyRequest): ScopeSettingsResponse => {
    const { scopeType, scopeId } = scopeOf(request);
    authorizeScope(request, scopeType, scopeId, "read");
    return { scopeType, scopeId, values: getScopeSettings(db, scopeType, scopeId) };
  };

  const writeScope = (
    request: FastifyRequest,
    scopeType: SettingScope,
    scopeId: number | null,
  ): ScopeSettingsResponse => {
    const patch = parseBody(settingsPatchSchema, request);
    return { scopeType, scopeId, values: putScopeSettings(db, scopeType, scopeId, patch) };
  };

  /** Account and repo scopes only; global and forge have their own routes. */
  const writeGeneric = (request: FastifyRequest): ScopeSettingsResponse => {
    const { scopeType, scopeId } = scopeOf(request);
    if (scopeType === "global") {
      requirePermission(request, "manage_settings");
    } else if (scopeType === "forge") {
      requirePermission(request, "manage_forges");
    }
    authorizeScope(request, scopeType, scopeId, "write");
    return writeScope(request, scopeType, scopeId);
  };

  const forgeParamsSchema = z.object({ scopeId: z.coerce.number().int().positive() });

  // Global settings carry no id, so both shapes of the path are registered.
  app.get("/settings/:scopeType", { config: { authz: "user" } }, read);
  app.get("/settings/:scopeType/:scopeId", { config: { authz: "user" } }, read);

  // Static segments win over the parameter routes below.
  app.put("/settings/global", { config: { authz: "manage_settings" } }, (request) =>
    writeScope(request, "global", null),
  );
  app.put("/settings/forge/:scopeId", { config: { authz: "manage_forges" } }, (request) =>
    writeScope(request, "forge", parseParams(forgeParamsSchema, request).scopeId),
  );
  app.put("/settings/:scopeType", { config: { authz: "user" } }, writeGeneric);
  app.put("/settings/:scopeType/:scopeId", { config: { authz: "user" } }, writeGeneric);

  app.get(
    "/repos/:id/effective-settings",
    { config: { authz: "user" } },
    (request): EffectiveSettingsResponse => {
      const { id } = parseParams(idParamsSchema, request);
      requireRepoView(request, id);
      return {
        repoId: id,
        settings: resolveSettings(db, id),
        explanation: explainSettings(db, id),
      };
    },
  );
};
