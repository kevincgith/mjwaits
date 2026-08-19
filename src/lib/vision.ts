// Client-side mahjong tile detection: a YOLOv8s model (fine-tuned on the
// dataset from https://github.com/Andy8647/MahjongVis, MIT licensed) run
// entirely in the browser via onnxruntime-web (WASM). No image ever leaves
// the device.

import * as ort from "onnxruntime-web";
import type { Tile } from "./mahjong";

const IMG_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.4;

// Class order the model was trained with (see YOLO/data.yaml in the
// MahjongVis repo). Digit-prefixed suits: B=Bamboo, C=Characters, D=Dots,
// F=Flower, S=Season (F/S are bonus tiles - not part of a hand's shape).
const CLASS_NAMES = [
  "1B", "1C", "1D", "1F", "1S", "2B", "2C", "2D", "2F", "2S",
  "3B", "3C", "3D", "3F", "3S", "4B", "4C", "4D", "4F", "4S",
  "5B", "5C", "5D", "6B", "6C", "6D", "7B", "7C", "7D", "8B",
  "8C", "8D", "9B", "9C", "9D", "EW", "GD", "NW", "RD", "SW",
  "WD", "WW",
] as const;

// mjwaits honor order: 1 East, 2 South, 3 West, 4 North, 5 Red, 6 Green, 7 White.
const HONOR_RANKS: Record<string, number> = { EW: 1, SW: 2, WW: 3, NW: 4, RD: 5, GD: 6, WD: 7 };

// Maps a model class name to a mjwaits Tile, or null for classes mjwaits
// doesn't represent (flowers/seasons are bonus tiles set aside on draw -
// they don't factor into a hand's shape or its waits).
function classToTile(className: string): Tile | null {
  if (className in HONOR_RANKS) return { suit: "z", rank: HONOR_RANKS[className] };
  const suitChar = className[className.length - 1];
  const rank = Number(className.slice(0, -1));
  if (suitChar === "C") return { suit: "m", rank };
  if (suitChar === "D") return { suit: "t", rank };
  if (suitChar === "B") return { suit: "s", rank };
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
