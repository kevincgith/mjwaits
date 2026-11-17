// The Dice tab's tables, laid out for Play's engine (see FeltGL): where
// each tile lies on the felt, in the felt's own px, and how it gets there -
// a turn over, a slide, a toss to a player - as the engine animates Play's
// tiles (by key: each move plays once, when its key first shows).

import { chain, rotateY, rotateZ, scale, translate, type Mat } from "./mat";
import { BACK, LIT, THICK, TILE_H, TILE_W, TURNED, lying, lyingDown, shadowAt, type Piece, type Quad } from "./layout";
import type { FeltScene } from "./FeltGL";

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Where a tile lies: its centre, how it's turned (as CSS's rotate) and
// whether it's face up.
interface Pose {
  x: number;
  y: number;
  rot: number;
  up: boolean;
}

// ---- 座位 Seats ------------------------------------------------------------

// The felt in units of 1/250 of its width (the old diagram's px): the six
// tiles in a row across it above the middle, and each player's place to put
// a dealt wind - in front of them, upright to you (so every wind reads at a
// glance), clear of their name tag: above or below it, or inside it at the
// sides. A tile is 32 units wide, as Play's (0.72 x 0.913, 0.42 thick).
export const SEAT_UNITS = 250;
const SEAT_TILE = 32;
const ROW_LEFT = 14;
const ROW_PITCH = 38;
const ROW_Y = 72;
const DEALT_IN = 56;
const DEALT_SIDE = 68;
const DEALT: { x: number; y: number; rot: number }[] = [
  { x: 125, y: SEAT_UNITS - DEALT_IN, rot: 0 },
  { x: SEAT_UNITS - DEALT_SIDE, y: 125, rot: 0 },
  { x: 125, y: DEALT_IN, rot: 0 },
  { x: DEALT_SIDE, y: 125, rot: 0 },
];
// Where the 筒 go once everyone's seated: off the far edge of the table.
const AWAY_Y = -40;

// The ceremony as the table shows it: the six faces in the shuffled row,
// the row once the 筒 are at its ends, and (once dealt) each wind's player
// - where they sat when it was dealt, where they sit now - and its turn in
// the deal.
export interface SeatsTable {
  step: number;
  revealed: string[];
  edged: string[];
  dealt: Record<string, { at: number; seat: number; order: number }> | null;
}

