// Watching an online table that lets its observers see every tile: the server
// sends this phone all four hands, and how much of it is shown is this screen's
// choice - from one player's seat, from the corner between two, or all of it.

import type { GameState } from "@mjwaits/shared/engine/game";
import { allTileKinds, tileKey, type Tile } from "@mjwaits/shared/engine/mahjong";
import type { MeldView, SeatView, TableView } from "@mjwaits/shared/engine/view";

export type ObserveMode = "pov" | "corner" | "god";
export interface Observe {
  mode: ObserveMode;
  seat: number; // table seat at the bottom (corner: where the camera starts, this seat at the lower left, the next at the lower right)
}

// The table seats whose hands this view has. (The corner camera has them
// all: it can be moved, and which faces it sees is down to where it is.)
export const seatsSeen = ({ mode, seat }: Observe): number[] => (mode === "pov" ? [seat] : [0, 1, 2, 3]);

const hidden = (m: MeldView): MeldView => ("hidden" in m || !(m.kind === "kong" && m.concealed) ? m : { kind: "kong", concealed: true, hidden: true, from: null });

function closed(p: SeatView): SeatView {
  const { overWater: _overWater, passedPung: _passedPung, threw: _threw, ...rest } = p;
  return {
    ...rest,
    hand: null,
    melds: p.melds.map(hidden),
    ...(p.riichi ? { riichi: { state: p.riichi.state, discard: p.riichi.discard, ippatsu: p.riichi.ippatsu } } : {}),
  };
}

// The whole table as this view shows it: `you` is the seat at the bottom, and
// a hand this view doesn't show is closed up as it would be for a player
// (until the hand's over, when an observer sees them all).
export function observedView(view: TableView, observe: Observe): TableView {
  const seen = seatsSeen(observe);
  const shows = (seat: number) => view.phase.kind === "over" || seen.includes(seat);
  const ph = view.phase;
  return {
    ...view,
    you: observe.seat,
    players: view.players.map((p, seat) => (shows(seat) ? p : closed(p))),
    phase:
      ph.kind === "turn" && !seen.includes(ph.seat)
        ? { kind: "turn", seat: ph.seat, drawn: null, ...(ph.drew ? { drew: true as const } : {}), replacement: ph.replacement, ...(ph.chain ? { chain: ph.chain } : {}) }
        : ph.kind === "swap"
          ? { ...ph, piles: ph.piles.map((pile, seat) => (pile && !seen.includes(seat) ? pile.map((t) => (t ? ("back" as const) : null)) : pile)) }
          : ph,
  };
}

// With every hand open, what's left to come: each kind's copies not in a hand,
// a meld, a discard or a 換牌 pile.
export function wallCounts(s: GameState): Map<string, number> {
  const counts = new Map<string, number>(allTileKinds().map((k) => [tileKey(k), 4]));
  const see = (t: Tile) => {
    const left = counts.get(tileKey(t));
    if (left !== undefined) counts.set(tileKey(t), left - 1);
  };
  for (const p of s.players) {
    p.hand.forEach(see);
    p.discards.forEach(see);
    p.melds.forEach((m) => m.tiles.forEach(see));
  }
  if (s.phase.kind === "swap") for (const pile of s.phase.piles) pile?.forEach((t) => t && see(t));
  return counts;
}

// The view last chosen on this phone, for coming back to.
const OBSERVE_KEY = "mjwaits.observe";
const DEFAULT_OBSERVE: Observe = { mode: "god", seat: 0 };

export function loadObserve(): Observe {
  try {
    const o = JSON.parse(localStorage.getItem(OBSERVE_KEY) ?? "null") as Partial<Observe> | null;
    if (o && (o.mode === "pov" || o.mode === "corner" || o.mode === "god") && (o.seat === 0 || o.seat === 1 || o.seat === 2 || o.seat === 3)) return { mode: o.mode, seat: o.seat };
  } catch {
    // Unreadable or blocked: the first view it is.
  }
  return DEFAULT_OBSERVE;
}

export function saveObserve(o: Observe): void {
  try {
    localStorage.setItem(OBSERVE_KEY, JSON.stringify(o));
  } catch {
    // Storage full or blocked: it only won't be remembered.
  }
}

// Whether this phone has moved the corner camera yet (until it has, the table says how).
const DRAGGED_KEY = "mjwaits.cornerDragged";

export function cornerDragged(): boolean {
  try {
    return localStorage.getItem(DRAGGED_KEY) === "1";
  } catch {
    return false;
  }
}

export function noteCornerDragged(): void {
  try {
    localStorage.setItem(DRAGGED_KEY, "1");
  } catch {
    // As above.
  }
}
