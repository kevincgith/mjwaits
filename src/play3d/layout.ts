// Play's WebGL table laid out in its own coordinates: where every tile lies,
// worked out from the table's sizes and what's on it - the same places
// Play's CSS puts them (its grid, its rows of 9 and 7, the walls and their
// slots), without measuring a single tile on the page.
//
// Two spaces, each in CSS pixels with CSS's axes (x right, y down, z up off
// the table): the felt's own plane, before its tilt (the WebGL table tilts
// it as .play-felt is), and your hand's row (.play-hand), standing in front
// of it. A tile is a block - its footprint 0.72em by 0.913em, 0.42em thick,
// the face on top - placed by a matrix from its centre on the table.

import { sameTile, type GameMeld } from "@mjwaits/shared/engine/game";
import { sortTiles, type Tile } from "@mjwaits/shared/engine/mahjong";
import type { BonusTile } from "@mjwaits/shared/engine/scoring";
import { bezier, EASE_IN, EASE_OUT, keyframes } from "./anim";
import { about, chain, rotateX, rotateY, rotateZ, scale, translate, type Mat } from "./mat";
import { acrossTable } from "./swapOrder";
import type { GLHandTile, GLPond, GLSide, GLSwapRow, GLTableView, GLWall } from "./types";

// The block, in ems of its tile size (as the CSS has it: --tile-w / -h, --play-thick, --tile-r).
export const TILE_W = 0.72;
export const TILE_H = 0.913;
export const THICK = 0.42;
export const TILE_R = 0.09;

// The table's sizes, read off the page when the screen changes size.
export interface Dims {
  feltW: number;
  feltH: number;
  rem: number;
  // --play-under: how far the felt runs on under your hand.
  under: number;
  hand: number; // --play-hand
  tile: number; // --play-tile
  wall: number; // --play-wall
  wallTop: number; // --play-wall-top
  // .play-middle's font size, and the compass in it.
  middle: number;
  compass: number;
  // How far down the felt your row's tiles reach, as seen (where their top
  // edge meets the felt's plane) - your pond stops short of it.
  handTop: number;
  // A point on the felt as seen, in your row's terms: from the middle of
  // its top edge, and how much nearer (bigger) it shows there.
  project?: (x: number, y: number, z: number) => { x: number; y: number; s: number };
  // How wide your row may run: the table's width (the screen, as it's held).
  rowRoom?: number;
  // How far down the felt the row of what you take in 換牌 reaches, as seen
  // (its top edge, where it meets the felt's plane).
  rowTop?: number;
  // In 換牌: your row's width so far, kept so the row doesn't re-centre as
  // tiles leave it (set by TableGL while the swap's on).
  handMinWidth?: number;
  // The felt's plane into your row's space so that it's drawn exactly where
  // the felt's own view draws it (from the middle of the row's top edge):
  // the two views differ only by where their perspective is from - a shear.
  feltToHand?: Mat;
}

// A tile: its face ("m1", "flower2"... or "back" face down), where it lies,
// and how its sides are shaded - as the CSS's --shade-long / --shade-end:
// how much darker its long sides and its ends are than its face.
export interface Piece {
  face: string;
  m: Mat;
  shade: [number, number];
  // 1, or 0 for a tile you can't throw now (食替), drawn dimmed.
  tint: number;
  // Your tile's place in your hand, for taps on it.
  hit?: number;
  // A pile's tile you can pick on your take (換牌).
  pick?: [GLSide, number];
  // Flying in from `from` (a 換牌 take): eased there over `dur` seconds,
  // lifted `lift` at the top of its arc.
  fly?: { key: string; from: Mat; dur: number; lift: number; pose?: (v: number) => Mat };
  // Not drawn once this many seconds into its flight.
  hideAfter?: number;
  // Moving as Play's CSS animates it, or easing to where it now lies when
  // that changes (CSS's transition) - see anim.ts and engine.ts.
  anim?: Anim;
  ease?: { key: string; dur: number; curve: (t: number) => number; delay?: number };
}

// An animation: from when `key` first appears, after `delay` seconds, `dur`
// seconds long, where it is at each point (0..1) through it.
export interface Anim {
  key: string;
  delay: number;
  dur: number;
  pose: (t: number) => Mat;
}

// Flat marks: shadows on the felt, the newest discard's pin, the hint and
// danger marks under and over your tiles, the spotlight's bubble.
export type QuadKind = "shadow" | "row-shadow" | "pin" | "hint" | "danger" | "bubble-top" | "bubble-bottom" | "bubble-left" | "bubble-right" | "picked" | "gap";
export interface Quad {
  kind: QuadKind;
  // The unit square (-0.5..0.5 each way, at z 0) to where it's drawn.
  m: Mat;
  anim?: Anim;
}

export interface Layout {
  felt: { pieces: Piece[]; quads: Quad[] };
  hand: { pieces: Piece[]; quads: Quad[]; width: number; height: number };
  // The compass's centre on the felt.
  middle: { x: number; y: number };
}

const UNSEEN = "z7";
const BACK = "back";
const LIT: [number, number] = [0, 0.14];
// Turned a quarter, a tile's long sides face the way its ends did.
const TURNED: [number, number] = [0.14, 0];

export const faceOf = (t: Tile): string => (t.suit === "j" ? "joker" : `${t.suit}${t.rank}`);
const bonusFace = (b: BonusTile): string => `${b.kind}${b.rank}`;

// A block lying face up with its centre at (x, y), `em` its tile size,
// turned `rot` degrees (as CSS's rotate).
const lying = (x: number, y: number, em: number, rot = 0, z = 0): Mat => chain(translate(x, y, z), rotateZ(rot), scale(em));
// Face down: turned over where it lies.
const lyingDown = (x: number, y: number, em: number, rot = 0, z = 0): Mat =>
  chain(translate(x, y, z), rotateZ(rot), translate(0, 0, THICK * em), rotateY(180), scale(em));

// A tile's shadow on the felt (its box-shadow: 0 0.03em 0.28em, round its
// 0.78em x 1em box) - the quad covers the box and the blur round it.
export const SHADOW_W = 0.78 + 0.8;
export const SHADOW_H = 1 + 0.8;
const shadowAt = (x: number, y: number, em: number, rot = 0): Quad => ({
  kind: "shadow",
  m: chain(translate(x, y, 0.4), rotateZ(rot), translate(0, 0.03 * em, 0), scale(SHADOW_W * em, SHADOW_H * em, 1)),
});

// A meld's tiles as laid out: each a slot (null: face down), a kong's
// fourth stacked on its middle tile on the table - as MeldsView has them.
interface Slot {
  face: string | null;
  top?: string | null;
}
function runOrder(tiles: Tile[], claimed: Tile): number[] {
  const c = tiles.findIndex((t) => sameTile(t, claimed));
  if (c < 0) return [0, 1, 2];
  const others = [0, 1, 2].filter((j) => j !== c);
  return [others[0], c, others[1]];
}
function meldSlots(m: GameMeld, hideConcealed: boolean, inRow: boolean): Slot[] {
  const stacked = m.kind === "kong" && m.tiles.length === 4 && !inRow;
  const face = (j: number) => (m.concealed && (hideConcealed || j === 0 || j === (stacked ? 2 : 3)) ? null : faceOf(m.tiles[j]));
  if (m.kind === "run" && m.claimed && m.tiles.length === 3) return runOrder(m.tiles, m.claimed).map((j) => ({ face: face(j) }));
  if (stacked) return [{ face: face(0) }, { face: face(1), top: face(3) }, { face: face(2) }];
  return m.tiles.map((_, j) => ({ face: face(j) }));
}

