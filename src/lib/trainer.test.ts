import { describe, expect, it } from "vitest";
import { analyzeDiscardChoices, getWaits, isCompleteHand, shanten, tileKey } from "./mahjong";
import {
  MAX_TRAINER_LEVEL,
  MIN_TRAINER_LEVEL,
  dealEndlessHand,
  discardRegret,
  drawFromWall,
  generateDiscardQuestion,
  generateTrainerQuestion,
  gradeDiscardOutcome,
  isOptimalDiscard,
  regretForOutcome,
  trainerHandSize,
} from "./trainer";

const TRIALS = 40;
// Discard questions run the full analyzeDiscardChoices grader on a 3n+2 hand,
// heaviest at level 5 - fewer trials keep the suite quick while still exercising
// many random hands.
const DISCARD_TRIALS = 8;

describe("generateTrainerQuestion", () => {
  for (let level = MIN_TRAINER_LEVEL; level <= MAX_TRAINER_LEVEL; level++) {
    for (const flush of [false, true]) {
      it(`produces a valid, non-trivial level ${level} question (flush=${flush})`, () => {
        for (let trial = 0; trial < TRIALS; trial++) {
          const q = generateTrainerQuestion(level, flush);

          expect(q.tiles.length).toBe(trainerHandSize(level));

          // Physical 4-copies-per-kind limit.
          const counts = new Map<string, number>();
          for (const t of q.tiles) counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) + 1);
          for (const c of counts.values()) expect(c).toBeLessThanOrEqual(4);

          // Non-zero waits, and they match the engine's own getWaits().
          expect(q.waits.length).toBeGreaterThan(0);
          expect(q.waits.map(tileKey).sort()).toEqual(
            getWaits(q.tiles, level)
              .map(tileKey)
              .sort()
          );

          // Every wait completes a group that already has a tile present in
          // the question - the UI relies on this to only show suits that are
          // actually in play, instead of the full 34-kind picker.
          const suitsInHand = new Set(q.tiles.map((t) => t.suit));
          for (const w of q.waits) expect(suitsInHand.has(w.suit)).toBe(true);

          if (flush) {
            const suits = new Set(q.tiles.map((t) => t.suit));
            expect(suits.size).toBe(1);
            expect(["m", "t", "b"]).toContain(q.tiles[0].suit);
          }
        }
      });
    }
  }

  it("varies the hand across calls rather than always returning the same one", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add(generateTrainerQuestion(2, false).tiles.map(tileKey).sort().join(","));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("generateDiscardQuestion", () => {
  for (let level = MIN_TRAINER_LEVEL; level <= MAX_TRAINER_LEVEL; level++) {
    for (const flush of [false, true]) {
      it(`produces a valid level ${level} discard question (flush=${flush})`, () => {
        for (let trial = 0; trial < DISCARD_TRIALS; trial++) {
          const q = generateDiscardQuestion(level, flush);

          // "Just drew" size, within the 4-copies-per-kind limit.
          expect(q.tiles.length).toBe(trainerHandSize(level) + 1);
          const counts = new Map<string, number>();
          for (const t of q.tiles) counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) + 1);
          for (const c of counts.values()) expect(c).toBeLessThanOrEqual(4);

          if (flush) {
            expect(new Set(q.tiles.map((t) => t.suit)).size).toBe(1);
            expect(["m", "t", "b"]).toContain(q.tiles[0].suit);
          }

          // Never a hand that's already won, and one choice per discardable kind.
          expect(q.outcome.alreadyComplete).toBe(false);
          expect(q.outcome.choices.length).toBe(new Set(q.tiles.map(tileKey)).size);

          // The graded outcome matches the engine run directly on the hand.
          const fresh = analyzeDiscardChoices(q.tiles, level);
          expect(q.outcome.choices.map((c) => tileKey(c.discard))).toEqual(
            fresh.choices.map((c) => tileKey(c.discard))
          );

          // optimalKeys is exactly the argmax set of winProbability, and always
          // non-empty (discarding the drawn tile reverts to tenpai).
          expect(q.optimalKeys.size).toBeGreaterThan(0);
          const trueBest = Math.max(...q.outcome.choices.map((c) => c.winProbability));
          expect(q.bestWinProbability).toBeCloseTo(trueBest, 12);
          for (const c of q.outcome.choices) {
            const key = tileKey(c.discard);
            expect(q.optimalKeys.has(key)).toBe(trueBest - c.winProbability <= 1e-9);
          }
        }
      });
    }
  }

  it("scores regret as zero for optimal picks and positive for worse ones", () => {
    for (let trial = 0; trial < DISCARD_TRIALS; trial++) {
      const q = generateDiscardQuestion(3, false);

      for (const key of q.optimalKeys) {
        expect(discardRegret(q, key)).toBe(0);
        expect(isOptimalDiscard(q, key)).toBe(true);
      }

      const worst = [...q.outcome.choices].sort((a, b) => a.winProbability - b.winProbability)[0];
      const worstKey = tileKey(worst.discard);
      if (!q.optimalKeys.has(worstKey)) {
        expect(discardRegret(q, worstKey)).toBeGreaterThan(0);
        expect(isOptimalDiscard(q, worstKey)).toBe(false);
      }
    }
  });

  it("varies the hand across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add(generateDiscardQuestion(3, false).tiles.map(tileKey).sort().join(","));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("gradeDiscardOutcome / regretForOutcome", () => {
  it("picks the argmax-winProbability set and scores regret against it", () => {
    for (let trial = 0; trial < DISCARD_TRIALS; trial++) {
      const q = generateDiscardQuestion(4, false);
      const { bestWinProbability, optimalKeys } = gradeDiscardOutcome(q.outcome);

      expect(optimalKeys.size).toBeGreaterThan(0);
      const trueBest = Math.max(...q.outcome.choices.map((c) => c.winProbability));
      expect(bestWinProbability).toBeCloseTo(trueBest, 12);

      for (const c of q.outcome.choices) {
        const key = tileKey(c.discard);
        expect(optimalKeys.has(key)).toBe(trueBest - c.winProbability <= 1e-9);
        expect(regretForOutcome(q.outcome, bestWinProbability, key)).toBeCloseTo(
          Math.max(0, trueBest - c.winProbability),
          12
        );
      }

      // A kind not among the choices is the worst case.
      expect(regretForOutcome(q.outcome, bestWinProbability, "z9")).toBe(bestWinProbability);
    }
  });
});

