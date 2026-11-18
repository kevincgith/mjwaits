// 座位's players as name cards on the felt, real things on a real table:
// each a heavy plaque at the player's seat, as a casino's high-value chips
// are - a thick, polished slab in the player's colour, rounded at its
// corners and edges, a gold pinstripe round its edge, and on top a double
// gold frame with their name in gold foil, upright to you whatever the seat.
// Nothing printed on it ever changes. Picked to swap seats, it's
// picked up off the felt; moving seats, it's lifted over what's between and
// set down at the new one. Who's East is shown with a real tile: the 東
// lying beside their plaque, slid across when East changes (till the winds are
// dealt - then the 東 dealt in front of them says it). Plaques and tile are
// solid: the dice bounce off them (see dice.ts's blocks).

import { chain, scale, translate } from "./mat";
import { LIT, TILE_H, TILE_W, lying, shadowAt, type Card, type Piece, type Quad } from "./layout";
import type { Block } from "./dice";

export interface SeatCard {
  // Initials, or a whole name (opened from Scores).
  name: string;
  // Whose colours: 0..3.
  player: number;
  // The seat it lies at: 0 bottom (you), 1 right, 2 top, 3 left.
  at: number;
  // East (provisional or real), before the winds are dealt: the 東 beside it.
  east: boolean;
  // Picked up to swap seats.
  picked: boolean;
}

// Where each seat's plaque lies (fractions of the felt) - as App's
// SEAT_ANCHORS, where its taps are taken.
export const CARD_AT: [number, number][] = [
  [0.5, 0.92],
  [0.888, 0.5],
  [0.5, 0.08],
  [0.112, 0.5],
];
// A plaque, against the felt's width: across, front to back, and thick.
export const CARD = { w: 0.2, d: 0.12, t: 0.03 };
// The 東 beside it: the tile's width, and its gap from the plaque.
const EAST = { w: 0.07, gap: 0.014 };
// Which side of each seat's plaque the 東 lies: to the right of the top and
// bottom ones, toward you from the side ones - clear of the six tiles' row.
const BESIDE: [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 0],
  [0, 1],
];
// Moving to another seat.
const MOVE_S = 0.45;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// The players' colours (as the tags were, made rich - emerald, sapphire,
// ruby, amethyst): light to dark across a plaque, its sheen.
const BODY = [
  ["#2f8c5a", "#1a6440", "#0c3a24"],
  ["#3b6fc4", "#21499a", "#122a5e"],
  ["#c4473d", "#952723", "#5c1314"],
  ["#8357c2", "#5d3999", "#371f63"],
];

// Where the 東 lies for a plaque at seat `at` (felt px), and its scale.
function eastAt(feltW: number, at: number): { x: number; y: number; em: number } {
  const [x, y] = CARD_AT[at].map((f) => f * feltW);
  const [ix, iy] = BESIDE[at];
  const em = (EAST.w * feltW) / TILE_W;
  const half = ix ? (TILE_W * em) / 2 : (TILE_H * em) / 2;
  const out = ((ix ? CARD.w : CARD.d) / 2 + EAST.gap) * feltW + half;
  return { x: x + ix * out, y: y + iy * out, em };
}

// The plaques, the 東 and their shadows, on a felt `feltW` px across.
export function cardsScene(feltW: number, cards: SeatCard[]): { props: Record<string, Card[]>; pieces: Piece[]; quads: Quad[] } {
  const [w, d, t] = [CARD.w * feltW, CARD.d * feltW, CARD.t * feltW];
  const move = { dur: MOVE_S, curve: ease };
  const out: Card[] = [];
  const quads: Quad[] = [];
  for (const c of cards) {
    const [x, y] = CARD_AT[c.at].map((f) => f * feltW);
    // (Picked up: held a little above the felt.)
    const up = c.picked ? t * 2.2 : 0;
    out.push({ m: chain(translate(x, y, t / 2 + up), scale(w, d, t)), face: c.player, ease: { key: `card:${c.player}`, ...move, lift: t * 4 } });
    const spread = 1 + up / d;
    quads.push({
      kind: "shadow",
      m: chain(translate(x + t * 0.3 + up * 0.3, y + t * 0.5 + up * 0.5, 0.4), scale(w * 1.12 * spread, d * 1.2 * spread, 1)),
      ease: { key: `card:${c.player}:shadow`, ...move },
    });
  }
  const pieces: Piece[] = [];
  const east = cards.find((c) => c.east);
  if (east) {
    const { x, y, em } = eastAt(feltW, east.at);
    pieces.push({ face: "z1", m: lying(x, y, em), shade: LIT, tint: 1, ease: { key: "east", ...move, lift: t * 4 } });
    quads.push({ ...shadowAt(x, y, em), ease: { key: "east:shadow", ...move } });
  }
  return { props: { cards: out }, pieces, quads };
}

