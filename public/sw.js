/* Offline shell for Iron Ledger.
   The app itself is cached so it opens without a connection; /api/state is
   never cached, because a stale record is worse than an honest error. */
const CACHE = "iron-ledger-v2";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;          // always live
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;       // fonts etc: let the network handle it

  // Network first so a deploy is picked up promptly, cache as the fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => hit || caches.match("/index.html"))
      )
  );
});

/* ---------- push ---------- */

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch { d = { body: e.data ? e.data.text() : "" }; }

  e.waitUntil(
    self.registration.showNotification(d.title || "Iron Ledger", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "iron-ledger-nudge",   // one at a time; a new one replaces the old
      renotify: true,
      data: { url: d.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
