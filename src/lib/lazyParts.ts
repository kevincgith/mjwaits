// The parts of the app the first screen doesn't need - Play, the online
// table, Scores, the rules sheet, the test hands, the scanner's engine -
// each in its own files, fetched when first opened. Once the page is idle
// they're all fetched anyway, so they open at once and work offline (see
// public/sw.js).

const loaders = {
  play: () => import("../PlayPanel"),
  // Play's WebGL table (three.js), which PlayPanel loads itself - here so
  // it's fetched with the rest, and Play works offline.
  table3d: () => import("../play3d/TableGL"),
  playHome: () => import("../PlayHome"),
  online: () => import("../OnlineTable"),
  scores: () => import("../ScoresPanel"),
  rules: () => import("../TaiRulesSheet"),
  testHands: () => import("@mjwaits/shared/engine/testHands"),
  // The scanner's engine (its .wasm comes with the first scan).
  scanner: () => import("onnxruntime-web/wasm"),
};
type Parts = typeof loaders;
type Part<K extends keyof Parts> = Awaited<ReturnType<Parts[K]>>;

// Each part once it's here, so it can be shown at once (see LazyParts.tsx).
const loaded = new Map<keyof Parts, unknown>();
function fetchPart<K extends keyof Parts>(key: K): Promise<Part<K>> {
  return (loaders[key]() as Promise<Part<K>>).then((m) => {
    loaded.set(key, m);
    return m;
  });
}
export const loadedPart = <K extends keyof Parts>(key: K) => loaded.get(key) as Part<K> | undefined;

// A file of the build this page came with that's gone from the server
// (a newer build is up): reload once, onto the new build.
const RELOAD_KEY = "mjwaits.chunkReload";
function reloadOnce(): boolean {
  try {
    if (!navigator.onLine || sessionStorage.getItem(RELOAD_KEY)) return false;
    sessionStorage.setItem(RELOAD_KEY, "1");
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Thrown when a part can't be fetched - told apart from the part's own errors.
export class PartLoadError extends Error {}

function load<K extends keyof Parts>(key: K): Promise<Part<K>> {
  return fetchPart(key).catch((e: unknown) => {
    if (reloadOnce()) return new Promise<never>(() => {});
    throw new PartLoadError(String(e));
  });
}

export const loadPlay = () => load("play");
export const loadPlayHome = () => load("playHome");
export const loadOnline = () => load("online");
export const loadScoresPanel = () => load("scores");
export const loadRulesSheet = () => load("rules");
export const loadTestHands = () => load("testHands");

// The same files as tileArt.ts's.
const TILE_ART = import.meta.glob<string>("../assets/tiles/*.svg", { eager: true, query: "?url", import: "default" });

// Whether the service worker had this page from the start - else (a first
// visit) the page's own files came before it, and weren't stored.
const controlledAtStart = typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;

function whenControlled(): Promise<void> {
  const sw = navigator.serviceWorker;
  if (!sw) return new Promise(() => {});
  if (sw.controller) return Promise.resolve();
  return new Promise((resolve) => sw.addEventListener("controllerchange", () => resolve(), { once: true }));
}

// Idle after the page has loaded, so nothing here holds up the first screen.
function idle(fn: () => void) {
  // Safari has no requestIdleCallback.
  const later = () => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
}

// After the first screen is up: fetch the lazy parts and all the tile art,
// and on a first visit the page's files again once the service worker has
// taken over, so it stores them - then the next launch works with no
// signal.
export function warmLazyParts(): void {
  if (!import.meta.env.PROD) return;
  idle(() => {
    const parts = Promise.allSettled((Object.keys(loaders) as (keyof Parts)[]).map(fetchPart)).then((results) => {
      if (results.every((r) => r.status === "fulfilled")) {
        try {
          sessionStorage.removeItem(RELOAD_KEY);
        } catch {
          // No storage: nothing to clear.
        }
      }
    });
    if (!("serviceWorker" in navigator)) return;
    void Promise.all([parts, whenControlled()]).then(() => {
      // Every tile's art too, not just those shown so far (the joker, say).
      const urls = new Set(Object.values(TILE_ART).filter((u) => !u.startsWith("data:")));
      if (!controlledAtStart) {
        const assets = `${window.location.origin}${import.meta.env.BASE_URL}assets/`;
        for (const e of performance.getEntriesByType("resource")) if (e.name.startsWith(assets)) urls.add(e.name);
      }
      for (const u of urls) fetch(u).catch(() => {});
    });
  });
}
