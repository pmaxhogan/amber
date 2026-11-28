import type { AmberEvent, PushDevice, PushPayload, PushSendResult } from "@amber/shared";
import type { Logger } from "pino";
import { generateVAPIDKeys, sendNotification } from "web-push";
import type { Db } from "../db/db.ts";
import { getAdminUser, getUser, listUsers } from "../domain/users.ts";
import type { EventMeta } from "../events.ts";
import { canView, loadRepoAccessFacts } from "../security/authz.ts";
import {
  EgressRefusedError,
  pinnedHttpsAgent,
  vetRestrictedUrl,
  type HostResolver,
  type VettedTarget,
} from "../security/egress.ts";

/**
 * Web push: tells subscribed browsers when a repository goes gone upstream.
 *
 * Standard Web Push (RFC 8030) with VAPID (RFC 8292), through the web-push
 * package (4.x is ESM with named exports only; its @types still describe the
 * old default export, which is undefined at runtime). Amber is its own application server: the key pair is generated on
 * first use and kept in the kv table, so a deployment needs no setup and no
 * third-party account. The private key is instance state like the git remote
 * password hash; it never leaves the server and is never logged.
 *
 * Gone repositories are batched for a short window before anything is sent. A
 * token that expires makes every private repository on that forge look gone
 * one after another, and those that cross the line together are one
 * notification, not two hundred.
 *
 * Every subscription belongs to the user whose browser made it, and every
 * notification goes to an explicit audience: a gone repository only to the
 * users who can view it (decided when the batch is sent, from fresh rows), a
 * storage cap crossing to that user and the admin, a test to the caller.
 *
 * EGRESS. A push endpoint is a URL a browser (that is, any user) hands us and
 * we later POST to, so it gets the restricted-forge rule (security/egress.ts):
 * https on 443, a DNS name, every address public. It is checked when the
 * subscription is saved AND again at every send, and the connection is pinned
 * to the addresses that passed, so a name that rebinds to an internal address
 * after subscribing is refused at the send that would reach it. What a failed
 * send records is a fixed category (PUSH_ERRORS), never the push service's
 * status line or body: anything more would turn "send me a test" into a probe
 * that reports what an arbitrary URL answered.
 */

export const KV_VAPID_PUBLIC = "push.vapid_public";
export const KV_VAPID_PRIVATE = "push.vapid_private";

/** How long gone repositories are collected before one notification goes out. */
export const GONE_BATCH_WINDOW_MS = 30_000;
/** A push service drops a message it could not deliver within this long. */
const TTL_SECONDS = 24 * 60 * 60;
/** Repositories named in one notification before it says "and N more". */
const MAX_NAMED = 3;

/**
 * The only strings a failed send ever stores or returns. Deliberately coarse:
 * the detail (status, body, resolved addresses) goes to the server log.
 */
export const PUSH_ERRORS = {
  refused: "Amber will not send to this push service: it is not on a public address.",
  rejected: "The push service refused the notification.",
  timeout: "The push service did not answer in time.",
  unreachable: "Could not reach the push service.",
} as const;
export type PushErrorCategory = keyof typeof PUSH_ERRORS;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The one call that leaves the process. Injectable so tests never do. `pin`
 * is the endpoint's host and the addresses that passed the egress check; the
 * sender must connect to those and nothing else.
 */
export type PushSender = (
  subscription: StoredSubscription,
  payload: string,
  vapid: VapidKeys & { subject: string },
  pin: VettedTarget,
) => Promise<void>;

interface SubscriptionRow extends StoredSubscription {
  user_agent: string | null;
  last_success_at: number | null;
  last_error: string | null;
  created_at: number;
}