export function seatsScene(feltW: number, t: SeatsTable): FeltScene {
  const u = feltW / SEAT_UNITS;
  const em = (SEAT_TILE * u) / TILE_W;
  const inRow = (slot: number, up: boolean): Pose => ({ x: (ROW_LEFT + slot * ROW_PITCH + SEAT_TILE / 2) * u, y: ROW_Y * u, rot: 0, up });
  const atSeat = (pos: number): Pose => ({ x: DEALT[pos].x * u, y: DEALT[pos].y * u, rot: DEALT[pos].rot, up: true });
  const place = (p: Pose, z = 0): Mat => (p.up ? lying(p.x, p.y, em, p.rot, z) : lyingDown(p.x, p.y, em, p.rot, z));
  // Lifted `lift` mid-way, landing as `b` lies.
  const between = (a: Pose, b: Pose, lift: number) => (k: number) => {
    const v = ease(k);
    // (The short way round.)
    let turn = b.rot - a.rot;
    turn -= 360 * Math.round(turn / 360);
    return place({ x: lerp(a.x, b.x, v), y: lerp(a.y, b.y, v), rot: a.rot + turn * v, up: b.up }, Math.sin(Math.PI * v) * lift);
  };
  // Turned over where it lies, about its long axis, lifted a little.
  const turnOver = (p: Pose) => (k: number) => {
    const v = ease(k);
    return chain(translate(p.x, p.y, Math.sin(Math.PI * v) * 0.45 * em), rotateZ(p.rot), translate(0, 0, (THICK * em) / 2), rotateY(180 * (1 - v)), translate(0, 0, (-THICK * em) / 2), scale(em));
  };
  const shadow = (p: Pose) => shadowAt(p.x, p.y, em, p.rot).m;

  const pieces: Piece[] = [];
  const quads: Quad[] = [];
  t.revealed.forEach((face, i) => {
    const pin = face.startsWith("t");
    const was = inRow(i, t.step >= 4);
    const edged = inRow(t.edged.indexOf(face), true);
    const deal = t.dealt?.[face];
    let pose: Pose;
    let anim: { key: string; delay: number; dur: number; from: (k: number) => Mat; shadow: (k: number) => Mat } | null = null;
    if (t.step < 4) pose = inRow(i, false);
    else if (t.step === 4) {
      pose = was;
      anim = { key: `flip:${face}`, delay: i * 0.06, dur: 0.5, from: turnOver(was), shadow: () => shadow(was) };
    } else if (pin && t.step >= 8) {
      // Done with: swept off the table as everyone takes their seat.
      pose = { ...edged, y: AWAY_Y * u };
      const to = pose;
      const off = between(edged, to, 0.3 * em);
      pieces.push({ face, m: scale(0), shade: LIT, tint: 1, anim: { key: `away:${face}`, delay: 0, dur: 0.5, pose: off } });
      quads.push({ kind: "shadow", m: scale(0), anim: { key: `away:${face}:shadow`, delay: 0, dur: 0.5, pose: (k) => shadow({ ...edged, y: lerp(edged.y, to.y, ease(k)) }) } });
      return;
    } else if (t.step < 7 || pin || !deal) {
      pose = edged;
      const slide = between(was, edged, 0.3 * em);
      anim = { key: `edge:${face}`, delay: 0, dur: 0.45, from: slide, shadow: (k) => shadow({ ...edged, x: lerp(was.x, edged.x, ease(k)) }) };
    } else if (t.step === 7) {
      pose = atSeat(deal.at);
      const toss = between(edged, pose, 1.4 * em);
      const to = pose;
      anim = { key: `deal:${face}`, delay: deal.order * 0.09, dur: 0.6, from: toss, shadow: (k) => shadow({ ...to, x: lerp(edged.x, to.x, ease(k)), y: lerp(edged.y, to.y, ease(k)) }) };
    } else if (deal.at === deal.seat) {
      // Their own seat already: it stays put.
      pose = atSeat(deal.seat);
    } else {
      const from = atSeat(deal.at);
      pose = atSeat(deal.seat);
      const to = pose;
      anim = { key: `seat:${face}`, delay: 0, dur: 0.5, from: between(from, pose, 0.6 * em), shadow: (k) => shadow({ ...to, x: lerp(from.x, to.x, ease(k)), y: lerp(from.y, to.y, ease(k)) }) };
    }
    pieces.push({
      face,
      m: place(pose),
      shade: Math.abs(pose.rot) === 90 ? TURNED : LIT,
      tint: 1,
      ...(anim ? { anim: { key: anim.key, delay: anim.delay, dur: anim.dur, pose: anim.from } } : {}),
    });
    quads.push({ kind: "shadow", m: shadow(pose), ...(anim ? { anim: { key: `${anim.key}:shadow`, delay: anim.delay, dur: anim.dur, pose: anim.shadow } } : {}) });
  });
  return { pieces, quads };
}

// ---- 擲骰 Dice: the wall ---------------------------------------------------

