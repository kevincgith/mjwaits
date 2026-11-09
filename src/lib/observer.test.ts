import { describe, expect, it } from "vitest";
import { applyTurnMove, botTurnMove, dealHand } from "@mjwaits/shared/engine/game";
import { viewFor } from "@mjwaits/shared/engine/view";
import { observedView, seatsSeen } from "./observer";
import { seatState } from "./seatState";

// A hand a few turns in, as the server sends it to an observer.
function table() {
  let s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
  if (s.phase.kind === "turn") s = applyTurnMove(s, botTurnMove(s));
  return s;
}

describe("what an observer's view shows", () => {
  it("names the seats each view shows", () => {
    expect(seatsSeen({ mode: "pov", seat: 3 })).toEqual([3]);
    expect(seatsSeen({ mode: "corner", seat: 3 })).toEqual([3, 0]);
    expect(seatsSeen({ mode: "god", seat: 3 })).toEqual([0, 1, 2, 3]);
  });

  it("shows from a seat just what that seat's player is sent", () => {
    const s = table();
    for (let seat = 0; seat < 4; seat++) {
      const seen = observedView(viewFor(s, -1, () => true, true), { mode: "pov", seat });
      const player = viewFor(s, seat);
      expect(seen.you).toBe(seat);
      expect(seen.players.map((p) => p.hand)).toEqual(player.players.map((p) => p.hand));
      expect(seen.players.map((p) => p.melds)).toEqual(player.players.map((p) => p.melds));
      expect(seen.phase).toEqual(player.phase);
    }
  });

  it("shows two neighbours from a corner, and every hand in god mode, the chosen seat at the bottom", () => {
    const all = viewFor(table(), -1, () => true, true);
    const corner = observedView(all, { mode: "corner", seat: 3 });
    expect(corner.players.map((p) => p.hand !== null)).toEqual([true, false, false, true]);
    const god = observedView(all, { mode: "god", seat: 2 });
    expect(god.players.every((p) => p.hand !== null)).toBe(true);
    expect(seatState(god).toTable(0)).toBe(2);
  });
});
