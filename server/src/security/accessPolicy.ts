import { accessPolicyEditUrl, type PolicyStatus } from "@amber/shared";
import type { Logger } from "pino";
import { z } from "zod";
import type { RedactedSecret } from "../config.ts";
import type { Db } from "../db/db.ts";
import {
  normalizeEmail,
  normalizeEmailList,
  reconcileUsers,
  type ReconcileChanges,
} from "../domain/users.ts";

/**
 * Who besides the admin is a user: exactly the explicit `email` include rules
 * of one reusable Cloudflare Access policy, read with a token whose only scope
 * is "Access: Apps and Policies Read".
 *
 * One in-process copy `{ emails, fetchedAt }`, mirrored to kv so a restart
 * starts from the last good list rather than from nothing. Every refresh is
 * single flight with a timeout, failures back off, and a successful refresh
 * reconciles the users table in one transaction.
 *
 * THE MEMBERSHIP RULE (membership() below) is the one function both the web
 * identity hook and git authentication use for every non-admin identity.
 */

/** How often the background timer re-reads the policy. */
export const POLICY_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A copy older than this is refreshed before it answers a membership question. */
export const POLICY_MAX_AGE_MS = 60_000;
/** When a refresh fails, a copy younger than this is still used; anything older fails closed. */
export const POLICY_STALE_LIMIT_MS = 5 * 60_000;
export const POLICY_FETCH_TIMEOUT_MS = 15_000;
/** After a failed read, the next attempt waits at least this long. */
export const POLICY_FAILURE_BACKOFF_MS = 30_000;

export const KV_POLICY_EMAILS = "access_policy.emails";
export const KV_POLICY_FETCHED_AT = "access_policy.fetched_at";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export type MembershipDecision = "allow" | "not_member" | "unavailable";

/** The slice of a fetch Response the reader uses. */
export interface PolicyFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Test seam: production passes the global fetch. Tests inject a function that
 * answers without the network.
 */
export type PolicyFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<PolicyFetchResponse>;

export type PolicySource =
  | { kind: "cloudflare"; accountId: string; policyId: string; apiToken: RedactedSecret }
  /** Insecure mode: INSECURE_USER_EMAILS stands in for the policy and never goes stale. */
  | { kind: "static"; emails: readonly string[] };

export interface RefreshOutcome {
  ok: boolean;
  /** Why the read failed. Never carries the token. */
  error: string | null;
  changes: ReconcileChanges;
}

export interface AccessPolicyOptions {
  db: Db;
  log: Logger;
  /** Null: no policy configured, so the instance is admin-only. */
  source: PolicySource | null;
  fetch?: PolicyFetch;
  now?: () => number;
  apiBase?: string;
}

const NO_CHANGES: ReconcileChanges = { created: 0, removed: 0, restored: 0 };

/**
 * The response envelope. Anything that does not match is a FAILED read, never
 * an empty list: reconciliation is destructive (it removes users and deletes
 * their git passwords), so only a parsed envelope may reach it.
 */
const ruleSchema = z.record(z.string(), z.unknown());
const policyResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    include: z.array(ruleSchema),
    exclude: z.array(ruleSchema).nullish(),
    require: z.array(ruleSchema).nullish(),
  }),
});

const emailRuleSchema = z.object({ email: z.object({ email: z.string().min(3) }) });

class PolicyReadError extends Error {
  override readonly name = "PolicyReadError";
}

interface ParsedPolicy {
  emails: string[];
  ignoredKinds: string[];
  hasRequireRules: boolean;
}

/**
 * Explicit email include rules, lower cased, minus explicit email EXCLUDE
 * rules. The spec only names include; an excluded address is also refused at
 * the edge, and git bypasses the edge, so honouring the exclusion here keeps
 * the git path from being looser than the web path.
 */
export function parsePolicyResponse(body: unknown): ParsedPolicy {
  const parsed = policyResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new PolicyReadError("Cloudflare answered with an unexpected policy shape.");
  }
  const ignored = new Set<string>();

  const emailsOf = (rules: readonly Record<string, unknown>[], record: boolean): string[] => {
    const out: string[] = [];
    for (const rule of rules) {
      if ("email" in rule) {
        const email = emailRuleSchema.safeParse(rule);
        if (!email.success) {
          // A malformed email rule would otherwise read as that user leaving.
          throw new PolicyReadError("Cloudflare answered with a malformed email rule.");
        }
        // An entry normalizeEmail refuses is passed through as written:
        // reconcileUsers and the membership set skip it with a warn, so it
        // never becomes anyone's identity.
        const raw = email.data.email.email;
        out.push(normalizeEmail(raw) ?? raw.trim());
        continue;
      }
      if (record) {
        for (const kind of Object.keys(rule)) {
          ignored.add(kind);
        }
      }
    }
    return out;
  };

  const include = emailsOf(parsed.data.result.include, true);
  const exclude = new Set(emailsOf(parsed.data.result.exclude ?? [], false));
  return {
    emails: [...new Set(include)].filter((email) => !exclude.has(email)).sort(),
    ignoredKinds: [...ignored].sort(),
    hasRequireRules: (parsed.data.result.require ?? []).length > 0,
  };
}

