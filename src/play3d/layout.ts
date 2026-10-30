// Play 2.0's table laid out in its own coordinates: where every tile lies,
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
import { about, chain, rotateX, rotateY, rotateZ, scale, translate, type Mat } from "./mat";
import type { GLHandTile, GLPond, GLSide, GLTableView, GLWall } from "./types";

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
}

// Flat marks: shadows on the felt, the newest discard's pin, the hint and
// danger marks under and over your tiles, the spotlight's bubble.
export type QuadKind = "shadow" | "row-shadow" | "pin" | "hint" | "danger" | "bubble-top" | "bubble-bottom" | "bubble-left" | "bubble-right";
export interface Quad {
  kind: QuadKind;
  // The unit square (-0.5..0.5 each way, at z 0) to where it's drawn.
  m: Mat;
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

// The spotlight's bubble: its tile (a size up on the table's), padded 0.38em round.
export function bubbleBox(d: Dims) {
  const te = d.tile * 1.25;
  return { te, em: d.middle, bw: 0.78 * te + 0.76 * d.middle, bh: te + 0.76 * d.middle };
}

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
    const meldsW = sum(cols.map(colW));
    const meldsH = cols.length ? Math.max(...cols.map(colLen)) : 0;
    const sideW = Math.max(flowers?.across ?? 0, meldsW);
    const sideH = (flowers?.along ?? 0) + meldsH + (flowers && cols.length ? gap : 0);
    const extra = Math.max(0, Wg * 0.5 - 0.9 * rem);
    const seatGap = 0.3 * T + extra;
    const meldIn = w.down ? 0 : 0.45 * T + extra;
    return { w, Wg, p, slot, faces, win, drew, edgeW, edgeH, flowers, cols, colW, meldsW, meldsH, sideW, sideH, seatGap, meldIn, width: edgeW + seatGap + sideW };
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
  // Room beside it: as far as the side seats allow, the row kept centred (fitTop).
  const leftReach = cx0 + 0.5 * rem + L.width;
  const rightReach = cx1 - 0.5 * rem - R.width;
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
      // Laid down: tipped over away from its player, slid back 0.45em.
      const isWin = i === tw.win;
      const cx = isWin ? fx - 0.03 * Wt + 0.5 * Wt : fx + 0.36 * Wt;
      const cy = edgeY0 - 0.45 * Wt + (isWin ? 0.39 : 0.5) * Wt;
      felt.push({ face: f, m: lying(cx, cy, Wt, isWin ? 90 : 0), shade: isWin ? TURNED : LIT, tint: 1 });
      feltQuads.push(shadowAt(cx, cy, Wt, isWin ? 90 : 0));
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
      const cx = which === "left" ? fx - tb + (isWin ? 0.39 : 0.5) * Wg : fx + tb - (isWin ? 0.39 : 0.5) * Wg;
      const cy = isWin ? fy - 0.03 * Wg + 0.5 * Wg : fy + 0.36 * Wg;
      const rot = isWin ? 0 : 90 * dir;
      felt.push({ face: f, m: lying(cx, cy, Wg, rot), shade: isWin ? LIT : TURNED, tint: 1 });
      feltQuads.push(shadowAt(cx, cy, Wg, rot));
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
    for (const col of S.cols) {
      const cw = S.colW(col);
      let gy = y;
      for (const g of col) {
        run(g, colX + (dir * cw) / 2, gy);
        gy += dir * (g.along + 0.15 * T);
      }
      colX += dir * cw;
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
      felt.push({ face: faceOf(t), m: lying(x, y, em, rot), shade: turned ? TURNED : LIT, tint: 1 });
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
    // Stood up about its foot, lifted 1.3em, facing you.
    const stand = chain(translate(sx, sy + bh / 2, 1.3 * em), rotateX(-32));
    feltQuads.push({ kind: `bubble-${from}`, m: chain(stand, translate(0, -bh / 2, 0), scale(bw + 2 * em, bh + 2 * em, 1)) });
    // The tile in it, tipped back from its foot to show its thickness.
    const foot = chain(stand, translate(0, -0.38 * em, 0));
    felt.push({ face: faceOf(view.spotlight.tile), m: chain(foot, translate(0, 0, 0.55 * te), rotateX(30), translate(0, -0.5 * te, 0), scale(te)), shade: LIT, tint: 1 });
  }

