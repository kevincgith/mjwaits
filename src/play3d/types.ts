// What Play's WebGL table draws: the tiles on the table, as PlayPanel
// works them out from the game - nothing of three.js, so the panel can
// build it without loading the renderer.

import type { GameMeld } from "@mjwaits/shared/engine/game";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import type { BonusTile } from "@mjwaits/shared/engine/scoring";

export type GLSide = "bottom" | "right" | "top" | "left";
export type PeekSide = Exclude<GLSide, "bottom">;

// The corner camera (an observer's view): `yaw` how far the table is turned,
// `tilt` how far its plane is laid back, both in degrees. It starts at the
// corner between two seats; dragging moves it (see TableGL).
export interface CornerCamera {
  yaw: number;
  tilt: number;
}
export const CORNER_YAW = 45;
export const CORNER_TILT = 62;
export const CORNER_TILT_MIN = 30;
export const CORNER_TILT_MAX = 80;

// Another seat's tiles: its standing hand (laid down at the end), and its
// melds and bonus tiles in front of it - as HandTiles, Melds and Flowers have them.
export interface GLWall {
  count: number;
  tiles: Tile[] | null;
  // What a peek's seen of this seat's concealed kongs, and whether a peek at
  // it is on now (each one's top tile turned up).
  glassKongs?: Tile[][];
  peekOpen?: boolean;
  // Which tile they've just drawn, when the corner camera has their hand.
  drawnTile?: Tile | null;
  drew: boolean;
  down: boolean;
  winningTile: Tile | null;
  melds: GameMeld[];
  hideConcealed: boolean;
  flowers: BonusTile[];
  // The side walls' size, grown into the room their melds leave (sideWallGrow).
  wallGrow: number;
  // When the hand tips over as it's laid down (seconds): from `at`, each
  // tile `step` after the last, each taking `dur` (TOPPLE_* in PlayPanel).
  topple: { at: number; step: number; dur: number };
}

export interface GLPond {
  tiles: Tile[];
  riichiAt?: number;
  pinLast: boolean;
  // Where each 叮 fell in this pond - before tile `at` (its own: its
  // declaring tile, the first of the 叮) - by whose side declared it, and how
  // they're shown: a bar in its colour (GLTableView.dingColours) on that
  // seam, or the tiles since on a new row, the bar down its start.
  dings?: { at: number; by: GLSide }[];
  dingMark?: "bar" | "row";
}

// One of your concealed tiles - null when it's face down (watching, not seated).
export interface GLHandTile {
  tile: Tile | null;
  drawn: boolean;
  selected: boolean;
  hint: boolean;
  danger: boolean;
  // 聽 Waits: throwing it would leave you ready - a yellow triangle over it
  // (over where hints' red bar goes, while hints are on: see GLMine.hints).
  ready?: boolean;
  barred: boolean;
  winner: boolean;
  // Whether a tap on it does anything (your turn, or picking for 換牌).
  enabled: boolean;
}

export interface GLMine {
  tiles: GLHandTile[];
  melds: GameMeld[];
  hideConcealed: boolean;
  flowers: BonusTile[];
  toppled: boolean;
  // Changes with every tile drawn, so each one slides in.
  drawKey: string;
  // A won hand: how long the winning tile is shown before the rest go down.
  winLead: number;
  // Hints on: the red bar's place over your tiles is kept for it.
  hints?: boolean;
  // 換牌 under way: tiles leaving and joining your hand slide to their new
  // places rather than jump.
  sliding: boolean;
  // Your give, just made: the tiles you gave and where they stood in your
  // hand (of `count` tiles) - each flies down to your pile.
  given: { key: number; tiles: Tile[]; from: number[]; count: number } | null;
}

// 換牌: a seat's pile where its discards go - each place a tile face down
// ("back"), a face (yours, standing so you see what each player takes),
// or null where one's been taken.
export interface GLPile {
  slots: (Tile | "back" | null)[];
  standing: boolean;
  picked: number[];
  // Tappable on your take.
  pickable: boolean;
  // Quick swap: places taken this round, their tiles still lying there -
  // greyed, and no longer to be picked.
  taken?: boolean[];
}

// What a seat's taken this round, in a row by its hand: a group per giver,
// each place shown once its tile has landed (a face, or face down).
export interface GLSwapRow {
  groups: { tiles: (Tile | null)[]; shown: boolean[] }[];
}

// A taken tile flying from its pile to its place in the taker's row.
export interface GLFlight {
  id: number;
  from: GLSide;
  place: number;
  to: GLSide;
  group: number; // its giver's group in that row, as laid out
  slot: number; // its place in that group
  tile: Tile | null; // face down when null
  flip: boolean; // face down where it lay, face up where it lands
  greyed?: boolean; // quick swap: greyed where it lay, brightening as it flies
}

export interface GLTableView {
  walls: { right: GLWall; top: GLWall; left: GLWall };
  ponds: Record<GLSide, GLPond>;
  // Each side's colour for its 叮's bars (its avatar's, or its own).
  dingColours?: Record<GLSide, string>;
  mine: GLMine;
  // The discard up for grabs, in its bubble by the compass.
  spotlight: { tile: Tile; from: GLSide; key: string } | null;
  // 換牌, while it's on.
  piles: Partial<Record<GLSide, GLPile>> | null;
  rows: Partial<Record<GLSide, GLSwapRow>>;
  flights: GLFlight[];
  // Peeking allowed (after your 叮): which rack a finger's on and the place
  // along it, and that seat's tiles once they've come. `closing`: let go,
  // the tiles settling back.
  peek?: { side: PeekSide | null; at: number; tiles: Tile[] | null; closing?: boolean };
  // An observer's free camera: the whole table turned and laid back, every
  // hand standing at its edge (the seat that's usually your row, here, is one
  // more wall).
  corner?: { bottom: GLWall };
  // 見牌 Seen copies: the tile you're holding - every other tile out in the
  // open (ponds, melds, bonus tiles) greyed, so its copies stand out.
  focus?: Tile | null;
  // A 叮 player's plaque held: every tile out in the open greyed but those
  // thrown since its 叮 - each pond's from this tile on - safe against it.
  safeSince?: Partial<Record<GLSide, number>> | null;
}