interface GoneRepo {
  repoId: number;
  path: string;
  host: string;
  /** A GoneReason off the repo.gone event; absent on older or partial payloads. */
  reason?: string;
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

/** The instance key pair, generated the first time anything asks for it. */
export function ensureVapidKeys(db: Db, now: number = Date.now()): VapidKeys {
  const publicKey = readKv(db, KV_VAPID_PUBLIC);
  const privateKey = readKv(db, KV_VAPID_PRIVATE);
  if (publicKey !== undefined && privateKey !== undefined) {
    return { publicKey, privateKey };
  }
  const generated = generateVAPIDKeys();
  db.tx(() => {
    writeKv(db, KV_VAPID_PUBLIC, generated.publicKey, now);
    writeKv(db, KV_VAPID_PRIVATE, generated.privateKey, now);
  });
  return generated;
}

/**
 * VAPID wants a contact: an https URL or a mailto. Push services reject a
 * malformed one (Apple is strict), so anything that is not a real https
 * origin falls back to a syntactically valid placeholder address.
 */
export function vapidSubject(publicOrigin: string): string {
  try {
    const url = new URL(publicOrigin);
    if (url.protocol === "https:") {
      return url.origin;
    }
  } catch {
    // Fall through to the placeholder.
  }
  return "mailto:amber@example.invalid";
}

function serviceOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

/** The caller's own browsers. Nobody sees another user's devices. */
export function listPushDevices(db: Db, userId: number): PushDevice[] {
  return db
    .all<SubscriptionRow>(
      "SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id ASC",
      userId,
    )
    .map((row) => ({
      id: row.id,
      service: serviceOf(row.endpoint),
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
    }));
}

/**
 * Idempotent: a browser re-announcing itself refreshes its keys. The browser
 * belongs to whoever announced it LAST: a shared machine whose next user
 * subscribes the same push endpoint moves it to them, so the previous user's
 * notifications stop reaching a browser they no longer sit at.
 */
export function savePushSubscription(
  db: Db,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    /** The user whose browser this is. Required: never guessed. */
    userId: number;
  },
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO push_subscriptions
       (endpoint, p256dh, auth, user_agent, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
       user_id = excluded.user_id, last_error = NULL, updated_at = excluded.updated_at`,
    input.endpoint,
    input.p256dh,
    input.auth,
    input.userAgent,
    input.userId,
    now,
    now,
  );
}

/** Only the caller's own subscription; someone else's endpoint is left alone. */
export function deletePushSubscription(db: Db, endpoint: string, userId: number): boolean {
  return (
    db.run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", endpoint, userId)
      .changes > 0
  );
}

/**
 * Refuse an endpoint the egress rule does not allow. Called when a browser
 * subscribes; send() runs the same check again every time.
 */
export async function assertPushEndpointAllowed(
  endpoint: string,
  resolver?: HostResolver,
): Promise<VettedTarget> {
  return vetRestrictedUrl(endpoint, resolver);
}

const defaultSender: PushSender = async (subscription, payload, vapid, pin) => {
  // web-push issues one https.request; this agent's lookup answers only with
  // the validated addresses, while TLS still checks the certificate against
  // the endpoint's host name.
  const agent = pinnedHttpsAgent(pin);
  try {
    await sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      payload,
      {
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        TTL: TTL_SECONDS,
        urgency: "high",
        timeout: 15_000,
        agent,
      },
    );
  } finally {
    agent.destroy();
  }
};

function categoryOf(cause: unknown, status: number | null): PushErrorCategory {
  if (cause instanceof EgressRefusedError) {
    return "refused";
  }
  if (status !== null) {
    return "rejected";
  }
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  return /timeout|timed out/i.test(text) ? "timeout" : "unreachable";
}

function statusOf(cause: unknown): number | null {
  if (typeof cause === "object" && cause !== null && "statusCode" in cause) {
    const status = (cause as { statusCode: unknown }).statusCode;
    return typeof status === "number" ? status : null;
  }
  return null;
}

/** What a batch of gone repositories says on a lock screen. */
export function goneNotification(repos: readonly Omit<GoneRepo, "repoId">[]): PushPayload {
  const names = repos.map((repo) => `${repo.host}/${repo.path}`);
  if (names.length === 1 && repos[0]?.reason === "dmca_takedown") {
    return {
      title: "A repository was taken down",
      body: `${names[0] ?? ""} was removed by a DMCA takedown. Amber is keeping its backup.`,
      url: "/removed",
      tag: "amber-gone",
    };
  }
  if (names.length === 1) {
    return {
      title: "A repository is gone upstream",
      body: `${names[0] ?? ""} can no longer be fetched. Amber is keeping its backup.`,
      url: "/removed",
      tag: "amber-gone",
    };
  }
  const named = names.slice(0, MAX_NAMED).join(", ");
  const rest = names.length - MAX_NAMED;
  return {
    title: `${String(names.length)} repositories are gone upstream`,
    body: `${named}${rest > 0 ? ` and ${String(rest)} more` : ""}. Amber is keeping their backups.`,
    url: "/removed",
    tag: "amber-gone",
  };
}

export interface PushNotifierOptions {
  db: Db;
  log: Logger;
  /** config.publicOrigin; becomes the VAPID contact when it is https. */
  publicOrigin: string;
  send?: PushSender;
  /** Test seam: the egress resolver for push endpoints. */
  resolveHost?: HostResolver;
  batchWindowMs?: number;
  now?: () => number;
}

/** What a storage cap crossing says, to the user and to the admin. */
export function capNotification(email: string, forAdmin: boolean): PushPayload {
  return forAdmin
    ? {
        title: "A user reached their storage cap",
        body: `${email} is at or over their storage cap. New repositories are refused until they are under it again.`,
        url: "/users",
        tag: "amber-cap",
      }
    : {
        title: "You reached your storage cap",
        body: "New repositories are refused until you are under it again. Your existing backups keep syncing.",
        url: "/",
        tag: "amber-cap",
      };
}

export interface PushNotifier {
  publicKey(): string;
  /** Feed it every bus event; it reacts to repo.gone and to cap crossings. */
  handleEvent(event: AmberEvent, meta?: EventMeta): void;
  /** Send to the subscribed browsers of exactly these users. Never throws. */
  send(payload: PushPayload, userIds: readonly number[]): Promise<PushSendResult>;
  /** Send whatever is batched right now. Resolves once it has gone out. */
  flush(): Promise<void>;
  /** Stops the batch timer; anything still batched is sent first. */
  close(): Promise<void>;
}

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const { db } = options;
  const log = options.log.child({ mod: "push" });
  const sender = options.send ?? defaultSender;
  const now = options.now ?? Date.now;
  const windowMs = options.batchWindowMs ?? GONE_BATCH_WINDOW_MS;

  let pending: GoneRepo[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const send = async (
    payload: PushPayload,
    userIds: readonly number[],
  ): Promise<PushSendResult> => {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) {
      return { sent: 0, failed: 0 };
    }
    const subscriptions = db.all<StoredSubscription>(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE user_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY id ASC`,
      ...ids,
    );
    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0 };
    }
    const vapid = { ...ensureVapidKeys(db, now()), subject: vapidSubject(options.publicOrigin) };
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          // Re-vetted at every send, so the address used is the one checked.
          const pin = await vetRestrictedUrl(subscription.endpoint, options.resolveHost);
          await sender(subscription, body, vapid, pin);
          sent += 1;
          db.run(
            "UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
            now(),
            now(),
            subscription.id,
          );
        } catch (cause) {
          failed += 1;
          const status = statusOf(cause);
          if (status === 404 || status === 410) {
            // The browser unsubscribed or the subscription expired: it is
            // never coming back, so keeping the row would fail forever.
            db.run("DELETE FROM push_subscriptions WHERE id = ?", subscription.id);
            log.info(
              { subscriptionId: subscription.id, status },
              "push subscription is gone, removing it",
            );
            return;
          }
          const category = categoryOf(cause, status);
          db.run(
            "UPDATE push_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?",
            PUSH_ERRORS[category],
            now(),
            subscription.id,
          );
          // The detail is for the operator only.
          log.warn(
            {
              subscriptionId: subscription.id,
              category,
              status,
              err: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
              ...(cause instanceof EgressRefusedError
                ? { reason: cause.reason, addresses: cause.addresses }
                : {}),
            },
            "push notification failed",
          );
        }
      }),
    );
    return { sent, failed };
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) {
      return inFlight;
    }
    const batch = pending;
    pending = [];
    inFlight = inFlight.then(async () => {
      try {
        // Per user: only the repositories that user can view right now. A
        // user who can see none of the batch gets nothing at all.
        let sent = 0;
        let failed = 0;
        for (const user of listUsers(db)) {
          if (user.removedAt !== null) {
            continue;
          }
          const theirs = batch.filter((repo) => {
            const facts = loadRepoAccessFacts(db, repo.repoId);
            return facts !== undefined && canView(user, facts);
          });
          if (theirs.length === 0) {
            continue;
          }
          const result = await send(goneNotification(theirs), [user.id]);
          sent += result.sent;
          failed += result.failed;
        }
        log.info({ repos: batch.length, sent, failed }, "sent the gone notification");
      } catch (cause) {
        // A notification must never take the process down.
        log.error({ err: cause }, "could not send the gone notification");
      }
    });
    return inFlight;
  };

  const notifyCap = (userId: number): void => {
    inFlight = inFlight.then(async () => {
      try {
        const user = getUser(db, userId);
        if (user === undefined) {
          return;
        }
        const admin = getAdminUser(db);
        const own = await send(capNotification(user.email, false), [user.id]);
        const toAdmin =
          admin.id === user.id
            ? { sent: 0, failed: 0 }
            : await send(capNotification(user.email, true), [admin.id]);
        log.info(
          { userId, sent: own.sent + toAdmin.sent, failed: own.failed + toAdmin.failed },
          "sent the storage cap notification",
        );
      } catch (cause) {
        log.error({ err: cause }, "could not send the storage cap notification");
      }
    });
  };

  return {
    publicKey: () => ensureVapidKeys(db, now()).publicKey,

    handleEvent(event: AmberEvent, meta: EventMeta = {}): void {
      if (meta.capReachedUserId !== undefined) {
        notifyCap(meta.capReachedUserId);
      }
      if (event.type !== "repo.gone") {
        return;
      }
      const { repoId, path, host, reason } = event.payload;
      if (typeof repoId !== "number" || typeof path !== "string" || typeof host !== "string") {
        return;
      }
      pending.push({
        repoId,
        path,
        host,
        reason: typeof reason === "string" ? reason : undefined,
      });
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, windowMs);
        timer.unref?.();
      }
    },

    send,
    flush,
    close: flush,
  };
}
