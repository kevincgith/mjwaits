// State behind the hidden developer sheet (three taps on the logo): its
// switches, plus what the app records for it to show - the Scoring hand
// as notation, how long the heavy calculations took, and the last scan's
// raw detections. A plain module store (read with useDebug) rather than
// React state, so any tab can record into it without prop-threading.
//
// Only the layout overlay switch is saved (localStorage); the Trainer
// switches last until the page reloads.

import { useSyncExternalStore } from "react";
import type { Detection } from "./lib/vision";

export interface ScanDebugRegion {
  /** The letterboxed IMG_SIZE square the model actually saw. */
  canvas: HTMLCanvasElement;
  /** The model's raw first-pass detections, before any re-check. */
  detections: Detection[];
}

export interface DebugState {
  layoutOverlay: boolean;
  trainerReveal: boolean;
  trainerRepeat: boolean;
  /** The Scoring tab's tiles as notation ("(123m)" declared, "[1111z]" 暗槓). */
  scoringNotation: string;
  /** Milliseconds per calculation, keyed by a short name, latest run each. */
  timings: Record<string, number>;
  lastScan: { at: number; ms: number; regions: ScanDebugRegion[] } | null;
}

const LAYOUT_OVERLAY_KEY = "mjwaits.debugLayout";

function loadLayoutOverlay(): boolean {
  try {
    return window.localStorage.getItem(LAYOUT_OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
}

let state: DebugState = {
  layoutOverlay: loadLayoutOverlay(),
  trainerReveal: false,
  trainerRepeat: false,
  scoringNotation: "",
  timings: {},
  lastScan: null,
};
const listeners = new Set<() => void>();

export function setDebug(patch: Partial<DebugState>): void {
  state = { ...state, ...patch };
  if ("layoutOverlay" in patch) {
    try {
      if (patch.layoutOverlay) window.localStorage.setItem(LAYOUT_OVERLAY_KEY, "1");
      else window.localStorage.removeItem(LAYOUT_OVERLAY_KEY);
    } catch {
      // Storage unavailable - the switch just won't survive a reload.
    }
  }
  listeners.forEach((l) => l());
}

export function getDebug(): DebugState {
  return state;
}

/** Records how long a calculation took. Quiet - no re-render - since it's
 *  called from render-time memos; the sheet reads it when it opens. */
export function recordTiming(name: string, ms: number): void {
  state.timings = { ...state.timings, [name]: ms };
}

/** Runs `fn`, recording its duration under `name`. */
export function timed<T>(name: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  recordTiming(name, performance.now() - start);
  return result;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDebug(): DebugState {
  return useSyncExternalStore(subscribe, getDebug);
}
