// The Dice tab's tables in Play's WebGL (see FeltGL and diceScenes) -
// loaded on their own, with three.js, when the tab first shows one.

import type { RefObject } from "react";
import { FeltGL } from "./FeltGL";
import { seatsScene, wallScene, type SeatsTable, type WallBreakAt } from "./diceScenes";

export type { SeatsTable, WallBreakAt };

export function SeatTilesGL({ feltRef, table }: { feltRef: RefObject<HTMLElement | null>; table: SeatsTable }) {
  return <FeltGL feltRef={feltRef} scene={(w) => seatsScene(w, table)} />;
}

export function WallTilesGL({ feltRef, brk }: { feltRef: RefObject<HTMLElement | null>; brk: WallBreakAt | null }) {
  return <FeltGL feltRef={feltRef} scene={(w) => wallScene(w, brk)} />;
}
