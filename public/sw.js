// MJWaits' service worker: keeps the app working with no signal at the table.
//
//  - The page itself (a navigation to the app - not to another page here,
//    which would be stored in its place): network first - revalidated with the
//    server, past the HTTP cache - so an update shows up as soon as there's a
//    connection; the last copy is used when offline, when the server answers
//    with an error, or when the network takes over 2.5s (a weak signal
//    mustn't hold up the launch - the fresh copy is still stored when it
//    comes, for next time).
//  - A build is stored whole, then takes the last one's place (storePage):
//    the page is kept only once the build's own files are - and only then are
//    the files of the build before last dropped. Nothing is dropped as a new
//    file arrives: an update cut short leaves the last complete build as it
//    was, page and files.
//  - /assets/* (Vite's hashed, never-changing files - JS, CSS, tile art, the
//    detector's engine): cache first, stored the first time they're used.
//    Play, Scores and the other parts loaded later are fetched at idle on
//    every launch (src/lib/lazyParts.ts), so they're here too.
//  - A model asked for with its hash (/model/<file>?v=<hash>, see
//    src/lib/modelUrl.ts): cache first, like /assets/ - a retrained model
//    comes with a new hash, and the old copy is dropped.
//  - The build's lists (offline.json, offline-voices.json): from the network
//    when there is one, so the page reads the list of the build it is - the
//    stored copy with no signal.
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
// What the stored builds are made of (see storePage): kept in the cache
// beside them, under an address nothing else asks for.
const BUILDS = `${SCOPE}__builds.json`;

// A file as asked for: there, whole, and not a page in its place (a Wi-Fi
// sign-in page, or a server answering "not found" with its front page, both
// come back as a page with status 200 - never to be kept as a script).
const isFile = (response) => response.status === 200 && !(response.headers.get("content-type") ?? "").startsWith("text/html");

// A stored file is the stored file, whoever asks: a server's "Vary: Origin"
// (or Accept-Encoding) would have the copy kept for one kind of request - a
// fetch from here, say - not found by another (the page's own <script
// crossorigin>), and the page left without its script with no signal.
const ANY = { ignoreVary: true };

const assetPath = (pathname) => pathname.startsWith(`${SCOPE}assets/`);
const hrefOf = (path) => new URL(path, self.registration.scope).href;

// A build is stored whole, then takes the last one's place.
//
// The page is kept only once the files it starts from - the scripts and
// styles it names under /assets/ - and the rest of the build's own files
// (Play, Scores and the other parts loaded later: offline.json's list, see
// vite.config.ts) are stored. Kept on its own, the moment it arrived, a new
// build's page could be there while its script never was - a weak signal
// showing the old copy as the new one trickled in, or dropping between the
// two - and the next launch with no signal was a blank page. If any file
// can't be fetched, the page isn't stored: the last complete build stays,
// untouched.
//
// Only once the new page is in are older files dropped - and then the build
// before last's, not the last one's: a page of the last build that's still
// open may yet ask for its own parts (BUILDS keeps the two lists). Nothing
// is dropped as a file arrives.
let storing = null; // one at a time: the install, a launch and a late answer can all bring the same page
function storePage(response) {
  const run = (storing ?? Promise.resolve()).catch(() => {}).then(() => storeBuild(response));
  storing = run;
  return run;
}

async function storeBuild(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  // The page that's stored already: nothing to do (every launch with a
  // signal comes through here).
  const stored = await cache.match(SCOPE, ANY);
  if (stored && (await stored.text()) === html) return;

  const starts = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => new URL(m[1], self.registration.scope)).filter((u) => u.origin === self.location.origin && assetPath(u.pathname)).map((u) => u.href);
  // (A page that names no file of its own isn't the app: not kept in its place.)
  if (starts.length === 0 && stored) throw new Error("page names no assets");
  // The build's list - used only if it's this page's build (it names the
  // page's own files; a build from before there was a list has none).
  const list = await fetch(`${SCOPE}offline.json`, { cache: "no-cache" })
    .then((r) => (isFile(r) ? r.json() : null))
    .catch(() => null);
  const core = (list?.core ?? []).map(([path]) => hrefOf(path));
  const sameBuild = starts.length > 0 && starts.every((u) => core.includes(u));
  const needs = sameBuild ? [...new Set([...starts, ...core])] : starts;
  await Promise.all(
    needs.map(async (u) => {
      if (await cache.match(u, ANY)) return;
      const file = await fetch(u);
      if (!isFile(file)) throw new Error(`${u}: ${file.status}`);
      await cache.put(u, file);
    })
  );
  await cache.put(SCOPE, response);

  // The new build is in. Its files, and the last build's, stay; any other
  // file under /assets/ goes. (Without the list there's no telling which
  // are whose: nothing is dropped.)
  if (!sameBuild) return;
  const mine = [...needs, ...[...(list.scanner?.wasm ?? []), ...(list.scanner?.webgpu ?? [])].map(([path]) => hrefOf(path))].filter((u) => assetPath(new URL(u).pathname));
  const keys = await cache.keys();
  const here = keys.map((k) => k.url).filter((u) => assetPath(new URL(u).pathname));
  // (The first time through there's no record of the last build: all that's
  // stored now counts as its - kept this once.)
  const before = await cache
    .match(BUILDS, ANY)
    .then((r) => (r ? r.json() : null))
    .catch(() => null);
  const last = before?.current ?? here;
  const keep = new Set([...mine, ...last]);
  await Promise.all(keys.filter((k) => assetPath(new URL(k.url).pathname) && !keep.has(k.url)).map((k) => cache.delete(k)));
  await cache.put(BUILDS, new Response(JSON.stringify({ current: mine, previous: last }), { headers: { "content-type": "application/json" } }));
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

