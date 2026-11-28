import { isPermissionKey, type PermissionKey } from "@amber/shared";
import type { FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import type { Db } from "../db/db.ts";
import { DomainError, forbidden, notFound } from "../domain/errors.ts";
import type { User } from "../domain/users.ts";

/**
 * Authorization. Two layers, both fail closed:
 *
 * 1. COARSE, per route. Every route under /api declares what it needs in its
 *    Fastify route config: `config: { authz: "user" }`. One hook enforces it
 *    before any handler runs, and a route that declares nothing is refused at
 *    boot (assertRouteDeclaresAuthz, wired in app.ts) and again at request
 *    time, so forgetting the declaration can never mean "open".
 * 2. OBJECT LEVEL, in handlers, through the helpers below and never ad hoc:
 *    canView, requireRepoView, requireRepoOwnerOrAdmin, requireRepoEdit and
 *    visibleRepoSqlFilter. A repo the caller cannot view answers exactly
 *    like one that does not exist (404), never 403.
 */

/**
 * - `public`: no identity needed (nothing under /api uses it today; the
 *   public paths are /healthz and /git, outside /api).
 * - `user`: any accepted identity.
 * - `admin`: the admin only. Not delegable.
 * - a permission key: the admin, or a user holding that permission.
 */
export type AuthzRequirement = "public" | "user" | "admin" | PermissionKey;

declare module "fastify" {
  interface FastifyContextConfig {
    authz?: AuthzRequirement;
  }
}

export function isAuthzRequirement(value: unknown): value is AuthzRequirement {
  return (
    value === "public" ||
    value === "user" ||
    value === "admin" ||
    (typeof value === "string" && isPermissionKey(value))
  );
}

/** The admin holds every permission; anyone else holds what their row grants. */
export function hasPermission(user: User, key: PermissionKey): boolean {
  return user.isAdmin || user.permissions[key];
}

export function meetsRequirement(user: User | undefined, requirement: AuthzRequirement): boolean {
  if (requirement === "public") {
    return true;
  }
  if (user === undefined || user.removedAt !== null) {
    return false;
  }
  if (requirement === "user") {
    return true;
  }
  if (requirement === "admin") {
    return user.isAdmin;
  }
  return hasPermission(user, requirement);
}

/** The details a 403 carries, so the UI can say what is missing. */
function forbiddenFor(requirement: AuthzRequirement): DomainError {
  if (requirement === "admin") {
    return forbidden("Only the admin can do this.", { requires: "admin" });
  }
  return forbidden(`This needs the "${requirement}" permission.`, { permission: requirement });
}

/**
 * Boot-time guard, called from an onRoute hook registered at the ROOT before
 * any plugin, so it sees /api routes wherever they were registered. Throwing
 * here aborts registration, which makes buildApp reject.
 */
export function assertRouteDeclaresAuthz(
  route: Pick<RouteOptions, "url" | "method" | "config">,
): void {
  if (!isApiPath(route.url)) {
    return;
  }
  const authz = (route.config as { authz?: unknown } | undefined)?.authz;
  if (!isAuthzRequirement(authz)) {
    const method = Array.isArray(route.method) ? route.method.join(",") : String(route.method);
    throw new Error(
      `Route ${method} ${route.url} declares no valid config.authz. Every /api route must say ` +
        'what it needs: "public", "user", "admin" or a permission key.',
    );
  }
}

export function isApiPath(url: string): boolean {
  return url === "/api" || url.startsWith("/api/");
}

/**
 * The one coarse hook, registered inside the /api scope. Unknown /api paths
 * reach Fastify's not-found handler, which has no route config of its own:
 * any accepted identity gets the pinned 404 there rather than a 403.
 */
export async function enforceRouteAuthz(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const requirement: unknown = request.is404 ? "user" : request.routeOptions.config.authz;
  if (!isAuthzRequirement(requirement)) {
    request.log.error(
      { url: request.routeOptions.url, method: request.method },
      "route without an authz declaration reached the authz hook; refusing",
    );
    return reply.code(403).send({
      error: "forbidden",
      message: "This route declares no access requirement, so it is refused.",
    });
  }
  if (requirement === "public") {
    return undefined;
  }
  if (request.user === undefined) {
    return reply.code(401).send({
      error: "unauthorized",
      message: "Valid Cloudflare Access authentication is required.",
    });
  }
  if (!meetsRequirement(request.user, requirement)) {
    const error = forbiddenFor(requirement);
    return reply.code(error.status).send({
      error: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  return undefined;
}

/**
 * The accepted identity of a request. Handlers behind the authz hook always
 * have one; its absence is a wiring bug, answered as 401 rather than guessed.
 */
export function requireRequestUser(request: FastifyRequest): User {
  const user = request.user;
  if (user === undefined) {
    throw new DomainError("unauthorized", "Valid Cloudflare Access authentication is required.");
  }
  return user;
}

/** In-handler permission check, for requirements that depend on the body or path. */
export function requirePermission(request: FastifyRequest, key: PermissionKey): User {
  const user = requireRequestUser(request);
  if (!hasPermission(user, key)) {
    throw forbiddenFor(key);
  }
  return user;
}

export function requireAdmin(request: FastifyRequest): User {
  const user = requireRequestUser(request);
  if (!user.isAdmin) {
    throw forbiddenFor("admin");
  }
  return user;
}

// ---------------------------------------------------------------------------
// Object level: repositories
// ---------------------------------------------------------------------------

/**
 * The facts visibility is decided on. A NULL owner (a row from before
 * ownership existed that missed the backfill) is nobody's, so only the admin
 * and the permission-based clauses can see it.
 */
export interface RepoAccessFacts {
  id: number;
  ownerUserId: number | null;
  isPrivate: boolean;
}

/**
 * VISIBILITY: the admin, OR the owner, OR (public AND view_others_public), OR
 * (private AND view_others_private). Unknown visibility is stored as private.
 */
export function canView(
  user: User,
  repo: Pick<RepoAccessFacts, "ownerUserId" | "isPrivate">,
): boolean {
  if (user.removedAt !== null) {
    return false;
  }
  if (user.isAdmin) {
    return true;
  }
  if (repo.ownerUserId !== null && repo.ownerUserId === user.id) {
    return true;
  }
  return repo.isPrivate
    ? user.permissions.view_others_private
    : user.permissions.view_others_public;
}

/**
 * Whether `user` may learn that a repo they can VIEW is gone upstream (its
 * goneAt, the repo.gone event, the gone web push). Their own repos always;
 * anyone else's only with `view_removed`, which is what the Removed page is.
 * Callers check canView first: this never widens visibility.
 */
export function maySeeGone(user: User, repo: Pick<RepoAccessFacts, "ownerUserId">): boolean {
  return user.isAdmin || isRepoOwner(user, repo) || hasPermission(user, "view_removed");
}

export function isRepoOwner(user: User, repo: Pick<RepoAccessFacts, "ownerUserId">): boolean {
  return repo.ownerUserId !== null && repo.ownerUserId === user.id;
}

export function loadRepoAccessFacts(db: Db, id: number): RepoAccessFacts | undefined {
  const row = db.get<{ id: number; owner_user_id: number | null; is_private: number }>(
    "SELECT id, owner_user_id, is_private FROM repos WHERE id = ?",
    id,
  );
  return row === undefined
    ? undefined
    : { id: row.id, ownerUserId: row.owner_user_id, isPrivate: row.is_private !== 0 };
}

function dbOf(request: FastifyRequest): Db {
  return request.server.amber.db;
}

/** The repo, when the caller can view it. Otherwise the same 404 as a missing id. */
export function requireRepoView(request: FastifyRequest, id: number): RepoAccessFacts {
  const user = requireRequestUser(request);
  const facts = loadRepoAccessFacts(dbOf(request), id);
  if (facts === undefined || !canView(user, facts)) {
    throw notFound("Repository", id);
  }
  return facts;
}

/**
 * Owner or admin only: changing `path` or setting `account_override_id`
 * decides what the OWNER'S token fetches, so modify_others is not enough.
 * Invisible repos are still a 404.
 */
export function requireRepoOwnerOrAdmin(request: FastifyRequest, id: number): RepoAccessFacts {
  const user = requireRequestUser(request);
  const facts = requireRepoView(request, id);
  if (!user.isAdmin && !isRepoOwner(user, facts)) {
    throw forbidden("Only the repository's owner or the admin can do this.", {
      requires: "owner",
    });
  }
  return facts;
}

/**
 * Edit a repo: settings, pause, resume, sync now, force_anonymous, delete.
 * The owner and the admin always may; anyone else needs modify_others on a
 * repo they can view.
 */
export function requireRepoEdit(request: FastifyRequest, id: number): RepoAccessFacts {
  const user = requireRequestUser(request);
  const facts = requireRepoView(request, id);
  if (!user.isAdmin && !isRepoOwner(user, facts) && !user.permissions.modify_others) {
    throw forbiddenFor("modify_others");
  }
  return facts;
}

export interface SqlFilter {
  /** A parenthesized boolean expression, safe to AND into a WHERE clause. */
  sql: string;
  params: (number | string)[];
}

const SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * canView as SQL, so lists and their totals are filtered in the query rather
 * than after paging. `alias` names the repos table in the caller's query.
 */
export function visibleRepoSqlFilter(user: User, alias = "repos"): SqlFilter {
  if (!SQL_ALIAS.test(alias)) {
    throw new Error(`visibleRepoSqlFilter: unsafe table alias ${JSON.stringify(alias)}`);
  }
  if (user.removedAt !== null) {
    return { sql: "(0)", params: [] };
  }
  if (user.isAdmin) {
    return { sql: "(1)", params: [] };
  }
  const clauses = [`${alias}.owner_user_id = ?`];
  if (user.permissions.view_others_public) {
    clauses.push(`${alias}.is_private = 0`);
  }
  if (user.permissions.view_others_private) {
    clauses.push(`${alias}.is_private = 1`);
  }
  return { sql: `(${clauses.join(" OR ")})`, params: [user.id] };
}
