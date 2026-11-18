// The Dice tab's tables, laid out for Play's engine (see FeltGL): where
// each tile lies on the felt, in the felt's own px, and how it gets there -
// a turn over, a slide, a toss to a player - as the engine animates Play's
// tiles (by key: each move plays once, when its key first shows).

import { chain, rotateY, rotateZ, scale, translate, type Mat } from "./mat";
import { BACK, LIT, THICK, TILE_H, TILE_R, TILE_W, TURNED, lying, lyingDown, shadowAt, type Anim, type Piece, type Quad } from "./layout";
import type { FeltScene } from "./FeltGL";
import type { Block } from "./dice";
import { ringQuad, type Ringed } from "./textures";

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
// A tile, as its gold ring goes round it (fractions of the felt's width).
export const SEAT_TILE_RINGED: Ringed = {
  w: SEAT_TILE / SEAT_UNITS,
  h: ((SEAT_TILE / SEAT_UNITS) * TILE_H) / TILE_W,
  r: ((SEAT_TILE / SEAT_UNITS) * TILE_R) / TILE_W,
};
const ROW_LEFT = 14;
const ROW_PITCH = 38;
const ROW_Y = 72;
const DEALT_IN = 62;
const DEALT_SIDE = 74;
const DEALT: { x: number; y: number; rot: number }[] = [
  { x: 125, y: SEAT_UNITS - DEALT_IN, rot: 0 },
  { x: SEAT_UNITS - DEALT_SIDE, y: 125, rot: 0 },
  { x: 125, y: DEALT_IN, rot: 0 },
  { x: DEALT_SIDE, y: 125, rot: 0 },
];
// Where the 筒 go once everyone's seated: off the far edge of the table.
// (How far back a 筒 put away is drawn as it goes, in ems.)
const AWAY_BACK = 0.6;

