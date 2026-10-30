// 換牌 on the WebGL table: which place in the taker's row each tile goes to,
// and the order the givers' groups lie along that row - chosen so a take's
// tiles fly as formations that never cross or touch (see layout.ts): each
// giver's tiles keep their order along their line, from pile to row, and
// the groups lie along the row in the order their piles do.
import type { GLSide } from "./types";

// Which way, along a tile's own x, a pile's places run (top: right to left),
// and a row's places (across's row runs right to left).
const pileRuns = (s: GLSide) => (s === "top" ? -1 : 1);
const rowRuns = (s: GLSide) => (s === "top" ? -1 : 1);

// A giver's pile places, in the order they take the row's places.
export function swapSlots(from: GLSide, to: GLSide, places: number[]): number[] {
  const along = [...places].sort((a, b) => pileRuns(from) * (a - b));
  return rowRuns(to) > 0 ? along : along.reverse();
}

// Where each pile lies about the middle, and which way each row's groups run.
const PILE: Record<GLSide, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const ROW: Record<GLSide, [number, number]> = { bottom: [1, 0], top: [-1, 0], left: [0, 1], right: [0, -1] };

// The givers in the order their groups lie along the taker's row.
export function giverOrder<T>(to: GLSide, givers: { side: GLSide; key: T }[]): T[] {
  const at = (s: GLSide) => PILE[s][0] * ROW[to][0] + PILE[s][1] * ROW[to][1];
  return [...givers].sort((a, b) => at(a.side) - at(b.side)).map((g) => g.key);
}
