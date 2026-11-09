// Watching an online table that lets its observers see every tile: the server
// sends this phone all four hands, and how much of it is shown is this screen's
// choice - from one player's seat, from the corner between two, or all of it.

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
