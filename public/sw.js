/*
 * ICOS Control Center — offline-safe shell worker.
 *
 * Invariant: authoritative mutable state is NEVER served from cache.
 * - navigations: network only; offline → static offline.html (shows no data)
 * - /_next/static/*: cache-first ONLY when the server marks the response
 *   immutable. Dev builds reuse chunk filenames across rebuilds and send
 *   no-cache; storing those pins a stale module graph and breaks hydration.
 * - everything else (API, RSC payloads, icons, manifest): untouched network
 * - non-GET: never intercepted (commands must reach ICOS or fail visibly)
 */
const CACHE = "icos-shell-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Only a response the server itself declares immutable may be reused forever. */
function isImmutable(response) {
  return /immutable/i.test(response.headers.get("cache-control") || "");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok && isImmutable(response)) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
