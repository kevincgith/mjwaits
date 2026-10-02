// Client-side mahjong tile detection: a YOLOv8n (nano) model trained on a
// merged dataset from https://github.com/Andy8647/MahjongVis (MIT) and
// https://github.com/jaheel/MJOD-2136 (CC BY-NC-SA), run entirely in the
// browser via onnxruntime-web. No image ever leaves the device.
//
// Two engines, picked once per page load (see getEngine):
//  - GPU (WebGPU), where the browser supports it: onnxruntime-web's
//    "/webgpu" build plus the full-precision model (tile-detector-fp32.onnx).
//    ~8x faster per model run than the CPU engine (~28ms vs ~230ms on an
//    Apple M2), at the cost of a larger one-time download (~24 MB engine +
//    ~12 MB model). The 8-bit model is NOT used here: the GPU engine can't
//    run its integer ops natively and bounces them back to the CPU, which
//    made it slower than the CPU engine itself.
//  - CPU (WASM) everywhere else: the "/wasm" build plus the 8-bit model
//    (tile-detector.onnx), ~13 MB + ~3.4 MB. Imported from the "/wasm"
//    subpath rather than the package root, whose bundle registers every
//    backend and pulls in a binary roughly 2x the size.
// The GPU build is only ever loaded via a dynamic import, so a device
// without WebGPU never downloads it. Both models come from the same
// trained checkpoint (see training/README.md), so they find the same tiles
// up to 8-bit rounding.
import * as ortWasm from "onnxruntime-web/wasm";
import {
  allTileKinds,
  COMPLETE_SIZE,
  isCompleteHand,
  isEightPairsComplete,
  isSixteenUnrelatedComplete,
  isThirteenOrphansComplete,
  MELDS_REQUIRED,
  type Suit,
  type Tile,
} from "./mahjong";

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
  | { phase: "running" }
  // The re-check pass (see recheckRegion) - re-running detection on a few
  // variations of each region because the first pass didn't add up.
  | { phase: "rechecking" };

type Ort = typeof ortWasm;
interface Engine {
  ort: Ort;
  session: ortWasm.InferenceSession;
  backend: "webgpu" | "wasm";
}

let enginePromise: Promise<Engine> | null = null;

// Progress listeners aren't tied to whichever call happens to start the
// fetch - the model can start downloading in the background (see
// prefetchModel, called as soon as the user opens the scan flow, before
// they've picked a photo) well before anything is around to show a
// progress bar for it. Each getEngine call registers its own onProgress
// here for the lifetime of the shared fetch, so a bar that shows up later
// still gets the remaining progress instead of nothing.
const progressListeners = new Set<(p: ScanProgress) => void>();
function emitProgress(p: ScanProgress) {
  for (const listener of progressListeners) listener(p);
}

async function fetchModelBuffer(file: string, onProgress?: (loaded: number, total: number | null) => void): Promise<ArrayBuffer> {
  const response = await fetch(`${import.meta.env.BASE_URL}model/${file}`);
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

const reportDownload = (loaded: number, total: number | null) => emitProgress({ phase: "downloading-model", loaded, total });

async function createWasmEngine(): Promise<Engine> {
  const buffer = await fetchModelBuffer("tile-detector.onnx", reportDownload);
  emitProgress({ phase: "initializing" });
  const session = await ortWasm.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
  return { ort: ortWasm, session, backend: "wasm" };
}

// The GPU engine, or null if this browser can't give us one - no WebGPU at
// all, no usable GPU adapter, or anything along the way failing (the
// engine download, creating the session, or the warm-up run below). Never
// throws: the caller just falls back to the CPU engine.
async function createWebGpuEngine(): Promise<Engine | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return null;
  try {
    if (!(await gpu.requestAdapter())) return null;
    const ort = (await import("onnxruntime-web/webgpu")) as unknown as Ort;
    const buffer = await fetchModelBuffer("tile-detector-fp32.onnx", reportDownload);
    emitProgress({ phase: "initializing" });
    // logSeverityLevel 3 (errors only): the GPU engine otherwise logs a
    // warning on every load that a few small shape-calculation steps run
    // on the CPU instead - expected and harmless, but it shows up in the
    // browser console looking like an error.
    const session = await ort.InferenceSession.create(buffer, { executionProviders: ["webgpu"], logSeverityLevel: 3 });
    // The GPU compiles its programs on the first run (~0.8s on an M2) -
    // pay that here, during prefetchModel (while the user is still picking
    // a photo), rather than on the first real scan. Also proves the engine
    // actually runs before we commit to it.
    const blank = new ort.Tensor("float32", new Float32Array(3 * IMG_SIZE * IMG_SIZE), [1, 3, IMG_SIZE, IMG_SIZE]);
    await session.run({ images: blank });
    return { ort, session, backend: "webgpu" };
  } catch {
    return null;
  }
}

// "?backend=cpu" in the page URL skips the GPU engine - for checking
// whether a problem seen on one device is GPU-specific.
function cpuForced(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).get("backend") === "cpu";
}

function getEngine(onProgress?: (p: ScanProgress) => void): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => (!cpuForced() && (await createWebGpuEngine())) || createWasmEngine())();
  }
  if (onProgress) {
    progressListeners.add(onProgress);
    enginePromise.finally(() => progressListeners.delete(onProgress));
  }
  return enginePromise;
}

// Which engine this page is running the model on - "webgpu" or "wasm" -
// once it's loaded. For diagnostics only.
export async function detectorBackend(): Promise<"webgpu" | "wasm"> {
  return (await getEngine()).backend;
}

