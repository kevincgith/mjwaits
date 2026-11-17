// MJWaits' service worker: keeps the app working with no signal at the table.
//
//  - The page itself (a navigation to the app - not to another page here,
//    which would be stored in its place): network first - revalidated with the
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
//    the manifest, the bots' voice clips: the cached copy at once, re-checked
//    in the background (an unchanged file is just a quick 304) - once each
//    while this worker runs, not every time it's used (a clip said again).
//
// Bump VERSION to start over with fresh caches - but that also drops the
// files an open page of the last build may still load later, so only when
// the caches really must go.

const VERSION = "v1";
const CACHE = `mjwaits-${VERSION}`;
const SCOPE = new URL(self.registration.scope).pathname; // "/mjwaits/"

// A file under /assets/ as asked for: there, and not a page in its place (a
// Wi-Fi sign-in page, or a server answering "not found" with its front page,
// both come back as a page with status 200 - never to be kept as a script).
const isFile = (response) => response.ok && !(response.headers.get("content-type") ?? "").startsWith("text/html");

// A stored file is the stored file, whoever asks: a server's "Vary: Origin"
// (or Accept-Encoding) would have the copy kept for one kind of request - a
// fetch from here, say - not found by another (the page's own <script
// crossorigin>), and the page left without its script with no signal.
const ANY = { ignoreVary: true };

// The page is only stored together with the files it starts from - the
// scripts and styles it names under /assets/ - fetched and stored first.
// Stored on its own (as it used to be, the moment it arrived), a new build's
// page could be kept while its script never was: a weak signal showing the
// old copy as the new one trickled in, or dropping between the two - and the
// next launch with no signal was a blank page, a whole older build sitting
// unused in the cache. If any of them can't be fetched, the page isn't
// stored: the last complete one stays.
async function storePage(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  const starts = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => new URL(m[1], self.registration.scope))
    .filter((u) => u.origin === self.location.origin && u.pathname.startsWith(`${SCOPE}assets/`));
  // ...and the rest of the build's own files (Play, Scores and the other
  // parts loaded later - offline.json's list, see vite.config.ts), so the
  // new build is all there before it takes the old one's place - not just
  // its first screen. (The list is used only if it's this page's build -
  // it names the page's own files; a build from before there was one has none.)
  const rest = await fetch(`${SCOPE}offline.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => (m?.core ?? []).map(([path]) => new URL(path, self.registration.scope)))
    .catch(() => []);
  const sameBuild = starts.length > 0 && starts.every((u) => rest.some((r) => r.href === u.href));
  const needs = sameBuild ? [...starts, ...rest.filter((r) => !starts.some((u) => u.href === r.href))] : starts;
  await Promise.all(
    needs.map(async (u) => {
      if (await cache.match(u.href, ANY)) return;
      const file = await fetch(u.href);
      if (!isFile(file)) throw new Error(`${u.pathname}: ${file.status}`);
      await cache.put(u.href, file);
    })
  );
  await cache.put(SCOPE, response);
  // (Now the new page is in: the last build's copies of those files can go.)
  for (const u of needs) for (const old of await cache.keys()) if (old.url !== u.href && olderBuild(u)(new URL(old.url))) await cache.delete(old);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch(SCOPE, { cache: "no-cache", credentials: "same-origin" })
      .then((response) => (response.ok ? storePage(response) : undefined))
      // (No page stored yet is no reason not to start: the first launch stores it.)
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
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
// The file is handed to the page as it arrives, and stored alongside (the
// event kept alive for it) - not after: a big one (the scanner's model)
// shows its progress as it comes, and one that can't be stored (no room
// left on the phone) still reaches the page.
async function cacheFirst(event, isOld) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, ANY);
  if (hit) return hit;
  const response = await fetch(request);
  if (isFile(response)) {
    const copy = response.clone();
    event.waitUntil(
      (async () => {
        await cache.put(request, copy);
        for (const old of await cache.keys()) if (old.url !== request.url && isOld(new URL(old.url))) await cache.delete(old);
      })().catch(() => {})
    );
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
  const network = fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" }).then((response) => {
    // Stored with the files it starts from, or not at all (see storePage) -
    // alongside, not before it's shown: the page in hand is shown either way.
    if (response.ok) event.waitUntil(storePage(response.clone()).catch(() => {}));
    return response;
  });
  // Kept alive past the timeout below, so a late copy is still stored.
  event.waitUntil(network.catch(() => {}));
  const cached = await (await caches.open(CACHE)).match(SCOPE, ANY);
  // Nothing stored yet (a first visit): wait for the network, however long.
  if (!cached) return network.catch(() => Response.error());
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT_MS));
  try {
    return (await Promise.race([network, timeout])) ?? cached;
  } catch {
    return cached;
  }
}

// Files re-checked since this worker started.
const checked = new Set();

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, ANY);
  if (hit && checked.has(request.url)) return hit;
  checked.add(request.url);
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
  if (request.mode === "navigate") {
    // (Another page here - a dev page - goes straight to the network.)
    if (url.pathname === SCOPE || url.pathname === `${SCOPE}index.html`) event.respondWith(networkFirst(event));
  }
  else if (url.pathname.startsWith(`${SCOPE}assets/`)) event.respondWith(cacheFirst(event, olderBuild(url)));
  else if (url.pathname.startsWith(`${SCOPE}model/`) && url.searchParams.has("v")) event.respondWith(cacheFirst(event, olderModel(url)));
  else event.respondWith(staleWhileRevalidate(request));
});
