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
import { requirePermission } from "../security/authz.ts";
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
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.amber;

  const scopeOf = (request: FastifyRequest) => {
    const params = parseParams(settingsScopeParamsSchema, request);
    return { scopeType: params.scopeType, scopeId: params.scopeId ?? null };
  };

  const read = (request: FastifyRequest): ScopeSettingsResponse => {
    const { scopeType, scopeId } = scopeOf(request);
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
      return {
        repoId: id,
        settings: resolveSettings(db, id),
        explanation: explainSettings(db, id),
      };
    },
  );
};
