// What Play's WebGL table draws: the tiles on the table, as PlayPanel
// works them out from the game - nothing of three.js, so the panel can
// build it without loading the renderer.

import type { GameMeld } from "@mjwaits/shared/engine/game";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import type { BonusTile } from "@mjwaits/shared/engine/scoring";

export type GLSide = "bottom" | "right" | "top" | "left";

// Another seat's tiles: its standing hand (laid down at the end), and its
// melds and bonus tiles in front of it - as HandTiles, Melds and Flowers have them.
export interface GLWall {
  count: number;
  tiles: Tile[] | null;
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
}

// One of your concealed tiles - null when it's face down (watching, not seated).
export interface GLHandTile {
  tile: Tile | null;
  drawn: boolean;
  selected: boolean;
  hint: boolean;
  danger: boolean;
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
  // Yours, just given: places still waiting for their tile.
  arriving: number[];
  // Tappable on your take.
  pickable: boolean;
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
}

export interface GLTableView {
  walls: { right: GLWall; top: GLWall; left: GLWall };
  ponds: Record<GLSide, GLPond>;
  mine: GLMine;
  // The discard up for grabs, in its bubble by the compass.
  spotlight: { tile: Tile; from: GLSide; key: string } | null;
  // 換牌, while it's on.
  piles: Partial<Record<GLSide, GLPile>> | null;
  rows: Partial<Record<GLSide, GLSwapRow>>;
  flights: GLFlight[];
}