  return { felt: { pieces: felt, quads: feltQuads }, hand: layoutHand(view, d), middle };
}

// ---- Your row: melds and bonus tiles lying at the felt's angle, then your
// tiles standing, leaning toward you, the drawn tile set apart (or its
// place kept) - in .play-hand's own box.
function layoutHand(view: GLTableView, d: Dims): Layout["hand"] {
  const pieces: Piece[] = [];
  const quads: Quad[] = [];
  const H = d.hand;
  const mine = view.mine;
  const height = 1.2 * H;
  const foot = height; // every tile's foot on the row's line
  let x = 0;
  // Melds and flowers, a size down, flowers first; each lying at 32deg.
  const M = 0.74 * H;
  const groups = [flowerGroup(mine.flowers, M), ...mine.melds.map((m) => meldGroup(m, mine.hideConcealed, true, M))].filter((g): g is Group => !!g);
  if (groups.length) {
    groups.forEach((g, gi) => {
      const pitch = 0.72 * g.em;
      const ty = foot - g.pad - 0.5 * g.em;
      g.slots.forEach((s, k) => {
        const cx = x + g.pad + pitch * (k + 0.5);
        // (Turned about the foot of its face, as your standing tiles are -
        // the CSS's transform-origin for both.)
        const flat = chain(translate(cx, ty, 0), about(0, 0.5 * g.em, THICK * g.em, rotateX(32)));
        pieces.push({ face: s.face ?? BACK, m: s.face ? chain(flat, scale(g.em)) : chain(flat, translate(0, 0, THICK * g.em), rotateY(180), scale(g.em)), shade: LIT, tint: 1 });
      });
      x += g.along + (gi < groups.length - 1 ? 0.12 * M : 0);
    });
    x += 0.3 * M;
  }
  // Your tiles: each in a 0.78em box, 0.75em apart; the drawn one 0.3em apart.
  const winner = mine.toppled;
  mine.tiles.forEach((t: GLHandTile) => {
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
    const pivot = (m: Mat) => chain(translate(x0, y0, 0), about(0.39 * H, H, THICK * H, m));
    let m: Mat;
    if (winner && t.winner) m = chain(pivot(chain(rotateX(32), translate(-0.5 * H, -0.388 * H, 0), rotateZ(90))), translate(0.39 * H, 0.5 * H, 0));
    else m = chain(pivot(rotateX(winner ? 32 : -22)), translate(0.39 * H, 0.5 * H, 0));
    pieces.push({
      face: t.tile ? faceOf(t.tile) : BACK,
      m: t.tile ? chain(m, scale(H)) : chain(m, translate(0, 0, THICK * H), rotateY(180), scale(H)),
      shade: winner && t.winner ? TURNED : LIT,
      tint: t.barred ? 0 : 1,
    });
    // Hints: the bots' pick underlined in gold; a risky tile barred in red.
    if (t.hint) quads.push({ kind: "hint", m: chain(translate(x0 + 0.39 * H, y0 + H + 0.09 * H, 0), scale(0.78 * H * 0.64, 0.06 * H, 1)) });
    if (t.danger) quads.push({ kind: "danger", m: chain(translate(x0 + 0.39 * H, y0 - 0.13 * H, 0), scale(0.78 * H * 0.7, 0.06 * H, 1)) });
  });
  // No tile drawn: its place kept.
  if (mine.tiles.length && !mine.tiles.some((t) => t.drawn) && !winner) x += 0.3 * H + 0.746 * H;
  const width = x;
  // One soft shadow under the standing row.
  if (mine.tiles.length && !winner) quads.unshift({ kind: "row-shadow", m: chain(translate(width / 2, height - 0.05 * H, 0), scale(width - 0.2 * H + 0.36 * H, 0.3 * H + 0.36 * H, 1)) });
  return { pieces, quads, width, height };
}
