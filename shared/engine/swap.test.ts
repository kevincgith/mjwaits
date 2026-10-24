import { describe, expect, it } from "vitest";
import { dealHand, nextHand, swapGive, swapTake, takersAfter, type GameState } from "./game";
import { seededRng } from "./bots";
import { blindPicks, botGive, botSplit, checkTake, DEFAULT_SWAP_RULES, pileLeft, splitsFor, type SwapRules } from "./swap";
import { tileKey, type Tile } from "./mahjong";

const EVERY_ROUND: SwapRules = { ...DEFAULT_SWAP_RULES, winds: [1, 2, 3, 4] };

// Plays the swapping out the way the bots do.
function swapAll(state: GameState, rng: () => number): GameState {
  let s = state;
  for (let guard = 0; s.phase.kind === "swap" && guard < 100; guard++) {
    const ph = s.phase;
    if (ph.stage === "give") {
      const seat = ph.piles.findIndex((p) => !p);
      s = swapGive(s, seat, botGive(s.players[seat].hand, ph.count, rng), rng);
    } else {
      const sizes = ph.piles.map(pileLeft);
      const split = botSplit(sizes, ph.taker, takersAfter(ph, s.dealer), ph.count, rng);
      s = swapTake(s, ph.taker, ph.piles.map((p, g) => blindPicks(p!, split[g], rng)));
    }
  }
  return s;
}

const allTiles = (s: GameState) =>
  [...s.players.flatMap((p) => [...p.hand.map(tileKey), ...p.flowers.map((f) => JSON.stringify(f))]), ...s.wall.map((w) => ("bonus" in w ? JSON.stringify(w.bonus) : tileKey(w.tile)))].sort();

describe("換牌 at the deal", () => {
  it("deals 16 each and waits on the dice on a round that swaps", () => {
    const s = dealHand({ dealer: 2, roundWind: 2, dealerStreak: 0, swapRules: DEFAULT_SWAP_RULES }, undefined, seededRng(1));
    expect(s.phase.kind).toBe("swap");
    expect(s.players.map((p) => p.hand.length)).toEqual([16, 16, 16, 16]);
    if (s.phase.kind !== "swap") return;
    expect(s.phase.rounds).toBe(DEFAULT_SWAP_RULES.rounds[s.phase.dice[0] - 1]);
    expect(s.phase.count).toBe(DEFAULT_SWAP_RULES.tiles[s.phase.dice[1] - 1]);
    expect(s.phase.taker).toBe(2);
  });

  it("deals as usual on a round that doesn't", () => {
    const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0, swapRules: DEFAULT_SWAP_RULES }, undefined, seededRng(1));
    expect(s.phase.kind).toBe("turn");
  });

  it("plays out to the dealer's first draw, every tile accounted for", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = seededRng(seed);
      const dealt = dealHand({ dealer: seed % 4, roundWind: 3, dealerStreak: 0, swapRules: EVERY_ROUND }, undefined, rng);
      const before = allTiles(dealt);
      const s = swapAll(dealt, rng);
      expect(s.phase.kind).toBe("turn");
      if (s.phase.kind !== "turn") continue;
      expect(s.phase.seat).toBe(s.dealer);
      expect(s.players.map((p, i) => p.hand.length - (i === s.dealer ? 1 : 0))).toEqual([16, 16, 16, 16]);
      expect(allTiles(s)).toEqual(before);
    }
  });

  it("carries the settings to the next hand", () => {
    const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0, swapRules: EVERY_ROUND }, undefined, seededRng(4));
    const over: GameState = { ...swapAll(s, seededRng(5)), phase: { kind: "over", result: { winner: null, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] } } };
    expect(nextHand(over, undefined, seededRng(6)).phase.kind).toBe("swap");
  });

  it("refuses a take out of turn or against the rules", () => {
    let s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0, swapRules: { ...EVERY_ROUND, tiles: [3, 3, 3, 3, 3, 3] } }, undefined, seededRng(2));
    for (let seat = 0; seat < 4; seat++) s = swapGive(s, seat, s.players[seat].hand.slice(0, 3));
    expect(() => swapTake(s, 1, [[0], [], [0], [0]])).toThrow();
    expect(() => swapTake(s, 0, [[0], [0, 1], [0], []])).toThrow();
    const took = swapTake(s, 0, [[], [0], [0], [0]]);
    expect(took.phase).toMatchObject({ kind: "swap", taker: 1 });
    // The places taken stay, empty; nothing moves up.
    if (took.phase.kind !== "swap" || s.phase.kind !== "swap") return;
    expect(took.phase.piles[1]).toEqual([null, ...s.phase.piles[1]!.slice(1)]);
    expect(() => swapTake(took, 1, [[0], [], [0], [1]])).toThrow(/No tile there/);
    expect(() => swapTake(took, 1, [[0], [], [1], [1]])).not.toThrow();
  });
});

