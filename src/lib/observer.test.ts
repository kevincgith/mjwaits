import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTurnMove, botTurnMove, dealHand } from "@mjwaits/shared/engine/game";
import { viewFor } from "@mjwaits/shared/engine/view";
import { loadObserve, observedView, saveObserve, seatsSeen, wallCounts } from "./observer";
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
    expect(seatsSeen({ mode: "corner", seat: 3 })).toEqual([0, 1, 2, 3]);
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

  it("has every hand from the corner and in god mode, the chosen seat at the bottom", () => {
    const all = viewFor(table(), -1, () => true, true);
    const corner = observedView(all, { mode: "corner", seat: 3 });
    expect(corner.players.every((p) => p.hand !== null)).toBe(true);
    const god = observedView(all, { mode: "god", seat: 2 });
    expect(god.players.every((p) => p.hand !== null)).toBe(true);
    expect(seatState(god).toTable(0)).toBe(2);
  });
});

describe("an observer's tile count", () => {
  it("counts only what's in no one's hand, with every hand open", () => {
    const s = table();
    const left = [...wallCounts(s).values()].reduce((a, b) => a + b, 0);
    const out = s.players.reduce((n, p) => n + p.hand.length + p.discards.length + p.melds.reduce((m, x) => m + x.tiles.length, 0), 0);
    expect(left).toBe(136 - out);
  });
});

describe("remembering an observer's view", () => {
  const stubbed = (raw: string | null) => {
    const store = new Map(raw === null ? [] : [["mjwaits.observe", raw]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("comes back to the view chosen", () => {
    stubbed(null);
    saveObserve({ mode: "corner", seat: 2 });
    expect(loadObserve()).toEqual({ mode: "corner", seat: 2 });
  });

  it("starts from all hands, with nothing or nonsense saved", () => {
    for (const raw of [null, "not json", JSON.stringify({ mode: "x", seat: 1 }), JSON.stringify({ mode: "pov", seat: 9 })]) {
      stubbed(raw);
      expect(loadObserve()).toEqual({ mode: "god", seat: 0 });
    }
  });
});