// A group of tiles side by side (a meld, the bonus tiles), as one box in
// its row: its tiles at `pitch` apart (0.72em - they butt up), padded
// 0.04em round. `along`: its length; `across`: its depth.
interface Group {
  slots: Slot[];
  em: number; // the tiles' size
  pad: number;
  along: number;
  across: number;
}
const meldGroup = (m: GameMeld, hide: boolean, inRow: boolean, em: number): Group => {
  const slots = meldSlots(m, hide, inRow);
  return { slots, em, pad: 0.04 * em, along: slots.length * 0.72 * em + 0.08 * em, across: 1.08 * em };
};
// Bonus tiles four fifths the size, in a group padded as a meld (by the meld's em).
const flowerGroup = (fs: BonusTile[], em: number): Group | null =>
  fs.length ? { slots: fs.map((f) => ({ face: bonusFace(f) })), em: em * 0.8, pad: 0.04 * em, along: fs.length * 0.72 * 0.8 * em + 0.08 * em, across: 0.8 * em + 0.08 * em } : null;

// Lays a group's tiles from one end. `at(k)`: the centre of the k-th slot
// from where the row starts. `rot`: how the tiles turn to face their owner.
function placeGroup(g: Group, at: (k: number) => [number, number], rot: number, shade: [number, number], pieces: Piece[], quads: Quad[], tableZ = true) {
  g.slots.forEach((s, k) => {
    const [x, y] = at(k);
    pieces.push({ face: s.face ?? BACK, m: s.face ? lying(x, y, g.em, rot) : lyingDown(x, y, g.em, rot), shade, tint: 1 });
    if (tableZ) quads.push(shadowAt(x, y, g.em, rot));
    // A kong's fourth, on the middle one (a hair above its face).
    if (s.top !== undefined) {
      const z = THICK * g.em + 1;
      pieces.push({ face: s.top ?? BACK, m: s.top ? lying(x, y, g.em, rot, z) : lyingDown(x, y, g.em, rot, z), shade, tint: 1 });
    }
  });
}

