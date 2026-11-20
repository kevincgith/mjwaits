// Play's WebGL table laid out in its own coordinates: where every tile lies,
// worked out from the table's sizes and what's on it (its grid, its rows of
// 9 and 7, the walls and their slots), without measuring a single tile on
// the page.
//
// Two spaces, each in CSS pixels with CSS's axes (x right, y down, z up off
// the table): the felt's own plane, before its tilt (the WebGL table tilts
// it as .play-felt is), and your hand's row (.play-hand), standing in front
// of it. A tile is a block - its footprint 0.72em by 0.913em, 0.42em thick,
// the face on top - placed by a matrix from its centre on the table.

import { sameTile, type GameMeld } from "@mjwaits/shared/engine/game";
import { sortTiles, type Tile } from "@mjwaits/shared/engine/mahjong";
import { sortBonusTiles, type BonusTile } from "@mjwaits/shared/engine/scoring";
import { bezier, EASE_IN, EASE_OUT, keyframes } from "./anim";
import { about, apply, chain, identity, rotateX, rotateY, rotateZ, scale, translate, type Mat } from "./mat";
import { acrossTable } from "./swapOrder";
import type { GLHandTile, GLPond, GLSide, GLSwapRow, GLTableView, GLWall, PeekSide } from "./types";

// The most a side seat's wall grows (its standing tiles fewer as it melds:
// PlayPanel's sideWallGrow caps at this).
export const SIDE_WALL_GROW = 1 / 0.72;

// The block, in ems of its tile size: width, height, thickness and how round its edges are.
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
  // Where the view's from, in the felt's terms (x, y on it, z up off it),
  // and which way is down the screen there.
  eye?: [number, number, number];
  eyeDown?: [number, number, number];
  // How wide your row may run: the table's width (the screen, as it's held).
  rowRoom?: number;
  // How far down the felt the row of what you take in 換牌 reaches, as seen
  // (its top edge, where it meets the felt's plane).
  rowTop?: number;
  // The felt's plane into your row's space so that it's drawn exactly where
  // the felt's own view draws it (from the middle of the row's top edge):
  // the two views differ only by where their perspective is from - a shear.
  feltToHand?: Mat;
}

// A tile: its face ("m1", "flower2"... or "back" face down), where it lies,
// and how its sides are shaded: how much darker its long sides and its
// ends are than its face.
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
  // Moving through its keyframes, or easing to where it now lies when that
  // changes (as a CSS transition would) - see anim.ts and engine.ts.
  anim?: Anim;
  // (`lift`: raised this high mid-way, to clear what's in its path. `over`:
  // taken up this high (up the screen) and over, then set down - but only
  // when it changes places with another piece; moving along with the rest,
  // it slides; joining the row from above, it goes straight in once the
  // others have made room. See engine's easing.)
  // (`overDelay`: a further wait, only if it goes over.)
  ease?: { key: string; dur: number; curve: (t: number) => number; delay?: number; lift?: number; over?: number; overDelay?: number };
  // Its tint faded to a new one over `dur` seconds, not snapped (by `key`) -
  // from `from` when it first shows, if given.
  fade?: { key: string; dur: number; from?: number };
  // A tile out in the open - a pond's, a meld's, a bonus tile - greyed by
  // 見牌 Seen copies unless it's a copy of the tile held (see seenCopies);
  // its fade's key.
  seen?: string;
  // A meld's claimed tile, thrown since a held plaque's 叮: kept lit.
  safe?: boolean;
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
export type QuadKind = "tray" | "shadow" | "row-shadow" | "pin" | "hint" | "ready" | "danger" | "bubble-top" | "bubble-bottom" | "bubble-left" | "bubble-right" | "picked" | "gap" | "ring" | "tile-ring" | `ding-${GLSide}`;
export interface Quad {
  kind: QuadKind;
  // The unit square (-0.5..0.5 each way, at z 0) to where it's drawn.
  m: Mat;
  anim?: Anim;
  // Moved: eased from where it shows to its new place, as a Piece's ease.
  ease?: Piece["ease"];
}

// A seat's standing hand, for a peek: each tile's centre along the rack, and
// the part of the felt a finger counts as on it.
export interface Rack {
  side: PeekSide;
  axis: "x" | "y";
  centres: number[];
  box: { x0: number; y0: number; x1: number; y1: number };
}

// Something standing on the felt (a name card, the dealer's disc): its unit
// shape to where it stands, showing the `face`th of its faces.
export interface Card {
  m: Mat;
  face: number;
  ease?: Piece["ease"];
}

export interface Layout {
  // (`glass`: a peek's tiles, clear enough to see through, drawn over the rest.)
  // (`dice`: the Dice tab's - see dice.ts.)
  // (`props`: what stands on the felt besides its tiles, by name - the Dice
  // tab's name cards, each showing face `face` of `cardFaces`, and its
  // dealer's disc: see cards.ts.)
  felt: {
    pieces: Piece[];
    quads: Quad[];
    glass?: Piece[];
    glassQuads?: Quad[];
    racks?: Rack[];
    dice?: { m: Mat; anim?: Anim }[];
    props?: Record<string, Card[]>;
    cardFaces?: HTMLCanvasElement;
  };
  hand: { pieces: Piece[]; quads: Quad[]; width: number; height: number };
  // The compass's centre on the felt.
  middle: { x: number; y: number };
}

export const UNSEEN = "z7";
export const BACK = "back";
export const LIT: [number, number] = [0, 0.14];
// Turned a quarter, a tile's long sides face the way its ends did.
export const TURNED: [number, number] = [0.14, 0];

export const faceOf = (t: Tile): string => (t.suit === "j" ? "joker" : `${t.suit}${t.rank}`);
const bonusFace = (b: BonusTile): string => `${b.kind}${b.rank}`;

// A block lying face up with its centre at (x, y), `em` its tile size,
// turned `rot` degrees (as CSS's rotate).
export const lying = (x: number, y: number, em: number, rot = 0, z = 0): Mat => chain(translate(x, y, z), rotateZ(rot), scale(em));
// Face down: turned over where it lies.
export const lyingDown = (x: number, y: number, em: number, rot = 0, z = 0): Mat =>
  chain(translate(x, y, z), rotateZ(rot), translate(0, 0, THICK * em), rotateY(180), scale(em));

// A tile's shadow on the felt (its box-shadow: 0 0.03em 0.28em, round its
// 0.78em x 1em box) - the quad covers the box and the blur round it.
export const SHADOW_W = 0.78 + 0.8;
export const SHADOW_H = 1 + 0.8;
export const shadowAt = (x: number, y: number, em: number, rot = 0): Quad => ({
  kind: "shadow",
  m: chain(translate(x, y, 0.4), rotateZ(rot), translate(0, 0.03 * em, 0), scale(SHADOW_W * em, SHADOW_H * em, 1)),
});

// A meld's tiles as laid out: each a slot (null: face down), a kong's
// fourth stacked on its middle tile on the table - as MeldsView has them.
interface Slot {
  face: string | null;
  // Its meld's claimed tile, thrown since a held plaque's 叮 (safeSince).
  safe?: boolean;
  // Bonus tiles in two rows (more than four of them): its place along its
  // row, and which row - -1 the far one, 1 the near (its tiles' feet),
  // the two touching.
  col?: number;
  row?: number;
  top?: string | null;
  // A concealed kong shown at last (the hand over): its top tile turns over.
  flip?: boolean;
}
function runOrder(tiles: Tile[], claimed: Tile): number[] {
  const c = tiles.findIndex((t) => sameTile(t, claimed));
  if (c < 0) return [0, 1, 2];
  const others = [0, 1, 2].filter((j) => j !== c);
  return [others[0], c, others[1]];
}
function meldSlots(m: GameMeld, hideConcealed: boolean, inRow: boolean): Slot[] {
  const stacked = m.kind === "kong" && m.tiles.length === 4 && !inRow;
  // A concealed kong: in a row, its middle two shown; stacked, only its top
  // (the one under it stays face down - covered, it was turned up unseen).
  const face = (j: number) => (m.concealed && (hideConcealed || (stacked ? j !== 3 : j === 0 || j === 3)) ? null : faceOf(m.tiles[j]));
  if (m.kind === "run" && m.claimed && m.tiles.length === 3) return runOrder(m.tiles, m.claimed).map((j) => ({ face: face(j) }));
  if (stacked) return [{ face: face(0) }, { face: face(1), top: face(3), ...(m.concealed && !hideConcealed ? { flip: true } : {}) }, { face: face(2) }];
  return m.tiles.map((_, j) => ({ face: face(j) }));
}

