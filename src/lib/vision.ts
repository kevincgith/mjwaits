// Client-side mahjong tile detection: a YOLOv8n (nano) model trained on a
// merged dataset from https://github.com/Andy8647/MahjongVis (MIT) and
// https://github.com/jaheel/MJOD-2136 (CC BY-NC-SA), run entirely in the
// browser via onnxruntime-web (WASM). No image ever leaves the device.
//
// Imported from the "/wasm" subpath rather than the package root: the root
// entry point's bundle registers every backend (WASM, WebGL, WebGPU) and
// pulls in the JSEP-enabled wasm binary that WebGPU needs, roughly 2x the
// size of the plain WASM-only binary - getSession only ever passes
// executionProviders: ["wasm"], so none of that extra code ever runs. This
// subpath ships the same public API (InferenceSession, Tensor, env) with
// only the CPU WASM backend registered, cutting the one-time model-load
// download from ~26 MB to ~13 MB with no behavior change.
import * as ort from "onnxruntime-web/wasm";
import { COMPLETE_SIZE, MELDS_REQUIRED, type Suit, type Tile } from "./mahjong";

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

// Fraction of the source image (0-1), top-left origin - same convention as
// App.tsx's own CropRect (kept as a separate, structurally-identical type
// here rather than importing CropRect, so this module doesn't depend on
// App.tsx - TypeScript's structural typing makes the two interchangeable
// wherever a CropRect-shaped value is expected).
export interface RowRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

// How much vertical gap between two detections' centers (relative to the
// median detection height in the photo) counts as "a new row" rather than
// just normal jitter within the same row.
const ROW_GAP_FACTOR = 0.6;
// A cluster smaller than this is treated as stray noise (a misdetection or
// a lone stray tile), not a real row - real rows have several tiles.
// clusterRows carves out two specific exceptions to this floor, each kept
// regardless of size: a row made up ENTIRELY of bonus tiles (see
// isAllBonusTiles) - bonus tiles are rare, deliberate, and always set
// aside apart from the concealed hand, so even a single one sitting alone
// is a real row worth keeping, not noise the way a single stray real-tile
// misdetection would be - and a row of exactly 2 IDENTICAL real tiles
// (see isPairOnlyRow) - the smallest a concealed row can ever legitimately
// be is just its own pair (將眼) once every meld is declared elsewhere, so
// a genuine 2-tile pair row must never be mistaken for 1-2-tile stray
// noise either. A single stray real tile on its own is still always
// noise, though - the smallest legitimate real-tile row is exactly 2 (the
// pair), never 1.
const MIN_ROW_DETECTIONS = 3;
// Slack added around each row's own tight bounding box, as a fraction of
// that row's own width/height - rows are detected tile-tight, so this
// gives the user a little visual context and tolerance for a missed edge
// tile, rather than a razor-exact crop. Kept generous - a bit of empty
// margin around the tiles reads a lot easier than a box cropped flush to
// their edges.
const ROW_PAD_X = 0.08;
const ROW_PAD_Y = 0.3;
// Much tighter horizontal padding used only when splitting a single
// physical row into its bonus-tile (declared) and real-tile (concealed)
// halves side by side (see splitMixedRow) - unlike the normal 2-separate-
// rows case, the two halves sit right next to each other with no gap to
// lean on at all, so ROW_PAD_X's generous fraction (applied to what's
// often a narrow bonus-only sub-region) would blow straight through the
// midpoint and eat into the other half's own tiles.
const SPLIT_PAD_X = 0.015;
// Vertical padding used instead of ROW_PAD_Y for a row that contains a
// rotated outlier (see findRotatedOutlier) - the tile marking the 食胡
// tile is often turned sideways and set slightly apart from the row's
// main line, closer to the row's own tight-bounding-box edge than an
// upright tile normally sits, leaving it less padding margin than the
// rest of the row gets. A generous bump keeps that tile from ending up
// right at (or just past) the crop's edge.
const ROTATED_TILE_ROW_PAD_Y = 0.5;
// The most real (non-bonus) tiles any single hand-related row could ever
// legitimately contain: a full hand already caps out at COMPLETE_SIZE,
// and each of its up to MELDS_REQUIRED melds being a kong (the maximum
// possible, one extra tile per kong) pushes that no higher than
// COMPLETE_SIZE + MELDS_REQUIRED. A row with more real tiles than this
// can't be part of the hand itself at all - see isPlausibleHandRow.
const MAX_PLAUSIBLE_HAND_ROW_TILES = COMPLETE_SIZE + MELDS_REQUIRED;

