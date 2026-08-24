import { describe, expect, it } from "vitest";
import { getWaits, tileKey } from "./mahjong";
import { MAX_TRAINER_LEVEL, MIN_TRAINER_LEVEL, generateTrainerQuestion, trainerHandSize } from "./trainer";

const TRIALS = 40;

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
