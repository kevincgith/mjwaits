// How much of the app is stored on this phone for use with no signal, and
// fetching the rest - the sheet behind the MJWaits icon (OfflineSheet), and
// the app's and the scanner's files fetched quietly after launch (fetchAhead).
//
// What a build is made of comes from offline.json, written at build time
// (vite.config.ts); what's stored is whatever the service worker has kept
// (public/sw.js: its "mjwaits-" caches). A file is fetched simply by asking
// for it - the service worker keeps what passes through it. So none of this
// does anything without the service worker (the dev server, a private window).

import { knownScanEngine } from "./scanEngine";

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
  // The app itself: every tab, Play and its table, the tile art, the learned opponents' model.
  core: PartStatus;
  // The scanner: its engine and model, for the engine this phone uses (the
  // plain engine also runs the learned opponents).
  scanner: PartStatus;
  // The bots' voice clips.
  voices: PartStatus;
}
export type OfflinePart = keyof OfflineStatus;

// The list of the build this page is - or null when what comes back is
// another build's (the phone's stored copy from before an update, with no
// signal to fetch this one's): then nothing is said about what's stored,
// rather than something wrong. Told by the page's own script being in it.
let manifest: Promise<Manifest | null> | null = null;
function readManifest(): Promise<Manifest | null> {
  manifest ??= fetch(`${base}offline.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`offline.json: ${r.status}`);
      return r.json() as Promise<Manifest>;
    })
    .then((m) => {
      const mine = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((s) => new URL(s.src).pathname).filter((p) => p.startsWith(`${base}assets/`));
      const listed = new Set(m.core.map(([path]) => base + path));
      if (mine.length > 0 && !mine.every((p) => listed.has(p))) {
        manifest = null; // (asked again next time: the signal may be back)
        return null;
      }
      return m;
    })
    .catch((e: unknown) => {
      manifest = null;
      throw e;
    });
  return manifest;
}

let voiceFiles: Promise<Files> | null = null;
const readVoices = (): Promise<Files> =>
  (voiceFiles ??= fetch(`${base}offline-voices.json`).then((r) => {
    if (!r.ok) throw new Error(`offline-voices.json: ${r.status}`);
    return r.json() as Promise<Files>;
  })).catch((e: unknown) => {
    voiceFiles = null;
    throw e;
  });

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

// What's stored of each part - or null while this build's list can't be had
// (see readManifest).
export async function offlineStatus(): Promise<OfflineStatus | null> {
  const [m, have] = await Promise.all([readManifest(), stored()]);
  if (!m) return null;
  // The voice clips: counted from how many of them are stored (their own
  // list is long - read only to fetch them).
  const prefix = `${base}voices/`;
  const voicesHave = Math.min([...have].filter((p) => p.startsWith(prefix)).length, m.voices.files);
  const voices: PartStatus = {
    files: m.voices.files,
    have: voicesHave,
    bytes: m.voices.bytes,
    haveBytes: m.voices.files ? Math.round((m.voices.bytes * voicesHave) / m.voices.files) : 0,
  };
  return { core: count(m.core, have), scanner: count(m.scanner[knownScanEngine()], have), voices };
}

// ---- Fetching ---------------------------------------------------------------
//
// One fetch of a part at a time, kept here - not in the sheet - so it goes
// on with the sheet shut and is there, with how far it's got, when it's
// opened again. A file being fetched for one part isn't fetched again for
// another (the app's own files and the scanner's go quietly after launch;
// Download may be tapped meanwhile).

export interface Download {
  part: OfflinePart;
  done: number;
  of: number;
  // Stopped short: no signal, or no room left. What came through is kept.
  failed?: boolean;
}

let download: Download | null = null;
let stop: AbortController | null = null;
const watchers = new Set<() => void>();
const tell = () => watchers.forEach((w) => w());

export const currentDownload = (): Download | null => download;
export function watchDownloads(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

const inFlight = new Map<string, Promise<void>>();
function fetchOne(path: string, signal: AbortSignal): Promise<void> {
  let going = inFlight.get(path);
  if (!going) {
    going = (async () => {
      const r = await fetch(base + path, { signal });
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      // Read through, so the service worker's copy is whole - a piece at a
      // time, not held (the scanner's engine is 24 MB).
      const reader = r.body?.getReader();
      if (reader) while (!(await reader.read()).done);
    })().finally(() => inFlight.delete(path));
    inFlight.set(path, going);
  }
  return going;
}

// Fetches what's missing of `files`, a few at a time. Rejects on the first
// that can't be fetched - and the others stop there too.
async function fetchMissing(files: Files, signal: AbortSignal, onProgress?: (done: number, of: number) => void): Promise<void> {
  const have = await stored();
  const missing = files.filter(([path]) => !have.has(base + path));
  let done = 0;
  let next = 0;
  let failed = false;
  onProgress?.(0, missing.length);
  const one = async () => {
    while (next < missing.length && !failed && !signal.aborted) {
      const [path] = missing[next++];
      try {
        await fetchOne(path, signal);
      } catch (e) {
        failed = true;
        throw e;
      }
      onProgress?.(++done, missing.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, one));
  if (signal.aborted) throw new DOMException("stopped", "AbortError");
}

async function filesOf(part: OfflinePart): Promise<Files> {
  const m = await readManifest();
  if (!m) throw new Error("this build's list isn't to be had");
  return part === "core" ? m.core : part === "scanner" ? m.scanner[knownScanEngine()] : readVoices();
}

// Starts fetching a part (nothing, if one's being fetched already). Goes on
// whatever's showing; watchDownloads says how it's going.
export function startDownload(part: OfflinePart): void {
  if (download && !download.failed) return;
  const control = (stop = new AbortController());
  download = { part, done: 0, of: 0 };
  tell();
  void (async () => {
    try {
      await fetchMissing(await filesOf(part), control.signal, (done, of) => {
        if (stop !== control) return;
        download = { part, done, of };
        tell();
      });
      if (stop === control) download = null;
    } catch {
      if (stop === control) download = control.signal.aborted ? null : { ...(download ?? { part, done: 0, of: 0 }), failed: true };
    }
    tell();
  })();
}

export function stopDownload(): void {
  stop?.abort();
  download = null;
  tell();
}

// After launch, quietly: the rest of the app's own files, then the scanner's
// engine and model, so the first scan opens without a wait and works with
// no signal. The scanner's are big (16 MB; 35 with the GPU engine, fetched
// only on a phone a scan has shown runs it), so not on a phone that's asked
// to save data or says it's on mobile data (where it says - an iPhone
// doesn't). Nothing without the service worker to keep them.
export async function fetchAhead(): Promise<void> {
  if (!canStore()) return;
  const quiet = new AbortController();
  try {
    await fetchMissing(await filesOf("core"), quiet.signal);
  } catch {
    return; // (no signal: next launch)
  }
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  if (connection?.saveData || connection?.type === "cellular") return;
  await fetchMissing(await filesOf("scanner"), quiet.signal).catch(() => {
    // No signal, or no room: the scan fetches them itself when it's used.
  });
}

export const megabytes = (bytes: number) => (bytes >= 10 * 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