// A group of tiles side by side (a meld, the bonus tiles), as one box in
// its row: its tiles at `pitch` apart (0.72em - they butt up), padded
// 0.04em round. `along`: its length; `across`: its depth.
export interface Group {
  slots: Slot[];
  em: number; // the tiles' size
  pad: number;
  along: number;
  across: number;
  // A concealed kong a peek has seen: its face, and whether its top tile is
  // turned up to show it now.
  glass?: { face: string; open: boolean; key: string };
  // When a concealed kong's top tile turns over at the hand's end (s): as
  // its player's hand goes down.
  flipAt?: number;
}
// `safe`: its claimed tile (the middle one - a run's is put there) was
// thrown since a held plaque's 叮.
export const meldGroup = (m: GameMeld, hide: boolean, inRow: boolean, em: number, safe = false): Group => {
  const slots = meldSlots(m, hide, inRow).map((s, j) => (safe && j === 1 && !m.concealed ? { ...s, safe: true } : s));
  return { slots, em, pad: 0.04 * em, along: slots.length * 0.72 * em + 0.08 * em, across: 1.08 * em };
};
// Bonus tiles four fifths the size, in a group padded as a meld (by the meld's em).
// More than four: two rows, touching - the seasons and the flowers - a full
// set of four (or the more of them) the near row.
export const flowerGroup = (fs: BonusTile[], em: number): Group | null => {
  if (!fs.length) return null;
  const sorted = sortBonusTiles(fs);
  const fe = 0.8 * em;
  if (sorted.length <= 4) return { slots: sorted.map((f) => ({ face: bonusFace(f) })), em: fe, pad: 0.04 * em, along: fs.length * 0.72 * fe + 0.08 * em, across: fe + 0.08 * em };
  const seasons = sorted.filter((f) => f.kind === "season");
  const flowers = sorted.filter((f) => f.kind !== "season");
  const [far, near] = seasons.length > flowers.length ? [flowers, seasons] : [seasons, flowers];
  const slots: Slot[] = [...far.map((f, col) => ({ face: bonusFace(f), col, row: -1 })), ...near.map((f, col) => ({ face: bonusFace(f), col, row: 1 }))];
  return { slots, em: fe, pad: 0.04 * em, along: Math.max(far.length, near.length) * 0.72 * fe + 0.08 * em, across: 2 * TILE_H * fe + 0.08 * em };
};
// A slot's half-row shift (two rows of bonus tiles), along its tiles' own y.
const rowShift = (s: Slot, em: number) => (s.row ?? 0) * 0.5 * TILE_H * em;

// Lays a group's tiles from one end. `at(k)`: the centre of the k-th slot
// from where the row starts. `rot`: how the tiles turn to face their owner.
// `owner`: which way along its tiles' own y its owner sits (1: toward their
// feet - the side seats', turned to them; -1: across's, upright to you) - a
// second row of bonus tiles' full set goes that side.
export function placeGroup(g: Group, at: (k: number) => [number, number], rot: number, shade: [number, number], pieces: Piece[], quads: Quad[], tableZ = true, owner = 1) {
  g.slots.forEach((s, k) => {
    const [ax, ay] = at(s.col ?? k);
    const dy = owner * rowShift(s, g.em);
    const r = (rot * Math.PI) / 180;
    const [x, y] = [ax - Math.sin(r) * dy, ay + Math.cos(r) * dy];
    pieces.push({ face: s.face ?? BACK, m: s.face ? lying(x, y, g.em, rot) : lyingDown(x, y, g.em, rot), shade, tint: 1, seen: `seen:${Math.round(x)}:${Math.round(y)}`, ...(s.safe ? { safe: true } : {}) });
    if (tableZ) quads.push(shadowAt(x, y, g.em, rot));
    // A kong's fourth, on the middle one (a hair above its face).
    if (s.top !== undefined) {
      const z = THICK * g.em + 1;
      if (g.glass) {
        // Turned up to the one looking, tipped toward them; or lying as it was.
        const up = chain(translate(x, y, z + 0.5 * g.em), rotateX(-24), scale(g.em * 1.08));
        pieces.push({ face: g.glass.face, m: g.glass.open ? up : lyingDown(x, y, g.em, rot, z), shade, tint: 1, ease: { key: g.glass.key, dur: 0.24, curve: SETTLE } });
      } else {
        // A concealed kong shown at the hand's end: its top tile lifts off,
        // turns over along its length and settles face up.
        const flip = s.flip && s.top
          ? {
              key: `kong:flip:${Math.round(x)}:${Math.round(y)}`,
              delay: g.flipAt ?? KONG_FLIP_DELAY,
              dur: 0.6,
              pose: (k: number) => {
                const e = SETTLE(k);
                return chain(translate(x, y, z + Math.sin(Math.PI * e) * 0.8 * g.em), rotateZ(rot), translate(0, 0, (THICK * g.em) / 2), rotateY(180 * (1 - e)), translate(0, 0, (-THICK * g.em) / 2), scale(g.em));
              },
            }
          : undefined;
        pieces.push({ face: s.top ?? BACK, m: s.top ? lying(x, y, g.em, rot, z) : lyingDown(x, y, g.em, rot, z), shade, tint: 1, anim: flip, seen: `seen:${Math.round(x)}:${Math.round(y)}:top` });
      }
    }
  });
}

// A seat's melds, its concealed kongs marked with what a peek has seen of them.
function seeThrough(side: PeekSide, w: GLWall, groups: Group[]): Group[] {
  let k = 0;
  return groups.map((g, i) => {
    const m = w.melds[i];
    if (!(m.kind === "kong" && m.concealed)) return g;
    const n = k++;
    const tiles = w.glassKongs?.[n];
    return tiles ? { ...g, glass: { face: faceOf(tiles[0]), open: !!w.peekOpen, key: `kong:${side}:${n}` } } : g;
  });
}

// Seen copies: a pond's tiles other than the one you're holding, greyed
// further than a 食替 tile (tint 0): 43% bright, mostly drained of colour.
const POND_GREY = -0.5;
// 見牌: how long the ponds take to grey (and come back).
const POND_FADE_S = 0.2;
// A concealed kong turned up at the hand's end, if its group doesn't say
// when (flipAt): a beat after it's over.
const KONG_FLIP_DELAY = 0.35;
// A peek: how far either side of the finger it reaches (the last each side
// cut off at the box's end - PEEK_CUT places from the finger); its tiles' size (in pond
// tiles) and how far apart (in their size); how solid a tile seen through in
// the rack is; how far up from the felt they stand (leant back as your own
// row's tiles are seen). They're solid, dimmed in a gradient toward the
// window's ends: each tile's tint is PEEK_TINT + how many places from the
// finger it is, across the screen (see glassMaterial).
const PEEK_REACH = 3;
export const PEEK_CUT = 3;
const PEEK_SIZE = 1.2;
export const PEEK_PITCH = 0.76;
export const PEEK_TINT = 10;
const PEEK_CLEAR = 0.32;
const PEEK_LEAN = 54;
// The box a peek's tiles stand in: upright behind them, at their lean - a
// plain rectangle as you see it - its length in the row's places (to the
// cut each side, and the margin it has above and below its tiles), and its
// height in its tiles' size: theirs and that margin (the shape peekTray is
// painted to).
export const TRAY_W = 2 * PEEK_CUT + 0.4;
export const TRAY_H = TILE_H + 0.45;

