import {
  idParamsSchema,
  settingsPatchSchema,
  settingsScopeParamsSchema,
  type EffectiveSettingsResponse,
  type ScopeSettingsResponse,
} from "@amber/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  explainSettings,
  getScopeSettings,
  putScopeSettings,
  resolveSettings,
} from "../domain/settings.ts";
import { parseBody, parseParams } from "./validate.ts";

/**
 * /api/settings/:scopeType/:scopeId and effective-settings explain.
 *
 * Values are validated per key against shared/src/settingsRegistry.ts, which
 * also decides which scopes a key may be stored at. Unknown keys are rejected
 * rather than dropped, so a typo cannot look like it saved.
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

  const write = (request: FastifyRequest): ScopeSettingsResponse => {
    const { scopeType, scopeId } = scopeOf(request);
    const patch = parseBody(settingsPatchSchema, request);
    return { scopeType, scopeId, values: putScopeSettings(db, scopeType, scopeId, patch) };
  };

  // Global settings carry no id, so both shapes of the path are registered.
  app.get("/settings/:scopeType", read);
  app.get("/settings/:scopeType/:scopeId", read);
  app.put("/settings/:scopeType", write);
  app.put("/settings/:scopeType/:scopeId", write);

  app.get("/repos/:id/effective-settings", (request): EffectiveSettingsResponse => {
    const { id } = parseParams(idParamsSchema, request);
    return {
      repoId: id,
      settings: resolveSettings(db, id),
      explanation: explainSettings(db, id),
    };
  });
};
