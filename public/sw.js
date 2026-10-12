// MJWaits' service worker: keeps the app working with no signal at the table.
//
//  - The page itself (any navigation): network first - revalidated with the
//    server, past the HTTP cache - so an update shows up as soon as there's a
//    connection; the last copy is used when offline.
//  - /assets/* (Vite's hashed, never-changing files - JS, CSS, tile art, the
//    detector's engine): cache first, stored the first time they're used.
//    When a newer build's file comes in, older copies of the same file (same
//    name, different hash) are dropped, so the cache doesn't grow release
//    after release.
//  - Anything else on this site - the detector's model (/model/*, which keeps
//    its name when retrained), icons, the manifest: the cached copy at once,
//    re-checked in the background (an unchanged file is just a quick 304).
//
// Bump VERSION to start over with fresh caches.

const VERSION = "v1";
const CACHE = `mjwaits-${VERSION}`;
const SCOPE = new URL(self.registration.scope).pathname; // "/mjwaits/"

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SCOPE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mjwaits-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// "index-TDdQcqqK.js" -> "index.js": what stays the same between builds.
const stem = (pathname) => pathname.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, "$1");

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const path = new URL(request.url).pathname;
    // Drop the previous build's copy of this file before storing the new one.
    for (const old of await cache.keys()) {
      const oldPath = new URL(old.url).pathname;
      if (oldPath !== path && oldPath.startsWith(`${SCOPE}assets/`) && stem(oldPath) === stem(path)) await cache.delete(old);
    }
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // "no-cache": revalidate with the server rather than take the browser's
    // own HTTP-cached copy (GitHub Pages allows 10 minutes), so a deploy
    // shows up on the very next launch. (A navigation Request can't take
    // options itself, hence fetching its URL.)
    const response = await fetch(request.url, { cache: "no-cache", credentials: "same-origin" });
    if (response.ok) await cache.put(SCOPE, response.clone());
    return response;
  } catch {
    return (await cache.match(SCOPE)) ?? Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit ?? Response.error());
  return hit ?? refresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  // The app's own "is there a new version?" check asks for no-store - let
  // it go straight to the network, untouched and uncached.
  if (request.cache === "no-store") return;
  if (request.mode === "navigate") event.respondWith(networkFirst(request));
  else if (url.pathname.startsWith(`${SCOPE}assets/`)) event.respondWith(cacheFirst(request));
  else event.respondWith(staleWhileRevalidate(request));
});
