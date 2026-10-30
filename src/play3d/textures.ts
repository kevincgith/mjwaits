// The pictures Play's WebGL table draws with, painted once onto canvases:
// every tile face from the app's own SVG art (one atlas), the jade back,
// and the soft marks - shadows, the newest discard's pin, the hint and
// danger bars, the spotlight's bubble.

import { TILE_H, TILE_R, TILE_W } from "./layout";

const ART = import.meta.glob<string>("../assets/tiles/*.svg", { eager: true, query: "?url", import: "default" });

// Each face in a cell of the atlas: the face itself, and round it a
// gutter of the colour its edge meets (so mipmaps blend into the side,
// not the next face).
const CELL_W = 256;
const CELL_H = 320;
const GUTTER = 8;
const COLS = 8;
const SIZE = 2048;
const FACE_W = CELL_W - 2 * GUTTER;
const FACE_H = Math.round((FACE_W * TILE_H) / TILE_W);
const RADIUS = (FACE_W * TILE_R) / TILE_W;

export interface Atlas {
  canvas: HTMLCanvasElement;
  // u, v, width, height of each face, by name ("m1", "flower2", "back").
  rects: Map<string, [number, number, number, number]>;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const load = (url: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });

export async function buildAtlas(): Promise<Atlas> {
  const names = Object.keys(ART).map((k) => k.replace(/^.*\/(.*)\.svg$/, "$1"));
  const images = await Promise.all(names.map((n) => load(ART[`../assets/tiles/${n}.svg`])));
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const rects = new Map<string, [number, number, number, number]>();
  const cell = (k: number) => [(k % COLS) * CELL_W, Math.floor(k / COLS) * CELL_H] as const;
  const place = (name: string, k: number, paint: (x: number, y: number) => void, edge: string) => {
    const [cx, cy] = cell(k);
    ctx.save();
    ctx.fillStyle = edge;
    ctx.fillRect(cx, cy, CELL_W, CELL_H);
    const x = cx + GUTTER;
    const y = cy + GUTTER;
    paint(x, y);
    ctx.restore();
    rects.set(name, [x / SIZE, y / SIZE, FACE_W / SIZE, FACE_H / SIZE]);
  };
  names.forEach((name, k) => {
    const img = images[k];
    // The face: white, rounded as the tile's top is, the art on it and a
    // hairline round its edge (img.tile-face's box-shadow).
    place(
      name,
      k,
      (x, y) => {
        roundRect(ctx, x, y, FACE_W, FACE_H, RADIUS);
        ctx.save();
        ctx.clip();
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, y, FACE_W, FACE_H);
        if (img) ctx.drawImage(img, x, y, FACE_W, FACE_H);
        ctx.restore();
        roundRect(ctx, x + 1, y + 1, FACE_W - 2, FACE_H - 2, RADIUS - 1);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
        ctx.stroke();
      },
      "#f2ede0"
    );
  });
  // The back: jade, with a darker rim (inset 0.04em).
  place(
    "back",
    names.length,
    (x, y) => {
      const rim = (FACE_W * 0.04) / TILE_W;
      roundRect(ctx, x, y, FACE_W, FACE_H, RADIUS);
      ctx.fillStyle = "#1f7a32";
      ctx.fill();
      roundRect(ctx, x + rim, y + rim, FACE_W - 2 * rim, FACE_H - 2 * rim, Math.max(0, RADIUS - rim));
      ctx.fillStyle = "#35a84a";
      ctx.fill();
    },
    "#1f7a32"
  );
  return { canvas, rects };
}

// A canvas `w` x `h` px, painted by `paint`.
function paintCanvas(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  paint(c.getContext("2d")!);
  return c;
}

// A shape's blurred shadow: `shape` drawn far off the canvas, its shadow
// thrown back onto it (Safari's canvas has no blur filter).
function shadowOf(ctx: CanvasRenderingContext2D, blur: number, colour: string, shape: (dx: number) => void) {
  const far = 10000;
  ctx.shadowColor = colour;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = far;
  ctx.fillStyle = "#000";
  shape(-far);
  ctx.fill();
}

// A tile's shadow on the felt (see SHADOW_W / SHADOW_H in layout.ts):
// 0.28em of blur round its 0.78em x 1em box, rounded 0.135em - at 100px an em.
export function tileShadow(): HTMLCanvasElement {
  const k = 100;
  return paintCanvas(1.58 * k, 1.8 * k, (ctx) =>
    shadowOf(ctx, 0.28 * k, "rgba(0, 0, 0, 0.3)", (dx) => roundRect(ctx, 0.4 * k + dx, 0.4 * k, 0.78 * k, 1 * k, 0.135 * k))
  );
}