// The standing hand's faces, as HandTilesView has them: blanks till it's laid
// down; then sorted, a winning tile last.
function wallFaces(w: GLWall): { faces: string[]; win: number } {
  if (!(w.down && w.tiles)) return { faces: Array<string>(w.count).fill(UNSEEN), win: -1 };
  const sorted = sortTiles(w.tiles);
  const at = w.winningTile ? sorted.findIndex((t) => sameTile(t, w.winningTile!)) : -1;
  const faces = (at < 0 ? sorted : [...sorted.filter((_, i) => i !== at), sorted[at]]).map(faceOf);
  return { faces, win: at < 0 ? -1 : faces.length - 1 };
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// A take's flights, by the taker and the giver's group they land in.
const flightGroups = <F extends { to: string; group: number }>(fs: F[]): F[][] => {
  const by = new Map<string, F[]>();
  for (const f of fs) by.set(`${f.to}:${f.group}`, [...(by.get(`${f.to}:${f.group}`) ?? []), f]);
  return [...by.values()];
};

// Play's easings (App.css).
const FALL = bezier(0.55, 0, 1, 0.45);
const SETTLE = bezier(0.2, 0.8, 0.3, 1);
// Your hand rearranging in 換牌 (HAND_SLIDE_MS in PlayPanel).
const SLIDE = bezier(0.3, 0.7, 0.2, 1);
const SLIDE_S = 0.45;
// Your given tiles, down to your pile - lifted clear of the row by this far in.
const GIVE_S = 0.6;
const GIVE_CLEAR_S = 0.22;
// A tile tipping over (play-topple-*): from standing (`from` deg) down flat,
// quickening as it falls, a small bounce back up (7deg) and settled; slid
// back `back` as it goes - [angle, back].
const toppleFrames = (from: number, bounce: number, back: number) => [
  { at: 0, v: [from, 0], ease: FALL },
  { at: 0.8, v: [0, back], ease: EASE_OUT },
  { at: 0.9, v: [bounce, back], ease: EASE_IN },
  { at: 1, v: [0, back] },
];
// Your tiles tipping back onto the table (play-topple-mine): from leaning
// toward you (-22deg) to the felt's 32deg.
const MINE_FRAMES = [
  { at: 0, v: [-22], ease: FALL },
  { at: 0.8, v: [32], ease: EASE_OUT },
  { at: 0.9, v: [26], ease: EASE_IN },
  { at: 1, v: [32] },
];
// A laid-down hand's i-th tile tipping over, timed by its wall's topple.
const topple = (key: string, w: GLWall, i: number, from: number, bounce: number, back: number, pose: (angle: number, back: number) => Mat): Anim => ({
  key,
  delay: w.topple.at + i * w.topple.step,
  dur: w.topple.dur,
  pose: (k) => {
    const [a, b] = keyframes(toppleFrames(from, bounce, back), k);
    return pose(a, b);
  },
});

// A toppling tile's shadow: only once it's nearly down.
const landing = (q: Quad, key: string, w: GLWall, i: number): Quad => ({
  ...q,
  anim: { key: `${key}:shadow`, delay: w.topple.at + i * w.topple.step, dur: w.topple.dur, pose: (k) => (k < 0.7 ? scale(0) : q.m) },
});

// The felt's plane into your row's space (from the middle of the row's top
// edge, `handMid` and `handY` in the canvas), so a tile on the felt is drawn
// in your row's view exactly where the felt's own view draws it: the views
// differ only by where they're seen from - a point at depth z shows shifted
// by the eyes' difference, z/d of it. `felt`: the felt into the canvas.
export function feltToHand(felt: Mat, stage: { d: number; ox: number; oy: number }, row: { ox: number; oy: number }, handMid: number, handY: number): Mat {
  const shear = scale(1);
  shear[8] = -(stage.ox - row.ox) / stage.d;
  shear[9] = -(stage.oy - row.oy) / stage.d;
  return chain(translate(-handMid, -handY, 0), shear, felt);
}

// The spotlight's bubble: its tile (a size up on the table's), padded 0.38em round.
export function bubbleBox(d: Dims) {
  const te = d.tile * 1.25;
  return { te, em: d.middle, bw: 0.78 * te + 0.76 * d.middle, bh: te + 0.76 * d.middle };
}

// What you take in 換牌, standing above your hand: nine tenths of your
// tiles - nearer you than your pile on the felt, so bigger than it shows.
export const SWAP_ROW = 0.9;

export function layoutTable(view: GLTableView, d: Dims): Layout {
  const felt: Piece[] = [];
  const feltQuads: Quad[] = [];
  const { rem, tile: T } = d;
  // .play-felt's padding, grid gaps and the grid's content box.
  const cx0 = 0.7 * rem;
  const cx1 = d.feltW - 0.7 * rem;
  const cy0 = 0.45 * rem;
  const cy1 = d.feltH - d.under - 0.35 * rem;
  const colGap = 0.5 * rem;
  const rowGap = 0.25 * rem;
  const centreX = d.feltW / 2;

  // ---- The side seats: their wall at the edge, melds and bonus tiles in front.
  const side = (which: "left" | "right") => {
    const w = view.walls[which];
    const Wg = d.wall * w.wallGrow;
    const p = 0.72 * Wg;
    const slot = 0.97 * Wg;
    const { faces, win } = wallFaces(w);
    const drew = w.drew && !w.down;
    const n = faces.length;
    const edgeW = 0.55 * Wg;
    const edgeH = (drew ? n * p : (n + 1) * p) + 0.25 * Wg + slot;
    // In front: the bonus tiles, then the melds - their columns (each group
    // a column of turned tiles) wrapping toward the middle past a full
    // wall's length - all centred on one line across.
    const flowers = flowerGroup(w.flowers, T);
    const gap = 0.15 * T;
    const maxLen = 17 * 0.72 * d.wall;
    const cols: Group[][] = [];
    let len = 0;
    for (const g of w.melds.map((m) => meldGroup(m, w.hideConcealed, false, T))) {
      if (!cols.length || len + gap + g.along > maxLen + 0.5) {
        cols.push([g]);
        len = g.along;
      } else {
        cols[cols.length - 1].push(g);
        len += gap + g.along;
      }
    }
    const colW = (c: Group[]) => Math.max(...c.map((g) => g.across));
    const colLen = (c: Group[]) => sum(c.map((g) => g.along)) + gap * (c.length - 1);
    // 換牌: what they've taken this round lies among their melds as one
    // more item - on down the last column if it fits, else a column of its
    // own toward the middle (as .play-seat-melds wraps it).
    const row = view.rows[which];
    const rowLen = row ? sum(row.groups.map((g) => g.tiles.length * 0.72 * T + 0.08 * T)) + 0.55 * T * (row.groups.length - 1) : 0;
    // The melds and bonus tiles keep their places while it's there (only
    // for the moment of the swap): it goes on down the last column only as
    // far as the wall reaches, else into a column of its own.
    const meldsW = sum(cols.map(colW));
    const meldsH = cols.length ? Math.max(...cols.map(colLen)) : 0;
    const sideW = Math.max(flowers?.across ?? 0, meldsW);
    const sideH = (flowers?.along ?? 0) + meldsH + (flowers && meldsH ? gap : 0);
    // (Where exactly: see the seat's placing below.)
    const span = Math.max(edgeH, maxLen) / 2;
    const extra = Math.max(0, Wg * 0.5 - 0.9 * rem);
    const seatGap = 0.3 * T + extra;
    const meldIn = w.down ? 0 : 0.45 * T + extra;
    return { w, Wg, p, slot, faces, win, drew, edgeW, edgeH, flowers, cols, colW, meldsW, meldsH, sideW, sideH, seatGap, meldIn, row, rowLen, span, gap, width: edgeW + seatGap + sideW };
  };
  const L = side("left");
  const R = side("right");
  const sideCol = Math.max(L.width, R.width);

  // ---- Across: its wall, its melds beside it - or in front, if they won't fit.
  const top = view.walls.top;
  const Wt = d.wallTop;
  const tp = 0.72 * Wt;
  const tslot = 0.97 * Wt;
  const tw = wallFaces(top);
  const tdrew = top.drew && !top.down;
  const tn = tw.faces.length;
  const tEdgeW = (tdrew || tw.win >= 0 ? tn * tp : (tn + 1) * tp) + 0.25 * Wt + tslot;
  const tEdgeH = 0.55 * Wt;
  const tFlowers = flowerGroup(top.flowers, T);
  const tMelds = top.melds.map((m) => meldGroup(m, top.hideConcealed, false, T));
  const tGap = 0.15 * T;
  const meldsLong = sum(tMelds.map((g) => g.along + tGap));
  const laid = meldsLong + (tFlowers ? tFlowers.along + tGap : 0);
  // Room beside it: as far as what of the side seats is beside it allows -
  // their walls (as they'll lie at the end), and their melds and bonus
  // tiles if they reach up that far - the row kept centred (fitTop).
  const band = [cy0 + 0.6 * d.wallTop, cy0 + 0.6 * d.wallTop + Math.max(0.55 * d.wallTop, 1.05 * T)];
  const reachOf = (S: typeof L) => {
    const lying = Math.max(0, S.Wg * 0.5 - 0.9 * rem);
    const sideTop = (cy0 + cy1) / 2 - S.sideH / 2;
    const sideReaches = S.sideW > 0 && sideTop < band[1] && sideTop + S.sideH > band[0];
    return sideReaches ? S.width : S.edgeW + lying;
  };
  const leftReach = cx0 + 0.5 * rem + reachOf(L);
  const rightReach = cx1 - 0.5 * rem - reachOf(R);
  const room = 2 * Math.min(centreX - leftReach, rightReach - centreX) - 8;
  const standing = Math.max(0, 16 - 3 * top.melds.length);
  const beside = (standing + 1) * tp + 0.25 * Wt + 0.3 * T;
  const topOut = meldsLong > 0 && beside + laid > room && beside + meldsLong <= room;
  const topFront = laid > 0 && beside + laid > room && !topOut;
  const hasBeside = !topFront && (top.melds.length > 0 || top.flowers.length > 0);
  const tSideItems = [...(tFlowers && !topOut ? [tFlowers] : []), ...tMelds];
  const tSideW = sum(tSideItems.map((g) => g.along)) + tGap * Math.max(0, tSideItems.length - 1);
  const tSideH = tSideItems.length ? Math.max(...tSideItems.map((g) => g.across)) : 0;
  const tSeatGap = topFront ? 0.3 * T + 0.05 * Wt : 0.3 * T;
  const tSeatW = topFront ? Math.max(tEdgeW, tSideW) : tSideW + tSeatGap + tEdgeW - (hasBeside ? tslot : 0);
  const tSeatH = topFront ? tEdgeH + tSeatGap + tSideH : Math.max(tEdgeH, tSideH);
  const tSeatX0 = centreX - tSeatW / 2;
  const tSeatY0 = cy0 + 0.6 * Wt;

  // ---- The grid: the middle column as wide as the far pond, the side
  // ponds' columns sharing what's left; the middle row the compass.
  const col3 = Math.max(9 * 0.74 * T, d.compass);
  const col2 = (cx1 - cx0 - 2 * sideCol - col3 - 4 * colGap) / 2;
  const col2x1 = cx0 + sideCol + colGap + col2;
  const col4x0 = col2x1 + colGap + col3 + colGap;
  const row1 = 0.6 * Wt + tSeatH;
  const midH = d.compass;
  const row2 = (cy1 - cy0 - row1 - midH - 3 * rowGap) / 2;
  const row2y1 = cy0 + row1 + rowGap + row2;
  const midY = row2y1 + rowGap + midH / 2;
  const row4y0 = row2y1 + rowGap + midH + rowGap;
  const middle = { x: centreX, y: midY };

  // Each seat's tiles on the felt, as boxes in its plane - what its pond
  // mustn't run into: its wall's footprint, its melds' and bonus tiles'.
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const owned: Record<"top" | "left" | "right", Box[]> = { top: [], left: [], right: [] };
  const ownSince = (side: "top" | "left" | "right", from: number) => {
    for (const p of felt.slice(from)) {
      const m = p.m;
      // (Standing tiles are counted by their wall's footprint.)
      if (Math.abs(m[10]) < 1e-3 * Math.hypot(m[0], m[1], m[2])) continue;
      const em = Math.hypot(m[0], m[1], m[2]);
      const turned = Math.abs(m[0]) < 0.5 * em;
      const [hw, hh] = turned ? [0.5 * em, 0.39 * em] : [0.39 * em, 0.5 * em];
      owned[side].push({ x0: m[12] - hw, y0: m[13] - hh, x1: m[12] + hw, y1: m[13] + hh });
    }
  };

  // ---- Across's wall and melds.
  {
    const from = felt.length;
    let edgeX0: number;
    let edgeY0: number;
    let sideX1: number;
    let sideY: number; // the side row's centre line
    if (topFront) {
      edgeX0 = centreX - tEdgeW / 2;
      edgeY0 = tSeatY0;
      sideX1 = centreX + tSideW / 2;
      sideY = tSeatY0 + tEdgeH + tSeatGap + tSideH / 2 - (top.down ? 0 : 0.45 * T + 0.05 * Wt);
    } else {
      sideX1 = tSeatX0 + tSeatW;
      const edgeX1 = sideX1 - tSideW - tSeatGap + (hasBeside ? tslot : 0);
      edgeX0 = edgeX1 - tEdgeW;
      edgeY0 = tSeatY0 + (tSeatH - tEdgeH) / 2;
      sideY = tSeatY0 + tSeatH / 2 - (hasBeside ? (top.down ? 0.25 : 0.58) * T : 0);
    }
    // The tiles from the right of the wall's content (its slot padding at
    // the right): a drawn tile first, at the left, 0.25em apart.
    const contentX1 = edgeX0 + tEdgeW - tslot;
    let x = contentX1;
    const xs: number[] = [];
    for (let i = tn - 1; i >= 0; i--) {
      const wide = i === tw.win ? Wt : tp;
      x -= wide;
      xs[i] = x;
      if (i === tw.win || (i === 1 && tdrew)) x -= 0.25 * Wt;
    }
    tw.faces.forEach((f, i) => {
      const fx = xs[i];
      if (!top.down) {
        felt.push({ face: f, m: chain(translate(fx + 0.36 * Wt, edgeY0, 0), rotateX(90), translate(0, 0.5 * Wt, 0), scale(Wt)), shade: LIT, tint: 1 });
        return;
      }
      // Laid down: tipped over away from its player about its foot, slid
      // back 0.45em (a winning tile, last, lying sideways).
      const isWin = i === tw.win;
      const ox = fx - 0.03 * Wt + (isWin ? 0.5 : 0.39) * Wt;
      const pose = (a: number, b: number) =>
        chain(translate(ox, edgeY0 - b, 0), rotateX(a), translate(0, (isWin ? 0.39 : 0.5) * Wt, 0), rotateZ(isWin ? 90 : 0), scale(Wt));
      const cx = ox;
      const cy = edgeY0 - 0.45 * Wt + (isWin ? 0.39 : 0.5) * Wt;
      felt.push({ face: f, m: pose(0, 0.45 * Wt), shade: isWin ? TURNED : LIT, tint: 1, anim: topple(`top:down:${i}`, top, i, 90, 7, 0.45 * Wt, pose) });
      feltQuads.push(landing(shadowAt(cx, cy, Wt, isWin ? 90 : 0), `top:down:${i}`, top, i));
    });
    // Melds and bonus tiles from the right end (their left), each group's
    // tiles right to left.
    let gx = sideX1;
    for (const g of tSideItems) {
      const x1 = gx - g.pad;
      const pitch = 0.72 * g.em;
      placeGroup(g, (k) => [x1 - pitch * (k + 0.5), sideY], 0, LIT, felt, feltQuads);
      gx -= g.along + tGap;
    }
    // Bonus tiles out a row, under the melds, from the right.
    if (topOut && tFlowers) {
      const y = sideY + tSideH / 2 + 0.15 * T + tFlowers.across / 2;
      const x1 = sideX1 - tFlowers.pad;
      placeGroup(tFlowers, (k) => [x1 - 0.72 * tFlowers.em * (k + 0.5), y], 0, LIT, felt, feltQuads);
    }
    owned.top.push({ x0: edgeX0, y0: edgeY0, x1: edgeX0 + tEdgeW, y1: edgeY0 + tEdgeH });
    ownSince("top", from);
  }

  const rowAt: Partial<Record<"left" | "right", { x: number; y: number; dir: number }>> = {};
  // ---- The side seats, centred top to bottom: the wall against the edge,
  // the melds' columns in front of it.
  for (const which of ["left", "right"] as const) {
    const S = which === "left" ? L : R;
    const from = felt.length;
    const dir = which === "left" ? 1 : -1; // toward the middle
    const seatX0 = which === "left" ? cx0 + 0.5 * rem : cx1 - 0.5 * rem - S.width;
    const midSeatY = (cy0 + cy1) / 2;
    const edgeY0 = midSeatY - S.edgeH / 2;
    const edgeX0 = which === "left" ? seatX0 : seatX0 + S.width - S.edgeW;
    const { Wg, p, slot, faces, win, drew } = S;
    // The left wall from its far end (padding: the slot at the top); the
    // right's from its near end. A drawn tile at the player's right.
    const ys: number[] = [];
    if (which === "left") {
      let y = edgeY0 + slot;
      faces.forEach((_, i) => {
        if ((i === faces.length - 1 && drew) || i === win) y += 0.25 * Wg;
        ys[i] = y;
        y += i === win ? Wg : p;
      });
    } else {
      let y = edgeY0 + S.edgeH - slot;
      for (let i = faces.length - 1; i >= 0; i--) {
        y -= i === win ? Wg : p;
        ys[i] = y;
        if ((i === 1 && drew) || i === win) y -= 0.25 * Wg;
      }
    }
    const tb = Math.min(0.45 * Wg, 0.9 * rem);
    faces.forEach((f, i) => {
      const fy = ys[i];
      const fx = which === "left" ? edgeX0 : edgeX0 + S.edgeW;
      if (!S.w.down) {
        const m =
          which === "left"
            ? chain(translate(fx, fy + 0.36 * Wg, 0), rotateY(-90), translate(0.5 * Wg, 0, 0), rotateZ(90), scale(Wg))
            : chain(translate(fx, fy + 0.36 * Wg, 0), rotateY(90), translate(-0.5 * Wg, 0, 0), rotateZ(-90), scale(Wg));
        felt.push({ face: f, m, shade: TURNED, tint: 1 });
        return;
      }
      const isWin = i === win;
      // Tipped over toward the middle about its outer foot (play-topple-left / -right).
      const oy = isWin ? fy - 0.03 * Wg + 0.5 * Wg : fy + 0.36 * Wg;
      const rot = isWin ? 0 : 90 * dir;
      const reach = (isWin ? 0.39 : 0.5) * Wg;
      const pose = (a: number, b: number) => chain(translate(fx - dir * b, oy, 0), rotateY(a), translate(dir * reach, 0, 0), rotateZ(rot), scale(Wg));
      const cx = fx - dir * tb + dir * reach;
      const cy = oy;
      felt.push({ face: f, m: pose(0, tb), shade: isWin ? LIT : TURNED, tint: 1, anim: topple(`${which}:down:${i}`, S.w, i, -90 * dir, -7 * dir, tb, pose) });
      feltQuads.push(landing(shadowAt(cx, cy, Wg, rot), `${which}:down:${i}`, S.w, i));
    });
    // The melds: in front of the wall, stepped in toward it till the hand's
    // laid down; columns from the player's left (the far end for the left
    // seat, the near end for the right), wrapping toward the middle.
    // (The left player's runs from the far end, down; the right's from the near end, up.)
    const sideX0 = which === "left" ? edgeX0 + S.edgeW + S.seatGap - S.meldIn : edgeX0 - S.seatGap + S.meldIn - S.sideW;
    const sideMid = sideX0 + S.sideW / 2;
    let y = midSeatY - (dir * S.sideH) / 2;
    const run = (g: Group, cx: number, from: number) => {
      const pitch = 0.72 * g.em;
      placeGroup(g, (k) => [cx, from + dir * (g.pad + pitch * (k + 0.5))], 90 * dir, TURNED, felt, feltQuads);
    };
    if (S.flowers) {
      run(S.flowers, sideMid, y);
      y += dir * (S.flowers.along + 0.15 * T);
    }
    let colX = which === "left" ? sideMid - S.meldsW / 2 : sideMid + S.meldsW / 2;
    // A 換牌 row: on after what's in front of the wall (the bonus tiles,
    // the melds' last column) if it ends within the wall's length; else a
    // column of its own toward the middle, centred along the wall - never
    // past the wall's end. Alone, it's centred.
    const fits = (from: number) => dir * (from + dir * S.rowLen - midSeatY) <= S.span + 0.5;
    const ownColumn = (x: number) => ({ x, y: midSeatY - (dir * S.rowLen) / 2, dir });
    let after = { x: sideMid, y };
    for (const col of S.cols) {
      const cw = S.colW(col);
      let gy = y;
      for (const g of col) {
        run(g, colX + (dir * cw) / 2, gy);
        gy += dir * (g.along + 0.15 * T);
      }
      after = { x: colX + (dir * cw) / 2, y: gy };
      colX += dir * cw;
    }
    if (S.row) {
      // (Clear of the standing tiles: the seat's gap in front of the wall,
      // not stepped in as the melds are till the hand goes down.)
      const wallInner = which === "left" ? edgeX0 + S.edgeW : edgeX0;
      const alone = !S.flowers && !S.cols.length;
      const nextX = S.cols.length ? colX + (dir * 1.08 * T) / 2 : sideMid + dir * (S.sideW / 2 + 0.15 * T + 0.54 * T);
      rowAt[which] = alone ? ownColumn(wallInner + dir * (S.seatGap + 0.54 * T)) : fits(after.y) ? { ...after, dir } : ownColumn(nextX);
    }
    owned[which].push({ x0: edgeX0, y0: edgeY0, x1: edgeX0 + S.edgeW, y1: edgeY0 + S.edgeH });
    ownSince(which, from);
  }

  // ---- The ponds, each from the compass toward its player.
  const pondTiles = (side: GLSide, pond: GLPond) => {
    const along = side === "top" || side === "bottom";
    const limit = along ? 9 * 0.74 * T : 7 * 0.74 * T;
    // Each tile's length along its row, and the rows' depth.
    const step = (i: number) => (i === pond.riichiAt ? 0.95 : 0.73) * T;
    const rowDepth = 0.93 * T;
    const lines: number[][] = [[]];
    let len = 0;
    pond.tiles.forEach((_, i) => {
      if (len + step(i) > limit + 0.01 && lines[lines.length - 1].length) {
        lines.push([]);
        len = 0;
      }
      lines[lines.length - 1].push(i);
      len += step(i);
    });
    if (!pond.tiles.length) return;
    // A size smaller when its rows would reach its owner's tiles - only as
    // small as that needs (pondFit), from its edge by the compass.
    const depth = lines.length * rowDepth + 0.07 * T;
    const gap = 5;
    let free = Infinity;
    if (side === "bottom") free = d.handTop - gap - (row4y0 + 0.3 * T);
    else if (side === "top") {
      const x0 = centreX - limit / 2;
      const x1 = centreX + limit / 2;
      const theirs = owned.top.filter((b) => b.x1 > x0 && b.x0 < x1);
      if (theirs.length) free = row2y1 - Math.max(...theirs.map((b) => b.y1)) - gap;
    } else {
      const y0 = midY - limit / 2;
      const y1 = midY + limit / 2;
      const theirs = owned[side].filter((b) => b.y1 > y0 && b.y0 < y1);
      if (theirs.length) free = side === "left" ? col2x1 - Math.max(...theirs.map((b) => b.x1)) - gap : Math.min(...theirs.map((b) => b.x0)) - gap - col4x0;
    }
    const fit = Math.round(Math.max(0.4, Math.min(1, free / depth)) * 100) / 100;
    const em = T * fit;
    pond.tiles.forEach((t, i) => {
      const r = lines.findIndex((l) => l.includes(i));
      const before = sum(lines[r].filter((j) => j < i).map(step));
      const riichi = i === pond.riichiAt;
      let x: number;
      let y: number;
      let rot: number;
      if (side === "top") {
        const x1 = centreX + limit / 2;
        x = x1 - before - step(i) / 2;
        y = row2y1 - (r + 0.5) * rowDepth + (riichi ? 0.11 * T : 0);
        rot = riichi ? 90 : 0;
        [x, y] = [centreX + (x - centreX) * fit, row2y1 + (y - row2y1) * fit];
      } else if (side === "bottom") {
        const x0 = centreX - limit / 2;
        x = x0 + before + step(i) / 2;
        const top0 = row4y0 + 0.3 * T;
        y = top0 + (r + 0.5) * rowDepth + (riichi ? 0.11 * T : 0);
        rot = riichi ? 90 : 0;
        [x, y] = [centreX + (x - centreX) * fit, top0 + (y - top0) * fit];
      } else if (side === "left") {
        const y0 = midY - limit / 2;
        x = col2x1 - (r + 0.5) * rowDepth;
        y = y0 + before + step(i) / 2;
        rot = riichi ? 0 : 90;
        [x, y] = [col2x1 + (x - col2x1) * fit, midY + (y - midY) * fit];
      } else {
        const y1 = midY + limit / 2;
        x = col4x0 + (r + 0.5) * rowDepth;
        y = y1 - before - step(i) / 2;
        rot = riichi ? 0 : -90;
        [x, y] = [col4x0 + (x - col4x0) * fit, midY + (y - midY) * fit];
      }
      const turned = (side === "left" || side === "right") !== riichi;
      const m = lying(x, y, em, rot);
      // The newest discard drops onto the felt from a little above and settles (play-drop).
      const drop =
        pond.pinLast && i === pond.tiles.length - 1
          ? {
              key: `${side}:drop:${i}`,
              delay: 0,
              dur: 0.36,
              pose: (k: number) =>
                chain(
                  translate(0, 0, keyframes([{ at: 0, v: [1.4 * em], ease: bezier(0.5, 0, 0.9, 0.6) }, { at: 0.72, v: [0], ease: bezier(0.2, 0.6, 0.4, 1) }, { at: 0.86, v: [0.12 * em], ease: bezier(0.5, 0, 0.8, 0.5) }, { at: 1, v: [0] }], k)[0]),
                  m
                ),
            }
          : undefined;
      felt.push({ face: faceOf(t), m, shade: turned ? TURNED : LIT, tint: 1, anim: drop });
      feltQuads.push(shadowAt(x, y, em, rot));
      // The newest discard's pin: a gold point on its thrower's side.
      if (pond.pinLast && i === pond.tiles.length - 1) {
        const pin = 0.3 * em;
        const at =
          side === "bottom"
            ? chain(translate(x, y + 0.5 * em + 0.075 * em, THICK * em * 0.5), scale(pin, 0.15 * em, 1))
            : side === "top"
              ? chain(translate(x, y - 0.5 * em - 0.075 * em, THICK * em), rotateZ(180), scale(pin, 0.15 * em, 1))
              : side === "left"
                ? chain(translate(x - 0.615 * em, y, THICK * em), rotateZ(90), scale(pin, 0.15 * em, 1))
                : chain(translate(x + 0.615 * em, y, THICK * em), rotateZ(-90), scale(pin, 0.15 * em, 1));
        feltQuads.push({ kind: "pin", m: at });
      }
    });
  };
  (["top", "left", "right", "bottom"] as const).forEach((s) => pondTiles(s, view.ponds[s]));

  // ---- The spotlight: the discard up for grabs, in a bubble standing up
  // off the felt by the compass, on its thrower's side.
  if (view.spotlight) {
    const em = d.middle;
    const from = view.spotlight.from;
    const sx = middle.x + (from === "left" ? -3.6 : from === "right" ? 3.6 : 0) * em;
    const sy = middle.y + (from === "top" ? -3.1 : from === "bottom" ? 3.1 : 0) * em;
    const { te, bw, bh } = bubbleBox(d);
    // Stood up about its foot, lifted 1.3em, facing you - popped in from
    // half size (play-pop, 0.22s).
    const stand = (s: number) => chain(translate(sx, sy + bh / 2, 1.3 * em), rotateX(-32), scale(s, s, 1));
    const bubble = (s: number) => chain(stand(s), translate(0, -bh / 2, 0), scale(bw + 2 * em, bh + 2 * em, 1));
    // The tile in it, tipped back from its foot to show its thickness.
    const tile = (s: number) => chain(stand(s), translate(0, -0.38 * em, 0), translate(0, 0, 0.55 * te), rotateX(30), translate(0, -0.5 * te, 0), scale(te));
    const pop = (pose: (s: number) => Mat, part: string): Anim => ({ key: `spot:${view.spotlight!.key}:${part}`, delay: 0, dur: 0.22, pose: (k) => pose(0.5 + 0.5 * EASE_OUT(k)) });
    feltQuads.push({ kind: `bubble-${from}`, m: bubble(1), anim: pop(bubble, "bubble") });
    felt.push({ face: faceOf(view.spotlight.tile), m: tile(1), shade: LIT, tint: 1, anim: pop(tile, "tile") });
  }

  // ---- 換牌: each seat's pile where its discards go, a little bigger than
  // a discard - the others' face down, yours standing up facing you; the
  // tiles taken flying to a row by the taker's hand.
  const P = 1.2 * T;
  const spots: Partial<Record<GLSide, Spot[]>> = {};
  // Your pile: right under the compass (its tiles lean back toward it), so
  // it's clear of the row of what you take, shown just above your hand -
  // the whole swap long, so it never moves mid-way.
  const mineAt = Math.min(row4y0 + 0.3 * P, (d.rowTop ?? Infinity) - 4 - 0.5 * P);
  // Your give: each place in your pile, and the given tile (by its order in the give) that went there.
  const givenAt = new Map<number, number>();
  if (view.mine.given && view.piles?.bottom) {
    const left = view.mine.given.tiles.map((t, j) => ({ face: faceOf(t), j }));
    view.piles.bottom.slots.forEach((s, i) => {
      if (!s || s === "back") return;
      const k = left.findIndex((g) => g.face === faceOf(s));
      if (k >= 0) givenAt.set(i, left.splice(k, 1)[0].j);
    });
  }
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const pile = view.piles?.[side];
    if (!pile) continue;
    const n = pile.slots.length;
    const len = n * 0.78 * P + (n - 1) * 0.06 * P;
    const rot = side === "left" ? 90 : side === "right" ? -90 : 0;
    spots[side] = pile.slots.map((slot, i) => {
      const along = len / 2 - 0.39 * P - i * 0.84 * P;
      const [x, y] =
        side === "top"
          ? [centreX + along, row2y1 - 0.5 * P]
          : side === "bottom"
            ? [centreX - along, mineAt]
            : side === "left"
              ? [col2x1 - 0.5 * P, midY - along]
              : [col4x0 + 0.5 * P, midY + along];
      const standing = pile.standing && side === "bottom";
      const lift = pile.picked.includes(i) ? 0.45 * P : 0;
      // Yours stand up on the felt, leaning back as your hand does (54deg up
      // from it) - on their near foot, so they rest on the felt, not over it.
      const m = standing
        ? chain(translate(x - 0.39 * P, y - 0.5 * P, 0), about(0.39 * P, (0.5 + TILE_H / 2) * P, 0, rotateX(-54)), translate(0.39 * P, 0.5 * P, 0), scale(P))
        : lyingDown(x, y, P, rot, lift);
      const spot = { x, y, rot, standing, m: standing ? m : lyingDown(x, y, P, rot) };
      if (slot === null) {
        // Taken: its place outlined on the felt.
        const deep = standing ? THICK * P : 0.913 * P;
        feltQuads.push({ kind: "gap", m: chain(translate(x, standing ? y + 0.5 * P - deep / 2 : y, 0.5), rotateZ(rot), scale(0.72 * P, deep, 1)) });
        return spot;
      }
      if (pile.arriving.includes(i)) return spot;
      // Just given: unseen till its tile has come down from your hand.
      const coming = side === "bottom" && view.mine.given && givenAt.has(i) ? view.mine.given.key : null;
      const arrive: Anim | undefined = coming === null ? undefined : { key: `give:${coming}:${i}`, delay: 0, dur: GIVE_S, pose: () => scale(0) };
      felt.push({ face: slot === "back" ? BACK : faceOf(slot), m, shade: rot ? TURNED : LIT, tint: 1, pick: pile.pickable ? [side, i] : undefined, anim: arrive });
      // (Its shadow lands with it.)
      const shadow = standing ? { kind: "shadow" as const, m: chain(translate(x, y + 0.42 * P, 0.4), scale(SHADOW_W * P, 0.75 * P, 1)) } : shadowAt(x, y, P, rot);
      feltQuads.push(arrive ? { ...shadow, anim: { ...arrive, key: `${arrive.key}:shadow` } } : shadow);
      // Picked: lifted off the felt, rimmed in gold.
      if (lift) feltQuads.push({ kind: "picked", m: chain(translate(x, y, lift + THICK * P + 0.5), rotateZ(rot), scale(0.92 * P, 1.11 * P, 1)) });
      return spot;
    });
  }
  // The rows on the felt: a side seat's on down its melds, turned to face
  // it; across's in front of it on the middle line - a group per giver.
  const places: Partial<Record<GLSide, { x: number; y: number; rot: number }[][]>> = {};
  const rowPlaces = (row: GLSwapRow, start: [number, number], dir: [number, number], rot: number) => {
    let at = 0;
    return row.groups.map((g) => {
      const ps = g.tiles.map((_, k) => {
        const s = at + 0.04 * T + 0.72 * T * (k + 0.5);
        return { x: start[0] + dir[0] * s, y: start[1] + dir[1] * s, rot };
      });
      at += g.tiles.length * 0.72 * T + 0.08 * T + 0.55 * T;
      return ps;
    });
  };
  for (const which of ["left", "right"] as const) {
    const row = view.rows[which];
    const a = rowAt[which];
    if (row && a) places[which] = rowPlaces(row, [a.x, a.y], [0, a.dir], 90 * a.dir);
  }
  if (view.rows.top) {
    const row = view.rows.top;
    const long = row.groups.reduce((t, g) => t + g.tiles.length * 0.72 * T + 0.08 * T, 0) + 0.55 * T * (row.groups.length - 1);
    places.top = rowPlaces(row, [centreX + long / 2, tSeatY0 + tSeatH + 0.35 * T - 0.6 * Wt + 0.54 * T], [-1, 0], 0);
  }
  for (const side of ["left", "right", "top"] as const) {
    const row = view.rows[side];
    row?.groups.forEach((g, gi) =>
      g.tiles.forEach((t, k) => {
        const p = places[side]![gi][k];
        if (!g.shown[k]) return;
        felt.push({ face: t ? faceOf(t) : BACK, m: t ? lying(p.x, p.y, T, p.rot) : lyingDown(p.x, p.y, T, p.rot), shade: p.rot ? TURNED : LIT, tint: 1 });
        feltQuads.push(shadowAt(p.x, p.y, T, p.rot));
      })
    );
  }
  // The tiles in the air (to your row: see layoutHand), each giver's as a formation.
  for (const fs of flightGroups(view.flights.filter((f) => f.to !== "bottom"))) {
    const ok = fs.filter((f) => spots[f.from]?.[f.place] && places[f.to]?.[f.group]?.[f.slot]);
    if (!ok.length) continue;
    const from = ok.map((f) => spots[f.from]![f.place]);
    const to = ok.map((f) => places[f.to]![f.group][f.slot]);
    const a = alongLine(from, from[0].rot);
    // (Side to side, face down, they land a half turn round - see acrossTable.)
    const half = acrossTable(ok[0].from, ok[0].to) && ok.every((f) => !f.tile) ? 180 : 0;
    const b = alongLine(to, to[0].rot + half);
    ok.forEach((f, k) => {
      const p = to[k];
      const rot = p.rot + half;
      const start: FlightEnd = { x: a.x, y: a.y, along: a.along[k], rot: from[k].rot, em: P, pitch: from[k].standing ? -54 : 0, flip: from[k].standing ? 0 : 180, tilt: 0 };
      const end: FlightEnd = { x: b.x, y: b.y, along: b.along[k], rot, em: T, pitch: 0, flip: f.tile ? 0 : 180, tilt: 0 };
      felt.push({
        face: f.tile ? faceOf(f.tile) : BACK,
        m: f.tile ? lying(p.x, p.y, T, rot) : lyingDown(p.x, p.y, T, rot),
        shade: p.rot ? TURNED : LIT,
        tint: 1,
        fly: { key: `fly:${f.id}`, from: from[k].m, dur: 0.75, lift: 1.4 * T, pose: inFormation(start, end, 1.4 * T) },
      });
    });
  }

  return { felt: { pieces: felt, quads: feltQuads }, hand: layoutHand(view, d, spots, givenAt), middle };
}

