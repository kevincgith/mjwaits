import { describe, expect, it } from "vitest";
import { seededRng } from "../bots";
import { newGame } from "../game";
import { encodeObservation, OBS_SIZE, OBS_SIZE_MATCH } from "./encode";
import { afterHand, matchScalars, matchUtility, NUM_MATCH_SCALARS, placeBonus, randomMatch, newMatch } from "./match";

describe("match context", () => {
  it("placing bonus: ties share their places", () => {
    expect(placeBonus([50, 10, -20, -40], 0)).toBe(300);
    expect(placeBonus([50, 10, -20, -40], 3)).toBe(-300);
    expect(placeBonus([30, 30, -20, -40], 1)).toBe(200);
    expect(matchUtility([50, 10, -20, -40], 1, 0)).toBe(10);
    expect(matchUtility([50, 10, -20, -40], 1, 0.5)).toBe(60);
  });
  it("random starts are zero-sum, inside the day, with a goal on the dial", () => {
    const rng = seededRng(3);
    for (let i = 0; i < 200; i++) {
      const m = randomMatch(rng);
      expect(m.totals.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2);
      expect(m.hand).toBeLessThan(m.length);
      expect([0, 0.25, 0.5, 0.75, 1]).toContain(m.goal);
    }
  });
  it("a finished hand moves the totals and the stats", () => {
    const s = newGame();
    s.phase = { kind: "over", result: { winner: 2, from: 1, tile: null, score: { total: 70 } as never, scoreError: null, deltas: [0, -70, 70, 0] } };
    const m = afterHand(newMatch(80, 1), s);
    expect(m.totals).toEqual([0, -70, 70, 0]);
    expect(m.hand).toBe(1);
    expect(m.stats[2]).toMatchObject({ hands: 1, wins: 1, winTai: 70, bigWins: 1 });
    expect(m.stats[1]).toMatchObject({ hands: 1, dealIns: 1 });
  });
  it("the match inputs are appended to the hand's observation, all in byte range", () => {
    const s = newGame();
    const m = { ...newMatch(80, 0.5), totals: [120, -40, -60, -20], hand: 30 };
    expect(encodeObservation(s, 0).length).toBe(OBS_SIZE);
    const v2 = encodeObservation(s, 0, m);
    expect(v2.length).toBe(OBS_SIZE_MATCH);
    expect(Array.from(v2.slice(0, OBS_SIZE))).toEqual(Array.from(encodeObservation(s, 0)));
    const sc = matchScalars(m, 0);
    expect(sc).toHaveLength(NUM_MATCH_SCALARS);
    // goal 10, 50 left, progress 7.5, 1st, total 12 + 128, gaps -16 -18 -14 + 128
    expect(sc.slice(0, 11)).toEqual([10, 50, 7.5, 1, 0, 0, 0, 140, 112, 110, 114]);
  });
});