function detectionCenterY(d: Detection): number {
  return (d.box[1] + d.box[3]) / 2;
}

// Whether `tile`'s own box shape stands out as rotated specifically
// relative to `row`'s own typical shape - same ratio-outlier math as
// findRotatedOutlier, just checked against a row `tile` isn't already a
// member of. Used by rescueRotatedStrays below to decide whether an
// otherwise-too-small lone-tile cluster is really the 食胡 marker tile
// pulled away from its own row (rather than a coincidental misdetection
// with an unremarkable, non-rotated shape, which should stay dropped as
// ordinary noise).
function isRotatedRelativeTo(tile: Detection, row: Detection[]): boolean {
  return row.length >= 3 && findRotatedOutlier([...row, tile]) === tile;
}

// Rescues a lone tile that the gap-based pass below split into its own
// too-small cluster (see MIN_ROW_DETECTIONS) purely because it sits far
// enough from the rest of its actual row to trip the gap threshold - the
// way a 食胡 marker tile is often deliberately set apart, turned sideways,
// from the rest of the hand (see findRotatedOutlier's own reasoning).
// Without this, that tile would simply vanish from the crop entirely once
// MIN_ROW_DETECTIONS drops its now-orphaned 1-tile cluster, not just end
// up under-padded at the row's edge.
//
// Merges any single-detection, non-bonus cluster that looks rotated
// relative to its nearest OTHER cluster back into that cluster, before
// the usual size floor gets a chance to drop it. Only ever considers
// clusters of exactly 1 - a genuine stray real tile is never smaller than
// that, and a 2+-tile cluster (a real small row, or a genuine pair) isn't
// the "single marker tile pulled away" shape this is looking for.
function rescueRotatedStrays(rawRows: Detection[][]): Detection[][] {
  const centerOf = (row: Detection[]): number => row.reduce((sum, d) => sum + detectionCenterY(d), 0) / row.length;
  const result = rawRows.map((r) => [...r]);
  for (let i = 0; i < result.length; i++) {
    const row = result[i];
    if (row.length !== 1 || !row[0].tile) continue; // only a single stray REAL tile is a candidate
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let j = 0; j < result.length; j++) {
      if (j === i || result[j].length === 0) continue;
      const dist = Math.abs(centerOf(result[j]) - centerOf(row));
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = j;
      }
    }
    if (nearestIdx !== -1 && isRotatedRelativeTo(row[0], result[nearestIdx])) {
      result[nearestIdx].push(row[0]);
      result[i] = [];
    }
  }
  return result.filter((r) => r.length > 0);
}