// A tile at one end of a 換牌 flight, for flying in formation: its centre,
// how far along its giver's line it lies (`along`, from the line's middle),
// which way the line runs (`rot`, as the tile's own turn - its x runs along
// the line), its size, and how it's turned over / stood up about the line
// (`pitch`: stood up about its x, as your tiles stand; `flip`: turned over
// about its y, as every face-down tile on the table is - so a back stays
// the same way round from pile to row) and tipped with the felt (`tilt`,
// in your row's space).
interface FlightEnd {
  x: number;
  y: number;
  along: number;
  rot: number;
  em: number;
  pitch: number;
  flip: number;
  tilt: number;
}
const near = (a: number, to: number) => a + 360 * Math.round((to - a) / 360);
// One tile of a formation, at `v` (0..1, eased) through its flight: the
// giver's tiles move as one rigid line - turning together, spaced a little
// more than a tile apart till they butt up in the row - so none ever
// crosses or touches another; lifted (and a size up) at the top of the arc.
function inFormation(a: FlightEnd, b: FlightEnd, lift: number): (v: number) => Mat {
  const rot1 = near(b.rot, a.rot);
  const flip0 = near(a.flip, b.flip);
  return (v) => {
    const up = 1 + 0.08 * Math.sin(Math.PI * v);
    const em = (a.em + (b.em - a.em) * v) * up;
    const half = (THICK * em) / 2;
    return chain(
      translate(a.x + (b.x - a.x) * v, a.y + (b.y - a.y) * v, Math.sin(Math.PI * v) * lift),
      rotateX(a.tilt + (b.tilt - a.tilt) * v),
      rotateZ(a.rot + (rot1 - a.rot) * v),
      translate((a.along + (b.along - a.along) * v) * up, 0, 0),
      translate(0, 0, half),
      rotateX(a.pitch + (b.pitch - a.pitch) * v),
      rotateY(flip0 + (b.flip - flip0) * v),
      translate(0, 0, -half),
      scale(em)
    );
  };
}
// A group's tiles laid along their line: each one's offset from the middle.
function alongLine(ps: { x: number; y: number }[], rot: number): { x: number; y: number; along: number[] } {
  const x = sum(ps.map((p) => p.x)) / ps.length;
  const y = sum(ps.map((p) => p.y)) / ps.length;
  const ux = Math.cos((rot * Math.PI) / 180);
  const uy = Math.sin((rot * Math.PI) / 180);
  return { x, y, along: ps.map((p) => (p.x - x) * ux + (p.y - y) * uy) };
}

