// Client-side mahjong tile detection: a YOLOv8n (nano) model trained on a
// merged dataset from https://github.com/Andy8647/MahjongVis (MIT) and
// https://github.com/jaheel/MJOD-2136 (CC BY-NC-SA), run entirely in the
// browser via onnxruntime-web (WASM). No image ever leaves the device.

import * as ort from "onnxruntime-web";
import type { Tile } from "./mahjong";

export const IMG_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.4;
// How much two boxes may overlap before they're treated as the same
// physical tile (see nonMaxSuppression) - standard YOLO default.
const NMS_IOU_THRESHOLD = 0.45;

// Unified class order the model was trained with: mjwaits's own 34 tile
// kinds (m/t/z 1-9/1-7, bamboo as b to leave "s" free) followed by 8 bonus
// classes (flowers/seasons) that mjwaits doesn't represent - a hand's shape
// never includes them, so they're excluded from the detected hand rather
// than mapped. Kept short (2 chars) since these strings are also what gets
// drawn as the label on each detected tile's box in the scan review step -
// "flower2"/"season1" were wide enough to crowd a small box.
const CLASS_NAMES = [
  "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m",
  "1t", "2t", "3t", "4t", "5t", "6t", "7t", "8t", "9t",
  "1b", "2b", "3b", "4b", "5b", "6b", "7b", "8b", "9b",
  "1z", "2z", "3z", "4z", "5z", "6z", "7z",
  "1f", "2f", "3f", "4f",
  "1s", "2s", "3s", "4s",
] as const;

// Maps a model class name to a mjwaits Tile, or null for classes mjwaits
// doesn't represent (flowers/seasons are bonus tiles set aside on draw -
// they don't factor into a hand's shape or its waits).
function classToTile(className: string): Tile | null {
  const c = className[className.length - 1];
  const rank = Number(className.slice(0, -1));
  if (c === "m" || c === "t" || c === "b" || c === "z") return { suit: c, rank };
  return null; // "f" (flower) or "s" (season)
}

// classToTile's counterpart for the two bonus classes it excludes - returns
// a plain {kind, rank} shape (structurally a scoring.ts BonusTile, without
// importing that module here) rather than null for "f"/"s" classes, null
// otherwise. Used by the Scoring tab's declared-region scan, which - unlike
// the Calculator - actually wants bonus tiles rather than discarding them.
export function classToBonusTile(className: string): { kind: "flower" | "season"; rank: 1 | 2 | 3 | 4 } | null {
  const c = className[className.length - 1];
  const rank = Number(className.slice(0, -1)) as 1 | 2 | 3 | 4;
  if (c === "f") return { kind: "flower", rank };
  if (c === "s") return { kind: "season", rank };
  return null;
}

export interface Detection {
  tile: Tile | null;
  className: string;
  confidence: number;
  // Pixel coordinates in the IMG_SIZE x IMG_SIZE letterboxed frame `letterbox` produced.
  box: [number, number, number, number];
}

export interface DetectionResult {
  detections: Detection[];
  tiles: Tile[];
  ignoredBonusCount: number;
}

export interface Letterbox {
  canvas: HTMLCanvasElement;
  size: number;
}

// "downloading-model" carries real byte progress (we stream the fetch
// ourselves to get it); "initializing" covers onnxruntime-web loading and
// compiling its WASM runtime, which exposes no progress hook, so it's
// shown as an indeterminate state rather than a fabricated percentage.
export type ScanProgress =
  | { phase: "downloading-model"; loaded: number; total: number | null }
  | { phase: "initializing" }
  | { phase: "running" };

let sessionPromise: Promise<ort.InferenceSession> | null = null;

// Progress listeners aren't tied to whichever call happens to start the
// fetch - the model can start downloading in the background (see
// prefetchModel, called as soon as the user opens the scan flow, before
// they've picked a photo) well before anything is around to show a
// progress bar for it. Each getSession call registers its own onProgress
// here for the lifetime of the shared fetch, so a bar that shows up later
// still gets the remaining progress instead of nothing.
const progressListeners = new Set<(p: ScanProgress) => void>();
function emitProgress(p: ScanProgress) {
  for (const listener of progressListeners) listener(p);
}

async function fetchModelBuffer(onProgress?: (loaded: number, total: number | null) => void): Promise<ArrayBuffer> {
  const response = await fetch(`${import.meta.env.BASE_URL}model/tile-detector.onnx`);
  if (!response.ok) throw new Error(`Could not download the tile detector (${response.status})`);
  if (!response.body) return response.arrayBuffer();

  const total = Number(response.headers.get("content-length")) || null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer.buffer;
}

