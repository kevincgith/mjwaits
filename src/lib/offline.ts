// How much of the app is stored on this phone for use with no signal, and
// fetching the rest - the sheet behind the MJWaits icon (OfflineSheet), and
// the scanner's files fetched quietly after launch (preloadScanner).
//
// What a build is made of comes from offline.json, written at build time
// (vite.config.ts); what's stored is whatever the service worker has kept
// (public/sw.js: its "mjwaits-" caches). A file is fetched simply by asking
// for it - the service worker keeps what passes through it. So none of this
// does anything without the service worker (the dev server, a private window).

const base = import.meta.env.BASE_URL;

type Files = [path: string, bytes: number][];
interface Manifest {
  core: Files;
  scanner: { wasm: Files; webgpu: Files };
  voices: { files: number; bytes: number };
}

// One part of the app: how many of its files (and bytes) are stored.
export interface PartStatus {
  files: number;
  have: number;
  bytes: number;
  haveBytes: number;
}
export interface OfflineStatus {
  // The app itself: every tab, Play and its table, the tile art.
  core: PartStatus;
  // The scanner: its engine and model, for the engine this phone uses.
  scanner: PartStatus;
  // The bots' voice clips.
  voices: PartStatus;
}

let manifest: Promise<Manifest> | null = null;
const readManifest = (): Promise<Manifest> =>
  (manifest ??= fetch(`${base}offline.json`).then((r) => {
    if (!r.ok) throw new Error(`offline.json: ${r.status}`);
    return r.json() as Promise<Manifest>;
  })).catch((e: unknown) => {
    manifest = null; // (asked again next time)
    throw e;
  });

let voiceFiles: Promise<Files> | null = null;
const readVoices = (): Promise<Files> =>
  (voiceFiles ??= fetch(`${base}offline-voices.json`).then((r) => {
    if (!r.ok) throw new Error(`offline-voices.json: ${r.status}`);
    return r.json() as Promise<Files>;
  })).catch((e: unknown) => {
    voiceFiles = null;
    throw e;
  });

// Which of the scanner's engines this phone would use (as lib/vision.ts
// picks: the GPU one where there's WebGPU and an adapter for it).
let variant: Promise<"wasm" | "webgpu"> | null = null;
const scannerVariant = (): Promise<"wasm" | "webgpu"> =>
  (variant ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      return gpu && (await gpu.requestAdapter()) ? "webgpu" : "wasm";
    } catch {
      return "wasm";
    }
  })());

// Every address the service worker has stored (path and query, from the site's root).
async function stored(): Promise<Set<string>> {
  const out = new Set<string>();
  if (typeof caches === "undefined") return out;
  for (const name of await caches.keys()) {
    if (!name.startsWith("mjwaits-")) continue;
    for (const request of await (await caches.open(name)).keys()) {
      const url = new URL(request.url);
      out.add(url.pathname + url.search);
    }
  }
  return out;
}

const count = (files: Files, have: Set<string>): PartStatus =>
  files.reduce(
    (s, [path, bytes]) => {
      const here = have.has(base + path);
      return { files: s.files + 1, have: s.have + (here ? 1 : 0), bytes: s.bytes + bytes, haveBytes: s.haveBytes + (here ? bytes : 0) };
    },
    { files: 0, have: 0, bytes: 0, haveBytes: 0 },
  );

export const complete = (s: PartStatus) => s.files > 0 && s.have === s.files;

// Whether anything can be stored here at all.
export const canStore = () => typeof caches !== "undefined" && "serviceWorker" in navigator && !!navigator.serviceWorker.controller;

export async function offlineStatus(): Promise<OfflineStatus> {
  const [m, kind, have] = await Promise.all([readManifest(), scannerVariant(), stored()]);
  // The voice clips: counted from their own list only once it's been read
  // (it's long) - until then, from how many of them are stored.
  const prefix = `${base}voices/`;
  const voicesHave = [...have].filter((p) => p.startsWith(prefix)).length;
  const voices: PartStatus = {
    files: m.voices.files,
    have: Math.min(voicesHave, m.voices.files),
    bytes: m.voices.bytes,
    haveBytes: m.voices.files ? Math.round((m.voices.bytes * Math.min(voicesHave, m.voices.files)) / m.voices.files) : 0,
  };
  return { core: count(m.core, have), scanner: count(m.scanner[kind], have), voices };
}

// Fetches what's missing of `files`, a few at a time; `onProgress` after
// each. Resolves once all are in (or rejects on the first that can't be
// fetched - no signal: what's been fetched so far is kept).
async function fetchMissing(files: Files, onProgress?: (done: number, of: number) => void, signal?: AbortSignal): Promise<void> {
  const have = await stored();
  const missing = files.filter(([path]) => !have.has(base + path));
  let done = 0;
  let next = 0;
  const one = async () => {
    while (next < missing.length) {
      const [path] = missing[next++];
      const r = await fetch(base + path, { signal });
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      await r.arrayBuffer(); // (read through, so the service worker's copy is whole)
      onProgress?.(++done, missing.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, one));
}

export type OfflinePart = keyof OfflineStatus;

export async function downloadPart(part: OfflinePart, onProgress?: (done: number, of: number) => void, signal?: AbortSignal): Promise<void> {
  const m = await readManifest();
  const files = part === "core" ? m.core : part === "scanner" ? m.scanner[await scannerVariant()] : await readVoices();
  await fetchMissing(files, onProgress, signal);
}

// After launch, quietly: the scanner's engine and model, so the first scan
// opens without a wait and works with no signal. They're big (17 MB, or 37
// with the GPU engine), so not on a phone that's asked to save data or says
// it's on mobile data (where it says - an iPhone doesn't), and not without
// the service worker to keep them.
export function preloadScanner(): void {
  if (!canStore()) return;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  if (connection?.saveData || connection?.type === "cellular") return;
  void downloadPart("scanner").catch(() => {
    // No signal, or no room: the scan fetches them itself when it's used.
  });
}

export const megabytes = (bytes: number) => (bytes >= 10 * 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
