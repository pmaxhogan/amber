import type { ApiClient } from "../api/client.ts";

/**
 * Browser side of web push: register the service worker, ask permission,
 * subscribe with the browser's push service, and hand the subscription to
 * amber. Each browser subscribes for itself; the server keeps one row per
 * subscription and notifies them all.
 */

export const SERVICE_WORKER_URL = "/sw.js";

export type PushState =
  /** No service worker or push API here (or an insecure origin). */
  | "unsupported"
  /** iOS only delivers web push to a site added to the Home Screen. */
  | "needs_install"
  /** The user blocked notifications; only browser settings can undo that. */
  | "denied"
  | "off"
  | "on";

interface PushEnvironment {
  navigator: Navigator;
  window: Window & typeof globalThis;
}

function environment(): PushEnvironment | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  return { navigator, window };
}

function isIos(nav: Navigator): boolean {
  // iPadOS reports itself as a Mac; the touch points give it away.
  return (
    /iphone|ipad|ipod/i.test(nav.userAgent) ||
    (/mac/i.test(nav.userAgent) && nav.maxTouchPoints > 1)
  );
}

function isStandalone(env: PushEnvironment): boolean {
  const legacy = (env.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return legacy || env.window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function pushSupported(env: PushEnvironment | null = environment()): boolean {
  return (
    env !== null &&
    "serviceWorker" in env.navigator &&
    "PushManager" in env.window &&
    "Notification" in env.window
  );
}

/** VAPID keys travel as base64url; subscribe() wants the raw bytes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

async function currentSubscription(env: PushEnvironment): Promise<PushSubscription | null> {
  const registration = await env.navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  return registration === undefined ? null : registration.pushManager.getSubscription();
}

function toServerShape(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (json.endpoint === undefined || p256dh === undefined || auth === undefined) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/**
 * Where this browser stands. A browser that is already subscribed re-announces
 * itself, so a server that lost the row (restored database, pruned after a
 * failed send) picks it up again without the user doing anything.
 */
export async function readPushState(api: ApiClient): Promise<PushState> {
  const env = environment();
  if (!pushSupported(env) || env === null) {
    return env !== null && isIos(env.navigator) && !isStandalone(env)
      ? "needs_install"
      : "unsupported";
  }
  if (env.window.Notification.permission === "denied") return "denied";
  const subscription = await currentSubscription(env);
  if (subscription === null) return "off";
  const body = toServerShape(subscription);
  if (body === null) return "off";
  await api.subscribePush(body);
  return "on";
}

/** Must run from a user gesture: browsers only prompt for permission then. */
export async function enablePush(api: ApiClient): Promise<PushState> {
  const env = environment();
  if (!pushSupported(env) || env === null) return "unsupported";

  const permission = await env.window.Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "off";
  }

  const registration = await env.navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await env.navigator.serviceWorker.ready;
  const { publicKey } = await api.getPush();
  let subscription = await registration.pushManager.getSubscription();
  subscription ??= await registration.pushManager.subscribe({
    // Required by every browser: a push must produce a visible notification.
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });

  const body = toServerShape(subscription);
  if (body === null) {
    throw new Error("The browser returned a push subscription without keys");
  }
  await api.subscribePush(body);
  return "on";
}

export async function disablePush(api: ApiClient): Promise<PushState> {
  const env = environment();
  if (!pushSupported(env) || env === null) return "unsupported";
  const subscription = await currentSubscription(env);
  if (subscription !== null) {
    // Server first: if the browser side then fails, nothing is left that
    // would keep sending to a subscription the user turned off.
    await api.unsubscribePush(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return "off";
}