// Splits `detections` into vertically-separated groups ("rows"), sorted
// top-to-bottom, dropping any group too small to be a real row - except an
// all-bonus-tile group or a matching pair (see MIN_ROW_DETECTIONS' own
// comment for both exceptions), each kept regardless of size, and except a
// lone tile rescued back into a neighboring row for looking rotated
// relative to it (see rescueRotatedStrays). Purely a function of box
// positions - classification correctness doesn't matter here, only "is
// there a tile-shaped thing here," so bonus-tile detections count too
// (they normally sit right alongside whichever row they belong to, and a
// wrong tile-kind guess doesn't change a box's position).
// Exported for direct unit testing (see vision.test.ts) - detectRowRegions
// itself needs a real model/canvas to test end-to-end, but the row-
// splitting logic is pure and worth testing against synthetic Detection[]
// fixtures on its own.
export function clusterRows(detections: Detection[]): Detection[][] {
  if (detections.length === 0) return [];
  const sorted = [...detections].sort((a, b) => detectionCenterY(a) - detectionCenterY(b));
  const heights = sorted.map((d) => d.box[3] - d.box[1]).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const rawRows: Detection[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = detectionCenterY(sorted[i]) - detectionCenterY(sorted[i - 1]);
    if (gap > medianHeight * ROW_GAP_FACTOR) rawRows.push([]);
    rawRows[rawRows.length - 1].push(sorted[i]);
  }
  const rows = rescueRotatedStrays(rawRows);
  return rows.filter((r) => r.length >= MIN_ROW_DETECTIONS || isAllBonusTiles(r) || isPairOnlyRow(r));
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// Groups a row's own real (non-bonus) tile detections by kind, counting
// how many copies of each kind showed up - shared by hasKong/hasPair below,
// which only differ in which count they're looking for.
function tileKindCounts(row: Detection[]): number[] {
  const counts = new Map<string, number>();
  for (const d of row) {
    if (!d.tile) continue;
    const key = `${d.tile.suit}${d.tile.rank}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()];
}

// A cluster containing 4 copies of the exact same tile is almost certainly
// a declared kong (a random concealed 16-tile hand holding all 4 copies of
// one kind, uncalled, is rare).
function hasKong(row: Detection[]): boolean {
  return tileKindCounts(row).some((n) => n >= 4);
}

// The hand's pair (將眼) is always concealed - it's never callable/declared
// (see scoring.ts's own ParsedScoringHand comment) - so a tile kind
// appearing exactly twice (not 3+, which would already be a triplet/kong,
// not a pair) is a signal toward Concealed, the opposite direction of
// hasKong's own signal toward Declared.
function hasPair(row: Detection[]): boolean {
  return tileKindCounts(row).some((n) => n === 2);
}

// Bonus tiles (flowers/seasons) are always set aside next to the declared
// melds, never mixed into the concealed hand (see App.tsx's own 門前牌區
// "Bonus tiles" sub-picker) - so seeing one at all is a strong declared signal.
function hasBonusTile(row: Detection[]): boolean {
  return row.some((d) => !d.tile);
}

// A row consisting ENTIRELY of bonus tiles - a stronger, decisive version
// of hasBonusTile's own soft +1 signal (see isRowADeclared below, and
// clusterRows' own use of this to exempt such a row from the usual
// noise-size filter). A real hand's concealed portion never holds bonus
// tiles at all, so a row with nothing BUT bonus tiles couldn't be
// anything other than the declared side, however few tiles it has.
function isAllBonusTiles(row: Detection[]): boolean {
  return row.length > 0 && row.every((d) => !d.tile);
}

// A row of exactly 2 identical real tiles - the smallest a concealed row
// can ever legitimately be (see MIN_ROW_DETECTIONS' own comment: once
// every meld is declared elsewhere, only the pair/將眼 itself is left
// concealed). Used by clusterRows to exempt this specific shape from the
// usual noise-size floor - unlike an arbitrary 1-2-tile stray, a matching
// pair is a meaningfully complete row on its own. Generic over anything
// with a `tile` field (same reason findRotatedOutlier above is generic) -
// App.tsx's own 食胡 auto-selection reuses this directly on a scanned
// region's ReviewDetection[]: findRotatedOutlier can't identify a rotated
// outlier from just 2 tiles (not enough for its median comparison to mean
// anything), but a matching pair needs no rotation signal at all - both
// tiles are the exact same kind, so either one is safely the 食胡 tile.
export function isPairOnlyRow<T extends { tile: Tile | null }>(row: T[]): boolean {
  if (row.length !== 2) return false;
  const [a, b] = row;
  return a.tile !== null && b.tile !== null && a.tile.suit === b.tile.suit && a.tile.rank === b.tile.rank;
}

// How far a detection's own width/height ratio has to differ from the
// group's median ratio (as a multiple, either direction) to count as a
// rotated outlier rather than normal photo jitter between upright tiles.
const ROTATION_OUTLIER_FACTOR = 1.5;

// The model has no concept of tile orientation at all (no "rotated" class -
// see CLASS_NAMES), so this infers it purely from box shape: real tiles
// sitting together are all the same physical shape and orientation, so
// they share roughly the same width/height ratio - a tile turned 90°
// stands out as the one box with a conspicuously different ratio from the
// rest. Needs at least 3 items for "the rest" to establish a meaningful
// median. Generic over anything box-shaped with a `tile` field (both
// vision.ts's own Detection and App.tsx's ReviewDetection qualify) since
// this is reused both for the declared/concealed row-labelling signal
// below and, separately, by App.tsx to guess which concealed-hand tile is
// the 食胡 tile (a claimed or self-drawn winning tile is often laid at an
// angle in a photo to mark it apart from the rest of the hand). Returns
// the single most extreme outlier (there's normally at most one; if
// somehow more than one candidate qualifies, e.g. a concealed kong's two
// turned end tiles, only the most extreme is reported - callers that just
// want a yes/no signal only care whether this returns non-null at all).
export function findRotatedOutlier<T extends { box: [number, number, number, number]; tile: Tile | null }>(
  items: T[]
): T | null {
  if (items.length < 3) return null;
  const ratio = (b: T["box"]) => (b[2] - b[0]) / (b[3] - b[1]);
  const ratios = items.map((d) => ratio(d.box));
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return null;
  let best: T | null = null;
  let bestDeviation = ROTATION_OUTLIER_FACTOR;
  items.forEach((item, i) => {
    const r = ratios[i];
    const deviation = r > median ? r / median : median / r;
    if (deviation > bestDeviation) {
      bestDeviation = deviation;
      best = item;
    }
  });
  return best;
}

// How "declared-looking" a row is, from its own detections alone - a kong
// or a bonus tile each count as one point toward declared, a rotated
// outlier tile or the hand's own pair each count one point toward
// concealed. Exported for direct unit testing alongside the signals it's
// built from.
export function declarednessScore(row: Detection[]): number {
  return (hasKong(row) ? 1 : 0) + (hasBonusTile(row) ? 1 : 0) - (findRotatedOutlier(row) ? 1 : 0) - (hasPair(row) ? 1 : 0);
}

// A specialized variant of declarednessScore for selectHandRows' own
// "which of these LEFTOVER rows is most likely the concealed hand"
// decision - weighs hasPair (the hand's own pair/將眼, which the rules
// themselves guarantee can never be declared - see hasPair's own comment)
// more heavily than a rotated-outlier tile. Both signals point toward
// concealed in declarednessScore, but rotation alone is a weaker signal
// for THIS specific decision: a discard pile's tiles aren't laid out with
// any care, so one of them landing at a rotated-looking angle by pure
// accident is entirely plausible, whereas a genuine matching pair
// coincidentally showing up among a pile of otherwise-independent
// discards is far less likely. Only used to break a tie/decide between
// candidates, not as a general-purpose declared/concealed classifier the
// way declarednessScore itself is - see mostConcealedLooking below.
function concealednessScore(row: Detection[]): number {
  return declarednessScore(row) - (hasPair(row) ? 1 : 0);
}

// Backtracking search: can `counts` (1-indexed, index 0 unused) be fully
// grouped into triplets, kongs, and (if `allowRuns`) runs, with nothing
// left over? Same shape of search as mahjong.ts's own (private)
// canDecompose, reimplemented here rather than imported from there since
// this ALSO needs to accept a kong-sized (4-tile) group - mahjong.ts's
// own scoring decomposition always takes a kong as its own explicit meld
// straight from parsing, never as "4 of a kind found by this same
// search," so it has no reason to check for one itself.
function canGroupIntoMelds(counts: number[], allowRuns: boolean): boolean {
  const size = counts.length - 1;
  let i = 1;
  while (i <= size && counts[i] === 0) i++;
  if (i > size) return true; // nothing left, fully grouped

  if (counts[i] >= 4) {
    counts[i] -= 4;
    if (canGroupIntoMelds(counts, allowRuns)) {
      counts[i] += 4;
      return true;
    }
    counts[i] += 4;
  }
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canGroupIntoMelds(counts, allowRuns)) {
      counts[i] += 3;
      return true;
    }
    counts[i] += 3;
  }
  if (allowRuns && i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    if (canGroupIntoMelds(counts, allowRuns)) {
      counts[i]++;
      counts[i + 1]++;
      counts[i + 2]++;
      return true;
    }
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
  }
  return false;
}

// Whether every tile in `tiles` groups into a complete triplet, run, or
// kong, with nothing at all left over - true declared melds are always
// complete groups by construction (you can't declare a partial one), so
// this checks whether a row's real tiles COULD legitimately be a
// complete set of declared melds, as opposed to the loose, ungrouped
// tiles a discard pile produces by chance. Honors (z) never form runs,
// only triplets/kongs, same as mahjong.ts's own rules. Trivially true for
// an empty input (nothing to group) - callers needing a non-empty row
// check that separately (see looksLikeDeclaredMelds).
function canFormOnlyMelds(tiles: Tile[]): boolean {
  const bySuit = new Map<Suit, number[]>();
  for (const t of tiles) {
    if (!bySuit.has(t.suit)) bySuit.set(t.suit, new Array((t.suit === "z" ? 7 : 9) + 1).fill(0));
    bySuit.get(t.suit)![t.rank]++;
  }
  for (const [suit, counts] of bySuit) {
    if (!canGroupIntoMelds(counts, suit !== "z")) return false;
  }
  return true;
}

function realTiles(row: Detection[]): Tile[] {
  return row.flatMap((d) => (d.tile ? [d.tile] : []));
}

function realTileCount(row: Detection[]): number {
  return row.reduce((n, d) => n + (d.tile ? 1 : 0), 0);
}

// canFormOnlyMelds, but tolerant of exactly one leftover tile that isn't
// part of any complete group - either the whole set decomposes cleanly,
// or removing any ONE tile leaves a (still non-empty, ≥3-tile) remainder
// that does. Guards looksLikeDeclaredMelds against a stray tile that
// isn't really part of the declared melds at all but ended up counted in
// the same row anyway - most notably a rotated 食胡 marker tile that
// rescueRotatedStrays (see clusterRows) merged into the declared row
// instead of the concealed one, when it happened to sit closer to that
// row than to its own. A genuine discard pile essentially never
// recovers this way - removing just one tile from a truly chaotic pile
// practically never leaves the rest cleanly grouped, since there's no
// reason for 14 of its 15 tiles to already be arranged into complete
// melds by chance.
function canFormMeldsAllowingOneStray(tiles: Tile[]): boolean {
  if (tiles.length >= 3 && canFormOnlyMelds(tiles)) return true;
  for (let i = 0; i < tiles.length; i++) {
    const rest = [...tiles.slice(0, i), ...tiles.slice(i + 1)];
    if (rest.length >= 3 && canFormOnlyMelds(rest)) return true;
  }
  return false;
}

// Whether `row`'s own real tiles (bonus tiles set aside, same as
// hasBonusTile elsewhere) fully decompose into complete melds, tolerating
// one stray leftover tile (see canFormMeldsAllowingOneStray) - a much
// stronger, decisive signal than declarednessScore's own soft kong/pair/
// rotation-based weighing, since true declared melds are always whole
// groups while a discard pile's loose tiles essentially never happen to
// form one by chance. Used both to pre-empt isRowADeclared's own additive
// comparison below, and by selectHandRows to spot which of 3+ candidate
// rows is genuinely the declared side.
// Exported for direct unit testing.
export function looksLikeDeclaredMelds(row: Detection[]): boolean {
  return canFormMeldsAllowingOneStray(realTiles(row));
}

// Decides which of the two detected rows is Declared vs Concealed, most
// decisive signals first:
//  1. isAllBonusTiles - a row made up ENTIRELY of bonus tiles is
//     unambiguously Declared, however few tiles it has (a real concealed
//     hand never holds bonus tiles at all).
//  2. looksLikeDeclaredMelds - a row whose real tiles fully decompose
//     into complete melds is unambiguously Declared too (a discard pile's
//     loose tiles essentially never do this by chance).
// Each of these settles the call outright regardless of what the OTHER
// row's own signals say, rather than just contributing its own +1 the
// way hasKong/hasBonusTile do inside declarednessScore. Only once neither
// row (or both) qualifies on either count does this fall through to
// declarednessScore's own additive comparison, with position (rowA = top)
// as its final tiebreak on a plain 0-0/tied score.
// Exported for direct unit testing alongside declarednessScore itself.
export function isRowADeclared(rowA: Detection[], rowB: Detection[]): boolean {
  const aAllBonus = isAllBonusTiles(rowA);
  const bAllBonus = isAllBonusTiles(rowB);
  if (aAllBonus !== bAllBonus) return aAllBonus;

  const aMelds = looksLikeDeclaredMelds(rowA);
  const bMelds = looksLikeDeclaredMelds(rowB);
  if (aMelds !== bMelds) return aMelds;

  return declarednessScore(rowA) >= declarednessScore(rowB);
}

// Whether `row` could plausibly be part of the hand itself at all, rather
// than something else entirely showing up as its own row - almost always
// a discard pile, the one other loose pile of tiles that regularly ends
// up in the same photo. Just rules out a row with more real tiles than
// the hand's own fixed tile-count ceiling (see MAX_PLAUSIBLE_HAND_ROW_TILES)
// could ever legitimately produce - a cheap pre-filter ahead of
// selectHandRows' own sharper, shape-based check (looksLikeDeclaredMelds),
// which doesn't need a size cutoff of its own since a genuinely enormous
// discard pile essentially never happens to fully decompose into melds by
// chance either way.
function isPlausibleHandRow(row: Detection[]): boolean {
  return realTileCount(row) <= MAX_PLAUSIBLE_HAND_ROW_TILES;
}

// When clusterRows finds 3+ distinct rows, at least one of them is very
// likely not part of the hand at all - picks out (at most) 2 that are, for
// detectRowRegions' normal 1-or-2-row handling to work with below. Never
// touches the exactly-2-rows (or fewer) case - there's no third row to be
// suspicious of in the first place, so both are trusted as-is and left for
// isRowADeclared to label.
//
// Two passes: first drops anything larger than the hand's own tile-count
// ceiling could ever produce (isPlausibleHandRow) - a discard pile has no
// such ceiling, so it just keeps growing as the game goes on. Then, among
// what's left, looks for a row whose real tiles fully decompose into
// complete melds (looksLikeDeclaredMelds) - if EXACTLY one does, that's
// confidently the declared row, paired with whichever of the rest scores
// LOWEST on concealednessScore (most concealed-looking - see that
// function's own comment for why it weighs the hand's own pair more
// heavily than a rotated 食胡 marker tile specifically for this decision)
// as the concealed-hand candidate, dropping everything else. Size is
// deliberately NOT the tiebreak here: a heavily-declared hand can leave a
// genuinely tiny concealed remainder (e.g. just one run plus the pair)
// that's smaller than an ordinary discard pile sitting in the same photo,
// so "the bigger leftover row" can easily pick the wrong one. If no
// single row settles which is declared (none decompose, or more than one
// ambiguously does), falls back to just the single most concealed-looking
// row (by the same measure) as the sole concealed-hand candidate -
// detectRowRegions' own 1-row handling (splitMixedRow) decides what, if
// anything, to do with it from there.
// Exported for direct unit testing alongside isPlausibleHandRow's and
// looksLikeDeclaredMelds's own reasoning.
export function selectHandRows(rows: Detection[][]): Detection[][] {
  if (rows.length <= 2) return rows;
  const plausible = rows.filter(isPlausibleHandRow);
  if (plausible.length <= 2) return plausible;

  const mostConcealedLooking = (candidates: Detection[][]): Detection[] =>
    candidates.reduce((a, b) => (concealednessScore(b) < concealednessScore(a) ? b : a));

  const meldRows = plausible.filter(looksLikeDeclaredMelds);
  if (meldRows.length === 1) {
    const declared = meldRows[0];
    const rest = plausible.filter((r) => r !== declared);
    return [declared, mostConcealedLooking(rest)];
  }
  return [mostConcealedLooking(plausible)];
}

// A single physical row can itself mix bonus tiles in with the concealed
// hand - the edge case of a fully concealed hand (no declared melds at
// all, so clusterRows never has a second row to split off) that still has
// its own bonus tiles set aside within that same row. Splits such a row
// by CONTENT instead of position: every bonus-tile detection becomes the
// Declared half (bonus tiles are never part of the concealed hand,
// however few there are - see isAllBonusTiles's own reasoning), every
// real tile becomes the Concealed half. Returns null when there's nothing
// to split (no bonus tiles at all, or - degenerately - no real tiles
// either) - detectRowRegions has no 2-region-shaped result to build from
// a row that's entirely one or the other.
// Exported for direct unit testing.
export function splitMixedRow(row: Detection[]): { declared: Detection[]; concealed: Detection[] } | null {
  const declared = row.filter((d) => !d.tile);
  const concealed = row.filter((d) => d.tile);
  return declared.length > 0 && concealed.length > 0 ? { declared, concealed } : null;
}

export interface DetectedRegions {
  declared: RowRegion;
  concealed: RowRegion;
}

// A structural subset of HTMLImageElement (its two natural dimensions),
// so this can be unit tested against a plain object instead of a real
// loaded <img>.
export interface ImageSize {
  naturalWidth: number;
  naturalHeight: number;
}

// Converts one row's raw box-space bounding box (in the IMG_SIZE x
// IMG_SIZE letterboxed frame `letterbox` produced) back into a padded
// fraction of the original photo. Reverses letterbox()'s own centering
// math (see its own comment) one step further than runScan's existing
// de-padding does (App.tsx) - this also divides by `scale` to land on a
// fraction of the original image's own dimensions, since that's what a
// CropRect needs, rather than stopping at de-padded pixel coordinates in
// the letterboxed frame.
//
// `padXFraction` defaults to the normal ROW_PAD_X, but a caller splitting
// a single row into side-by-side halves (see splitMixedRow) passes
// SPLIT_PAD_X's much tighter margin instead. The vertical padding, by
// contrast, is always decided from the row's own content: a row
// containing a rotated outlier (see findRotatedOutlier) gets
// ROTATED_TILE_ROW_PAD_Y's larger margin instead of the normal ROW_PAD_Y,
// regardless of which caller reached here.
// Exported for direct unit testing - detectRowRegions itself still needs
// a real model/canvas to test end-to-end.
export function rowToRegion(row: Detection[], image: ImageSize, padXFraction: number = ROW_PAD_X): RowRegion {
  const srcWidth = image.naturalWidth;
  const srcHeight = image.naturalHeight;
  const scale = Math.min(IMG_SIZE / srcWidth, IMG_SIZE / srcHeight);
  const padX = (IMG_SIZE - srcWidth * scale) / 2;
  const padY = (IMG_SIZE - srcHeight * scale) / 2;
  const x1 = Math.min(...row.map((d) => d.box[0]));
  const y1 = Math.min(...row.map((d) => d.box[1]));
  const x2 = Math.max(...row.map((d) => d.box[2]));
  const y2 = Math.max(...row.map((d) => d.box[3]));
  let fx1 = (x1 - padX) / scale / srcWidth;
  let fy1 = (y1 - padY) / scale / srcHeight;
  let fx2 = (x2 - padX) / scale / srcWidth;
  let fy2 = (y2 - padY) / scale / srcHeight;
  const w = fx2 - fx1;
  const h = fy2 - fy1;
  const padYFraction = findRotatedOutlier(row) ? ROTATED_TILE_ROW_PAD_Y : ROW_PAD_Y;
  fx1 = clamp01(fx1 - w * padXFraction);
  fx2 = clamp01(fx2 + w * padXFraction);
  fy1 = clamp01(fy1 - h * padYFraction);
  fy2 = clamp01(fy2 + h * padYFraction);
  return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1 };
}

function rectsOverlapVertically(a: RowRegion, b: RowRegion): boolean {
  return a.y < b.y + b.h && b.y < a.y + a.h;
}

// If `a` and `b` end up overlapping vertically after padding - most
// likely because the padded rows sit close enough together that
// ROW_PAD_Y/ROTATED_TILE_ROW_PAD_Y on each side eats further into their
// actual gap than the gap itself allows - trims both back to meet at the
// midpoint of their combined span, rather than let the whole autofit
// result get rejected outright by the caller's own overlap check (see
// fittedRegionsFrom in App.tsx). Whichever region sits on top gets its
// bottom edge trimmed up to the midpoint; the other's top edge trimmed
// down to meet it. A no-op when they don't actually overlap.
// Exported for direct unit testing.
export function resolveVerticalOverlap(a: RowRegion, b: RowRegion): [RowRegion, RowRegion] {
  if (!rectsOverlapVertically(a, b)) return [a, b];
  const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
  const midpoint = (top.y + top.h + bottom.y) / 2;
  const trimmedTop: RowRegion = { ...top, h: midpoint - top.y };
  const trimmedBottom: RowRegion = { ...bottom, y: midpoint, h: bottom.y + bottom.h - midpoint };
  return a.y <= b.y ? [trimmedTop, trimmedBottom] : [trimmedBottom, trimmedTop];
}

// Runs detection on the WHOLE uncropped photo (unlike detectTiles' usual
// per-region callers, which only ever see an already-cropped source) and
// clusters the results into rows by vertical position - most hand photos
// lay declared melds and the concealed hand out as two clearly separated
// rows, so this can seed the crop screen's two regions instead of always
// starting from fixed guesses. Returns null if it can't turn what it found
// into exactly 2 confident regions - the caller falls back to fixed
// defaults either way, so this never needs to be "sure," just right often
// enough to help.
export async function detectRowRegions(image: HTMLImageElement): Promise<DetectedRegions | null> {
  const box = letterbox(image);
  const { detections } = await detectTiles(box);
  const rows = selectHandRows(clusterRows(detections));

  if (rows.length === 2) {
    // Which physical row is Declared vs Concealed - see isRowADeclared.
    const [rowA, rowB] = rows; // rowA = top, rowB = bottom (clusterRows sorts top-to-bottom)
    const aIsDeclared = isRowADeclared(rowA, rowB);
    const declaredRow = aIsDeclared ? rowA : rowB;
    const concealedRow = aIsDeclared ? rowB : rowA;
    const [declared, concealed] = resolveVerticalOverlap(rowToRegion(declaredRow, image), rowToRegion(concealedRow, image));
    return { declared, concealed };
  }

  if (rows.length === 1) {
    // A fully concealed hand (nothing declared, so no second row ever
    // forms) can still carry its own bonus tiles within that one row -
    // see splitMixedRow.
    const split = splitMixedRow(rows[0]);
    if (!split) return null;
    const [declared, concealed] = resolveVerticalOverlap(
      rowToRegion(split.declared, image, SPLIT_PAD_X),
      rowToRegion(split.concealed, image, SPLIT_PAD_X)
    );
    return { declared, concealed };
  }

  return null;
}
