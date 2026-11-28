import type { AmberEvent, PushDevice, PushPayload, PushSendResult } from "@amber/shared";
import type { Logger } from "pino";
import { generateVAPIDKeys, sendNotification } from "web-push";
import type { Db } from "../db/db.ts";
import { OWNER_OR_ADMIN_SQL } from "../domain/users.ts";

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
 */

export const KV_VAPID_PUBLIC = "push.vapid_public";
export const KV_VAPID_PRIVATE = "push.vapid_private";

/** How long gone repositories are collected before one notification goes out. */
export const GONE_BATCH_WINDOW_MS = 30_000;
/** A push service drops a message it could not deliver within this long. */
const TTL_SECONDS = 24 * 60 * 60;
/** Repositories named in one notification before it says "and N more". */
const MAX_NAMED = 3;
const MAX_STORED_ERROR_CHARS = 300;

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

/** The one call that leaves the process. Injectable so tests never do. */
export type PushSender = (
  subscription: StoredSubscription,
  payload: string,
  vapid: VapidKeys & { subject: string },
) => Promise<void>;

interface SubscriptionRow extends StoredSubscription {
  user_agent: string | null;
  last_success_at: number | null;
  last_error: string | null;
  created_at: number;
}

interface GoneRepo {
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

export function listPushDevices(db: Db): PushDevice[] {
  return db.all<SubscriptionRow>("SELECT * FROM push_subscriptions ORDER BY id ASC").map((row) => ({
    id: row.id,
    service: serviceOf(row.endpoint),
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  }));
}

/** Idempotent: a browser re-announcing itself refreshes its keys. */
export function savePushSubscription(
  db: Db,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    /** The user whose browser this is. Absent, the admin row: never NULL. */
    userId?: number | null;
  },
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO push_subscriptions
       (endpoint, p256dh, auth, user_agent, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ${OWNER_OR_ADMIN_SQL}, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
       last_error = NULL, updated_at = excluded.updated_at`,
    input.endpoint,
    input.p256dh,
    input.auth,
    input.userAgent,
    input.userId ?? null,
    now,
    now,
  );
}

export function deletePushSubscription(db: Db, endpoint: string): boolean {
  return db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint).changes > 0;
}

const defaultSender: PushSender = async (subscription, payload, vapid) => {
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
    },
  );
};

function statusOf(cause: unknown): number | null {
  if (typeof cause === "object" && cause !== null && "statusCode" in cause) {
    const status = (cause as { statusCode: unknown }).statusCode;
    return typeof status === "number" ? status : null;
  }
  return null;
}

/** What a batch of gone repositories says on a lock screen. */
export function goneNotification(repos: readonly GoneRepo[]): PushPayload {
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
  batchWindowMs?: number;
  now?: () => number;
}

export interface PushNotifier {
  publicKey(): string;
  /** Feed it every bus event; it only reacts to repo.gone. */
  handleEvent(event: AmberEvent): void;
  /** Send to every subscribed browser. Never throws. */
  send(payload: PushPayload): Promise<PushSendResult>;
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

  const send = async (payload: PushPayload): Promise<PushSendResult> => {
    const subscriptions = db.all<StoredSubscription>(
      "SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id ASC",
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
          await sender(subscription, body, vapid);
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
          const message = (cause instanceof Error ? cause.message : String(cause)).slice(
            0,
            MAX_STORED_ERROR_CHARS,
          );
          db.run(
            "UPDATE push_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?",
            status === null ? message : `HTTP ${String(status)}: ${message}`,
            now(),
            subscription.id,
          );
          log.warn(
            { subscriptionId: subscription.id, status, err: message },
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
        const result = await send(goneNotification(batch));
        log.info({ repos: batch.length, ...result }, "sent the gone notification");
      } catch (cause) {
        // A notification must never take the process down.
        log.error({ err: cause }, "could not send the gone notification");
      }
    });
    return inFlight;
  };

  return {
    publicKey: () => ensureVapidKeys(db, now()).publicKey,

    handleEvent(event: AmberEvent): void {
      if (event.type !== "repo.gone") {
        return;
      }
      const { path, host, reason } = event.payload;
      if (typeof path !== "string" || typeof host !== "string") {
        return;
      }
      pending.push({ path, host, reason: typeof reason === "string" ? reason : undefined });
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