describe("taking from the piles", () => {
  it("takes at least one from everyone else, never from your own", () => {
    for (const split of splitsFor([5, 5, 5, 5], 0, 5)) {
      expect(split[0]).toBe(0);
      expect(Math.min(split[1], split[2], split[3])).toBeGreaterThanOrEqual(1);
    }
    expect(checkTake([5, 5, 5, 5], 0, [1, 2, 3], 5, [0, 0, 2, 3]).ok).toBe(false);
    expect(checkTake([5, 5, 5, 5], 0, [1, 2, 3], 5, [1, 1, 1, 2]).ok).toBe(false);
  });

  it("takes evenly without a word, lopsided with a warning", () => {
    expect(checkTake([5, 5, 5, 5], 0, [1, 2, 3], 5, [0, 1, 2, 2])).toEqual({ ok: true });
    const lop = checkTake([5, 5, 5, 5], 0, [1, 2, 3], 5, [0, 1, 1, 3]);
    expect(lop.ok).toBe(true);
    expect(lop.warning).toMatch(/Lopsided/);
  });

  it("warns of a take that leaves someone after a lopsided one", () => {
    // After the dealer took 0,2,1,2 from piles of 5: an even take here still
    // leaves the next two no even way through.
    const c = checkTake([5, 3, 4, 3], 1, [2, 3], 5, [2, 0, 1, 2]);
    expect(c.ok).toBe(true);
    expect(c.warning).toMatch(/leaves someone after you/);
  });

  it("takes exactly the same from each when the count shares out", () => {
    expect(checkTake([6, 6, 6, 6], 0, [1, 2, 3], 6, [0, 2, 2, 2])).toEqual({ ok: true });
    expect(checkTake([6, 6, 6, 6], 0, [1, 2, 3], 6, [0, 1, 2, 3])).toEqual({ ok: false, error: "Take 2 from each" });
    expect(checkTake([6, 6, 6, 6], 0, [1, 2, 3], 6, [0, 1, 1, 4]).ok).toBe(false);
    expect(splitsFor([6, 6, 6, 6], 1, 6)).toEqual([[2, 0, 2, 2]]);
    // 5 doesn't share out: lopsided is still only frowned on.
    expect(checkTake([5, 5, 5, 5], 0, [1, 2, 3], 5, [0, 1, 1, 3]).ok).toBe(true);
  });

  it("refuses a take that leaves someone after unable to take from everyone", () => {
    expect(checkTake([1, 1, 2, 2], 2, [3], 3, [1, 1, 0, 1]).ok).toBe(false);
  });

  it("bots take evenly when they can", () => {
    const rng = seededRng(9);
    for (let i = 0; i < 50; i++) {
      const split = botSplit([5, 5, 5, 5], 0, [1, 2, 3], 5, rng);
      expect(checkTake([5, 5, 5, 5], 0, [1, 2, 3], 5, split)).toEqual({ ok: true });
    }
  });

  it("bots give their loneliest tiles, not pairs", () => {
    const t = (suit: Tile["suit"], rank: number) => ({ suit, rank }) as Tile;
    const hand = [t("m", 1), t("m", 2), t("m", 3), t("t", 5), t("t", 5), t("z", 7), t("b", 9), t("z", 1)];
    const given = botGive(hand, 3, seededRng(1)).map(tileKey).sort();
    expect(given).toEqual([t("b", 9), t("z", 1), t("z", 7)].map(tileKey).sort());
  });
});