// The standing hand's faces, as HandTilesView has them: blanks till it's laid
// down; then sorted from its player's left, a winning tile at their right.
// (`reversed`: a wall laid out from its player's right - across's and the
// right seat's - so its faces come the other way round, the winning tile first.)
export function wallFaces(w: GLWall, reversed = false): { faces: string[]; win: number } {
  if (!(w.down && w.tiles)) return { faces: Array<string>(w.count).fill(UNSEEN), win: -1 };
  const sorted = sortTiles(w.tiles);
  const at = w.winningTile ? sorted.findIndex((t) => sameTile(t, w.winningTile!)) : -1;
  const faces = (at < 0 ? sorted : [...sorted.filter((_, i) => i !== at), sorted[at]]).map(faceOf);
  if (reversed) faces.reverse();
  return { faces, win: at < 0 ? -1 : reversed ? 0 : faces.length - 1 };
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
// Your hand rearranging in 換牌 (HAND_SLIDE_MS in PlayPanel): a tile that
// changes places with others is taken up over the row (SLIDE_OVER tiles'
// height), across, and set down in its place - never through them - a suit
// at a time, in the hand's order, SUIT_STEP_S apart. One just shifting along
// (a gap closing, room made) slides, all of them in one go; one taken, coming
// down from above, waits for its room and goes straight into it.
const SLIDE = bezier(0.3, 0.7, 0.2, 1);
const SLIDE_S = 0.6;
// A hand's tiles (16-tile mahjong), as your row holds them through 換牌.
const FULL_HAND = 16;
const SUIT_STEP_S = 0.2;
const SLIDE_OVER = 0.9;
// Your pile's tiles stand up from the felt this far (54deg), leaning back as your hand's do.
const MINE_LEAN = 54;
// Your given tiles, down to your pile - lifted clear of the row by this far in.
const GIVE_S = 0.6;
const GIVE_CLEAR_S = 0.22;
// A tile tipping over: from standing (`from` deg) down flat,
// quickening as it falls, a small bounce back up (7deg) and settled; slid
// back `back` as it goes - [angle, back].
const toppleFrames = (from: number, bounce: number, back: number) => [
  { at: 0, v: [from, 0], ease: FALL },
  { at: 0.8, v: [0, back], ease: EASE_OUT },
  { at: 0.9, v: [bounce, back], ease: EASE_IN },
  { at: 1, v: [0, back] },
];
// Your tiles tipping back onto the table: from leaning
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
  const glass: Piece[] = [];
  const glassQuads: Quad[] = [];
  const racks: Rack[] = [];
  const { rem, tile: T } = d;
  const peek = view.peek;
  // A standing tile in the peek's window goes clear.
  const seenThrough = (side: PeekSide, i: number) => peek?.side === side && !peek.closing && !!peek.tiles && Math.abs(i - peek.at) <= PEEK_REACH;
  const standingTile = (side: PeekSide, i: number, face: string, m: Mat, shade: [number, number]) =>
    seenThrough(side, i) ? glass.push({ face, m, shade, tint: PEEK_CLEAR }) : felt.push({ face, m, shade, tint: 1 });
  // A rack's place for a finger, and a peek at it: the tiles round the finger
  // lift out and stand in a row facing you, starting at `lane` (running
  // `dir` from it, a side rack; centred under the finger, across's), and
  // settle back into the rack on letting go.
  const addRack = (rack: Rack, lane: number, poses: Mat[], reversed: boolean, apart: boolean, dir: number) => {
    racks.push(rack);
    if (peek?.side !== rack.side || !peek.tiles || !rack.centres.length) return;
    const at = Math.min(peek.at, rack.centres.length - 1);
    const tiles = reversed ? [...peek.tiles].reverse() : peek.tiles;
    // (A tile just drawn stands apart at the start of a reversed row, and isn't shown.)
    const skip = reversed && apart ? 1 : 0;
    // (Side by side as your own row's tiles stand.)
    const em = PEEK_SIZE * T;
    const pitch = PEEK_PITCH * em;
    const side = rack.axis === "y";
    // (The window, TRAY_W places long, kept on the felt - and a side rack's
    // out beside it, clear of the wall.)
    const margin = (TRAY_W / 2 + 0.2) * pitch;
    const across = Math.max(margin, Math.min(d.feltW - margin, rack.centres[at]));
    const middleX = side ? lane + dir * (TRAY_W / 2 - 0.2) * pitch : across;
    const foot = side ? Math.max(cy0 + 1.7 * T, Math.min(cy1 - 1.5 * T, rack.centres[at] + 0.55 * T)) : lane + 1.4 * T;
    // The box they stand in, to keep them clear of whatever's on the table
    // behind: just behind them, leant as they are (more room below them -
    // their faces stand out in front of it, so are seen a little lower).
    if (!peek.closing) {
      const tray = (s: number) => chain(translate(middleX, foot, 0.14 * T), rotateX(-PEEK_LEAN), translate(0, (-TILE_H / 2 + 0.075) * em, -0.02 * em), scale(TRAY_W * pitch * s, TRAY_H * em * s, 1));
      glassQuads.push({ kind: "tray", m: tray(1), anim: { key: `tray:${rack.side}`, delay: 0, dur: 0.2, pose: (t) => tray(0.7 + 0.3 * SETTLE(t)) } });
    }
    // (Let go, they're simply gone: the rack's own tiles solid again.)
    if (peek.closing) return;
    for (let i = at - PEEK_REACH; i <= at + PEEK_REACH; i++) {
      const tile = tiles[i - skip];
      if (!tile || !poses[i]) continue;
      const key = `peek:${rack.side}:${i}`;
      const along = (side ? dir : 1) * (i - at);
      const x = middleX + along * pitch;
      // Standing in a straight row facing you, there at once (no flight
      // out of the rack) - sliding along with the finger; solid, dimmed toward the ends.
      const m = chain(translate(x, foot, 0.14 * T), rotateX(-PEEK_LEAN), translate(0, (-TILE_H / 2) * em, 0), scale(em));
      glass.push({ face: faceOf(tile), m, shade: LIT, tint: PEEK_TINT + along, ease: { key, dur: 0.18, curve: SETTLE } });
    }
  };

  // The felt's padding (.play-felt), the gaps kept between the table's
  // parts, and the room inside.
  const cx0 = 0.7 * rem;
  const cx1 = d.feltW - 0.7 * rem;
  const cy0 = 0.45 * rem;
  const cy1 = d.feltH - d.under - 0.35 * rem;
  const colGap = 0.5 * rem;
  const rowGap = 0.25 * rem;
  const centreX = d.feltW / 2;
  // Across's row: the band of the felt its wall (and what's beside it) lies in.
  const band = [cy0 + 0.6 * d.wallTop, cy0 + 0.6 * d.wallTop + Math.max(0.55 * d.wallTop, 1.05 * T)];

  // ---- The side seats: their wall at the edge, melds and bonus tiles in front.
  const side = (which: "left" | "right") => {
    const w = view.walls[which];
    const Wg = d.wall * w.wallGrow;
    const p = 0.72 * Wg;
    const slot = 0.97 * Wg;
    const { faces, win } = wallFaces(w, which === "right");
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
    // A column runs as long as the side allows - from level with across's
    // row (never up into it: else across would have make way, its tiles
    // jumping at a side seat's call) to your end - and only then wraps
    // toward the middle. The bonus tiles head the first column - unless
    // that would wrap a meld that fits without them: then they're a column
    // of their own, toward the middle (flowersOwn).
    const room = cy1 - band[1];
    const melds = seeThrough(which, w, w.melds.map((m, i) => ({ ...meldGroup(m, w.hideConcealed, false, T, i >= (view.safeSince?.[which]?.meld ?? Infinity)), flipAt: w.topple.at })));
    const columns = (colMax: number) => {
      const cs: Group[][] = [];
      let len = 0;
      for (const g of melds) {
        if (!cs.length || len + gap + g.along > colMax + 0.5) {
          cs.push([g]);
          len = g.along;
        } else {
          cs[cs.length - 1].push(g);
          len += gap + g.along;
        }
      }
      return cs;
    };
    const headed = columns(room - (flowers ? flowers.along + gap : 0));
    const alone = flowers ? columns(room) : headed;
    const flowersOwn = !!flowers && alone.length < headed.length;
    const cols = flowersOwn ? alone : headed;
    const colW = (c: Group[]) => Math.max(...c.map((g) => g.across));
    const colLen = (c: Group[]) => sum(c.map((g) => g.along)) + gap * (c.length - 1);
    // 換牌: what they've taken this round lies among their melds as one
    // more item - on down the last column if it fits, else a column of its
    // own toward the middle.
    const row = view.rows[which];
    const rowLen = row ? sum(row.groups.map((g) => g.tiles.length * 0.72 * T + 0.08 * T)) + 0.55 * T * (row.groups.length - 1) : 0;
    // The melds and bonus tiles keep their places while it's there (only
    // for the moment of the swap): it goes on down the last column only as
    // far as the wall reaches, else into a column of its own.
    const meldsW = sum(cols.map(colW));
    const meldsH = cols.length ? Math.max(...cols.map(colLen)) : 0;
    const sideW = flowersOwn ? meldsW + flowers!.across : Math.max(flowers?.across ?? 0, meldsW);
    const sideH = flowersOwn ? Math.max(meldsH, flowers!.along) : (flowers?.along ?? 0) + meldsH + (flowers && meldsH ? gap : 0);
    // Centred along the side - or, too long for that, slid toward your end
    // just enough to stay clear of across's row.
    const sideTop = Math.max(band[1], Math.min((cy0 + cy1) / 2 - sideH / 2, cy1 - sideH));
    // (Where exactly: see the seat's placing below.)
    const span = Math.max(edgeH, maxLen) / 2;
    const extra = Math.max(0, Wg * 0.5 - 0.9 * rem);
    const seatGap = 0.3 * T + extra;
    const meldIn = w.down ? 0 : 0.45 * T + extra;
    return { w, Wg, p, slot, faces, win, drew, edgeW, edgeH, flowers, flowersOwn, cols, colW, meldsW, meldsH, sideW, sideH, sideTop, seatGap, meldIn, row, rowLen, span, gap, width: edgeW + seatGap + sideW };
  };
  const L = side("left");
  const R = side("right");
  const sideCol = Math.max(L.width, R.width);

  // ---- Across: its wall, its melds beside it - or in front, if they won't fit.
  const top = view.walls.top;
  const Wt = d.wallTop;
  const tp = 0.72 * Wt;
  const tslot = 0.97 * Wt;
  const tw = wallFaces(top, true);
  const tdrew = top.drew && !top.down;
  const tn = tw.faces.length;
  const tEdgeW = (tdrew || tw.win >= 0 ? tn * tp : (tn + 1) * tp) + 0.25 * Wt + tslot;
  const tEdgeH = 0.55 * Wt;
  const tFlowers = flowerGroup(top.flowers, T);
  const tMelds = seeThrough("top", top, top.melds.map((m, i) => ({ ...meldGroup(m, top.hideConcealed, false, T, i >= (view.safeSince?.top?.meld ?? Infinity)), flipAt: top.topple.at })));
  const tGap = 0.15 * T;
  const meldsLong = sum(tMelds.map((g) => g.along + tGap));
  const laid = meldsLong + (tFlowers ? tFlowers.along + tGap : 0);
  // Room beside it: as far as what of the side seats is beside it allows -
  // their walls (as they'll lie at the end), and their melds and bonus
  // tiles if they reach up that far - the row kept centred (fitTop).
  // (The side walls as big as they grow - see SIDE_WALL_GROW - so across's
  // room is the same all hand, whatever the side seats call.)
  const reachOf = (S: typeof L) => {
    const Wg = d.wall * SIDE_WALL_GROW;
    const lying = Math.max(0, Wg * 0.5 - 0.9 * rem);
    const sideReaches = S.sideW > 0 && S.sideTop < band[1] && S.sideTop + S.sideH > band[0];
    return sideReaches ? S.width : 0.55 * Wg + lying;
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
  // (Beside: as deep as a meld from the start - so the wall, centred on it,
  // is where it'll be once a meld's laid, not dropping down then.)
  const tSeatH = topFront ? tEdgeH + tSeatGap + tSideH : Math.max(tEdgeH, tSideH, 1.08 * T);
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
    // the right): a drawn tile (or winning one) first, at the left - its
    // player's right - 0.25em apart.
    const contentX1 = edgeX0 + tEdgeW - tslot;
    let x = contentX1;
    const xs: number[] = [];
    for (let i = tn - 1; i >= 0; i--) {
      const wide = i === tw.win ? Wt : tp;
      x -= wide;
      xs[i] = x;
      if (i === 1 && (tdrew || tw.win === 0)) x -= 0.25 * Wt;
    }
    const topPoses: Mat[] = [];
    tw.faces.forEach((f, i) => {
      const fx = xs[i];
      if (!top.down) {
        topPoses[i] = chain(translate(fx + 0.36 * Wt, edgeY0, 0), rotateX(90), translate(0, 0.5 * Wt, 0), scale(Wt));
        standingTile("top", i, f, topPoses[i], LIT);
        return;
      }
      // Laid down: tipped over away from its player about its foot, slid
      // back 0.45em (a winning tile, at its player's right, lying sideways).
      const isWin = i === tw.win;
      const ox = fx - 0.03 * Wt + (isWin ? 0.5 : 0.39) * Wt;
      const pose = (a: number, b: number) =>
        chain(translate(ox, edgeY0 - b, 0), rotateX(a), translate(0, (isWin ? 0.39 : 0.5) * Wt, 0), rotateZ(isWin ? 90 : 0), scale(Wt));
      const cx = ox;
      const cy = edgeY0 - 0.45 * Wt + (isWin ? 0.39 : 0.5) * Wt;
      felt.push({ face: f, m: pose(0, 0.45 * Wt), shade: isWin ? TURNED : LIT, tint: 1, anim: topple(`top:down:${i}`, top, i, 90, 7, 0.45 * Wt, pose) });
      feltQuads.push(landing(shadowAt(cx, cy, Wt, isWin ? 90 : 0), `top:down:${i}`, top, i));
    });
    if (!top.down) {
      // (In front of its melds, when they're in front of it.)
      const lane = (topFront ? tSeatY0 + tSeatH : edgeY0 + tEdgeH) + 0.75 * T;
      addRack({ side: "top", axis: "x", centres: xs.map((v) => v + 0.36 * Wt), box: { x0: edgeX0 - tp, y0: edgeY0 - 1.3 * Wt, x1: edgeX0 + tEdgeW + tp, y1: lane + 0.6 * T } }, lane, topPoses, true, tdrew, 1);
    }
    // Melds and bonus tiles from the right end (their left), each group's
    // tiles right to left.
    let gx = sideX1;
    for (const g of tSideItems) {
      const x1 = gx - g.pad;
      const pitch = 0.72 * g.em;
      placeGroup(g, (k) => [x1 - pitch * (k + 0.5), sideY], 0, LIT, felt, feltQuads, true, -1);
      gx -= g.along + tGap;
    }
    // Bonus tiles out a row, under the melds, from the right.
    if (topOut && tFlowers) {
      const y = sideY + tSideH / 2 + 0.15 * T + tFlowers.across / 2;
      const x1 = sideX1 - tFlowers.pad;
      placeGroup(tFlowers, (k) => [x1 - 0.72 * tFlowers.em * (k + 0.5), y], 0, LIT, felt, feltQuads, true, -1);
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
    const edgeX0 = which === "left" ? seatX0 : seatX0 + S.width - S.edgeW;
    const { Wg, p, faces, win, drew } = S;
    // The two side hands mirror each other: the tiles in hand in the same
    // place on both sides, and a tile drawn (or the winning tile) set apart
    // at the player's right: below the left player's hand, above the
    // right's. Half a full-size tile below the middle: a side wall's a tile
    // shorter than a full hand's (sideWallGrow, in PlayPanel), so its near
    // end - the left player's drawn tile, clear of your hand - is where a
    // full one's would be, and its far end a tile lower: room there for the
    // right player's winning tile past a full concealed hand. (Top to
    // bottom: the left wall from its far end, the right's from its near end.)
    const apart = drew || win >= 0;
    const held = faces.length - (apart ? 1 : 0);
    const handY0 = midSeatY + 0.5 * 0.72 * d.wall - (held * p) / 2;
    const ys: number[] = [];
    if (which === "left") {
      let y = handY0;
      faces.forEach((_, i) => {
        if ((i === faces.length - 1 && drew) || i === win) y += 0.25 * Wg;
        ys[i] = y;
        y += i === win ? Wg : p;
      });
    } else {
      let y = handY0 - (apart ? 0.25 * Wg + (win === 0 ? Wg : p) : 0);
      faces.forEach((_, i) => {
        ys[i] = y;
        y += i === win ? Wg : p;
        if (i === 0 && apart) y += 0.25 * Wg;
      });
    }
    const edgeY0 = ys.length ? Math.min(...ys) : handY0;
    const edgeY1 = ys.length ? Math.max(...ys.map((y, i) => y + (i === win ? Wg : p))) : handY0;
    const tb = Math.min(0.45 * Wg, 0.9 * rem);
    const poses: Mat[] = [];
    faces.forEach((f, i) => {
      const fy = ys[i];
      const fx = which === "left" ? edgeX0 : edgeX0 + S.edgeW;
      if (!S.w.down) {
        const m =
          which === "left"
            ? chain(translate(fx, fy + 0.36 * Wg, 0), rotateY(-90), translate(0.5 * Wg, 0, 0), rotateZ(90), scale(Wg))
            : chain(translate(fx, fy + 0.36 * Wg, 0), rotateY(90), translate(-0.5 * Wg, 0, 0), rotateZ(-90), scale(Wg));
        poses[i] = m;
        standingTile(which, i, f, m, TURNED);
        return;
      }
      const isWin = i === win;
      // Tipped over toward the middle about its outer foot.
      const oy = isWin ? fy - 0.03 * Wg + 0.5 * Wg : fy + 0.36 * Wg;
      const rot = isWin ? 0 : 90 * dir;
      const reach = (isWin ? 0.39 : 0.5) * Wg;
      const pose = (a: number, b: number) => chain(translate(fx - dir * b, oy, 0), rotateY(a), translate(dir * reach, 0, 0), rotateZ(rot), scale(Wg));
      const cx = fx - dir * tb + dir * reach;
      const cy = oy;
      felt.push({ face: f, m: pose(0, tb), shade: isWin ? LIT : TURNED, tint: 1, anim: topple(`${which}:down:${i}`, S.w, i, -90 * dir, -7 * dir, tb, pose) });
      feltQuads.push(landing(shadowAt(cx, cy, Wg, rot), `${which}:down:${i}`, S.w, i));
    });
    if (!S.w.down) {
      // (In front of its melds and bonus tiles.)
      const clear = (S.sideW ? S.seatGap - S.meldIn + S.sideW : 0) + 0.75 * T;
      const lane = which === "left" ? edgeX0 + S.edgeW + clear : edgeX0 - clear;
      const [bx0, bx1] = which === "left" ? [edgeX0 - 1.5 * Wg, lane + 0.6 * T] : [lane - 0.6 * T, edgeX0 + S.edgeW + 1.5 * Wg];
      addRack({ side: which, axis: "y", centres: ys.map((v) => v + 0.36 * Wg), box: { x0: bx0, y0: edgeY0 - p, x1: bx1, y1: edgeY1 + p } }, lane, poses, which === "right", drew, dir);
    }
    // The melds: in front of the wall, stepped in toward it till the hand's
    // laid down; columns from the player's left (the far end for the left
    // seat, the near end for the right), wrapping toward the middle.
    // (The left player's runs from the far end, down; the right's from the near end, up.)
    const sideX0 = which === "left" ? edgeX0 + S.edgeW + S.seatGap - S.meldIn : edgeX0 - S.seatGap + S.meldIn - S.sideW;
    const sideMid = sideX0 + S.sideW / 2;
    let y = S.sideTop + S.sideH / 2 - (dir * S.sideH) / 2;
    const run = (g: Group, cx: number, from: number) => {
      const pitch = 0.72 * g.em;
      placeGroup(g, (k) => [cx, from + dir * (g.pad + pitch * (k + 0.5))], 90 * dir, TURNED, felt, feltQuads);
    };
    if (S.flowers && !S.flowersOwn) {
      run(S.flowers, sideMid, y);
      y += dir * (S.flowers.along + 0.15 * T);
    }
    let colX = sideMid - (dir * (S.flowersOwn ? S.sideW : S.meldsW)) / 2;
    // A 換牌 row: on down the melds' last column if it ends within the
    // wall's length; else a column of its own toward the middle, centred
    // along the wall - never past the wall's end. Bonus tiles alone, it's
    // always in front of them, never on in line with them. Alone, it's centred.
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
    // (Their own column: past the melds', from the same end.)
    if (S.flowers && S.flowersOwn) run(S.flowers, colX + (dir * S.flowers.across) / 2, y);
    if (S.row) {
      // (Clear of the standing tiles: the seat's gap in front of the wall,
      // not stepped in as the melds are till the hand goes down.)
      const wallInner = which === "left" ? edgeX0 + S.edgeW : edgeX0;
      const alone = !S.flowers && !S.cols.length;
      const nextX = S.cols.length ? colX + (dir * 1.08 * T) / 2 : sideMid + dir * (S.sideW / 2 + 0.15 * T + 0.54 * T);
      rowAt[which] = alone ? ownColumn(wallInner + dir * (S.seatGap + 0.54 * T)) : S.cols.length && fits(after.y) ? { ...after, dir } : ownColumn(nextX);
    }
    owned[which].push({ x0: edgeX0, y0: edgeY0, x1: edgeX0 + S.edgeW, y1: edgeY1 });
    ownSince(which, from);
  }

  // ---- The ponds, each from the compass toward its player.
  // (Each one's tiles on the felt, as laid: its box and size.)
  const pondBoxes: Partial<Record<GLSide, { x0: number; x1: number; y0: number; y1: number; em: number }[]>> = {};
  const pondTiles = (side: GLSide, pond: GLPond) => {
    // (9 tiles a row on every side: the side ponds as long as the others.)
    const limit = 9 * 0.74 * T;
    // Each tile's length along its row, and the rows' depth.
    const step = (i: number) => (i === pond.riichiAt ? 0.95 : 0.73) * T;
    const rowDepth = 0.93 * T;
    // The 叮s, each a bar on the felt in its declarer's colour: in New row,
    // the tiles thrown since each start a row, the bar on the felt before it;
    // in Compact, the row opens a gap where it fell, the bar in it - before its
    // tile, or, none thrown since, where the next will go (`n`, a place held
    // for it - a new row shows nothing till its first tile).
    const dings = (pond.dings ?? []).map((g) => ({ ...g, at: Math.min(g.at, pond.tiles.length) }));
    const newRows = pond.dingMark === "row";
    const n = pond.tiles.length;
    const bars = newRows ? dings.filter((g) => g.at < n) : dings;
    const held = !newRows && bars.some((g) => g.at === n) ? n + 1 : n;
    // The bars' room in the row: a gap before the tile each 叮 fell at, the
    // bars a bar's width apart, padded each side - more on the near side in
    // the side ponds, whose rows run away from you: there a tile hides the
    // felt just past it, so the bars go clear of that. In New row, no gap:
    // the lines lie on the felt before the row, the tiles where they'd be
    // (in yours and across's, clear of the side pond at that corner - the
    // pond drawn a little smaller if they'd reach its tiles).
    const BAR = 0.085 * T;
    const SEP = 0.05 * T;
    const PAD = 0.06 * T;
    const HIDE = 0.26 * T;
    const [lead, trail] = side === "left" ? [PAD, HIDE] : side === "right" ? [HIDE, PAD] : [PAD, PAD];
    const gapAt = (i: number) => {
      const k = newRows ? 0 : bars.filter((g) => g.at === i).length;
      return k ? lead + k * BAR + (k - 1) * SEP + trail : 0;
    };
    const room = (i: number) => gapAt(i) + step(i);
    const lines: number[][] = [[]];
    let len = 0;
    for (let i = 0; i < held; i++) {
      const full = len + room(i) > limit + 0.01;
      const fresh = newRows && dings.some((g) => g.at === i);
      if ((full || fresh) && lines[lines.length - 1].length) {
        lines.push([]);
        len = 0;
      }
      lines[lines.length - 1].push(i);
      len += room(i);
    }
    if (!held) return;
    // A size smaller when its rows would reach its owner's tiles - only as
    // small as that needs (pondFit), from its edge by the compass.
    // Each row as deep as its tiles: a full row's, or - a row of the 叮 tile
    // alone, laid the other way (a new row's) - as shallow as it is, the next
    // row against it.
    const rowDeep = (l: number[]) => (l.length && l.every((i) => i === pond.riichiAt) ? (TILE_W + 0.93 - TILE_H) * T : rowDepth);
    const starts = lines.map((_, r) => sum(lines.slice(0, r).map(rowDeep)));
    // (A row's middle, as a full row's: a 叮 tile leans to its compass side.)
    const mid = (r: number) => starts[r] + rowDepth / 2;
    const depth = sum(lines.map(rowDeep)) + 0.07 * T;
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
    // Each 叮 bar's place on the felt, the pond drawn at `fit`.
    const thinAt = (fit: number) => BAR * Math.max(fit, 0.7);
    const barsAt = (fit: number) =>
      bars.map((g) => {
        const same = bars.filter((o) => o.at === g.at);
        const nth = same.indexOf(g);
        const r = lines.findIndex((l) => l.includes(g.at));
        const long = (rowDeep(lines[r]) < rowDepth ? TILE_W : TILE_H) * T * fit - 0.1 * T * fit;
        // (Across the pond from the compass toward its owner: the row's middle.)
        const deep = starts[r] * fit + (rowDeep(lines[r]) * fit) / 2;
        // Where it lies along the row (as laid out, before the pond's fitted).
        // (New row's lines: before the row, out from it - the left pond's
        // rows start at its far end, so there out past where the first tile
        // hides the felt.)
        const a = newRows ? -(0.14 * T + (side === "left" ? 0.36 * T : 0)) - nth * (BAR + SEP) - BAR / 2 : sum(lines[r].filter((j) => j < g.at).map(room)) + lead + nth * (BAR + SEP) + BAR / 2;
        let x: number;
        let y: number;
        if (side === "top") [x, y] = [centreX + (limit / 2 - a) * fit, row2y1 - deep];
        else if (side === "bottom") [x, y] = [centreX + (-limit / 2 + a) * fit, row4y0 + 0.3 * T + deep];
        else if (side === "left") [x, y] = [col2x1 - deep, midY + (-limit / 2 + a) * fit];
        else [x, y] = [col4x0 + deep, midY + (limit / 2 - a) * fit];
        return { g, x, y, long };
      });
    let fit = Math.round(Math.max(0.4, Math.min(1, free / depth)) * 100) / 100;
    // New row in yours and across's: the lines before a row start at the
    // corner, by the side pond's first tiles there (yours by the left's,
    // across's by the right's) - drawn a little smaller, step by step, till
    // they're clear of them. (A tile hides the felt just past it, away from
    // you: that's kept clear too.)
    const corner = newRows ? (side === "bottom" ? pondBoxes.left : side === "top" ? pondBoxes.right : undefined) : undefined;
    const hits = (f: number) => {
      const thin = thinAt(f);
      return barsAt(f).some((b) => {
        const [hx, hy] = side === "top" || side === "bottom" ? [thin / 2, b.long / 2] : [b.long / 2, thin / 2];
        return corner!.some((t) => b.x - hx < t.x1 + PAD && t.x0 - PAD < b.x + hx && b.y - hy < t.y1 + PAD && t.y0 - HIDE * t.em / T - PAD < b.y + hy);
      });
    };
    if (corner?.length && bars.length) while (fit > 0.4 && hits(fit)) fit = Math.round((fit - 0.01) * 100) / 100;
    const em = T * fit;
    pondBoxes[side] = [];
    pond.tiles.forEach((t, i) => {
      const r = lines.findIndex((l) => l.includes(i));
      const before = sum(lines[r].filter((j) => j < i).map(room)) + gapAt(i);
      const riichi = i === pond.riichiAt;
      // A 叮 tile, laid the other way, sits flush with its row's compass side.
      const lean = riichi ? ((TILE_H - TILE_W) / 2) * T : 0;
      let x: number;
      let y: number;
      let rot: number;
      if (side === "top") {
        const x1 = centreX + limit / 2;
        x = x1 - before - step(i) / 2;
        y = row2y1 - mid(r) + lean;
        rot = riichi ? 90 : 0;
        [x, y] = [centreX + (x - centreX) * fit, row2y1 + (y - row2y1) * fit];
      } else if (side === "bottom") {
        const x0 = centreX - limit / 2;
        x = x0 + before + step(i) / 2;
        const top0 = row4y0 + 0.3 * T;
        y = top0 + mid(r) - lean;
        rot = riichi ? 90 : 0;
        [x, y] = [centreX + (x - centreX) * fit, top0 + (y - top0) * fit];
      } else if (side === "left") {
        const y0 = midY - limit / 2;
        x = col2x1 - mid(r) + lean;
        y = y0 + before + step(i) / 2;
        rot = riichi ? 0 : 90;
        [x, y] = [col2x1 + (x - col2x1) * fit, midY + (y - midY) * fit];
      } else {
        const y1 = midY + limit / 2;
        x = col4x0 + mid(r) - lean;
        y = y1 - before - step(i) / 2;
        rot = riichi ? 0 : -90;
        [x, y] = [col4x0 + (x - col4x0) * fit, midY + (y - midY) * fit];
      }
      const turned = (side === "left" || side === "right") !== riichi;
      const m = lying(x, y, em, rot);
      const [hw, hh] = rot === 0 || rot === 180 ? [TILE_W / 2, TILE_H / 2] : [TILE_H / 2, TILE_W / 2];
      pondBoxes[side]!.push({ x0: x - hw * em, x1: x + hw * em, y0: y - hh * em, y1: y + hh * em, em });
      // The newest discard drops onto the felt from a little above and settles.
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
      felt.push({ face: faceOf(t), m, shade: turned ? TURNED : LIT, tint: 1, anim: drop, seen: `${side}:pond:${i}` });
      feltQuads.push(shadowAt(x, y, em, rot));
      // The newest discard's pin: a gold point on its thrower's side.
      if (pond.pinLast && i === pond.tiles.length - 1) {
        const pin = 0.3 * em;
        // (From its near edge - a 叮 tile, laid the other way, is shallower.)
        const half = riichi ? 0.39 * em : 0.5 * em;
        const at =
          side === "bottom"
            ? chain(translate(x, y + half + 0.075 * em, THICK * em * 0.5), scale(pin, 0.15 * em, 1))
            : side === "top"
              ? chain(translate(x, y - half - 0.075 * em, THICK * em), rotateZ(180), scale(pin, 0.15 * em, 1))
              : side === "left"
                ? chain(translate(x - half - 0.115 * em, y, THICK * em), rotateZ(90), scale(pin, 0.15 * em, 1))
                : chain(translate(x + half + 0.115 * em, y, THICK * em), rotateZ(-90), scale(pin, 0.15 * em, 1));
        feltQuads.push({ kind: "pin", m: at });
      }
    });
    // The 叮 bars, lying on the felt across the row, as deep as its tiles.
    // (They keep a width to see however small the pond is drawn.)
    const thin = thinAt(fit);
    const turn = rotateZ(side === "top" || side === "bottom" ? 0 : 90);
    for (const b of barsAt(fit)) feltQuads.push({ kind: `ding-${b.g.by}`, m: chain(translate(b.x, b.y, 0.4), turn, scale(thin, b.long, 1)) });
  };
  // (The side ponds first: yours and across's keep their New row lines
  // clear of them.)
  (["left", "right", "top", "bottom"] as const).forEach((s) => pondTiles(s, view.ponds[s]));

  // ---- The spotlight: the discard up for grabs, in a bubble standing up
  // off the felt by the compass, on its thrower's side.
  if (view.spotlight) {
    const em = d.middle;
    const from = view.spotlight.from;
    const sx = middle.x + (from === "left" ? -3.6 : from === "right" ? 3.6 : 0) * em;
    // (Above and below: 1.3em past the compass's edge, whatever its size.)
    const off = d.compass / 2 + 1.3 * em;
    const sy = middle.y + (from === "top" ? -off : from === "bottom" ? off : 0);
    const { te, bw, bh } = bubbleBox(d);
    // Stood up about its foot, lifted 1.3em, facing you square on (upright
    // as the screen is) - so a bubble off to the side shows its tile just
    // as one in the middle does, not turned, its side toward the middle -
    // popped in from half size (play-pop, 0.22s).
    const foot: [number, number, number] = [sx, sy + bh / 2, 1.3 * em];
    const facing = d.eye && d.eyeDown ? facingEye(foot, d.eye, d.eyeDown) : rotateX(-32);
    const stand = (s: number) => chain(translate(...foot), facing, scale(s, s, 1));
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
  // (Not one already taken: it's down, and long since - its place went
  // empty for a moment as it was taken, and drawn as given again its fall
  // from your hand started over.)
  const givenAt = new Map<number, number>();
  if (view.mine.given && view.piles?.bottom) {
    const left = view.mine.given.tiles.map((t, j) => ({ face: faceOf(t), j }));
    const mine = view.piles.bottom;
    mine.slots.forEach((s, i) => {
      if (!s || s === "back" || mine.taken?.[i]) return;
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
        ? chain(translate(x - 0.39 * P, y - 0.5 * P, 0), about(0.39 * P, (0.5 + TILE_H / 2) * P, 0, rotateX(-MINE_LEAN)), translate(0.39 * P, 0.5 * P, 0), scale(P))
        : lyingDown(x, y, P, rot, lift);
      const spot = { x, y, rot, standing, m: standing ? m : lyingDown(x, y, P, rot) };
      if (slot === null) {
        // Taken: its place outlined on the felt.
        // (A standing tile met the felt along its near foot: its gap is that
        // foot - from the edge it rested on, out as far as its thickness
        // shows in front of it, leaning back.)
        const foot = (0.5 + TILE_H / 2) * P;
        const deep = standing ? THICK * P * Math.sin((MINE_LEAN * Math.PI) / 180) : 0.913 * P;
        feltQuads.push({ kind: "gap", m: chain(translate(x, standing ? y - 0.5 * P + foot + deep / 2 : y, 0.5), rotateZ(rot), scale(0.72 * P, deep, 1)) });
        return spot;
      }
      // Just given: unseen till its tile has come down from your hand.
      const coming = side === "bottom" && view.mine.given && givenAt.has(i) ? view.mine.given.key : null;
      const arrive: Anim | undefined = coming === null ? undefined : { key: `give:${coming}:${i}`, delay: 0, dur: GIVE_S, pose: () => scale(0) };
      const taken = !!pile.taken?.[i];
      felt.push({ face: slot === "back" ? BACK : faceOf(slot), m, shade: rot ? TURNED : LIT, tint: taken ? POND_GREY : 1, pick: pile.pickable && !taken ? [side, i] : undefined, anim: arrive });
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
  const formations = flightGroups(view.flights.filter((f) => f.to !== "bottom")).flatMap((fs) => {
    const ok = fs.filter((f) => spots[f.from]?.[f.place] && places[f.to]?.[f.group]?.[f.slot]);
    if (!ok.length) return [];
    const from = ok.map((f) => spots[f.from]![f.place]);
    const to = ok.map((f) => places[f.to]![f.group][f.slot]);
    const a = alongLine(from, from[0].rot);
    // (Side to side, face down, they land a half turn round - see acrossTable.)
    const half = acrossTable(ok[0].from, ok[0].to) && ok.every((f) => !f.tile) ? 180 : 0;
    const b = alongLine(to, to[0].rot + half);
    const ends = ok.map((f, k): [FlightEnd, FlightEnd] => [
      { x: a.x, y: a.y, along: a.along[k], rot: from[k].rot, em: P, pitch: from[k].standing ? -54 : 0, flip: from[k].standing ? 0 : 180, tilt: 0 },
      { x: b.x, y: b.y, along: b.along[k], rot: to[k].rot + half, em: T, pitch: 0, flip: f.tile ? 0 : 180, tilt: 0 },
    ]);
    return [{ ok, from, to, ends }];
  });
  const levels = airLevels(formations.map((fm) => fm.ends), T);
  formations.forEach(({ ok, from, to, ends }, n) => {
    const lift = 1.4 * T;
    const raise = levels[n] * AIR_STEP * T;
    ok.forEach((f, k) => {
      const p = to[k];
      const [start, end] = ends[k];
      felt.push({
        face: f.tile ? faceOf(f.tile) : BACK,
        m: f.tile ? lying(p.x, p.y, T, end.rot) : lyingDown(p.x, p.y, T, end.rot),
        shade: p.rot ? TURNED : LIT,
        tint: 1,
        fly: { key: `fly:${f.id}`, from: from[k].m, dur: 0.75, lift, pose: inFormation(start, end, lift, raise) },
        ...(f.greyed ? { fade: { key: `fly:${f.id}:tint`, dur: 0.6, from: POND_GREY } } : {}),
      });
    });
  });

  const hand = layoutHand(view, d, spots, givenAt);
  seenCopies(felt, view.focus);
  seenCopies(hand.pieces, view.focus);
  safeSince(felt, view.safeSince);
  safeSince(hand.pieces, view.safeSince);
  return { felt: { pieces: felt, quads: feltQuads, glass, glassQuads, racks }, hand, middle };
}

// Turned to face the eye from `at`: its z toward the eye, its y down the
// screen as near as it can be (so it shows upright, not rolled).
function facingEye(at: [number, number, number], eye: [number, number, number], down: [number, number, number]): Mat {
  const unit = (v: number[]) => {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const z = unit([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const k = down[0] * z[0] + down[1] * z[1] + down[2] * z[2];
  const y = unit([down[0] - k * z[0], down[1] - k * z[1], down[2] - k * z[2]]);
  const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  const m = identity();
  m.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
  return m;
}

// 見牌 Seen copies: with a tile held, every tile out in the open (the ponds,
// the melds - yours too - and the bonus tiles) greyed but its copies, fading
// there and back. (Your own concealed tiles stay as they are; so does a tile
// lying face down - a concealed kong's - which shows nothing to count.)
function seenCopies(pieces: Piece[], focus: Tile | null | undefined) {
  const held = focus ? faceOf(focus) : null;
  for (const p of pieces) {
    if (!p.seen || p.face === BACK) continue;
    if (held !== null && p.face !== held) p.tint = Math.min(p.tint, POND_GREY);
    p.fade = { key: p.seen, dur: POND_FADE_S };
  }
}

// A 叮 player's plaque held: every tile in the open greyed (as 見牌 does,
// fading the same) but those thrown since its 叮 - in the ponds, and
// claimed into melds.
function safeSince(pieces: Piece[], since: GLTableView["safeSince"]) {
  if (!since) return;
  for (const p of pieces) {
    if (!p.seen || p.face === BACK || p.safe) continue;
    const at = /^(top|bottom|left|right):pond:(\d+)$/.exec(p.seen);
    if (!at || Number(at[2]) < (since[at[1] as GLSide]?.pond ?? Infinity)) p.tint = Math.min(p.tint, POND_GREY);
  }
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
function inFormation(a: FlightEnd, b: FlightEnd, lift: number, raise = 0): (v: number) => Mat {
  const rot1 = near(b.rot, a.rot);
  const flip0 = near(a.flip, b.flip);
  return (v) => {
    const up = 1 + 0.08 * Math.sin(Math.PI * v);
    const em = (a.em + (b.em - a.em) * v) * up;
    const half = (THICK * em) / 2;
    return chain(
      translate(a.x + (b.x - a.x) * v, a.y + (b.y - a.y) * v, Math.sin(Math.PI * v) * lift + raise * airRamp(v)),
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
// Formations in the air at once (a quick swap's round sets them all off
// together) whose tiles would meet - over the same spot at the same moment,
// their arcs alike - pass through each other: each flies the lowest it can
// while clearing, at that moment, every one it meets (by its height in
// tiles, `AIR_STEP` a level - risen to soon after it sets off, and kept
// till it's nearly down: see airRamp). Meeting is coming closer than a tile's
// length, and closer than the two were where they set off or where they
// land (out of one pile, or into one row, they're side by side - not in each
// other's way - unless they cross over). (In tiles: `T` a tile.)
const AIR_STEP = 0.9;
const airRamp = (v: number) => Math.min(1, Math.sin(Math.PI * v) / 0.08);
export function airLevels(fms: [FlightEnd, FlightEnd][][], T: number): number[] {
  const STEPS = 25;
  const moments = [0, ...Array.from({ length: STEPS }, (_, s) => 0.02 + (0.96 * s) / (STEPS - 1)), 1];
  // Each formation's tiles, flat on the felt, at each moment.
  const at = fms.map((ends) => {
    const poses = ends.map(([a, b]) => inFormation(a, b, 0));
    return moments.map((v) => poses.map((p) => apply(p(v), 0, 0, THICK / 2)));
  });
  const apart = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const last = moments.length - 1;
  const levels: number[] = [];
  at.forEach((mine, n) => {
    const meets = new Set<number>();
    for (let m = 0; m < n; m++)
      for (let s = 1; s < last; s++) {
        const met = mine[s].some((a, i) =>
          at[m][s].some((b, j) => apart(a, b) < Math.min(1.05 * T, 0.9 * apart(mine[0][i], at[m][0][j]), 0.9 * apart(mine[last][i], at[m][last][j])))
        );
        if (met) meets.add(levels[m]);
      }
    let l = 0;
    while (meets.has(l)) l++;
    levels.push(l);
  });
  return levels;
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
  const melds = mine.melds.map((m, i) => meldGroup(m, mine.hideConcealed, true, M, i >= (view.safeSince?.bottom?.meld ?? Infinity)));
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
      const cx = flowers.pad + 0.72 * flowers.em * ((s.col ?? k) + 0.5);
      // (Two rows: the far one on the near one's top edge, in its plane.)
      const pose = (a: number) => chain(translate(cx, ty, 0), about(0, 0.5 * flowers.em, THICK * flowers.em, rotateX(a)), scale(flowers.em), translate(0, (s.row ?? 0) < 0 ? -TILE_H : 0, 0));
      pieces.push({ face: s.face!, m: pose(32), shade: LIT, tint: 1, anim: { key: `h:f:${k}`, delay: 0, dur: 0.5, pose: (t) => pose(keyframes(MINE_FRAMES, t)[0]) }, seen: `h:f:${k}` });
    });
  }
  if (groups.length) {
    const named = flowers && !bonusOut ? ["f", ...mine.melds.map((_, i) => `m${i}`)] : mine.melds.map((_, i) => `m${i}`);
    groups.forEach((g, gi) => {
      const pitch = 0.72 * g.em;
      const ty = foot - g.pad - 0.5 * g.em;
      g.slots.forEach((s, k) => {
        const cx = x + g.pad + pitch * ((s.col ?? k) + 0.5);
        // (Turned about the foot of its face, as your standing tiles are.)
        // Laid down from standing as it's declared (0.5s).
        const pose = (a: number) => {
          const flat = chain(translate(cx, ty, 0), about(0, 0.5 * g.em, THICK * g.em, rotateX(a)));
          // (Two rows of bonus tiles: the far one on the near one's top edge, in its plane.)
          const far = translate(0, (s.row ?? 0) < 0 ? -TILE_H : 0, 0);
          return s.face ? chain(flat, scale(g.em), far) : chain(flat, translate(0, 0, THICK * g.em), rotateY(180), scale(g.em));
        };
        pieces.push({
          face: s.face ?? BACK,
          m: pose(32),
          shade: LIT,
          tint: 1,
          anim: { key: `h:${named[gi]}:${k}`, delay: 0, dur: 0.5, pose: (t) => pose(keyframes(MINE_FRAMES, t)[0]) },
          seen: `h:${named[gi]}:${k}`,
          ...(s.safe ? { safe: true } : {}),
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
  // Outside 換牌, likewise by what it is - and where, in a hand of so many -
  // so it eases only its own lift and drop: thrown, no other tile takes its
  // place lifted, and moved along the row it jumps.
  const kinds = new Map<string, number>();
  const own = (face: string, x0: number) => {
    const n = kinds.get(face) ?? 0;
    kinds.set(face, n + 1);
    return `h:${mine.tiles.length}:${face}#${n}@${Math.round(x0)}`;
  };
  // (The suits in the order the hand holds them, for its slides.)
  const suits: string[] = [];
  for (const t of mine.tiles) if (!suits.includes(t.tile?.suit ?? "")) suits.push(t.tile?.suit ?? "");
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
    // its side - the rest of your hand tipping back onto the table after
    // it, one by one.
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
      // A tile just drawn slides in from the wall's side.
      if (t.drawn) anim = { key: `h:draw:${mine.drawKey}`, delay: 0, dur: 0.32, pose: (k) => chain(translate(0.5 * H * (1 - SETTLE(k)), -0.35 * H * (1 - SETTLE(k)), 0), m) };
    }
    pieces.push({
      face: t.tile ? faceOf(t.tile) : BACK,
      m,
      shade: winner && t.winner ? TURNED : LIT,
      tint: t.barred ? 0 : 1,
      hit: i,
      anim,
      // Picked up and put back eased, not snapped (on its lift only: moved
      // along the row, it jumps - but in 換牌, slid along the row to its
      // new place).
      ease: winner
        ? undefined
        : mine.sliding
          ? // (Just after a give, once the given tiles have lifted clear of
            // their gaps; then a suit at a time, lifted past the rest - so
            // nothing passes through anything.)
            {
              key: ident(t.tile ? faceOf(t.tile) : BACK),
              dur: SLIDE_S,
              curve: SLIDE,
              delay: mine.given ? GIVE_CLEAR_S : 0,
              over: SLIDE_OVER * H,
              overDelay: suits.indexOf(t.tile?.suit ?? "") * SUIT_STEP_S,
            }
          : { key: own(t.tile ? faceOf(t.tile) : BACK, x0), dur: 0.16, curve: SETTLE },
    });
    // Hints: the bots' pick underlined in gold; a risky tile barred in red.
    // Each in its tile's own face plane, leant back with it - drawn flat in
    // front of the row, the perspective put them off centre (most at the
    // row's ends, and the red bar over the leant-back top furthest).
    // (The gold one on the face's foot margin, just proud of it: below the
    // tile it was all but hidden under the bar beneath the table.)
    const bar = (y: number, w: number, proud = 0) => chain(translate(x0, y0, 0), about(0.39 * H, H, THICK * H, rotateX(-22)), translate(0.39 * H, y, (THICK + proud) * H), scale(w, 0.06 * H, 1));
    // A tile that would leave you ready (聽 Waits): a yellow triangle over
    // it, pointing down at it - over the red bar's place while hints are on
    // (in a row, whichever tiles are barred red).
    const tri = 0.3 * H;
    if (t.ready) quads.push({ kind: "ready", m: chain(translate(x0, y0, 0), about(0.39 * H, H, THICK * H, rotateX(-22)), translate(0.39 * H, (mine.hints ? -0.2 : -0.07) * H - tri / 2, THICK * H), scale(tri, tri, 1)) });
    if (t.hint) quads.push({ kind: "hint", m: bar(0.935 * H, 0.78 * H * 0.64, 0.012) });
    if (t.danger) quads.push({ kind: "danger", m: bar(-0.13 * H, 0.78 * H * 0.7) });
  });
  // No tile drawn: its place kept.
  if (mine.tiles.length && !mine.tiles.some((t) => t.drawn) && !winner) x += 0.3 * H + 0.746 * H;
  // In 換牌 the row keeps a full hand's room - it's centred, and re-centred
  // as tiles leave it every tile would jump. (Worked out from the hand
  // each time, never remembered: a width kept from an earlier moment - the
  // screen still settling as Play opens - left the row off centre.)
  const short = mine.sliding && !winner ? Math.max(0, FULL_HAND - mine.tiles.filter((t) => !t.drawn).length) : 0;
  const width = x + short * 0.75 * H;
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
          ...(f.greyed ? { fade: { key: `fly:${f.id}:tint`, dur: 0.6, from: POND_GREY } } : {}),
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