// Kicks off the model download/init ahead of time, so it's already done (or
// further along) by the time the user finishes cropping and detectTiles
// actually needs it. Safe to call more than once - getSession only starts
// the fetch on the first call. Errors are swallowed here; if the fetch is
// genuinely broken, the later detectTiles call awaits the same rejected
// sessionPromise and reports it through the normal scan error UI then.
export function prefetchModel(): void {
  getEngine().catch(() => {});
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

function toTensor(ort: Ort, canvas: HTMLCanvasElement): ortWasm.Tensor {
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
// Tiles much bigger in the model's input than in the photos it was trained
// on read badly - a crop only a tile or two wide (a declared box holding
// just a flower, a lone pair) fills the input with each tile. Measured on
// six bonus tiles across three photos: filling the input read 1 of 6
// right (a 梅 flower came back as a season, 竹 as 北), while the same
// crops shrunk onto the gray background read all 6 right at 60, 90 and
// 130 px wide alike. So when the read's tiles come out wider than
// MAX_TILE_INPUT_PX, detectTiles reads again with them shrunk to
// TARGET_TILE_INPUT_PX. A tile that big can also go unread entirely (a 竹
// flower cropped a tile and a half wide came back empty), leaving no size
// to go by - an empty read is retried at EMPTY_RETRY_FACTOR, which brings
// a tile filling the input down to about TARGET_TILE_INPUT_PX.
const MAX_TILE_INPUT_PX = 160;
const TARGET_TILE_INPUT_PX = 100;
const EMPTY_RETRY_FACTOR = 0.25;

// `box`'s content shrunk by `factor` around its center, on the same gray.
function shrinkLetterbox(box: Letterbox, factor: number): Letterbox {
  const canvas = document.createElement("canvas");
  canvas.width = IMG_SIZE;
  canvas.height = IMG_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  const side = IMG_SIZE * factor;
  ctx.drawImage(box.canvas, (IMG_SIZE - side) / 2, (IMG_SIZE - side) / 2, side, side);
  return { canvas, size: IMG_SIZE };
}

// Detections in `box`'s frame - read again shrunk, see MAX_TILE_INPUT_PX,
// when the tiles fill too much of it or nothing was read.
export async function detectTiles(box: Letterbox, onProgress?: (p: ScanProgress) => void): Promise<DetectionResult> {
  const result = await detectTilesOnce(box, onProgress);
  const widths = result.detections.map((d) => d.box[2] - d.box[0]).sort((a, b) => a - b);
  const tileWidth = widths[Math.floor(widths.length / 2)];
  if (widths.length > 0 && tileWidth <= MAX_TILE_INPUT_PX) return result;
  const factor = widths.length > 0 ? TARGET_TILE_INPUT_PX / tileWidth : EMPTY_RETRY_FACTOR;
  const shrunk = await detectTilesOnce(shrinkLetterbox(box, factor), onProgress);
  if (shrunk.detections.length === 0) return result;
  const center = IMG_SIZE / 2;
  const unshrink = (v: number) => center + (v - center) / factor;
  return {
    ...shrunk,
    detections: shrunk.detections.map((d) => ({ ...d, box: d.box.map(unshrink) as Detection["box"] })),
  };
}

async function detectTilesOnce(box: Letterbox, onProgress?: (p: ScanProgress) => void): Promise<DetectionResult> {
  let engine = await getEngine(onProgress);
  onProgress?.({ phase: "running" });
  let outputs: ortWasm.InferenceSession.OnnxValueMapType;
  try {
    outputs = await engine.session.run({ images: toTensor(engine.ort, box.canvas) });
  } catch (err) {
    if (engine.backend !== "webgpu") throw err;
    // The GPU engine failed mid-session (a lost device, a driver
    // hiccup) - switch this page to the CPU engine for good and retry.
    enginePromise = createWasmEngine();
    engine = await getEngine(onProgress);
    outputs = await engine.session.run({ images: toTensor(engine.ort, box.canvas) });
  }
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
// Exported for direct unit testing (rowToRegion's minEdgePadTiles tests
// compare against this default explicitly).
export const ROW_PAD_X = 0.08;
const ROW_PAD_Y = 0.3;
// Much tighter horizontal padding used only when splitting a single
// physical row into its bonus-tile (declared) and real-tile (concealed)
// halves side by side (see splitMixedRow) - unlike the normal 2-separate-
// rows case, the two halves sit right next to each other with no gap to
// lean on at all, so ROW_PAD_X's generous fraction (applied to what's
// often a narrow bonus-only sub-region) would blow straight through the
// midpoint and eat into the other half's own tiles.
const SPLIT_PAD_X = 0.015;
// The hairline gap (as a fraction of the photo's width) left between a
// split row's two side-by-side halves - see regionsFromRows.
const SPLIT_GAP = 1e-6;
// Vertical padding used instead of ROW_PAD_Y for a row that contains a
// rotated outlier (see findRotatedOutlier). Only a modest bump over the
// normal ROW_PAD_Y, not a dramatic one: rescueRotatedStrays (see
// clusterRows) already pulls a rotated marker tile that sits apart from
// the row's main line back INTO the row's own raw bounding box before
// this padding is even applied, so the box already fully contains the
// tile on its own - this just adds a little extra breathing room for
// imprecision in the model's own box for that tile, not a full second
// safety margin on top of an already-generous one.
const ROTATED_TILE_ROW_PAD_Y = 0.35;
// The narrowest a region is ever allowed to end up, as a fraction of the
// whole photo's width, regardless of how little padXFraction's own
// proportional padding would otherwise give it. ROW_PAD_X/SPLIT_PAD_X are
// both proportional to the row's OWN raw width, so a row with very few
// real tiles (the extreme case: a single bonus tile, with no declared
// melds at all) still ends up a sliver-thin box even after padding - too
// narrow for a person to actually grab a specific corner handle to
// resize it, since a real hand photo's full width usually spans many
// tiles, dwarfing a single tile's own width by comparison. Matches
// App.tsx's own MIN_CROP_FRACTION (the smallest a user can manually drag
// a crop box down to) - kept as vision.ts's own separate constant rather
// than importing that one, so this module doesn't depend on App.tsx.
const MIN_REGION_WIDTH = 0.1;
// A declared row's tiles (individual melds, often with a rotated claimed
// tile right at one end) sit closer to the row's own raw edge than a
// concealed row's do, and ROW_PAD_X's flat proportional padding thins out
// fast on a declared row with plenty of tiles (its "row width" denominator
// gets large while each individual tile stays the same size). Guarantee at
// least one whole tile's own width of padding at each horizontal end for a
// declared row specifically, on top of (not instead of) ROW_PAD_X - taking
// whichever of the two ends up more generous - so there's always real room
// to grab and nudge the crop without immediately clipping an edge tile.
// Not applied to the concealed row or to a split-row half (see
// DECLARED_ROW_MIN_EDGE_PAD_TILES's own call site).
const DECLARED_ROW_MIN_EDGE_PAD_TILES = 1;
// The least padding, in tile widths, a split row's bonus-tile half (see
// regionsFromRows) gets at its outer end - its inner end still meets the
// concealed half at the boundary between them. Bonus tiles are the ones
// the whole-photo read most often misses (the outermost one especially,
// e.g. an upside-down flower), so this keeps a missed outer bonus tile
// inside the box. It also helps the scan itself read them: such a box is
// tiny (~13% of the photo's width for 3 tiles), which blows each tile up
// far larger than the model is used to, and in testing the same 3 bonus
// tiles read 3 of 3 from a ~25%-wide crop but only 2 of 3 from the tight
// one. Unlike a wide concealed row, where extra width only makes the
// tiles smaller and harder to read, a little more room here helps.
const BONUS_SPLIT_MIN_EDGE_PAD_TILES = 1.5;
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

// How far (in the row's own median tile heights) a lone tile's box may sit
// above or below a row's boxes and still be rescued into it. A 食胡 tile
// set apart sits right beside its row; without this limit, a face-up
// sideways tile lying near the wall at the bottom of one photo, ten tile
// heights below the hand, was merged into it as its "rotated" tile and
// stretched the concealed box down over everything in between.
const STRAY_MAX_GAP_TILES = 1;

function isNearRow(tile: Detection, row: Detection[]): boolean {
  const heights = row.map((d) => d.box[3] - d.box[1]).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const top = Math.min(...row.map((d) => d.box[1]));
  const bottom = Math.max(...row.map((d) => d.box[3]));
  const gap = Math.max(top - tile.box[3], tile.box[1] - bottom, 0);
  return gap <= medianHeight * STRAY_MAX_GAP_TILES;
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
    if (nearestIdx !== -1 && isNearRow(row[0], result[nearestIdx]) && isRotatedRelativeTo(row[0], result[nearestIdx])) {
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

// A tile turned sideways doesn't always clear ROTATION_OUTLIER_FACTOR: on
// one photo a sideways winning tile at the end of a 14-tile row measured
// anywhere from 1.37 to 1.66 depending on how the box was cropped, so it
// was named the winning tile only some of the time. Upright tiles in the
// same row never strayed past 1.16, though, so a tile from this lower
// factor still counts when it stands this many times further out than any
// other tile in the group - clearly the odd one out, not just jitter.
const ROTATION_OUTLIER_MIN_FACTOR = 1.3;
const ROTATION_OUTLIER_MARGIN = 1.15;

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
  const deviations = ratios.map((r) => (r > median ? r / median : median / r));
  let bestIndex = 0;
  deviations.forEach((d, i) => {
    if (d > deviations[bestIndex]) bestIndex = i;
  });
  const best = deviations[bestIndex];
  const runnerUp = Math.max(1, ...deviations.filter((_, i) => i !== bestIndex));
  if (best > ROTATION_OUTLIER_FACTOR) return items[bestIndex];
  if (best > ROTATION_OUTLIER_MIN_FACTOR && best >= runnerUp * ROTATION_OUTLIER_MARGIN) return items[bestIndex];
  return null;
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
// discards is far less likely. Only ever used as selectHandRows' own
// fallback when looksLikeConcealedFragment's stronger structural check
// can't settle it (that check should be preferred first - even this
// pair-weighted score can still pick a discard pile that happens to
// combine a coincidental pair AND a coincidental rotation at once, since
// it's still just an additive heuristic, not a structural guarantee).
// Exported for direct unit testing.
export function concealednessScore(row: Detection[]): number {
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

// Whether `tiles` forms a complete 十三么/十六不搭/嚦咕嚦咕 hand -
// scoring.ts's own scoreThirteenOrphans/scoreSixteenUnrelated/
// scoreEightPairs all guard on zero declared melds (see their own
// "declaredMelds.length > 0 -> null" checks), meaning any hand of one of
// these 3 shapes is ALWAYS fully concealed - there's no separate declared
// row for it to ever be split from at all. None of them decompose into
// "melds + one pair" the ordinary way (that's the whole point of being a
// special hand), so looksLikeConcealedFragment needs this as a separate
// path to recognize one when a discard pile is also sitting in the same
// photo. Tolerates one extra stray tile the same way the ordinary-hand
// checks do (e.g. a marker tile merged in from elsewhere by
// rescueRotatedStrays) by trying every single-tile removal against the
// exact COMPLETE_SIZE the underlying isXComplete checks require - doesn't
// attempt to tolerate a MISSING tile, since there's no way to conjure one
// back from a merely-undersized set.
function looksLikeSpecialHand(tiles: Tile[]): boolean {
  const isComplete = (t: Tile[]): boolean => isThirteenOrphansComplete(t) || isSixteenUnrelatedComplete(t) || isEightPairsComplete(t);
  if (tiles.length === COMPLETE_SIZE) return isComplete(tiles);
  if (tiles.length === COMPLETE_SIZE + 1) {
    for (let i = 0; i < tiles.length; i++) {
      if (isComplete([...tiles.slice(0, i), ...tiles.slice(i + 1)])) return true;
    }
  }
  return false;
}

// Whether `row`'s own real tiles decompose into any number of complete
// melds PLUS exactly one pair (trying every tile kind that appears 2+
// times as the candidate pair, in turn) - tolerating one leftover stray
// tile the same way looksLikeDeclaredMelds does - OR form one of the 3
// special hands outright (see looksLikeSpecialHand). A genuine concealed-
// hand fragment always has EXACTLY one pair (將眼) holding everything else
// together as complete melds (or is itself a complete special hand); a
// discard pile's tiles, even when they happen to include a coincidental
// pair (or even a coincidental rotated-looking tile ALONGSIDE one - see
// concealednessScore's own comment on why that combination can happen),
// essentially never ALSO have everything else cleanly grouped this way.
// This is the concealed-side counterpart to looksLikeDeclaredMelds - a
// decisive structural check selectHandRows prefers over
// concealednessScore's softer weighing, which is only a fallback for when
// no candidate cleanly qualifies here.
// Exported for direct unit testing.
export function looksLikeConcealedFragment(row: Detection[]): boolean {
  const tiles = realTiles(row);
  if (looksLikeSpecialHand(tiles)) return true;
  const countByKind = new Map<string, number>();
  for (const t of tiles) {
    const key = `${t.suit}${t.rank}`;
    countByKind.set(key, (countByKind.get(key) ?? 0) + 1);
  }
  for (const [key, count] of countByKind) {
    if (count < 2) continue;
    const suit = key[0] as Suit;
    const rank = Number(key.slice(1));
    let removed = 0;
    const rest: Tile[] = [];
    for (const t of tiles) {
      if (removed < 2 && t.suit === suit && t.rank === rank) removed++;
      else rest.push(t);
    }
    if (rest.length === 0 || canFormMeldsAllowingOneStray(rest)) return true;
  }
  return false;
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

// Whether `row`'s real tiles (bonus tiles set aside) form a complete
// winning hand all on their own (isCompleteHand: melds plus one pair, or
// a special hand) - allowing for ONE detection mistake, since a whole row
// of 17 is a lot of tiles to read perfectly: one tile missed (16 read),
// one misread (17 read, one of them wrong), or one extra (18 read). A
// photo of a real hand came out each way under nothing more than a
// slightly different framing, and demanding a perfect read dropped it
// back onto the old labelling, which got that photo backwards. A discard
// pile essentially never lands within one tile of a complete hand by
// chance, so the tolerance costs nothing there.
//
// Such a row can only be a fully concealed hand: with all 17 tiles
// already concealed there's nothing left to have been declared, so the
// hand's declared side can hold bonus tiles at most.
// Exported for direct unit testing.
export function isCompleteHandRow(row: Detection[]): boolean {
  const tiles = realTiles(row);
  const n = tiles.length;
  if (n < COMPLETE_SIZE - 1 || n > COMPLETE_SIZE + 1) return false;
  const copies = (t: Tile, of: Tile[]) => of.filter((x) => x.suit === t.suit && x.rank === t.rank).length;
  // Every tile kind that could stand in for a missed/misread tile - never
  // a 5th copy of a kind, which no set has.
  const withOneMore = (base: Tile[]) =>
    allTileKinds()
      .filter((k) => copies(k, base) < 4)
      .some((k) => isCompleteHand([...base, k]));
  const without = (i: number) => [...tiles.slice(0, i), ...tiles.slice(i + 1)];
  if (n === COMPLETE_SIZE - 1) return withOneMore(tiles); // one missed
  if (n === COMPLETE_SIZE + 1) return tiles.some((_, i) => isCompleteHand(without(i))); // one extra
  return isCompleteHand(tiles) || tiles.some((_, i) => withOneMore(without(i))); // perfect, or one misread
}

// Whether `row` makes sense as any part of a hand at all - a "messy" row
// that doesn't (in practice a discard pile, however neatly it happens to
// be laid out) gets no box. Judged by what the tiles ARE rather than how
// they're arranged: a discard pile can be a perfectly straight line, but
// its tiles are just whatever got thrown away, so they almost never group
// into anything. A row belonging to a hand always does - it's one of:
//  - bonus tiles only (the declared side's flowers/seasons);
//  - just the hand's pair (the smallest possible concealed row);
//  - complete melds (the declared side - looksLikeDeclaredMelds);
//  - melds plus one pair (a concealed portion - looksLikeConcealedFragment),
//    or ONE tile short of that: a concealed hand waiting on its last tile,
//    which is exactly what the Calculator scans;
//  - a complete hand on its own (isCompleteHandRow).
// Each of those already tolerates one stray/misread tile, so a real row
// read with a single detection mistake still passes; two or more mistakes
// in one row can make it fail and lose its box - the user can always draw
// that one by hand. Anything with more real tiles than any hand could
// hold (see isPlausibleHandRow) is messy outright.
// Exported for direct unit testing.
export function isHandLikeRow(row: Detection[]): boolean {
  if (isAllBonusTiles(row) || isPairOnlyRow(row)) return true;
  if (!isPlausibleHandRow(row)) return false;
  if (looksLikeDeclaredMelds(row) || looksLikeConcealedFragment(row) || isCompleteHandRow(row)) return true;
  // One tile short of melds + pair - a waiting concealed hand (or portion).
  const tiles = realTiles(row);
  const copies = (k: Tile) => tiles.filter((t) => t.suit === k.suit && t.rank === k.rank).length;
  const asRow = (ts: Tile[]): Detection[] => ts.map((tile) => ({ tile, className: `${tile.rank}${tile.suit}`, confidence: 1, box: [0, 0, 0, 0] }));
  return allTileKinds()
    .filter((k) => copies(k) < 4)
    .some((k) => looksLikeConcealedFragment(asRow([...tiles, k])));
}

// Picks out (at most) 2 rows that are actually part of the hand, for
// detectRowRegions' normal 1-or-2-row handling to work with below.
//
// Before anything else, every "messy" row - one that can't be any part of
// a hand (see isHandLikeRow), in practice a discard pile - is dropped, so
// it never gets a box, whatever the row count. If nothing's left, the
// caller falls back to its default boxes.
//
// Then, whatever the row count: if exactly one row is a complete
// hand on its own (see isCompleteHandRow), that row IS the whole hand, so
// no other row of real tiles can be part of it - it's a discard pile, and
// is dropped. The only other row kept is one made up entirely of bonus
// tiles (isAllBonusTiles), as the declared side; if there isn't exactly
// one such row, the complete row comes back alone (and any bonus tiles in
// that same row are split out by regionsFromRows). Without this, a
// discard pile beside a fully concealed hand with its flowers in the same
// row got labelled the concealed hand, with the real hand called declared
// - the flowers tipped declarednessScore that way.
//
// Otherwise, when clusterRows finds 3+ distinct rows, at least one of them
// is very likely not part of the hand at all. Never touches the
// exactly-2-rows (or fewer) case - there's no third row to be suspicious
// of in the first place, so both are trusted as-is and left for
// isRowADeclared to label.
//
// Two passes: first drops anything larger than the hand's own tile-count
// ceiling could ever produce (isPlausibleHandRow) - a discard pile has no
// such ceiling, so it just keeps growing as the game goes on. Then, among
// what's left, looks for a row whose real tiles fully decompose into
// complete melds (looksLikeDeclaredMelds) - if EXACTLY one does, that's
// confidently the declared row, paired with whichever of the rest is
// picked by pickConcealedCandidate below as the concealed-hand candidate,
// dropping everything else. Size is deliberately never the tiebreak
// anywhere in here: a heavily-declared hand can leave a genuinely tiny
// concealed remainder (e.g. just one run plus the pair) that's smaller
// than an ordinary discard pile sitting in the same photo, so "the bigger
// leftover row" can easily pick the wrong one. If no single row settles
// which is declared (none decompose, or more than one ambiguously does),
// falls back to running the same concealed-candidate pick across ALL
// plausible rows, taking just the one result as the sole concealed-hand
// candidate - detectRowRegions' own 1-row handling (splitMixedRow)
// decides what, if anything, to do with it from there.
// Exported for direct unit testing alongside isPlausibleHandRow's and
// looksLikeDeclaredMelds's own reasoning.
export function selectHandRows(
  allRows: Detection[][],
  // Which rows are messy - defaults to judging each row's own detections
  // (isHandLikeRow); detectRowRegions passes confirmMessyRows' verdicts
  // instead, which take a closer look first.
  isMessy: (row: Detection[]) => boolean = (row) => !isHandLikeRow(row)
): Detection[][] {
  const rows = allRows.filter((row) => !isMessy(row));
  const completeRows = rows.filter(isCompleteHandRow);
  if (completeRows.length === 1) {
    const bonusRows = rows.filter(isAllBonusTiles);
    const keep = bonusRows.length === 1 ? [completeRows[0], bonusRows[0]] : [completeRows[0]];
    return rows.filter((r) => keep.includes(r)); // keeps clusterRows' top-to-bottom order
  }
  if (rows.length <= 2) return rows;
  const plausible = rows.filter(isPlausibleHandRow);
  if (plausible.length <= 2) return plausible;

  // Prefers looksLikeConcealedFragment's decisive structural check (melds
  // + exactly one pair) when EXACTLY one candidate qualifies; only falls
  // back to concealednessScore's softer weighing when that check is
  // ambiguous (none or 2+ candidates qualify) - see both functions' own
  // comments for why the structural check is the more reliable of the
  // two. A discard pile can score just as "concealed-looking" as the real
  // hand under concealednessScore alone if it happens to carry BOTH a
  // coincidental pair and a coincidentally-rotated tile at once, but it
  // essentially never ALSO has everything else cleanly grouped into
  // complete melds around that pair the way a genuine concealed fragment
  // does.
  const pickConcealedCandidate = (candidates: Detection[][]): Detection[] => {
    const fragments = candidates.filter(looksLikeConcealedFragment);
    if (fragments.length === 1) return fragments[0];
    return candidates.reduce((a, b) => (concealednessScore(b) < concealednessScore(a) ? b : a));
  };

  // isAllBonusTiles counts too, alongside looksLikeDeclaredMelds - the
  // same unambiguous signal isRowADeclared itself leads with (see its own
  // comment). Without it, a row of ONLY bonus tiles never registers here:
  // looksLikeDeclaredMelds decomposes realTiles(row), which is empty for
  // an all-bonus row, and canFormMeldsAllowingOneStray( [] ) returns
  // false for an empty input - so a real declared side that happens to be
  // just 2 flowers (no melds at all, e.g. everything else was self-drawn)
  // would otherwise never win this check, and - with no OTHER row
  // decomposing into melds either - selectHandRows would fall all the way
  // through to its no-clear-declared-row branch and return the concealed
  // hand ALONE, silently dropping the bonus-tile row entirely rather than
  // pairing the two.
  const meldRows = plausible.filter((row) => looksLikeDeclaredMelds(row) || isAllBonusTiles(row));
  if (meldRows.length === 1) {
    const declared = meldRows[0];
    const rest = plausible.filter((r) => r !== declared);
    return [declared, pickConcealedCandidate(rest)];
  }
  return [pickConcealedCandidate(plausible)];
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

// How wide a gap between two neighbouring tiles in a row (in tile widths)
// counts as deliberate - wider than the jitter between tiles sitting side
// by side, which on real photos stays under 0.06. See
// extendDeclaredToGap.
const DECLARED_GAP_MIN_TILES = 0.15;

// A row whose bonus tiles sit at one end can also hold declared melds
// between them and the concealed hand, set apart from it by a gap: one
// photo had "1f 345p | 456p 22m 33m 44m 55m 3s 5s" with the 4s laid
// sideways above. Moves the real tiles between the bonus tiles and the
// widest such gap over to the declared side, but only when they form
// complete melds - a concealed hand can have gaps of its own between
// groups, and without the bonus tiles marking which end is declared, or
// the melds check, a gap alone says nothing. `real` must be the row's real
// tiles, `bonusOnLeft` which end the bonus tiles sit at. Returns the real
// tiles that move to the declared side (possibly none).
// Exported for direct unit testing.
export function extendDeclaredToGap(real: Detection[], bonusOnLeft: boolean): Detection[] {
  if (real.length < 3) return [];
  const centerX = (d: Detection) => (d.box[0] + d.box[2]) / 2;
  // Ordered starting from the bonus end.
  const ordered = [...real].sort((a, b) => (bonusOnLeft ? centerX(a) - centerX(b) : centerX(b) - centerX(a)));
  const widths = real.map((d) => d.box[2] - d.box[0]).sort((a, b) => a - b);
  const minGap = widths[Math.floor(widths.length / 2)] * DECLARED_GAP_MIN_TILES;
  let best: Detection[] = [];
  let bestGap = minGap;
  // Edge of everything so far nearest the concealed side - a running
  // max/min, since boxes of neighbouring tiles overlap a little.
  let edge = bonusOnLeft ? -Infinity : Infinity;
  for (let k = 0; k < ordered.length - 2; k++) {
    edge = bonusOnLeft ? Math.max(edge, ordered[k].box[2]) : Math.min(edge, ordered[k].box[0]);
    const next = ordered[k + 1];
    const gap = bonusOnLeft ? next.box[0] - edge : edge - next.box[2];
    const segment = ordered.slice(0, k + 1);
    if (gap > bestGap && canFormOnlyMelds(realTiles(segment))) {
      bestGap = gap;
      best = segment;
    }
  }
  return best;
}

// `declared` is optional: a single detected row with no bonus tiles to
// split it by content (see splitMixedRow) has nothing to confidently call
// Declared at all - most often a fully concealed hand with no declared
// melds and no bonus tiles either. detectRowRegions still fits the sole
// Concealed region around it in that case rather than giving up entirely
// - see its own comment.
export interface DetectedRegions {
  concealed: RowRegion;
  declared?: RowRegion;
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
// regardless of which caller reached here. `minEdgePadTiles` (see
// DECLARED_ROW_MIN_EDGE_PAD_TILES) additionally floors the horizontal
// padding at that many tile-widths, measured from the row's own
// detections - only the declared-row caller in detectRowRegions passes
// this; every other caller leaves it at 0 (no floor beyond padXFraction).
// Exported for direct unit testing - detectRowRegions itself still needs
// a real model/canvas to test end-to-end.
// Widens [x1, x2] out to MIN_REGION_WIDTH (symmetrically, around its own
// center) if it's narrower than that - shifting the whole span rather
// than clamping each edge independently, so a region sitting right at
// the frame's edge still reaches the full minimum width by expanding
// away from that edge instead of silently staying too narrow.
function ensureMinWidth(x1: number, x2: number): [number, number] {
  if (x2 - x1 >= MIN_REGION_WIDTH) return [x1, x2];
  const center = (x1 + x2) / 2;
  let newX1 = center - MIN_REGION_WIDTH / 2;
  let newX2 = center + MIN_REGION_WIDTH / 2;
  if (newX1 < 0) {
    newX2 -= newX1;
    newX1 = 0;
  } else if (newX2 > 1) {
    newX1 -= newX2 - 1;
    newX2 = 1;
  }
  return [clamp01(newX1), clamp01(newX2)];
}

export function rowToRegion(
  row: Detection[],
  image: ImageSize,
  padXFraction: number = ROW_PAD_X,
  minEdgePadTiles: number = 0
): RowRegion {
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
  let padXAmount = w * padXFraction;
  if (minEdgePadTiles > 0) {
    const widths = row.map((d) => d.box[2] - d.box[0]).sort((a, b) => a - b);
    const medianTileWidthBox = widths[Math.floor(widths.length / 2)];
    const tileWidthFraction = medianTileWidthBox / scale / srcWidth;
    padXAmount = Math.max(padXAmount, tileWidthFraction * minEdgePadTiles);
  }
  fx1 = clamp01(fx1 - padXAmount);
  fx2 = clamp01(fx2 + padXAmount);
  fy1 = clamp01(fy1 - h * padYFraction);
  fy2 = clamp01(fy2 + h * padYFraction);
  // Only the normal (default ROW_PAD_X) case gets the minimum-width floor
  // - a caller passing SPLIT_PAD_X is fitting one of splitMixedRow's two
  // side-by-side halves, deliberately packed tight against each other
  // with no vertical gap to lean on; widening either one out to
  // MIN_REGION_WIDTH there could make the pair overlap, with no
  // horizontal-overlap resolver (unlike resolveVerticalOverlap) to fix it
  // back up afterward.
  if (padXFraction === ROW_PAD_X) [fx1, fx2] = ensureMinWidth(fx1, fx2);
  return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1 };
}

function rectsOverlap(a: RowRegion, b: RowRegion): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// If `a` and `b` end up overlapping after padding - most likely because
// the padded rows sit close enough together that
// ROW_PAD_Y/ROTATED_TILE_ROW_PAD_Y on each side eats further into their
// actual gap than the gap itself allows - trims both back to meet at the
// midpoint of their combined span, rather than let the whole autofit
// result get rejected outright by the caller's own overlap check (see
// fittedRegionsFrom in App.tsx). Whichever region sits on top gets its
// bottom edge trimmed up to the midpoint; the other's top edge trimmed
// down to meet it. A no-op when they don't actually overlap - checked in
// BOTH axes, not just vertically: splitMixedRow's two halves come from
// the same physical row, so they always share a vertical span while
// sitting side by side with a horizontal gap between them. Trimming those
// on vertical overlap alone sliced each half into a horizontal strip,
// cutting the tiles in half.
// Exported for direct unit testing.
export function resolveVerticalOverlap(a: RowRegion, b: RowRegion): [RowRegion, RowRegion] {
  if (!rectsOverlap(a, b)) return [a, b];
  const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
  const midpoint = (top.y + top.h + bottom.y) / 2;
  const trimmedTop: RowRegion = { ...top, h: midpoint - top.y };
  const trimmedBottom: RowRegion = { ...bottom, y: midpoint, h: bottom.y + bottom.h - midpoint };
  // One box spanning the other's whole height can't be split at a
  // midpoint - trimming would turn one inside out (negative height). Leave
  // both as they are for the caller's own overlap check to reject.
  if (trimmedTop.h <= 0 || trimmedBottom.h <= 0) return [a, b];
  return a.y <= b.y ? [trimmedTop, trimmedBottom] : [trimmedBottom, trimmedTop];
}

// A rectangle of the source photo, in whole source-image pixels.
export interface ImageWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Each detail window's size as a fraction of the photo, in both
// dimensions (along whichever axes detailWindows splits). Two windows
// along an axis at this size overlap by 20% of the photo in the middle -
// far wider than any one tile, so every tile sits
// wholly inside at least one window even after mapWindowDetections drops
// the ones cut off at a window's inner edge. Letterboxing a 60% window
// instead of the whole photo makes every tile up to ~1.7x larger in the
// model's input frame.
const DETAIL_WINDOW_FRACTION = 0.6;
// How close (in the window's own letterboxed frame, i.e. model-input
// pixels) a detection's box may come to one of the window's INNER edges
// before it's treated as a tile cut off by that edge rather than a whole
// one. The overlapping neighbor window sees that tile whole instead.
const WINDOW_EDGE_MARGIN = 3;

// The overlapping windows detectRowRegions' detail pass runs detection on
// - see DETAIL_WINDOW_FRACTION. Each axis is split into 2 windows only if
// that actually enlarges the tiles: a wide photo (e.g. a 16:9 video frame)
// is letterboxed by its width alone, so splitting its height too would
// double the model runs for no gain - left/right halves alone reach the
// same scale. A near-square photo (e.g. a 4:3 phone shot) needs both
// axes split for any real gain, so it gets the full 2x2 grid. Rounded to
// whole pixels so the cropped canvas (see cropToWindow) is exactly the
// window's size and mapWindowDetections' coordinate math lines up with it
// exactly.
// Exported for direct unit testing.
export function detailWindows(image: ImageSize): ImageWindow[] {
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  const splitW = Math.round(W * DETAIL_WINDOW_FRACTION);
  const splitH = Math.round(H * DETAIL_WINDOW_FRACTION);
  const scaleOf = (w: number, h: number) => Math.min(IMG_SIZE / w, IMG_SIZE / h);
  // Fewest windows first, so a tie on scale keeps the cheaper layout.
  const layouts = [
    { splitX: true, splitY: false },
    { splitX: false, splitY: true },
    { splitX: true, splitY: true },
  ];
  const best = layouts.reduce((a, b) => {
    const scaleA = scaleOf(a.splitX ? splitW : W, a.splitY ? splitH : H);
    const scaleB = scaleOf(b.splitX ? splitW : W, b.splitY ? splitH : H);
    return scaleB > scaleA * 1.001 ? b : a;
  });
  const w = best.splitX ? splitW : W;
  const h = best.splitY ? splitH : H;
  const xs = best.splitX ? [0, W - w] : [0];
  const ys = best.splitY ? [0, H - h] : [0];
  return ys.flatMap((y) => xs.map((x) => ({ x, y, w, h })));
}

// Maps detections from one detail window's own letterboxed frame into the
// WHOLE photo's letterboxed frame (the frame every Detection in
// detectRowRegions is otherwise in, and that rowToRegion expects),
// dropping any whose box touches one of the window's inner edges (edges
// that aren't also the photo's own border) - that's a tile cut off by the
// window, whose truncated box wouldn't reliably NMS away against the
// whole-tile box the neighboring window sees for it.
// Exported for direct unit testing.
export function mapWindowDetections(detections: Detection[], win: ImageWindow, image: ImageSize): Detection[] {
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  const winScale = Math.min(IMG_SIZE / win.w, IMG_SIZE / win.h);
  const winPadX = (IMG_SIZE - win.w * winScale) / 2;
  const winPadY = (IMG_SIZE - win.h * winScale) / 2;
  const scale = Math.min(IMG_SIZE / W, IMG_SIZE / H);
  const padX = (IMG_SIZE - W * scale) / 2;
  const padY = (IMG_SIZE - H * scale) / 2;
  const innerLeft = win.x > 0 ? winPadX + WINDOW_EDGE_MARGIN : -Infinity;
  const innerTop = win.y > 0 ? winPadY + WINDOW_EDGE_MARGIN : -Infinity;
  const innerRight = win.x + win.w < W ? IMG_SIZE - winPadX - WINDOW_EDGE_MARGIN : Infinity;
  const innerBottom = win.y + win.h < H ? IMG_SIZE - winPadY - WINDOW_EDGE_MARGIN : Infinity;
  return detections
    .filter(({ box: [x1, y1, x2, y2] }) => x1 > innerLeft && y1 > innerTop && x2 < innerRight && y2 < innerBottom)
    .map((d) => {
      const [x1, y1, x2, y2] = d.box;
      const toX = (bx: number) => padX + (win.x + (bx - winPadX) / winScale) * scale;
      const toY = (by: number) => padY + (win.y + (by - winPadY) / winScale) * scale;
      return { ...d, box: [toX(x1), toY(y1), toX(x2), toY(y2)] };
    });
}

function cropToWindow(image: HTMLImageElement, win: ImageWindow): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = win.w;
  canvas.height = win.h;
  canvas.getContext("2d")!.drawImage(image, win.x, win.y, win.w, win.h, 0, 0, win.w, win.h);
  return canvas;
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
//
// Shrinking the whole photo to IMG_SIZE can leave tiles too small for the
// model to find at all - a row set further back from the camera (often
// the declared melds, in a photo shot from the player's own seat) comes
// out noticeably smaller and more foreshortened than the row nearest the
// lens, and can drop out of the detections entirely while the near row
// is found fine. So when the whole-photo pass finds fewer than 2 rows,
// this re-runs detection on an overlapping grid of detail windows (see
// detailWindows), where every tile is larger, and merges those detections
// in - keeping the merged result only if it actually finds more rows.
// The extra passes only ever run on that fallback path, so a photo the
// first pass already handles costs nothing more.
export async function detectRowRegions(image: HTMLImageElement): Promise<DetectedRegions | null> {
  const { detections } = await detectTiles(letterbox(image));
  const clustered = clusterRows(detections);
  const messy = await confirmMessyRows(image, clustered);
  let rows = selectHandRows(clustered, (row) => messy.has(row));
  // A lone row that's already a complete hand needs no second look - see
  // isCompleteHandRow.
  if (rows.length < 2 && !(rows.length === 1 && isCompleteHandRow(rows[0]))) {
    const detailed = [...detections];
    for (const win of detailWindows(image)) {
      const { detections: windowDetections } = await detectTiles(letterbox(cropToWindow(image, win)));
      detailed.push(...mapWindowDetections(windowDetections, win, image));
    }
    const detailedClustered = clusterRows(nonMaxSuppression(detailed));
    const detailedMessy = await confirmMessyRows(image, detailedClustered);
    const detailedRows = selectHandRows(detailedClustered, (row) => detailedMessy.has(row));
    if (detailedRows.length > rows.length) rows = detailedRows;
  }
  // Look just past each chosen row's ends for tiles the low-resolution
  // read missed (see growRowEnds), so the box doesn't stop short of them.
  // Always - even when the rows already hold a complete hand's worth of
  // real tiles, since that says nothing about bonus tiles: on one phone a
  // fully concealed hand's 17 tiles were all read but the flowers beside
  // them weren't, and skipping this left them out of every box.
  const grown: Detection[][] = [];
  for (const row of rows) grown.push(await growRowEnds(image, row, rows.filter((r) => r !== row).flat()));
  return regionsFromRows(grown, image);
}

// How far past a row's box each of growRowEnds' two looks is shifted, in
// tile widths, and the widest gap between one tile and the next that still
// counts as the same row (gaps between melds are well under this).
const GROW_SHIFT_TILES = 2.5;
const GROW_MAX_GAP_TILES = 2;

// Adds to `row` any of `candidates` (detections from looks past its ends,
// already in the whole-photo frame) that continue it outward: centered
// within the row's own height band, not already one of its tiles or one of
// `taken` (tiles belonging to another row - e.g. a bonus-tile row sitting
// just above), and each within GROW_MAX_GAP_TILES of the tile before it,
// tile by tile, so it can't jump across the table to something unrelated.
// Exported for direct unit testing.
export function extendRowEnds(row: Detection[], candidates: Detection[], taken: Detection[] = []): Detection[] {
  if (row.length === 0) return row;
  const widths = row.map((d) => d.box[2] - d.box[0]).sort((a, b) => a - b);
  const tileW = widths[Math.floor(widths.length / 2)];
  const top = Math.min(...row.map((d) => d.box[1]));
  const bottom = Math.max(...row.map((d) => d.box[3]));
  const overlaps = (d: Detection, list: Detection[]) => list.some((e) => boxIou(e.box, d.box) > 0.3);
  const pool = candidates.filter((d) => {
    const cy = (d.box[1] + d.box[3]) / 2;
    return cy >= top && cy <= bottom && !overlaps(d, row) && !overlaps(d, taken);
  });
  const result = [...row];
  let left = Math.min(...row.map((d) => d.box[0]));
  let right = Math.max(...row.map((d) => d.box[2]));
  const maxGap = GROW_MAX_GAP_TILES * tileW;
  for (;;) {
    const next = pool
      .filter((d) => !result.includes(d) && d.box[0] < left && d.box[2] <= left + tileW / 2 && d.box[2] >= left - maxGap)
      .sort((a, b) => b.box[2] - a.box[2])[0];
    if (!next || overlaps(next, result)) break;
    result.push(next);
    left = next.box[0];
  }
  for (;;) {
    const next = pool
      .filter((d) => !result.includes(d) && d.box[2] > right && d.box[0] >= right - tileW / 2 && d.box[0] <= right + maxGap)
      .sort((a, b) => a.box[0] - b.box[0])[0];
    if (!next || overlaps(next, result)) break;
    result.push(next);
    right = next.box[2];
  }
  return result;
}

// A row's box is drawn around the tiles auto-fit's low-resolution whole-
// photo read actually FOUND, and the tiles at a row's ends are the ones it
// most often misses - on one phone, a real concealed row's two leftmost
// tiles (1b, 2b) went undetected, and since the rest (3b 66b 789b) still
// looked like a sensible concealed fragment nothing flagged it: the box
// just stopped at the 3b. So this takes a second look past each end: the
// row's own box shifted GROW_SHIFT_TILES outward, the SAME size so the
// tiles stay the same size to the model (simply widening the box instead
// made them smaller, and the scan then read only half the row), and adds
// whatever continues the row (see extendRowEnds). Two model runs per row.
async function growRowEnds(image: HTMLImageElement, row: Detection[], taken: Detection[]): Promise<Detection[]> {
  if (row.length === 0) return row;
  const base = rowToRegion(row, image);
  const scale = Math.min(IMG_SIZE / image.naturalWidth, IMG_SIZE / image.naturalHeight);
  const widths = row.map((d) => d.box[2] - d.box[0]).sort((a, b) => a - b);
  const shift = (GROW_SHIFT_TILES * widths[Math.floor(widths.length / 2)]) / scale / image.naturalWidth;
  const whole = photoCrop({ x: 0, y: 0, w: 1, h: 1 }, image);
  const candidates: Detection[] = [];
  for (const dir of [-1, 1]) {
    const x = Math.min(Math.max(0, base.x + dir * shift), 1 - base.w);
    if (Math.abs(x - base.x) < 1e-6) continue; // already at the photo's edge on this side
    const look = { ...base, x };
    const { detections } = await detectTiles(letterbox(cropRegion(image, look)));
    candidates.push(...remapDetections(detections, photoCrop(look, image), whole));
  }
  return extendRowEnds(row, candidates, taken);
}

// Which of `rows` are messy (see isHandLikeRow) - judged on a proper read,
// not just the whole-photo one. Auto-fit's whole-photo detections are low
// resolution and often only catch part of a row (4 of a real concealed
// row's 8 tiles, in one photo), and a partial read of a real row doesn't
// group into anything either - it'd look exactly as messy as a discard
// pile. So a row that fails on its whole-photo read is re-detected from a
// crop of just that row (rowToRegion - about how the scan itself will see
// it), and only called messy if that closer read still doesn't make sense
// as part of a hand. Costs one extra model run per suspicious row; a row
// with more real tiles than any hand could hold is messy outright.
async function confirmMessyRows(image: HTMLImageElement, rows: Detection[][]): Promise<Set<Detection[]>> {
  const messy = new Set<Detection[]>();
  for (const row of rows) {
    if (isHandLikeRow(row)) continue;
    if (!isPlausibleHandRow(row)) {
      messy.add(row);
      continue;
    }
    const { detections } = await detectTiles(letterbox(cropRegion(image, rowToRegion(row, image))));
    // The crop's padding can catch the edge of a neighbouring row - judge
    // the biggest row within it, which is this one.
    const closer = clusterRows(detections).reduce<Detection[]>((a, b) => (b.length > a.length ? b : a), []);
    if (!isHandLikeRow(closer)) messy.add(row);
  }
  return messy;
}

// The pure second half of detectRowRegions - turns selectHandRows' chosen
// rows into padded, labelled regions, or null if there's nothing usable.
// Split out so the whole post-detection pipeline can be unit tested
// against recorded detections, without a real model or canvas.
// Exported for direct unit testing.
export function regionsFromRows(rows: Detection[][], image: ImageSize): DetectedRegions | null {
  if (rows.length === 2) {
    // Which physical row is Declared vs Concealed - see isRowADeclared.
    const [rowA, rowB] = rows; // rowA = top, rowB = bottom (clusterRows sorts top-to-bottom)
    const aIsDeclared = isRowADeclared(rowA, rowB);
    const declaredRow = aIsDeclared ? rowA : rowB;
    const concealedRow = aIsDeclared ? rowB : rowA;
    const [declared, concealed] = resolveVerticalOverlap(
      rowToRegion(declaredRow, image, ROW_PAD_X, DECLARED_ROW_MIN_EDGE_PAD_TILES),
      rowToRegion(concealedRow, image)
    );
    return { declared, concealed };
  }

  if (rows.length === 1) {
    // A fully concealed hand (nothing declared, so no second row ever
    // forms) can still carry its own bonus tiles within that one row -
    // see splitMixedRow.
    const split = splitMixedRow(rows[0]);
    if (split) {
      // Only a clean side-by-side split if every bonus tile sits on the same
      // side of every real tile. Bonus tiles at both ends of the row, or in
      // among the real tiles, get one Concealed box around the whole row
      // instead - the Scoring tab counts any bonus tile scanned in the
      // Concealed region as declared anyway.
      const centerX = (d: Detection) => (d.box[0] + d.box[2]) / 2;
      const bonusXs = split.declared.map(centerX);
      const realXs = split.concealed.map(centerX);
      const bonusOnLeft = Math.max(...bonusXs) < Math.min(...realXs);
      if (!bonusOnLeft && Math.min(...bonusXs) <= Math.max(...realXs)) return { concealed: rowToRegion(rows[0], image) };
      // Declared melds set apart beside the bonus tiles join them - see
      // extendDeclaredToGap.
      const declaredMelds = extendDeclaredToGap(split.concealed, bonusOnLeft);
      split.declared.push(...declaredMelds);
      split.concealed = split.concealed.filter((d) => !declaredMelds.includes(d));
      // Bonus tiles often sit right up against the hand on the rack, so the
      // two halves' padded boxes can overlap by a few pixels - meet them
      // at the midpoint between the tiles' own facing edges instead. But a
      // gap of half a tile or more between the two groups most likely
      // hides a tile the read missed there - and a bonus tile, since those
      // are what the model misses (the hand's own tiles read reliably) -
      // so then the whole gap goes to the bonus half, the boundary sitting
      // right at the hand's own edge, instead of the midpoint cutting that
      // missed tile in half and leaving it half-visible to both scans.
      const [leftTiles, rightTiles] = bonusOnLeft ? [split.declared, split.concealed] : [split.concealed, split.declared];
      const leftTight = rowToRegion(leftTiles, image, 0);
      const rightTight = rowToRegion(rightTiles, image, 0);
      const gap = rightTight.x - (leftTight.x + leftTight.w);
      const scale = Math.min(IMG_SIZE / image.naturalWidth, IMG_SIZE / image.naturalHeight);
      const widths = rows[0].map((d) => d.box[2] - d.box[0]).sort((a, b) => a - b);
      const tileW = widths[Math.floor(widths.length / 2)] / scale / image.naturalWidth;
      const boundary =
        gap < tileW / 2 ? (leftTight.x + leftTight.w + rightTight.x) / 2 : bonusOnLeft ? rightTight.x : leftTight.x + leftTight.w;
      // The bonus half gets extra room at its outer end (see
      // BONUS_SPLIT_MIN_EDGE_PAD_TILES); the concealed half doesn't.
      const bonusPad = (half: Detection[]) => (half === split.declared ? BONUS_SPLIT_MIN_EDGE_PAD_TILES : 0);
      const left = rowToRegion(leftTiles, image, SPLIT_PAD_X, bonusPad(leftTiles));
      const right = rowToRegion(rightTiles, image, SPLIT_PAD_X, bonusPad(rightTiles));
      // The left half stops a hair short of the boundary: floating-point
      // rounding could otherwise leave its right edge a fraction past the
      // right half's left edge, which counts as an overlap - both for
      // App.tsx's own overlap check (rejecting the whole fit) and, before
      // this, for resolveVerticalOverlap (which then sliced the bonus box
      // into a thin strip under its tiles). Seen on a real photo.
      const trimmedLeft = { ...left, w: Math.min(left.x + left.w, boundary - SPLIT_GAP) - left.x };
      const rightX = Math.max(right.x, boundary);
      const trimmedRight = { ...right, x: rightX, w: right.x + right.w - rightX };
      const [declaredHalf, concealedHalf] = bonusOnLeft ? [trimmedLeft, trimmedRight] : [trimmedRight, trimmedLeft];
      // Side by side by construction - never trimmed vertically.
      return { declared: declaredHalf, concealed: concealedHalf };
    }
    // Nothing to split the row by content (no bonus tiles at all) - most
    // likely a fully concealed hand with nothing declared and no bonus
    // tiles either. Still worth fitting the sole Concealed region around
    // it rather than giving up entirely - the caller can always add a
    // Declared region by hand afterward if this guess turns out wrong.
    return { concealed: rowToRegion(rows[0], image) };
  }

  return null;
}

// A crop of the source photo exactly as the scan feeds it to the model:
// `x`/`y`/`w`/`h` are the source-photo pixels it covers (fractional - a
// region's own fractions times the photo's size), `canvasWidth`/
// `canvasHeight` the whole-pixel canvas those pixels get drawn into
// before letterboxing. Everything the re-check pass maps between crops is
// expressed against one of these, so a detection from one crop's
// letterboxed frame lands on exactly the same photo pixels in another's.
export interface PhotoCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  canvasWidth: number;
  canvasHeight: number;
}

// Describes (without drawing anything) the crop cropRegion makes for
// `rect` - pure, so the mapping math that depends on it is unit testable.
// Exported for direct unit testing.
export function photoCrop(rect: RowRegion, image: ImageSize): PhotoCrop {
  const w = rect.w * image.naturalWidth;
  const h = rect.h * image.naturalHeight;
  return {
    x: rect.x * image.naturalWidth,
    y: rect.y * image.naturalHeight,
    w,
    h,
    canvasWidth: Math.max(1, Math.round(w)),
    canvasHeight: Math.max(1, Math.round(h)),
  };
}

// Draws the selected fraction of `image` onto a new canvas at native
// resolution - the crop is applied before letterboxing, so anything
// outside it never reaches the detector. The one place every scan crop
// (first pass and re-check alike) is made, so they all share photoCrop's
// exact geometry.
export function cropRegion(image: HTMLImageElement, rect: RowRegion): HTMLCanvasElement {
  const crop = photoCrop(rect, image);
  const canvas = document.createElement("canvas");
  canvas.width = crop.canvasWidth;
  canvas.height = crop.canvasHeight;
  canvas.getContext("2d")!.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// letterbox()'s own centering math for a crop, plus how many source-photo
// pixels each canvas pixel covers (a hair off 1 once photoCrop rounds the
// canvas to whole pixels).
function letterboxFrame(crop: PhotoCrop) {
  const scale = Math.min(IMG_SIZE / crop.canvasWidth, IMG_SIZE / crop.canvasHeight);
  return {
    scale,
    padX: (IMG_SIZE - crop.canvasWidth * scale) / 2,
    padY: (IMG_SIZE - crop.canvasHeight * scale) / 2,
    pxX: crop.w / crop.canvasWidth,
    pxY: crop.h / crop.canvasHeight,
  };
}

// Maps detections from one crop's letterboxed frame into another's, via
// the source photo's own pixels, keeping only those whose center falls
// inside `to` - a re-check crop that reaches further out than the region
// the user actually chose (see recheckRects) can pick up tiles from next
// to it (the other row, the discard pile), and those must never be added
// to this region.
// Exported for direct unit testing.
export function remapDetections(detections: Detection[], from: PhotoCrop, to: PhotoCrop): Detection[] {
  const f = letterboxFrame(from);
  const t = letterboxFrame(to);
  const srcX = (bx: number) => from.x + ((bx - f.padX) / f.scale) * f.pxX;
  const srcY = (by: number) => from.y + ((by - f.padY) / f.scale) * f.pxY;
  const dstX = (sx: number) => t.padX + ((sx - to.x) / t.pxX) * t.scale;
  const dstY = (sy: number) => t.padY + ((sy - to.y) / t.pxY) * t.scale;
  return detections.flatMap((d) => {
    const [x1, y1, x2, y2] = d.box;
    const cx = srcX((x1 + x2) / 2);
    const cy = srcY((y1 + y2) / 2);
    if (cx < to.x || cx > to.x + to.w || cy < to.y || cy > to.y + to.h) return [];
    return [{ ...d, box: [dstX(srcX(x1)), dstY(srcY(y1)), dstX(srcX(x2)), dstY(srcY(y2))] }];
  });
}

// How far (as fractions of the whole photo: left, top, right, bottom)
// each re-check crop reaches beyond the region the user chose. A tile
// sitting close to the model's confidence cutoff - the 1b's fine line-art
// bird is the example this was built for - can flip between found and
// missed on crop changes this small: moving a region's edges by up to 3%
// swung it anywhere from 0.00 to 0.83 in testing, with no one direction
// consistently better. So rather than guess a "better" crop, the re-check
// samples several that each resize and frame the tiles a little
// differently, and lets them vote (see mergeRecheckRuns). Every crop only
// ever grows outward, never cutting into the chosen region, so no tile
// the user included is ever cropped off in any of them.
const RECHECK_PADDINGS: [number, number, number, number][] = [
  [0.02, 0.02, 0.02, 0.02], // a little more room all round
  [0.04, 0, 0.04, 0], // wider only - resizes the tiles differently
  [0.03, 0.03, 0, 0], // shifted up and left
  [0, 0, 0.03, 0.03], // shifted down and right
];

// The re-check crops for `rect` (see RECHECK_PADDINGS), clamped to the
// photo. Drops any that clamping leaves identical to `rect` itself or to
// an earlier one (a region already touching the photo's edges has less
// room to grow), since those would just repeat a run for no new vote.
// Exported for direct unit testing.
export function recheckRects(rect: RowRegion): RowRegion[] {
  const same = (a: RowRegion, b: RowRegion) =>
    Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.w - b.w) < 1e-9 && Math.abs(a.h - b.h) < 1e-9;
  const out: RowRegion[] = [];
  for (const [l, t, r, b] of RECHECK_PADDINGS) {
    const x1 = clamp01(rect.x - l);
    const y1 = clamp01(rect.y - t);
    const x2 = clamp01(rect.x + rect.w + r);
    const y2 = clamp01(rect.y + rect.h + b);
    const next = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    if (!same(next, rect) && !out.some((o) => same(o, next))) out.push(next);
  }
  return out;
}

// Share of the darkest and brightest pixels (per color channel) that
// autoContrast clips when stretching the rest to the full 0-255 range.
const AUTO_CONTRAST_CUTOFF = 0.02;

// A copy of `canvas` with each color channel stretched so its darkest/
// brightest AUTO_CONTRAST_CUTOFF lands on 0/255. Brings back fine dark
// strokes that overexposure has washed toward white - in testing, a 1b
// the model had lost at +20% brightness came back at 0.72 this way. Can't
// recover detail the camera clipped outright, though; at +40% nothing
// came back.
export function autoContrast(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const px = image.data;
  const count = px.length / 4;
  for (let c = 0; c < 3; c++) {
    const hist = new Array(256).fill(0);
    for (let i = c; i < px.length; i += 4) hist[px[i]]++;
    const cut = count * AUTO_CONTRAST_CUTOFF;
    let lo = 0;
    for (let seen = 0; lo < 255 && seen + hist[lo] <= cut; lo++) seen += hist[lo];
    let hi = 255;
    for (let seen = 0; hi > 0 && seen + hist[hi] <= cut; hi--) seen += hist[hi];
    if (hi - lo < 1) continue;
    const k = 255 / (hi - lo);
    for (let i = c; i < px.length; i += 4) px[i] = Math.min(255, Math.max(0, Math.round((px[i] - lo) * k)));
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

// How much two runs' boxes must overlap to count as the same physical
// tile when merging re-check runs - looser than NMS_IOU_THRESHOLD since
// the same tile's box shifts a little between differently-sized crops.
const RECHECK_MATCH_IOU = 0.5;

// A tile after the re-check pass. `recovery` marks what the re-check
// changed, so the review step can ask the user to double-check exactly
// those: "added" - the first pass missed it entirely; "reclassified" - the
// first pass found it but the re-check runs mostly read it as a different
// tile. null - unchanged.
export interface RecheckedDetection extends Detection {
  recovery: "added" | "reclassified" | null;
}

// Merges the first pass's detections with the re-check runs' (all already
// in the first pass's own frame - see remapDetections) by voting, tile by
// tile:
//  - Each first-pass tile is always kept. Its name becomes whichever class
//    has the highest total confidence across every run that found it -
//    so a first-pass misread that most re-check runs disagree with gets
//    corrected, and marked "reclassified".
//  - A tile the first pass missed is added (marked "added") only if a
//    MAJORITY of the re-check runs found it. That's what stops the
//    re-check from inventing tiles: a one-off false detection in a single
//    run never makes it in. It deliberately doesn't ask whether an added
//    tile would complete the hand - picking tiles by "does this make it
//    win" could just as easily land on a wrong hand that happens to win.
// Exported for direct unit testing.
export function mergeRecheckRuns(first: Detection[], runs: Detection[][]): RecheckedDetection[] {
  type Cluster = { anchor: Detection["box"]; firstPass: Detection | null; members: { run: number; d: Detection }[] };
  const clusters: Cluster[] = first.map((d) => ({ anchor: d.box, firstPass: d, members: [{ run: -1, d }] }));
  runs.forEach((detections, run) => {
    for (const d of [...detections].sort((a, b) => b.confidence - a.confidence)) {
      let best: Cluster | null = null;
      let bestIou = RECHECK_MATCH_IOU;
      for (const c of clusters) {
        if (c.members.some((m) => m.run === run)) continue; // one vote per run per tile
        const iou = boxIou(c.anchor, d.box);
        if (iou >= bestIou) {
          best = c;
          bestIou = iou;
        }
      }
      if (best) best.members.push({ run, d });
      else clusters.push({ anchor: d.box, firstPass: null, members: [{ run, d }] });
    }
  });

  const majority = Math.floor(runs.length / 2) + 1;
  return clusters.flatMap((c) => {
    if (!c.firstPass && c.members.length < majority) return [];
    const scoreByClass = new Map<string, number>();
    for (const { d } of c.members) scoreByClass.set(d.className, (scoreByClass.get(d.className) ?? 0) + d.confidence);
    const className = [...scoreByClass.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const best = c.members.filter((m) => m.d.className === className).reduce((a, b) => (b.d.confidence > a.d.confidence ? b : a)).d;
    const recovery = !c.firstPass ? "added" : className !== c.firstPass.className ? "reclassified" : null;
    return [
      {
        className,
        tile: classToTile(className),
        confidence: best.confidence,
        // A first-pass tile keeps its own box (it's what the user's
        // review image was drawn around); an added one takes its best
        // run's.
        box: c.firstPass ? c.firstPass.box : best.box,
        recovery,
      },
    ];
  });
}

// The re-check pass for one scanned region: runs detection again on each
// of recheckRects' crops plus an auto-contrast copy of the region itself,
// maps every run's tiles back into the first pass's frame, and merges them
// with the first pass by vote (see mergeRecheckRuns). Only meant to run
// when the first pass didn't add up (the caller decides - a hand that
// isn't a legal winning hand, a tile count the Calculator can't use) -
// it's several extra model runs per region.
export async function recheckRegion(
  image: HTMLImageElement,
  rect: RowRegion,
  first: Detection[],
  onProgress?: (p: ScanProgress) => void
): Promise<RecheckedDetection[]> {
  onProgress?.({ phase: "rechecking" });
  const base = photoCrop(rect, image);
  const runs: Detection[][] = [];
  for (const variant of recheckRects(rect)) {
    const { detections } = await detectTiles(letterbox(cropRegion(image, variant)));
    runs.push(remapDetections(detections, photoCrop(variant, image), base));
  }
  // Same geometry as the first pass, so its boxes are already in its frame.
  runs.push((await detectTiles(letterbox(autoContrast(cropRegion(image, rect))))).detections);
  return mergeRecheckRuns(first, runs);
}
