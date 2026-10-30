// What Play 2.0's WebGL table draws: the tiles on the table, as PlayPanel
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
}

export interface GLTableView {
  walls: { right: GLWall; top: GLWall; left: GLWall };
  ponds: Record<GLSide, GLPond>;
  mine: GLMine;
  // The discard up for grabs, in its bubble by the compass.
  spotlight: { tile: Tile; from: GLSide; key: string } | null;
}