function getSession(onProgress?: (p: ScanProgress) => void): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const buffer = await fetchModelBuffer((loaded, total) => emitProgress({ phase: "downloading-model", loaded, total }));
      emitProgress({ phase: "initializing" });
      return ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
    })();
  }
  if (onProgress) {
    progressListeners.add(onProgress);
    sessionPromise.finally(() => progressListeners.delete(onProgress));
  }
  return sessionPromise;
}

// Kicks off the model download/init ahead of time, so it's already done (or
// further along) by the time the user finishes cropping and detectTiles
// actually needs it. Safe to call more than once - getSession only starts
// the fetch on the first call. Errors are swallowed here; if the fetch is
// genuinely broken, the later detectTiles call awaits the same rejected
// sessionPromise and reports it through the normal scan error UI then.
export function prefetchModel(): void {
  getSession().catch(() => {});
}

// Resizes `image` to fit IMG_SIZE x IMG_SIZE without distortion, padding the
// rest with gray - the same preprocessing the model was trained/exported
// with. Returned canvas doubles as the base for drawing detection boxes on.
// Accepts a canvas as well as an image so an already-cropped source (see the
// scan review's crop step in App.tsx) can be letterboxed directly, with no
// intermediate re-encode.
export function letterbox(image: HTMLImageElement | HTMLCanvasElement): Letterbox {
  const canvas = document.createElement("canvas");
  canvas.width = IMG_SIZE;
  canvas.height = IMG_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  const srcWidth = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const srcHeight = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  const scale = Math.min(IMG_SIZE / srcWidth, IMG_SIZE / srcHeight);
  const w = srcWidth * scale;
  const h = srcHeight * scale;
  ctx.drawImage(image, (IMG_SIZE - w) / 2, (IMG_SIZE - h) / 2, w, h);
  return { canvas, size: IMG_SIZE };
}

function toTensor(canvas: HTMLCanvasElement): ort.Tensor {
  const ctx = canvas.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);
  const plane = IMG_SIZE * IMG_SIZE;
  const floatData = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    floatData[i] = data[i * 4] / 255;
    floatData[plane + i] = data[i * 4 + 1] / 255;
    floatData[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor("float32", floatData, [1, 3, IMG_SIZE, IMG_SIZE]);
}

function boxArea([x1, y1, x2, y2]: [number, number, number, number]): number {
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxIou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const interX1 = Math.max(a[0], b[0]);
  const interY1 = Math.max(a[1], b[1]);
  const interX2 = Math.min(a[2], b[2]);
  const interY2 = Math.min(a[3], b[3]);
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1);
  const union = boxArea(a) + boxArea(b) - interArea;
  return union > 0 ? interArea / union : 0;
}

// The model can (and does) fire twice on the same physical tile - two
// overlapping boxes, sometimes even with different guessed classes, both
// above CONFIDENCE_THRESHOLD. Standard greedy NMS: walk detections
// highest-confidence first, keeping each one and discarding any
// not-yet-kept detection that overlaps it past NMS_IOU_THRESHOLD.
// Deliberately class-agnostic (unlike textbook per-class NMS) - two boxes
// this close together are almost certainly the same physical tile even
// when the model guessed different classes for them, and a mahjong hand's
// tiles are laid out with no legitimate reason for two different tiles to
// overlap this much.
export function nonMaxSuppression(detections: Detection[]): Detection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.every((k) => boxIou(k.box, d.box) <= NMS_IOU_THRESHOLD)) kept.push(d);
  }
  return kept;
}

// Runs detection on an already-letterboxed canvas (see `letterbox`).
export async function detectTiles(box: Letterbox, onProgress?: (p: ScanProgress) => void): Promise<DetectionResult> {
  const session = await getSession(onProgress);
  onProgress?.({ phase: "running" });
  const outputs = await session.run({ images: toTensor(box.canvas) });
  const out = outputs.output0.data as Float32Array;
  const numDetections = outputs.output0.dims[1];

  const rawDetections: Detection[] = [];
  for (let i = 0; i < numDetections; i++) {
    const off = i * 6;
    const confidence = out[off + 4];
    if (confidence < CONFIDENCE_THRESHOLD) continue;
    const className = CLASS_NAMES[Math.round(out[off + 5])];
    rawDetections.push({
      tile: classToTile(className),
      className,
      confidence,
      box: [out[off], out[off + 1], out[off + 2], out[off + 3]],
    });
  }
  const detections = nonMaxSuppression(rawDetections);

  const tiles: Tile[] = [];
  let ignoredBonusCount = 0;
  for (const d of detections) {
    if (d.tile) tiles.push(d.tile);
    else ignoredBonusCount++;
  }

  return { detections, tiles, ignoredBonusCount };
}