// Four walls of 18 stacks, each two tiles high, face down, in a pinwheel -
// each wall running three stacks past the end of the next, like a spinning
// wheel's arms (as the old diagram) - set at a slight angle on the table, as
// a real one sits, and as big as fits inside a 16px felt border. The dice
// total breaks one side: its first `gapAfter` stacks clockwise are the
// counted run (Play's gold rim), and the gap opens after them (the stacks
// after it ease along), pointed at by Play's gold marker from outside.
export type WallSide = "top" | "right" | "bottom" | "left";
export interface WallBreakAt {
  side: WallSide;
  gapAfter: number;
}
const WALL_STACKS = 18;
const WALL_BORDER = 16;
// How far each wall runs past the next one's end, in stacks.
const WALL_JUT = 3;
const WALL_EASE = 0.35;
// The wall's turn on the table (degrees, as CSS's rotate: negative turns it
// anticlockwise).
export const WALL_SKEW = -15;
// In stacks (a tile's width), a stack's depth across its wall, and the
// square the pinwheel lies in - each wall's line, from its first stack
// clockwise: top left to right, right top to bottom, bottom right to left,
// left bottom to top; its turn, and which way is out.
const DEPTH = TILE_H / TILE_W;
const SPAN = WALL_STACKS + DEPTH + WALL_JUT;
const WALL_SIDES: { side: WallSide; first: [number, number]; dir: [number, number]; rot: number; out: [number, number] }[] = [
  { side: "top", first: [DEPTH + WALL_JUT + 0.5, WALL_JUT + DEPTH / 2], dir: [1, 0], rot: 0, out: [0, -1] },
  { side: "right", first: [WALL_STACKS + DEPTH / 2, DEPTH + WALL_JUT + 0.5], dir: [0, 1], rot: 90, out: [1, 0] },
  { side: "bottom", first: [WALL_STACKS - 0.5, WALL_STACKS + DEPTH / 2], dir: [-1, 0], rot: 0, out: [0, 1] },
  { side: "left", first: [WALL_JUT + DEPTH / 2, WALL_STACKS - 0.5], dir: [0, -1], rot: 90, out: [-1, 0] },
];
const TILT = (WALL_SKEW * Math.PI) / 180;
// Turned about the square's middle (in stacks, from it).
const turned = (x: number, y: number): [number, number] => {
  const dx = x - SPAN / 2;
  const dy = y - SPAN / 2;
  return [dx * Math.cos(TILT) - dy * Math.sin(TILT), dx * Math.sin(TILT) + dy * Math.cos(TILT)];
};
// The wall's inner face, all round (the dice bounce off it): its corners,
// in the felt's px.
export function wallFence(feltW: number): [number, number][] {
  const w = (feltW / 2 - WALL_BORDER) / REACH;
  const lo = WALL_JUT + DEPTH;
  const hi = WALL_STACKS;
  return ([[lo, lo], [hi, lo], [hi, hi], [lo, hi]] as const).map(([x, y]) => {
    const [tx, ty] = turned(x, y);
    return [feltW / 2 + tx * w, feltW / 2 + ty * w];
  });
}

// How far the turned wall reaches from the middle, either way (in stacks):
// every stack's corners.
const REACH = Math.max(
  ...WALL_SIDES.flatMap(({ first, dir, rot }) =>
    Array.from({ length: WALL_STACKS }, (_, i) => {
      const [hw, hh] = rot ? [DEPTH / 2, 0.5] : [0.5, DEPTH / 2];
      const x = first[0] + dir[0] * i;
      const y = first[1] + dir[1] * i;
      return [-1, 1].flatMap((sx) => [-1, 1].map((sy) => Math.max(...turned(x + sx * hw, y + sy * hh).map(Math.abs))));
    }).flat()
  )
);

export function wallScene(feltW: number, brk: WallBreakAt | null): FeltScene {
  // A stack's width, in px.
  const w = (feltW / 2 - WALL_BORDER) / REACH;
  const em = w / TILE_W;
  const gap = 0.7;
  const at = (x: number, y: number): [number, number] => {
    const [tx, ty] = turned(x, y);
    return [feltW / 2 + tx * w, feltW / 2 + ty * w];
  };
  const pieces: Piece[] = [];
  const quads: Quad[] = [];
  for (const { side, first, dir, rot: square, out } of WALL_SIDES) {
    const rot = square + WALL_SKEW;
    const broken = brk?.side === side ? brk.gapAfter : null;
    for (let i = 0; i < WALL_STACKS; i++) {
      const along = i + (broken !== null && i >= broken ? gap : 0);
      const [x, y] = at(first[0] + dir[0] * along, first[1] + dir[1] * along);
      for (const layer of [0, 1]) {
        pieces.push({
          face: BACK,
          m: lyingDown(x, y, em, rot, layer * THICK * em),
          shade: square ? TURNED : LIT,
          tint: 1,
          ease: { key: `wall:${side}:${i}:${layer}`, dur: WALL_EASE, curve: ease },
        });
      }
      quads.push(shadowAt(x, y, em, rot));
      if (broken !== null && i < broken)
        quads.push({ kind: "picked", m: chain(translate(x, y, 2 * THICK * em + 0.5), rotateZ(rot), scale(0.92 * em, 1.11 * em, 1)) });
    }
    if (broken !== null) {
      const along = broken - 0.5 + gap / 2;
      const off = DEPTH / 2 + 0.55;
      const [x, y] = at(first[0] + dir[0] * along + out[0] * off, first[1] + dir[1] * along + out[1] * off);
      // (Its point toward the wall.)
      const point = (out[1] === -1 ? 180 : out[0] === 1 ? -90 : out[0] === -1 ? 90 : 0) + WALL_SKEW;
      quads.push({ kind: "pin", m: chain(translate(x, y, 0.5), rotateZ(point), scale(0.9 * w, 0.45 * w, 1)) });
    }
  }
  return { pieces, quads };
}
