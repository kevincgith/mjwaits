// Client-side mahjong tile detection: a YOLOv8s model trained on a merged
// dataset from https://github.com/Andy8647/MahjongVis (MIT) and
// https://github.com/jaheel/MJOD-2136 (CC BY-NC-SA), run entirely in the
// browser via onnxruntime-web (WASM). No image ever leaves the device.

import * as ort from "onnxruntime-web";
import type { Tile } from "./mahjong";

const IMG_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.4;

// Unified class order the model was trained with: mjwaits's own 34 tile
// kinds (m/t/s 1-9, honors 1z-7z) followed by 8 bonus classes (flowers,
// seasons) that mjwaits doesn't represent - a hand's shape never includes
// them, so they're excluded from the detected hand rather than mapped.
const CLASS_NAMES = [
  "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m",
  "1t", "2t", "3t", "4t", "5t", "6t", "7t", "8t", "9t",
  "1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s",
  "1z", "2z", "3z", "4z", "5z", "6z", "7z",
  "flower1", "flower2", "flower3", "flower4",
  "season1", "season2", "season3", "season4",
] as const;

// Maps a model class name to a mjwaits Tile, or null for classes mjwaits
// doesn't represent (flowers/seasons are bonus tiles set aside on draw -
// they don't factor into a hand's shape or its waits).
function classToTile(className: string): Tile | null {
  const suit = className[className.length - 1];
  if (suit !== "m" && suit !== "t" && suit !== "s" && suit !== "z") return null;
  return { suit, rank: Number(className.slice(0, -1)) };
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

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(`${import.meta.env.BASE_URL}model/tile-detector.onnx`, {
      executionProviders: ["wasm"],
    });
  }
  return sessionPromise;
}

// Resizes `image` to fit IMG_SIZE x IMG_SIZE without distortion, padding the
// rest with gray - the same preprocessing the model was trained/exported
// with. Returned canvas doubles as the base for drawing detection boxes on.
export function letterbox(image: HTMLImageElement): Letterbox {
  const canvas = document.createElement("canvas");
  canvas.width = IMG_SIZE;
  canvas.height = IMG_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  const scale = Math.min(IMG_SIZE / image.naturalWidth, IMG_SIZE / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
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

// Runs detection on an already-letterboxed canvas (see `letterbox`).
export async function detectTiles(box: Letterbox): Promise<DetectionResult> {
  const session = await getSession();
  const outputs = await session.run({ images: toTensor(box.canvas) });
  const out = outputs.output0.data as Float32Array;
  const numDetections = outputs.output0.dims[1];

  const detections: Detection[] = [];
  for (let i = 0; i < numDetections; i++) {
    const off = i * 6;
    const confidence = out[off + 4];
    if (confidence < CONFIDENCE_THRESHOLD) continue;
    const className = CLASS_NAMES[Math.round(out[off + 5])];
    detections.push({
      tile: classToTile(className),
      className,
      confidence,
      box: [out[off], out[off + 1], out[off + 2], out[off + 3]],
    });
  }

  const tiles: Tile[] = [];
  let ignoredBonusCount = 0;
  for (const d of detections) {
    if (d.tile) tiles.push(d.tile);
    else ignoredBonusCount++;
  }

  return { detections, tiles, ignoredBonusCount };
}