describe("dealEndlessHand / drawFromWall", () => {
  it("deals 16 concealed + a 120-tile wall that together hold exactly 4 of each kind", () => {
    for (let trial = 0; trial < 20; trial++) {
      const { hand, wall } = dealEndlessHand();
      expect(hand.length).toBe(16);
      expect(wall.length).toBe(120);

      const counts = new Map<string, number>();
      for (const t of [...hand, ...wall]) counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) + 1);
      expect(counts.size).toBe(34);
      for (const c of counts.values()) expect(c).toBe(4);
    }
  });

  it("draws one tile at a time off the wall, then reports empty", () => {
    let { wall } = dealEndlessHand();
    const drawnKeys: string[] = [];
    while (wall.length > 0) {
      const before = wall.length;
      const res = drawFromWall(wall);
      expect(res.tile).not.toBeNull();
      expect(res.wall.length).toBe(before - 1);
      drawnKeys.push(tileKey(res.tile!));
      wall = res.wall;
    }
    expect(drawnKeys.length).toBe(120);
    expect(drawFromWall(wall)).toEqual({ tile: null, wall: [] });
  });

  it("plays a hand out for many turns, always taking a best discard, with zero regret", () => {
    const dealt = dealEndlessHand();
    let wall = dealt.wall;
    let firstDraw = drawFromWall(wall);
    wall = firstDraw.wall;
    let hand = [...dealt.hand, firstDraw.tile!];

    for (let turn = 0; turn < 25 && wall.length > 0; turn++) {
      expect(hand.length).toBe(17);
      if (isCompleteHand(hand, 5)) break;

      const outcome = analyzeDiscardChoices(hand, 5);
      const { bestWinProbability } = gradeDiscardOutcome(outcome);
      const best = [...outcome.choices].sort((a, b) => b.winProbability - a.winProbability)[0];
      const key = tileKey(best.discard);
      expect(regretForOutcome(outcome, bestWinProbability, key)).toBe(0);

      const idx = hand.findIndex((t) => tileKey(t) === key);
      hand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
      expect(hand.length).toBe(16);
      expect(shanten(hand, 5)).toBeGreaterThanOrEqual(0);

      const drew = drawFromWall(wall);
      wall = drew.wall;
      hand = [...hand, drew.tile!];
    }
  });
});