// The soft shadow under your standing row (.play-hand::before): an ellipse,
// blurred 0.18em, in a quad 0.18em larger all round - drawn for a row about
// 15em long.
export function rowShadow(): HTMLCanvasElement {
  const k = 40;
  const w = 15 * k;
  const h = 0.66 * k;
  return paintCanvas(w, h, (ctx) =>
    shadowOf(ctx, 0.18 * k, "rgba(0, 0, 0, 0.28)", (dx) => {
      ctx.beginPath();
      ctx.ellipse(w / 2 + dx, h / 2, w / 2 - 0.18 * k, h / 2 - 0.18 * k, 0, 0, Math.PI * 2);
    })
  );
}

// The newest discard's pin: a gold point, its tip at the top.
export function pin(): HTMLCanvasElement {
  return paintCanvas(64, 32, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(32, 0);
    ctx.lineTo(64, 32);
    ctx.lineTo(0, 32);
    ctx.closePath();
    ctx.fillStyle = "#ffd166";
    ctx.fill();
  });
}

// A picked pile tile's gold rim and glow (.play-swap-tile.is-picked), over
// its top: the quad is the face plus a tenth of a tile round it.
export function pickedRim(): HTMLCanvasElement {
  const w = 184;
  const h = 222;
  return paintCanvas(w, h, (ctx) => {
    const x = 0.1 * 200;
    const y = 0.1 * 200;
    const fw = 144;
    const fh = 182;
    ctx.shadowColor = "rgba(255, 209, 102, 0.7)";
    ctx.shadowBlur = 16;
    roundRect(ctx, x, y, fw, fh, 18);
    ctx.lineWidth = 12;
    ctx.strokeStyle = "#ffd166";
    ctx.stroke();
  });
}

// A taken pile tile's place: its footprint outlined, dashed.
export function gapOutline(): HTMLCanvasElement {
  return paintCanvas(144, 182, (ctx) => {
    roundRect(ctx, 5, 5, 134, 172, 16);
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(244, 247, 245, 0.55)";
    ctx.stroke();
  });
}

// A hint's gold underline, or a risky tile's red bar.
export function bar(colour: string): HTMLCanvasElement {
  return paintCanvas(128, 16, (ctx) => {
    roundRect(ctx, 0, 0, 128, 16, 8);
    ctx.fillStyle = colour;
    ctx.fill();
  });
}

// The spotlight's bubble (.play-spotlight): dark, ringed in gold, with its
// point toward whoever threw the tile - `bw` x `bh` px with an em of
// margin round it for its shadow and point, at `scale` canvas px a px.
export function bubble(bw: number, bh: number, em: number, from: "top" | "bottom" | "left" | "right", scale: number): HTMLCanvasElement {
  const W = (bw + 2 * em) * scale;
  const H = (bh + 2 * em) * scale;
  return paintCanvas(W, H, (ctx) => {
    ctx.scale(scale, scale);
    const x = em;
    const y = em;
    const ring = "rgba(255, 209, 102, 0.85)";
    const fill = "rgba(14, 18, 16, 0.92)";
    // Its shadow, then the point (behind the bubble, its two outer sides ringed), then the bubble.
    ctx.save();
    shadowOf(ctx, 0.7 * em, "rgba(0, 0, 0, 0.45)", (dx) => roundRect(ctx, x + dx, y + 0.35 * em, bw, bh, 0.7 * em));
    ctx.restore();
    const px = from === "left" ? x : from === "right" ? x + bw : x + bw / 2;
    const py = from === "top" ? y : from === "bottom" ? y + bh : y + bh / 2;
    const turn = { bottom: 45, top: -135, left: 135, right: -45 }[from];
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate((turn * Math.PI) / 180);
    const s = 0.5 * em;
    ctx.fillStyle = ring;
    ctx.fillRect(-s / 2 + 0.07 * em, -s / 2 + 0.07 * em, s, s);
    ctx.fillStyle = fill;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
    roundRect(ctx, x - 0.07 * em, y - 0.07 * em, bw + 0.14 * em, bh + 0.14 * em, 0.77 * em);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    roundRect(ctx, x, y, bw, bh, 0.7 * em);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = fill;
    ctx.fill();
  });
}
