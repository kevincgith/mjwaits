// MJWaits' service worker: keeps the app working with no signal at the table.
//
//  - The page itself (any navigation): network first - revalidated with the
//    server, past the HTTP cache - so an update shows up as soon as there's a
//    connection; the last copy is used when offline, or when the network
//    takes over 2.5s (a weak signal mustn't hold up the launch - the fresh
//    copy is still stored when it comes, for next time).
//  - /assets/* (Vite's hashed, never-changing files - JS, CSS, tile art, the
//    detector's engine): cache first, stored the first time they're used.
//    When a newer build's file comes in, older copies of the same file (same
//    name, different hash) are dropped, so the cache doesn't grow release
//    after release. Play, Scores and the other parts loaded later are
//    fetched at idle on every launch (src/lib/lazyParts.ts), so they're here
//    too.
//  - A model asked for with its hash (/model/<file>?v=<hash>, see
//    src/lib/modelUrl.ts): cache first, like /assets/ - a retrained model
//    comes with a new hash, and the old copy is dropped.
//  - Anything else on this site - a model asked for without a hash, icons,
//    the manifest: the cached copy at once, re-checked in the background (an
//    unchanged file is just a quick 304).
//
// Bump VERSION to start over with fresh caches - but that also drops the
// files an open page of the last build may still load later, so only when
// the caches really must go.

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

// `isOld(url)`: a stored copy the new one replaces.
async function cacheFirst(request, isOld) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    for (const old of await cache.keys()) if (old.url !== request.url && isOld(new URL(old.url))) await cache.delete(old);
    await cache.put(request, response.clone());
  }
  return response;
}

// The previous build's copy of this file (same name, another hash).
const olderBuild = (url) => (old) => {
  const path = url.pathname;
  return old.pathname !== path && old.pathname.startsWith(`${SCOPE}assets/`) && stem(old.pathname) === stem(path);
};
// This model under another hash, or none.
const olderModel = (url) => (old) => old.pathname === url.pathname && old.search !== url.search;

const PAGE_TIMEOUT_MS = 2500;

async function networkFirst(event) {
  // "no-cache": revalidate with the server rather than take the browser's
  // own HTTP-cached copy (GitHub Pages allows 10 minutes), so a deploy
  // shows up on the very next launch. (A navigation Request can't take
  // options itself, hence fetching its URL.)
  const network = fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" }).then(async (response) => {
    if (response.ok) await (await caches.open(CACHE)).put(SCOPE, response.clone());
    return response;
  });
  // Kept alive past the timeout below, so a late copy is still stored.
  event.waitUntil(network.catch(() => {}));
  const cached = await (await caches.open(CACHE)).match(SCOPE);
  // Nothing stored yet (a first visit): wait for the network, however long.
  if (!cached) return network.catch(() => Response.error());
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT_MS));
  try {
    return (await Promise.race([network, timeout])) ?? cached;
  } catch {
    return cached;
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
  if (request.mode === "navigate") event.respondWith(networkFirst(event));
  else if (url.pathname.startsWith(`${SCOPE}assets/`)) event.respondWith(cacheFirst(request, olderBuild(url)));
  else if (url.pathname.startsWith(`${SCOPE}model/`) && url.searchParams.has("v")) event.respondWith(cacheFirst(request, olderModel(url)));
  else event.respondWith(staleWhileRevalidate(request));
});