// The ceremony as the table shows it: the six faces in the shuffled row,
// the row once the 筒 are at its ends, and (once dealt) each wind's player
// - where they sat when it was dealt, where they sit now - and its turn in
// the deal.
export interface SeatsTable {
  step: number;
  revealed: string[];
  edged: string[];
  dealt: Record<string, { at: number; seat: number; order: number }> | null;
  // The 筒 at the end the deal starts from, as the deal's counted and made: a
  // gold ring on the felt round it (as round the first player's plaque).
  dealFrom?: string | null;
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
  // Lifted clear of the row first, across while it's up, and set down: over
  // the tiles it passes, never through them (`high`: over the other 筒 too,
  // where they cross).
  const over = (a: Pose, b: Pose, high: boolean) => (k: number) => {
    const s = (k0: number, k1: number) => ease(Math.min(1, Math.max(0, (k - k0) / (k1 - k0))));
    const z = (s(0, 0.3) - s(0.7, 1)) * (high ? 2 * THICK + 0.35 : THICK + 0.25) * em;
    const v = s(0.2, 0.8);
    return place({ x: lerp(a.x, b.x, v), y: lerp(a.y, b.y, v), rot: a.rot, up: b.up }, z);
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
      // Done with: picked up off the table and put away as everyone takes
      // their seat - lifted, drawn back a little, and gone (never past the
      // felt's edge, where the canvas runs on over the page).
      const to = { ...edged, y: edged.y - AWAY_BACK * em };
      const off = between(edged, to, 1.2 * em);
      const gone = (k: number) => 1 - ease(Math.min(1, Math.max(0, (k - 0.35) / 0.65)));
      const shrink = (m: Mat, s: number) => chain(translate(m[12], m[13], m[14]), scale(s, s, s), translate(-m[12], -m[13], -m[14]), m);
      pieces.push({ face, m: scale(0), shade: LIT, tint: 1, anim: { key: `away:${face}`, delay: 0, dur: 0.5, pose: (k) => shrink(off(k), gone(k)) } });
      quads.push({ kind: "shadow", m: scale(0), anim: { key: `away:${face}:shadow`, delay: 0, dur: 0.5, pose: (k) => shrink(shadow({ ...edged, y: lerp(edged.y, to.y, ease(k)) }), gone(k)) } });
      return;
    } else if (t.step < 7 || pin || !deal) {
      pose = edged;
      // (The 筒 lifted over the rest to the ends; a wind only shifting slides
      // flat, as they're on their way over; one staying where it is doesn't
      // move.)
      if (Math.abs(was.x - edged.x) > 0.5) {
        // (The two 筒 crossing: 二筒 goes over 一筒.)
        const [p1, p2] = ["t1", "t2"].map((f) => [t.revealed.indexOf(f), t.edged.indexOf(f)]);
        const cross = Math.sign(p1[0] - p2[0]) !== Math.sign(p1[1] - p2[1]);
        const path = pin ? over(was, edged, cross && face === "t2") : between(was, edged, 0);
        const v = (k: number) => (pin ? ease(Math.min(1, Math.max(0, (k - 0.2) / 0.6))) : ease(k));
        // (A wind sets off once the 筒 is up, and is in its place before the
        // 筒 comes down.)
        anim = { key: `edge:${face}`, delay: pin ? 0 : 0.15, dur: pin ? 0.75 : 0.4, from: path, shadow: (k) => shadow({ ...edged, x: lerp(was.x, edged.x, v(k)) }) };
      }
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
    if (face === t.dealFrom) {
      const [rw, rh] = ringQuad(SEAT_TILE_RINGED, feltW);
      quads.push({ kind: "tile-ring", m: chain(translate(pose.x, pose.y, 0.5), rotateZ(pose.rot), scale(rw, rh, 1)) });
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

// The tiles lying on the felt as the dice meet them (see dice.ts's blocks):
// each one's footprint, square to the table (turned a quarter, its width and
// depth swap), and its thickness - where it's laid, not where it's moving
// from. (Swept off the table: not there.)
export function tileBlocks(pieces: Piece[]): Block[] {
  const out: Block[] = [];
  for (const { m } of pieces) {
    const em = Math.hypot(m[0], m[1], m[2]);
    if (em < 1e-6) continue;
    out.push({
      x: m[12],
      y: m[13],
      hw: (Math.abs(m[0]) * TILE_W + Math.abs(m[4]) * TILE_H) / 2,
      hd: (Math.abs(m[1]) * TILE_W + Math.abs(m[5]) * TILE_H) / 2,
      h: THICK * em,
    });
  }
  return out;
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

// A mark of the break (the tiles picked out, the pin), shown once the wall's
// tiles have moved to open it - popping up where it goes, not before them.
const popIn = (key: string, m: Mat): Anim => ({
  key,
  delay: WALL_EASE,
  dur: 0.18,
  pose: (k) => {
    const s = k === 0 ? 0 : 0.6 + 0.4 * (1 - Math.pow(1 - k, 3));
    return chain(translate(m[12], m[13], m[14]), scale(s, s, 1), translate(-m[12], -m[13], -m[14]), m);
  },
});

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
      // (Its shadow moving with it.)
      quads.push({ ...shadowAt(x, y, em, rot), ease: { key: `wall:${side}:${i}:shadow`, dur: WALL_EASE, curve: ease } });
      if (broken !== null && i < broken) {
        const m = chain(translate(x, y, 2 * THICK * em + 0.5), rotateZ(rot), scale(0.92 * em, 1.11 * em, 1));
        quads.push({ kind: "picked", m, anim: popIn(`picked:${side}${broken}:${i}`, m) });
      }
    }
    if (broken !== null) {
      const along = broken - 0.5 + gap / 2;
      const off = DEPTH / 2 + 0.55;
      const [x, y] = at(first[0] + dir[0] * along + out[0] * off, first[1] + dir[1] * along + out[1] * off);
      // (Its point toward the wall.)
      const point = (out[1] === -1 ? 180 : out[0] === 1 ? -90 : out[0] === -1 ? 90 : 0) + WALL_SKEW;
      const m = chain(translate(x, y, 0.5), rotateZ(point), scale(0.9 * w, 0.45 * w, 1));
      quads.push({ kind: "pin", m, anim: popIn(`pin:${side}${broken}`, m) });
    }
  }
  return { pieces, quads };
}
