import type { Db } from "../db/db.ts";
import { getUser, type User } from "../domain/users.ts";
import type { MembershipDecision } from "../security/accessPolicy.ts";
import { hasPermission } from "../security/authz.ts";
import {
  generateGitPassword,
  hashGitPassword,
  verifyGitPassword,
} from "../security/gitPassword.ts";
import { isGitRemoteEnabled } from "./config.ts";
import { findGitCredential, isWellFormedGitUsername, readGitPasswordHash } from "./credentials.ts";
import type { AuthThrottle } from "./throttle.ts";

/**
 * Authentication for /git, the one surface outside Cloudflare Access. Every
 * step fails closed, and the order is part of the contract:
 *
 * 1. Kill switch off: 404 for everything, before a credential is read.
 * 2. Parse HTTP Basic. A request without it is the normal first leg of every
 *    git clone, so it always gets the challenge and spends no token.
 * 3. Throttle (throttle.ts), before anything is derived: the (address,
 *    username) bucket, and the address bucket unless that username has logged
 *    in from that address before.
 * 4. Look the credential up by username. When there is none, scrypt still
 *    runs against a dummy hash, so response time does not say which
 *    usernames exist.
 * 5. Verify the password (timing safe).
 * 6. Refuse a removed user and one without `git`, with the same 401.
 * 7. THE MEMBERSHIP RULE for everyone but the admin: not a member is the same
 *    401; a policy Amber cannot read is 503 with a plain text reason.
 *
 * Repository visibility (canView) is the caller's next step, in routes.ts.
 */

export type GitAuthFailure =
  | { ok: false; status: 404; reason: "disabled" }
  | { ok: false; status: 429; reason: "throttled"; retryAfterSeconds: number }
  | {
      ok: false;
      status: 401;
      reason: "no_credentials" | "bad_credentials" | "not_permitted" | "not_member" | "changed";
      userId?: number;
    }
  | { ok: false; status: 503; reason: "policy_unavailable"; userId: number };

export type GitAuthResult = { ok: true; user: User } | GitAuthFailure;

export interface GitAuthDeps {
  db: Db;
  policy: { membership(email: string): Promise<MembershipDecision> };
  throttle: AuthThrottle;
  /** Test seam, so a test can prove the derivation ran on every path. */
  verifyPassword?: (password: string, stored: string) => boolean;
}

export interface GitAuthRequest {
  authorization: unknown;
  ip: string;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

export function parseBasicAuth(header: unknown): BasicCredentials | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (match === null) {
    return null;
  }
  const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

let dummyHash: string | undefined;

/**
 * A real scrypt record with the current parameters, for a password nobody
 * knows (it is generated and dropped). It has to PARSE: verifyGitPassword
 * returns early on a malformed record, which would make an unknown username
 * measurably faster than a wrong password. Built once, on first use, so no
 * boot pays for it.
 */
export function dummyGitPasswordHash(): string {
  dummyHash ??= hashGitPassword(generateGitPassword());
  return dummyHash;
}

export async function authenticateGitRequest(
  deps: GitAuthDeps,
  request: GitAuthRequest,
): Promise<GitAuthResult> {
  const { db, throttle } = deps;
  const verify = deps.verifyPassword ?? verifyGitPassword;

  if (!isGitRemoteEnabled(db)) {
    return { ok: false, status: 404, reason: "disabled" };
  }

  const ip = request.ip;

  const credentials = parseBasicAuth(request.authorization);
  if (credentials === null) {
    // Always the challenge, even from a throttled address: it derives
    // nothing, and it is the first leg of every real clone (git sends Basic
    // only after a 401). Answering 429 here would lock a known-good user out
    // of a sprayed address before their credentials ever reached the
    // per-username check below.
    return { ok: false, status: 401, reason: "no_credentials" };
  }
  // Parsing Basic costs nothing; the derivation below is what the throttle
  // protects, and it needs the username to tell a known address apart.
  const throttleName = credentials.username;
  if (!throttle.allow(ip, throttleName)) {
    return {
      ok: false,
      status: 429,
      reason: "throttled",
      retryAfterSeconds: throttle.retryAfterSeconds(ip, throttleName),
    };
  }

  const stored = isWellFormedGitUsername(credentials.username)
    ? findGitCredential(db, credentials.username)
    : undefined;
  // Exactly one derivation on every path, found or not.
  const passwordOk = verify(credentials.password, stored?.passwordHash ?? dummyGitPasswordHash());
  if (stored === undefined || !passwordOk) {
    throttle.recordFailure(ip, throttleName);
    return { ok: false, status: 401, reason: "bad_credentials" };
  }

  const refuse = (reason: "not_permitted" | "not_member" | "changed"): GitAuthFailure => {
    throttle.recordFailure(ip, throttleName);
    return { ok: false, status: 401, reason, userId: stored.userId };
  };

  /** Still the same live credential, on a user who may use it. */
  const current = (): User | null => {
    const user = getUser(db, stored.userId);
    if (user === undefined || user.removedAt !== null || !hasPermission(user, "git")) {
      return null;
    }
    return readGitPasswordHash(db, user.id) === stored.passwordHash ? user : null;
  };

  const user = current();
  if (user === null) {
    return refuse("not_permitted");
  }
  if (user.isAdmin) {
    // The admin is exempt from the membership rule, exactly as on the web
    // path: a Cloudflare outage or a policy edit can never lock them out.
    throttle.recordSuccess(ip, throttleName);
    return { ok: true, user };
  }

  let decision: MembershipDecision;
  try {
    decision = await deps.policy.membership(user.email);
  } catch {
    decision = "unavailable";
  }
  if (decision === "unavailable") {
    // The password was right, so this does not count against the address.
    return { ok: false, status: 503, reason: "policy_unavailable", userId: user.id };
  }
  if (decision !== "allow") {
    return refuse("not_member");
  }

  // The membership read may have run a refresh that reconciled the users
  // table (removing this user and deleting the hash just verified), and an
  // admin revoke or a rotation may have landed during the await. Re-read and
  // require the same live credential.
  const after = current();
  if (after === null) {
    return refuse("changed");
  }
  throttle.recordSuccess(ip, throttleName);
  return { ok: true, user: after };
}
