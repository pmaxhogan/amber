/*
 * Amber service worker. It exists for one thing: showing a push notification
 * when a repository goes gone upstream, and opening the Removed page when the
 * notification is tapped. It deliberately has no fetch handler and caches
 * nothing, so it can never serve a stale app.
 *
 * Plain JavaScript in /public rather than bundled: a service worker's scope is
 * its own path, so it has to be served from the root under a stable name.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data === null ? {} : event.data.json();
  } catch {
    // A push with an unreadable body still has to show something: browsers
    // penalize a push that produces no notification.
  }
  const title = typeof payload.title === "string" ? payload.title : "Amber";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" ? payload.tag : "amber",
      renotify: true,
      icon: "/icon-256.png",
      badge: "/icon-256.png",
      data: { url: typeof payload.url === "string" ? payload.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  // Only ever an in-app path: a push payload must not be able to send the
  // user to another origin.
  const path = typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          return client.navigate(target).then((moved) => (moved || client).focus());
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
