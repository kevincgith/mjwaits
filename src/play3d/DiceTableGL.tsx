// The Dice tab's tables in Play's WebGL (see FeltGL and diceScenes) -
// loaded on their own, with three.js, when the tab first shows one. Each
// has its dice on it, as real cubes (see dice.ts): thrown onto the felt,
// or (set by hand) lying across where they land.

import { useRef, type RefObject } from "react";
import { FeltGL, type FeltScene } from "./FeltGL";
import { laidDice, diceScene, throwDice, THROW_FPS, type Block, type Box, type Thrown } from "./dice";
import { cardBlocks, cardsScene, paintCardFaces, type SeatCard } from "./cards";
import { seatsScene, tileBlocks, wallFence, wallScene, type SeatsTable, type WallBreakAt } from "./diceScenes";

export type { SeatCard, SeatsTable, WallBreakAt };

// The dice on a table: what they show, and whether they were thrown
// (`key` new for each throw - and for each change by hand).
export interface DiceOnTable {
  key: string;
  values: number[];
  thrown: boolean;
}

// A die's size, against the felt's width.
const DIE_SIZE = 0.105;
// Where they're thrown (fractions of the felt): inside the wall; below the
// six tiles. 座位's may roll on anywhere below the tiles - the table's edge
// is solid all round (RIM in from it), and they bounce off it.
const WALL_LAND: Box = { l: 0.32, t: 0.32, r: 0.68, b: 0.68 };
const SEAT_LAND: Box = { l: 0.18, t: 0.46, r: 0.82, b: 0.76 };
const SEAT_KEEP: Box = { l: 0, t: 0.42, r: 1, b: 1 };
const RIM = 0.012;

// Told, as a throw's made, how long till its dice lie still (ms) - so the
// roll above the table ends as they do.
type OnThrown = (key: string, ms: number) => void;

// The throw for `dice`, made once (by its key) at the felt's width then:
// aimed at `land`, to rest in `keep`; inside `fence` and off `blocks`, if
// there are any.
interface Aim {
  land: Box;
  keep?: Box;
  fence?: (w: number) => [number, number][];
  blocks?: (w: number) => Block[];
}
function useDice(dice: DiceOnTable | null, { land, keep, fence, blocks }: Aim, onThrown?: OnThrown) {
  const made = useRef<Thrown | null>(null);
  return (w: number): FeltScene => {
    if (!dice) return { pieces: [], quads: [] };
    if (made.current?.key !== dice.key) {
      const px = (b: Box) => ({ l: b.l * w, t: b.t * w, r: b.r * w, b: b.b * w });
      const box = px(land);
      const still = !dice.thrown || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const o = { key: dice.key, width: w, land: box, size: DIE_SIZE * w, values: dice.values };
      made.current = still ? laidDice(o) : throwDice({ ...o, keep: keep && px(keep), fence: fence?.(w), blocks: blocks?.(w), rim: RIM * w });
      if (!still) onThrown?.(dice.key, (Math.max(...made.current.paths.map((p) => p.length - 1)) / THROW_FPS) * 1000);
    }
    const { dice: cubes, quads } = diceScene(made.current, w);
    return { pieces: [], quads, dice: cubes };
  };
}

const withDice = (a: FeltScene, b: FeltScene): FeltScene => ({ ...a, quads: [...b.quads, ...a.quads], dice: b.dice });

// 座位: the six tiles, the players' name plaques at their seats (East's with
// its gold corner), and the dice (which bounce off them and the tiles).
export function SeatTilesGL({ feltRef, table, cards, dice, onThrown }: { feltRef: RefObject<HTMLElement | null>; table: SeatsTable; cards: SeatCard[]; dice: DiceOnTable | null; onThrown?: OnThrown }) {
  const onTable = useDice(dice, { land: SEAT_LAND, keep: SEAT_KEEP, blocks: (w) => [...cardBlocks(w, cards), ...tileBlocks(seatsScene(w, table).pieces)] }, onThrown);
  // The cards' faces: painted again only when a name, colour or East changes.
  const faces = useRef<{ canvas: HTMLCanvasElement; painted: string } | null>(null);
  const shown = JSON.stringify(cards.map((c) => [c.name, c.color, c.east]));
  const facesNow = () => {
    faces.current ??= { canvas: document.createElement("canvas"), painted: "" };
    if (faces.current.painted !== shown) {
      paintCardFaces(faces.current.canvas, cards);
      faces.current.painted = shown;
    }
    return faces.current.canvas;
  };
  const scene = (w: number): FeltScene => {
    const tiles = seatsScene(w, table);
    const onFelt = cardsScene(w, cards);
    return withDice({ pieces: tiles.pieces, quads: [...onFelt.quads, ...tiles.quads], props: onFelt.props, cardFaces: facesNow() }, onTable(w));
  };
  return <FeltGL feltRef={feltRef} scene={scene} look={`${JSON.stringify(table)}|${JSON.stringify(cards)}|${dice?.key ?? ""}`} />;
}

export function WallTilesGL({ feltRef, brk, dice, onThrown }: { feltRef: RefObject<HTMLElement | null>; brk: WallBreakAt | null; dice: DiceOnTable | null; onThrown?: OnThrown }) {
  const onTable = useDice(dice, { land: WALL_LAND, fence: wallFence }, onThrown);
  return <FeltGL feltRef={feltRef} scene={(w) => withDice(wallScene(w, brk), onTable(w))} look={`${brk ? `${brk.side}${brk.gapAfter}` : ""}|${dice?.key ?? ""}`} />;
}
