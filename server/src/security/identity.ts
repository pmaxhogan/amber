import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import {
  ensureMemberRow,
  getAdminUser,
  normalizeEmail,
  touchLastSeen,
  type User,
} from "../domain/users.ts";
import type { AccessPolicy } from "./accessPolicy.ts";
import { DEFAULT_PUBLIC_PREFIXES, isPublicPath, requestPathname } from "./cfAccess.ts";

/**
 * Who is asking. Runs right after the Cloudflare Access hook on every path it
 * guards, and ends every accepted request with `request.user`: the users row,
 * its effective permissions, and whether it is the admin.
 *
 * - The admin email is accepted on any valid token, whatever policy admitted
 *   it and whether or not the policy can be read: editing the users policy or
 *   a Cloudflare outage can never lock the admin out.
 * - Anyone else goes through THE MEMBERSHIP RULE (accessPolicy.ts): not a
 *   member is 403 `not_a_user`, a policy that cannot be read and has no fresh
 *   enough copy is 503 `policy_unavailable`. No policy configured means
 *   admin-only.
 * - A removed user (`removed_at`) is refused everywhere.
 *
 * Insecure mode has no tokens at all: every request is the admin, as before.
 * For tests and local development a request may carry X-Amber-Insecure-User
 * naming one of INSECURE_USER_EMAILS to act as that user. It can only ever
 * LOWER a request's privilege, since the default is already the admin, and an
 * address outside that list is refused rather than ignored.
 */

export const INSECURE_USER_HEADER = "x-amber-insecure-user";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on every accepted request outside the public prefixes. */
    user?: User;
  }
}

export interface IdentityOptions {
  config: Config;
  db: Db;
  policy: AccessPolicy;
  now?: () => number;
  publicPrefixes?: readonly string[];
}

const NOT_A_USER = {
  error: "not_a_user",
  message:
    "Your sign-in worked, but this Amber instance has not given your account access. " +
    "Ask the admin to add you.",
};

const POLICY_UNAVAILABLE = {
  error: "policy_unavailable",
  message: "Amber cannot confirm your access right now. Try again in a minute.",
};

/** The insecure-mode header, when present: one address, lower cased. */
function insecureUserHeader(request: FastifyRequest): string | null {
  const raw = request.headers[INSECURE_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return null;
  }
  const email = normalizeEmail(value);
  return email === "" ? null : email;
}

type Resolution = { user: User } | { refuse: "not_a_user" | "policy_unavailable" | "unauthorized" };

const plugin: FastifyPluginAsync<IdentityOptions> = async (
  app: FastifyInstance,
  options: IdentityOptions,
) => {
  const { config, db, policy } = options;
  const now = options.now ?? Date.now;
  const publicPrefixes = options.publicPrefixes ?? DEFAULT_PUBLIC_PREFIXES;
  const log = app.log.child({ mod: "identity" });

  /** A member of the policy, as their row. Removed rows are refused. */
  const member = (email: string): Resolution => {
    const user = ensureMemberRow(db, email, now());
    if (user.isAdmin || user.removedAt !== null) {
      // isAdmin here would mean the admin row's address differs from the
      // configured admin email; that identity is not accepted as the admin.
      return { refuse: "not_a_user" };
    }
    return { user };
  };

  const resolveInsecure = (request: FastifyRequest): Resolution => {
    const admin = getAdminUser(db);
    const asked = insecureUserHeader(request);
    if (asked === null || asked === admin.email) {
      return { user: admin };
    }
    if (!config.insecureUserEmails.includes(asked)) {
      return { refuse: "not_a_user" };
    }
    return member(asked);
  };

  const resolveSecure = async (request: FastifyRequest): Promise<Resolution> => {
    const email = request.cfAccess?.email;
    if (email === undefined) {
      // The token hook answers 401 before this runs; reaching here without a
      // verified email means that hook was not installed. Fail closed.
      return { refuse: "unauthorized" };
    }
    if (config.adminEmail !== null && email === config.adminEmail) {
      const admin = getAdminUser(db);
      if (admin.email !== email) {
        // Boot points the admin row at the configured address; a mismatch is
        // a database edited behind Amber's back. Refuse rather than guess.
        return { refuse: "not_a_user" };
      }
      return { user: admin };
    }
    const decision = await policy.membership(email);
    if (decision === "unavailable") {
      return { refuse: "policy_unavailable" };
    }
    if (decision === "not_member") {
      return { refuse: "not_a_user" };
    }
    return member(email);
  };

  const refuse = async (
    reply: FastifyReply,
    reason: "not_a_user" | "policy_unavailable" | "unauthorized",
  ): Promise<FastifyReply> => {
    if (reason === "policy_unavailable") {
      return reply.code(503).header("retry-after", "30").send(POLICY_UNAVAILABLE);
    }
    if (reason === "unauthorized") {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Valid Cloudflare Access authentication is required.",
      });
    }
    return reply.code(403).send(NOT_A_USER);
  };

  app.addHook("onRequest", async (request, reply) => {
    const pathname = requestPathname(request.url);
    if (isPublicPath(pathname, publicPrefixes)) {
      return;
    }

    const resolution = config.insecureMode
      ? resolveInsecure(request)
      : await resolveSecure(request);

    if ("refuse" in resolution) {
      // The reason and the path, never the address: emails stay out of logs.
      log.warn(
        { pathname, method: request.method, reason: resolution.refuse },
        "refused an identity",
      );
      await refuse(reply, resolution.refuse);
      // As in cfAccess: an async hook that answered must not reach a handler.
      return reply;
    }

    request.user = resolution.user;
    try {
      touchLastSeen(db, resolution.user, now());
    } catch (error) {
      // Being seen is a hint; a busy database must not fail the request.
      log.debug({ err: error }, "could not record last_seen_at");
    }
    return undefined;
  });
};

/** fastify-plugin for the same reason as cfAccess: the hook must cover every sibling route. */
export const identityPlugin = fp(plugin, {
  name: "amber-identity",
  fastify: "5.x",
});