// Kept alive for `work` where the event still can be (it can't once it's
// settled - then the work just runs on, as far as the worker's let).
function alongside(event, work) {
  const quiet = work.catch(() => {});
  try {
    event.waitUntil(quiet);
  } catch {
    // Too late to hold the event open: nothing to do about it.
  }
}

// The file is handed to the page as it arrives, and stored alongside (the
// event kept alive for it) - not after: a big one (the scanner's model)
// shows its progress as it comes, and one that can't be stored (no room
// left on the phone) still reaches the page.
// `isOld(url)`: a stored copy the new one replaces - a model's, under
// another hash. (A build's files are dropped by storePage, never here.)
async function cacheFirst(event, isOld) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, ANY);
  if (hit) return hit;
  const response = await fetch(request);
  if (isFile(response)) {
    const copy = response.clone();
    alongside(
      event,
      (async () => {
        await cache.put(request, copy);
        if (isOld) for (const old of await cache.keys()) if (old.url !== request.url && isOld(new URL(old.url))) await cache.delete(old);
      })()
    );
  }
  return response;
}

// This model under another hash, or none.
const olderModel = (url) => (old) => old.pathname === url.pathname && old.search !== url.search;

const PAGE_TIMEOUT_MS = 2500;

async function networkFirst(event) {
  const cached = await (await caches.open(CACHE)).match(SCOPE, ANY);
  // "no-cache": revalidate with the server rather than take the browser's
  // own HTTP-cached copy (GitHub Pages allows 10 minutes), so a deploy
  // shows up on the very next launch. (A navigation Request can't take
  // options itself, hence fetching its URL.)
  const network = fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" }).then((response) => {
    // The server's own trouble (an outage's error page, a "not found" midway
    // through a deploy) isn't shown in place of a copy that works.
    if (!response.ok) {
      if (cached) throw new Error(`page: ${response.status}`);
      return response;
    }
    // Stored with its build's files, or not at all (see storePage) -
    // alongside, not before it's shown: the page in hand is shown either way.
    alongside(event, storePage(response.clone()));
    return response;
  });
  // Kept alive past the timeout below, so a late copy is still stored.
  alongside(event, network);
  // Nothing stored yet (a first visit): wait for the network, however long.
  if (!cached) return network.catch(() => Response.error());
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT_MS));
  try {
    return (await Promise.race([network, timeout])) ?? cached;
  } catch {
    return cached;
  }
}

// The network's copy when there is one (stored, for when there isn't).
async function freshFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request.url, { cache: "no-cache" });
    if (!isFile(response)) throw new Error(`${request.url}: ${response.status}`);
    alongside(event, cache.put(request.url, response.clone()));
    return response;
  } catch {
    return (await cache.match(request.url, ANY)) ?? Response.error();
  }
}

// Files re-checked since this worker started.
const checked = new Set();

async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, ANY);
  if (hit && checked.has(request.url)) return hit;
  checked.add(request.url);
  const refresh = fetch(request).then((response) => {
    if (isFile(response)) alongside(event, cache.put(request, response.clone()));
    return response;
  });
  if (!hit) return refresh.catch(() => Response.error());
  alongside(event, refresh);
  return hit;
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
  } else if (assetPath(url.pathname)) event.respondWith(cacheFirst(event, null));
  else if (url.pathname.startsWith(`${SCOPE}model/`) && url.searchParams.has("v")) event.respondWith(cacheFirst(event, olderModel(url)));
  else if (url.pathname === `${SCOPE}offline.json` || url.pathname === `${SCOPE}offline-voices.json`) event.respondWith(freshFirst(event));
  else event.respondWith(staleWhileRevalidate(event));
});
