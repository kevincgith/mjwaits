// The Dice tab's tables in Play's WebGL (see FeltGL and diceScenes) -
// loaded on their own, with three.js, when the tab first shows one. Each
// has its dice on it, as real cubes (see dice.ts): thrown onto the felt,
// or (set by hand) lying across where they land.

import { useRef, type RefObject } from "react";
import { FeltGL, type FeltScene } from "./FeltGL";
import { laidDice, diceScene, throwDice, type Box, type Thrown } from "./dice";
import { seatsScene, wallFence, wallScene, type SeatsTable, type WallBreakAt } from "./diceScenes";

export type { SeatsTable, WallBreakAt };

// The dice on a table: what they show, and whether they were thrown
// (`key` new for each throw - and for each change by hand).
export interface DiceOnTable {
  key: string;
  values: number[];
  thrown: boolean;
}

// A die's size, against the felt's width.
const DIE_SIZE = 0.105;
// Where they come to rest (fractions of the felt): inside the wall; below
// the six tiles, clear of the players round the edge.
const WALL_LAND: Box = { l: 0.32, t: 0.32, r: 0.68, b: 0.68 };
const SEAT_LAND: Box = { l: 0.18, t: 0.46, r: 0.82, b: 0.76 };

// The throw for `dice`, made once (by its key) at the felt's width then.
function useDice(dice: DiceOnTable | null, land: Box, fence?: (w: number) => [number, number][]) {
  const made = useRef<Thrown | null>(null);
  return (w: number): FeltScene => {
    if (!dice) return { pieces: [], quads: [] };
    if (made.current?.key !== dice.key) {
      const box = { l: land.l * w, t: land.t * w, r: land.r * w, b: land.b * w };
      const still = !dice.thrown || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const o = { key: dice.key, width: w, land: box, size: DIE_SIZE * w, values: dice.values };
      made.current = still ? laidDice(o) : throwDice({ ...o, fence: fence?.(w) });
    }
    const { dice: cubes, quads } = diceScene(made.current, w);
    return { pieces: [], quads, dice: cubes };
  };
}

const withDice = (a: FeltScene, b: FeltScene): FeltScene => ({ pieces: a.pieces, quads: [...b.quads, ...a.quads], dice: b.dice });

export function SeatTilesGL({ feltRef, table, dice }: { feltRef: RefObject<HTMLElement | null>; table: SeatsTable; dice: DiceOnTable | null }) {
  const onTable = useDice(dice, SEAT_LAND);
  return <FeltGL feltRef={feltRef} scene={(w) => withDice(seatsScene(w, table), onTable(w))} look={`${JSON.stringify(table)}|${dice?.key ?? ""}`} />;
}

export function WallTilesGL({ feltRef, brk, dice }: { feltRef: RefObject<HTMLElement | null>; brk: WallBreakAt | null; dice: DiceOnTable | null }) {
  const onTable = useDice(dice, WALL_LAND, wallFence);
  return <FeltGL feltRef={feltRef} scene={(w) => withDice(wallScene(w, brk), onTable(w))} look={`${brk ? `${brk.side}${brk.gapAfter}` : ""}|${dice?.key ?? ""}`} />;
}