function readKv(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
}

function writeKv(db: Db, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now,
    now,
  );
}

export class AccessPolicy {
  readonly #db: Db;
  readonly #log: Logger;
  readonly #source: PolicySource | null;
  readonly #fetch: PolicyFetch;
  readonly #now: () => number;
  readonly #apiBase: string;

  #emails: Set<string> | null = null;
  #fetchedAt: number | null = null;
  #lastFailureAt: number | null = null;
  #lastError: string | null = null;
  #inflight: Promise<RefreshOutcome> | null = null;
  #timer: NodeJS.Timeout | null = null;
  readonly #warnedKinds = new Set<string>();
  #warnedRequire = false;

  constructor(options: AccessPolicyOptions) {
    this.#db = options.db;
    this.#log = options.log.child({ mod: "accessPolicy" });
    this.#source = options.source;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as PolicyFetch);
    this.#now = options.now ?? Date.now;
    this.#apiBase = options.apiBase ?? CLOUDFLARE_API_BASE;

    if (this.#source?.kind === "static") {
      // The stand-in list is authoritative and constant, so it is reconciled
      // once and never refreshed.
      this.#emails = new Set(normalizeEmailList(this.#source.emails));
      this.#fetchedAt = this.#now();
      reconcileUsers(this.#db, this.#source.emails, this.#now(), this.#log);
    } else if (this.#source?.kind === "cloudflare") {
      this.#loadMirror();
    }
  }

  get configured(): boolean {
    return this.#source !== null;
  }

  /** The copy in use, for tests and diagnostics. */
  emails(): readonly string[] | null {
    return this.#emails === null ? null : [...this.#emails].sort();
  }

  get fetchedAt(): number | null {
    return this.#fetchedAt;
  }

  /** What the admin sees in GET /api/me and the Users page. */
  status(): PolicyStatus {
    const source = this.#source;
    if (source === null) {
      return { configured: false, fetchedAt: null, stale: false, editUrl: null, lastError: null };
    }
    const editUrl =
      source.kind === "cloudflare" ? accessPolicyEditUrl(source.accountId, source.policyId) : null;
    if (source.kind === "static") {
      return {
        configured: true,
        fetchedAt: this.#fetchedAt,
        stale: false,
        editUrl,
        lastError: null,
      };
    }
    const age = this.#fetchedAt === null ? Infinity : this.#now() - this.#fetchedAt;
    const lastFailed =
      this.#lastFailureAt !== null &&
      (this.#fetchedAt === null || this.#lastFailureAt >= this.#fetchedAt);
    return {
      configured: true,
      fetchedAt: this.#fetchedAt,
      // Two missed background refreshes also count, so a timer that stopped
      // for any reason does not look healthy.
      stale: lastFailed || age > 2 * POLICY_REFRESH_INTERVAL_MS,
      editUrl,
      lastError: lastFailed ? this.#lastError : null,
    };
  }

  /**
   * THE MEMBERSHIP RULE, for every non-admin identity on every path:
   *
   * - no policy configured: not a member (the instance is admin-only);
   * - a copy older than 60 seconds (or none at all) is refreshed first;
   * - when that refresh fails, a copy less than 5 minutes old is still used,
   *   and anything older FAILS CLOSED as "unavailable".
   *
   * Inside the failure backoff the refresh fails immediately rather than
   * waiting, so a request never sleeps here.
   */
  async membership(email: string): Promise<MembershipDecision> {
    const source = this.#source;
    if (source === null) {
      return "not_member";
    }
    const normalized = normalizeEmail(email);
    if (normalized === null) {
      return "not_member";
    }
    if (source.kind === "static") {
      return this.#emails?.has(normalized) === true ? "allow" : "not_member";
    }

    if (this.#fetchedAt === null || this.#now() - this.#fetchedAt > POLICY_MAX_AGE_MS) {
      const outcome = await this.refresh();
      if (!outcome.ok) {
        const age = this.#fetchedAt === null ? Infinity : this.#now() - this.#fetchedAt;
        if (!(age < POLICY_STALE_LIMIT_MS)) {
          return "unavailable";
        }
      }
    }
    return this.#emails?.has(normalized) === true ? "allow" : "not_member";
  }

  /**
   * Re-read the policy now. Single flight: concurrent callers share one
   * request. Within the backoff after a failure no request is made at all.
   */
  refresh(): Promise<RefreshOutcome> {
    const source = this.#source;
    if (source === null) {
      return Promise.resolve({
        ok: false,
        error: "No access policy is configured.",
        changes: NO_CHANGES,
      });
    }
    if (source.kind === "static") {
      return Promise.resolve({ ok: true, error: null, changes: NO_CHANGES });
    }
    if (this.#inflight !== null) {
      return this.#inflight;
    }
    const now = this.#now();
    const failedLast =
      this.#lastFailureAt !== null &&
      (this.#fetchedAt === null || this.#lastFailureAt >= this.#fetchedAt);
    if (
      failedLast &&
      this.#lastFailureAt !== null &&
      now - this.#lastFailureAt < POLICY_FAILURE_BACKOFF_MS
    ) {
      return Promise.resolve({
        ok: false,
        error: this.#lastError ?? "The last policy read failed; retrying shortly.",
        changes: NO_CHANGES,
      });
    }

    const run = this.#read(source).finally(() => {
      this.#inflight = null;
    });
    this.#inflight = run;
    return run;
  }

  /** Background refresh every 5 minutes. Unref'd, so it never holds the process open. */
  start(): void {
    if (this.#source?.kind !== "cloudflare" || this.#timer !== null) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.refresh();
    }, POLICY_REFRESH_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #loadMirror(): void {
    const rawEmails = readKv(this.#db, KV_POLICY_EMAILS);
    const rawFetchedAt = readKv(this.#db, KV_POLICY_FETCHED_AT);
    if (rawEmails === undefined || rawFetchedAt === undefined) {
      return;
    }
    try {
      const emails = z.array(z.string()).parse(JSON.parse(rawEmails));
      const fetchedAt = Number.parseInt(rawFetchedAt, 10);
      if (!Number.isSafeInteger(fetchedAt)) {
        return;
      }
      this.#emails = new Set(normalizeEmailList(emails));
      this.#fetchedAt = fetchedAt;
    } catch {
      // A mirror that cannot be read is treated as no copy at all, which the
      // membership rule turns into a refresh, or a fail closed.
      this.#log.warn("the stored access policy copy could not be read; ignoring it");
    }
  }

  async #read(source: Extract<PolicySource, { kind: "cloudflare" }>): Promise<RefreshOutcome> {
    const token = source.apiToken.reveal();
    const url =
      `${this.#apiBase}/accounts/${encodeURIComponent(source.accountId)}` +
      `/access/policies/${encodeURIComponent(source.policyId)}`;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PolicyReadError("The Cloudflare API did not answer within 15 seconds."));
      }, POLICY_FETCH_TIMEOUT_MS);
      timer.unref();
    });

    try {
      const policy = await Promise.race([
        (async () => {
          const response = await this.#fetch(url, {
            method: "GET",
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new PolicyReadError(
              `The Cloudflare API answered ${String(response.status)} for the access policy.`,
            );
          }
          return parsePolicyResponse(await response.json());
        })(),
        timeout,
      ]);

      this.#noteIgnored(policy);
      const now = this.#now();
      const changes = this.#db.tx(() => {
        const result = reconcileUsers(this.#db, policy.emails, now, this.#log);
        writeKv(this.#db, KV_POLICY_EMAILS, JSON.stringify(policy.emails), now);
        writeKv(this.#db, KV_POLICY_FETCHED_AT, String(now), now);
        return result;
      });
      this.#emails = new Set(normalizeEmailList(policy.emails));
      this.#fetchedAt = now;
      this.#lastError = null;
      if (changes.created + changes.removed + changes.restored > 0) {
        this.#log.info({ ...changes, members: policy.emails.length }, "access policy reconciled");
      }
      return { ok: true, error: null, changes };
    } catch (error) {
      const message = this.#describe(error, token);
      this.#lastFailureAt = this.#now();
      this.#lastError = message;
      this.#log.warn({ reason: message }, "access policy refresh failed");
      return { ok: false, error: message, changes: NO_CHANGES };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Log once per kind, so a policy with a domain rule does not warn every 5 minutes. */
  #noteIgnored(policy: ParsedPolicy): void {
    const fresh = policy.ignoredKinds.filter((kind) => !this.#warnedKinds.has(kind));
    if (fresh.length > 0) {
      for (const kind of fresh) {
        this.#warnedKinds.add(kind);
      }
      this.#log.warn(
        { kinds: fresh },
        "the access policy has include rules that are not explicit emails; they are ignored, " +
          "and anyone admitted only by them is refused as not a user",
      );
    }
    if (policy.hasRequireRules && !this.#warnedRequire) {
      this.#warnedRequire = true;
      this.#log.warn(
        "the access policy has require rules; Amber cannot evaluate them, so the git remote " +
          "does not enforce them",
      );
    }
  }

  /** A message safe for logs and the admin's screen. The token never appears in it. */
  #describe(error: unknown, token: string): string {
    let message: string;
    if (error instanceof PolicyReadError) {
      message = error.message;
    } else if (error instanceof Error) {
      message = `The access policy could not be read (${error.name}: ${error.message}).`;
    } else {
      message = "The access policy could not be read.";
    }
    return token === "" ? message : message.split(token).join("[redacted]");
  }
}