// A pile's place on the felt: where its tile lies, and how.
interface Spot {
  x: number;
  y: number;
  rot: number;
  standing: boolean;
  m: Mat;
}

// ---- Your row: melds and bonus tiles lying at the felt's angle, then your
// tiles standing, leaning toward you, the drawn tile set apart (or its
// place kept) - in .play-hand's own box.
function layoutHand(view: GLTableView, d: Dims, spots: Partial<Record<GLSide, Spot[]>>, givenAt: Map<number, number>): Layout["hand"] {
  const pieces: Piece[] = [];
  const quads: Quad[] = [];
  const H = d.hand;
  const mine = view.mine;
  const height = 1.2 * H;
  const foot = height; // every tile's foot on the row's line
  let x = 0;
  // Melds and flowers, a size down, flowers first; each lying at 32deg.
  const M = 0.74 * H;
  const flowers = flowerGroup(mine.flowers, M);
  const melds = mine.melds.map((m) => meldGroup(m, mine.hideConcealed, true, M));
  // Your row running past the screen's edges (judged with the bonus tiles
  // in it, and a tile drawn): the bonus tiles move out a row, onto the
  // table just above it, from its left (bonusOut).
  const inRow = (gs: Group[]) => (gs.length ? sum(gs.map((g) => g.along)) + 0.12 * M * (gs.length - 1) + 0.3 * M : 0);
  const rowLong = inRow([...(flowers ? [flowers] : []), ...melds]) + mine.tiles.filter((t) => !t.drawn).length * 0.75 * H + 1.065 * H;
  const bonusOut = !!flowers && !!d.rowRoom && rowLong > d.rowRoom;
  const groups = [...(flowers && !bonusOut ? [flowers] : []), ...melds];
  if (flowers && bonusOut) {
    const ty = -0.15 * M - flowers.pad - 0.5 * flowers.em;
    flowers.slots.forEach((s, k) => {
      const cx = flowers.pad + 0.72 * flowers.em * (k + 0.5);
      const pose = (a: number) => chain(translate(cx, ty, 0), about(0, 0.5 * flowers.em, THICK * flowers.em, rotateX(a)), scale(flowers.em));
      pieces.push({ face: s.face!, m: pose(32), shade: LIT, tint: 1, anim: { key: `h:f:${k}`, delay: 0, dur: 0.5, pose: (t) => pose(keyframes(MINE_FRAMES, t)[0]) } });
    });
  }
  if (groups.length) {
    const named = flowers && !bonusOut ? ["f", ...mine.melds.map((_, i) => `m${i}`)] : mine.melds.map((_, i) => `m${i}`);
    groups.forEach((g, gi) => {
      const pitch = 0.72 * g.em;
      const ty = foot - g.pad - 0.5 * g.em;
      g.slots.forEach((s, k) => {
        const cx = x + g.pad + pitch * (k + 0.5);
        // (Turned about the foot of its face, as your standing tiles are -
        // the CSS's transform-origin for both.) Laid down from standing
        // as it's declared (play-topple-mine, 0.5s).
        const pose = (a: number) => {
          const flat = chain(translate(cx, ty, 0), about(0, 0.5 * g.em, THICK * g.em, rotateX(a)));
          return s.face ? chain(flat, scale(g.em)) : chain(flat, translate(0, 0, THICK * g.em), rotateY(180), scale(g.em));
        };
        pieces.push({
          face: s.face ?? BACK,
          m: pose(32),
          shade: LIT,
          tint: 1,
          anim: { key: `h:${named[gi]}:${k}`, delay: 0, dur: 0.5, pose: (t) => pose(keyframes(MINE_FRAMES, t)[0]) },
        });
      });
      x += g.along + (gi < groups.length - 1 ? 0.12 * M : 0);
    });
    x += 0.3 * M;
  }
  // Your tiles: each in a 0.78em box, 0.75em apart; the drawn one 0.3em apart.
  const winner = mine.toppled;
  const tilesFrom = x;
  // Each tile by what it is (the n-th of its kind), so in 換牌 it slides
  // from where it was to where it's gone - a tile from your row too.
  const seen = new Map<string, number>();
  const ident = (face: string) => {
    const n = seen.get(face) ?? 0;
    seen.set(face, n + 1);
    return `id:${face}#${n}`;
  };
  mine.tiles.forEach((t: GLHandTile, i) => {
    let x0: number;
    if (t.drawn) {
      x0 = x + 0.3 * H;
      x = x0 + 0.78 * H - 0.015 * H;
    } else if (t.winner && winner) {
      x0 = x + 0.12 * H;
      x = x0 + 0.78 * H + 0.11 * H;
    } else {
      x0 = x - 0.015 * H;
      x = x0 + 0.78 * H - 0.015 * H;
    }
    const y0 = 0.2 * H - (t.selected ? 0.2 * H : 0);
    // Standing on its foot (at the face's depth), leant back 22deg; laid
    // flat at the felt's 32deg once your hand's down.
    const block = (m: Mat) => {
      const c = chain(translate(x0, y0, 0), about(0.39 * H, H, THICK * H, m), translate(0.39 * H, 0.5 * H, 0));
      return t.tile ? chain(c, scale(H)) : chain(c, translate(0, 0, THICK * H), rotateY(180), scale(H));
    };
    // The tile you won with: lifted and shown, then laid flat and turned on
    // its side (play-show-mine) - the rest of your hand tipping back onto
    // the table after it, one by one (play-topple-mine).
    const shown = ([ty, rx, tx2, ty2, rz]: number[]) => block(chain(translate(0, ty, 0), rotateX(rx), translate(tx2, ty2, 0), rotateZ(rz)));
    const SHOW = [
      { at: 0, v: [-0.5 * H, -22, 0, 0, 0], ease: bezier(0.2, 0.7, 0.4, 1) },
      { at: 0.45, v: [-0.6 * H, -22, 0, 0, 0], ease: FALL },
      { at: 0.85, v: [0, 32, -0.5 * H, -0.388 * H, 90], ease: EASE_OUT },
      { at: 0.93, v: [0, 26, -0.5 * H, -0.388 * H, 90], ease: EASE_IN },
      { at: 1, v: [0, 32, -0.5 * H, -0.388 * H, 90] },
    ];
    let anim: Anim | undefined;
    let m: Mat;
    if (winner && t.winner) {
      m = shown(SHOW[4].v);
      anim = { key: `h:show:${i}`, delay: 0.2, dur: 0.8, pose: (k) => shown(keyframes(SHOW, k)) };
    } else if (winner) {
      m = block(rotateX(32));
      anim = { key: `h:down:${i}`, delay: 0.2 + mine.winLead + i * 0.07, dur: 0.6, pose: (k) => block(rotateX(keyframes(MINE_FRAMES, k)[0])) };
    } else {
      m = block(rotateX(-22));
      // A tile just drawn slides in from the wall's side (play-draw).
      if (t.drawn) anim = { key: `h:draw:${mine.drawKey}`, delay: 0, dur: 0.32, pose: (k) => chain(translate(0.5 * H * (1 - SETTLE(k)), -0.35 * H * (1 - SETTLE(k)), 0), m) };
    }
    pieces.push({
      face: t.tile ? faceOf(t.tile) : BACK,
      m,
      shade: winner && t.winner ? TURNED : LIT,
      tint: t.barred ? 0 : 1,
      hit: i,
      anim,
      // Picked up and put back eased, not snapped (.play-hand-tile's
      // transition - on its lift only: moved along the row, it jumps -
      // but in 換牌, slid along the row to its new place).
      ease: winner
        ? undefined
        : mine.sliding
          ? // (Just after a give, once the given tiles have lifted clear of
            // their gaps - so nothing passes through anything.)
            { key: ident(t.tile ? faceOf(t.tile) : BACK), dur: SLIDE_S, curve: SLIDE, delay: mine.given ? GIVE_CLEAR_S : 0 }
          : { key: `h:${i}:${Math.round(x0)}`, dur: 0.16, curve: SETTLE },
    });
    // Hints: the bots' pick underlined in gold; a risky tile barred in red.
    if (t.hint) quads.push({ kind: "hint", m: chain(translate(x0 + 0.39 * H, y0 + H + 0.09 * H, 0), scale(0.78 * H * 0.64, 0.06 * H, 1)) });
    if (t.danger) quads.push({ kind: "danger", m: chain(translate(x0 + 0.39 * H, y0 - 0.13 * H, 0), scale(0.78 * H * 0.7, 0.06 * H, 1)) });
  });
  // No tile drawn: its place kept.
  if (mine.tiles.length && !mine.tiles.some((t) => t.drawn) && !winner) x += 0.3 * H + 0.746 * H;
  // In 換牌 the row keeps its width (see handMinWidth) - it's centred, and
  // re-centred as tiles leave it every tile would jump.
  const width = Math.max(x, mine.sliding ? (d.handMinWidth ?? 0) : 0);
  // One soft shadow under the standing row.
  if (mine.tiles.length && !winner) quads.unshift({ kind: "row-shadow", m: chain(translate(width / 2, height - 0.05 * H, 0), scale(width - 0.2 * H + 0.36 * H, 0.3 * H + 0.36 * H, 1)) });
  // 換牌: what you've taken, above your hand - standing as your tiles do,
  // a size smaller, a group per giver - and the tiles flying in to it from
  // the piles (drawn from where they're seen on the felt).
  const row = view.rows.bottom;
  if (row) {
    const Rm = SWAP_ROW * H;
    const long = row.groups.reduce((t, g) => t + g.tiles.length * 0.72 * Rm + 0.08 * Rm, 0) + 0.6 * Rm * (row.groups.length - 1);
    const foot = -0.25 * d.rem - 0.04 * Rm;
    let at = width / 2 - long / 2;
    const placeAt = row.groups.map((g) => {
      const ps = g.tiles.map((_, k) => at + 0.04 * Rm + 0.72 * Rm * k - 0.03 * Rm);
      at += g.tiles.length * 0.72 * Rm + 0.08 * Rm + 0.6 * Rm;
      return ps;
    });
    const standing = (x0: number, t: Tile | null) => {
      const c = chain(translate(x0, foot - Rm, 0), about(0.39 * Rm, Rm, THICK * Rm, rotateX(-22)), translate(0.39 * Rm, 0.5 * Rm, 0));
      return t ? chain(c, scale(Rm)) : chain(c, translate(0, 0, THICK * Rm), rotateY(180), scale(Rm));
    };
    row.groups.forEach((g, gi) =>
      g.tiles.forEach((t, k) => {
        if (g.shown[k]) pieces.push({ face: t ? faceOf(t) : BACK, m: standing(placeAt[gi][k], t), shade: LIT, tint: 1, ease: { key: ident(t ? faceOf(t) : BACK), dur: SLIDE_S, curve: SLIDE } });
      })
    );
    // Flying in from the piles, each giver's as a formation - starting as
    // they're seen on the felt (tipped back its 32deg, face down).
    for (const fs of flightGroups(view.flights.filter((f) => f.to === "bottom"))) {
      const ok = fs.filter((f) => spots[f.from]?.[f.place] && placeAt[f.group]?.[f.slot] !== undefined);
      if (!ok.length || !d.project) continue;
      const from = ok.map((f) => spots[f.from]![f.place]);
      const flat = alongLine(from, from[0].rot);
      const seenMid = d.project(flat.x, flat.y, 0);
      const ends = ok.map((f) => ({ x: placeAt[f.group][f.slot] + 0.39 * Rm, y: foot - 0.5 * Rm }));
      const b = alongLine(ends, 0);
      ok.forEach((f, k) => {
        const seen = d.project!(from[k].x, from[k].y, 0);
        const P = 1.2 * d.tile * seen.s;
        // Exactly where it lay, as your row's view draws it (see feltToHand).
        const start = d.feltToHand ? chain(translate(width / 2, 0, 0), d.feltToHand, from[k].m) : chain(translate(width / 2 + seen.x, seen.y, 0), rotateX(32), rotateZ(from[k].rot), translate(0, 0, THICK * P), rotateY(180), scale(P));
        const a: FlightEnd = { x: width / 2 + seenMid.x, y: seenMid.y, along: flat.along[k] * seenMid.s, rot: from[k].rot, em: 1.2 * d.tile * seenMid.s, pitch: 0, flip: 180, tilt: 32 };
        const z: FlightEnd = { x: b.x, y: b.y, along: b.along[k], rot: 0, em: Rm, pitch: -22, flip: f.tile ? 0 : 180, tilt: 0 };
        pieces.push({
          face: f.tile ? faceOf(f.tile) : BACK,
          m: standing(placeAt[f.group][f.slot], f.tile),
          shade: LIT,
          tint: 1,
          fly: { key: `fly:${f.id}`, from: start, dur: 0.75, lift: 1.4 * d.tile, pose: inFormation(a, z, 1.4 * d.tile) },
        });
      });
    }
  }
  // Your give: each tile from where it stood (lifted, picked) in your hand
  // as it was, down to its place in your pile on the felt.
  const given = mine.given;
  const pile = spots.bottom;
  if (given && pile && d.project) {
    for (const [i, j] of givenAt) {
      const spot = pile[i];
      const x0 = tilesFrom + given.from[j] * 0.75 * H - 0.015 * H;
      const start = chain(translate(x0, 0, 0), about(0.39 * H, H, THICK * H, rotateX(-22)), translate(0.39 * H, 0.5 * H, 0), scale(H));
      const seenAt = d.project(spot.x, spot.y - 0.5 * 1.2 * d.tile, 0);
      const P = 1.2 * d.tile * seenAt.s;
      // Landing exactly where your pile's tile stands, as your row's view draws it.
      const end = d.feltToHand ? chain(translate(width / 2, 0, 0), d.feltToHand, spot.m) : chain(translate(width / 2 + seenAt.x, seenAt.y + 0.5 * P, 0), rotateX(-22), scale(P));
      pieces.push({
        face: faceOf(given.tiles[j]),
        m: end,
        shade: LIT,
        tint: 1,
        fly: { key: `give:${given.key}:${i}:air`, from: start, dur: GIVE_S, lift: 0.6 * H },
        // Gone once it's down (the pile's own tile takes over).
        hideAfter: GIVE_S,
      });
    }
  }
  return { pieces, quads, width, height };
}