// The plaques and the 東 as the dice meet them: each one's footprint and
// height (px).
export function cardBlocks(feltW: number, cards: SeatCard[]): Block[] {
  const blocks: Block[] = cards.map((c) => {
    const [x, y] = CARD_AT[c.at].map((f) => f * feltW);
    return { x, y, hw: (CARD.w * feltW) / 2, hd: (CARD.d * feltW) / 2, h: CARD.t * feltW };
  });
  const east = cards.find((c) => c.east);
  if (east) {
    const { x, y, em } = eastAt(feltW, east.at);
    blocks.push({ x, y, hw: (TILE_W * em) / 2, hd: (TILE_H * em) / 2, h: 0.42 * em });
  }
  return blocks;
}

// The plaques' printed tops, one under another on `canvas` (the `player`th
// for each player): painted afresh only when a name changes. Each the
// player's colour, deepest at its edges, with a fine engraved pattern over
// it; a double gold frame; and the name in gold foil, embossed - as big as
// fits.
const CELL_W = 512;
const CELL_H = Math.round((CELL_W * CARD.d) / CARD.w);
const FONT = (px: number) => `800 ${px}px system-ui, -apple-system, "PingFang TC", sans-serif`;
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// Gold leaf: light at the top, deep at the foot.
function gold(ctx: CanvasRenderingContext2D, y0: number, y1: number) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, "#fff1c2");
  g.addColorStop(0.45, "#e2bb62");
  g.addColorStop(1, "#9c7027");
  return g;
}
export function paintCardFaces(canvas: HTMLCanvasElement, cards: SeatCard[]) {
  canvas.width = CELL_W;
  canvas.height = CELL_H * 4;
  canvas.dataset.faces = "4";
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const c of cards) {
    const [light, mid, deep] = BODY[c.player];
    ctx.save();
    ctx.translate(0, c.player * CELL_H);
    // The colour, deepest at the edges.
    const body = ctx.createRadialGradient(CELL_W * 0.45, CELL_H * 0.4, 10, CELL_W / 2, CELL_H / 2, CELL_W * 0.62);
    body.addColorStop(0, light);
    body.addColorStop(0.55, mid);
    body.addColorStop(1, deep);
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, CELL_W, CELL_H);
    // The engraving: fine waves across it.
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
    ctx.lineWidth = 1.5;
    for (let k = -CELL_H; k < CELL_H * 2; k += 9) {
      ctx.beginPath();
      for (let x = 0; x <= CELL_W; x += 8) {
        const y = k + Math.sin(x / 26 + k / 40) * 7;
        if (x) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    // The double gold frame.
    ctx.strokeStyle = gold(ctx, 0, CELL_H);
    ctx.lineWidth = 11;
    roundRect(ctx, 16, 16, CELL_W - 32, CELL_H - 32, 22);
    ctx.stroke();
    ctx.lineWidth = 3;
    roundRect(ctx, 34, 34, CELL_W - 68, CELL_H - 68, 14);
    ctx.stroke();
    // The name in gold foil, embossed.
    const room = CELL_W - 120;
    let size = Math.round(CELL_H * (c.name.length > 2 ? 0.46 : 0.58));
    ctx.font = FONT(size);
    while (size > 30 && ctx.measureText(c.name).width > room) ctx.font = FONT((size -= 4));
    let name = c.name;
    while (name.length > 1 && ctx.measureText(name).width > room) name = name.slice(0, -1);
    if (name !== c.name) name = `${name.slice(0, -1)}…`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const [x, y] = [CELL_W / 2, CELL_H / 2 + size * 0.04];
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillText(name, x + 3, y + 4);
    ctx.fillStyle = gold(ctx, y - size / 2, y + size / 2);
    ctx.fillText(name, x, y);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 248, 220, 0.55)";
    ctx.strokeText(name, x, y - 1);
    ctx.restore();
  }
}
