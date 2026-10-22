import { describe, expect, it } from "vitest";
import { parseScoringHand, scoreParsedHand, type GameContext, type ScoreResult } from "./scoring";
import { scoreParsedHand as scoreParsedHandLegacy, type ScoreResult as LegacyScoreResult } from "./scoringLegacy";
import { FUZZ_SCALE, HAND_KINDS, randomBonus, randomContext, rng } from "./randomHands";
import { TEST_HAND_BASE_CONTEXT } from "./testHands";

// engineParity.test.ts checks the configurable engine against the frozen
// hard-coded one (scoringLegacy.ts) on the scoring tests' own hands. This
// does the same on thousands of seeded random hands - ordinary and all three
// special shapes, each under a random situation and bonus tiles - to catch
// what no hand-written test thought of. A failure prints the hand and its
// situation; add it to scoring.test.ts once understood.

const summary = (r: ScoreResult | LegacyScoreResult) => ({
  total: r.total,
  matched: r.matched.map((m) => `${m.pattern.id} ${m.tai}`),
  second: r.second?.matched.map((m) => `${m.pattern.id} ${m.tai}`) ?? null,
});

const outcome = (score: () => ScoreResult | LegacyScoreResult) => {
  try {
    return summary(score());
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

// Situation fields that differ from the defaults, for a readable failure.
const situation = (ctx: GameContext) =>
  Object.fromEntries(Object.entries(ctx).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(TEST_HAND_BASE_CONTEXT[k as keyof GameContext])));

type Run = { kind: keyof typeof HAND_KINDS; count: number; seed: number };
const RUNS: Run[] = ([
  { kind: "normal", count: 1000, seed: 1 },
  { kind: "normal", count: 1000, seed: 2 },
  { kind: "thirteen-orphans", count: 250, seed: 3 },
  { kind: "sixteen-unrelated", count: 250, seed: 4 },
  { kind: "eight-pairs", count: 400, seed: 5 },
] satisfies Run[]).map((run) => ({ ...run, count: run.count * FUZZ_SCALE }));

describe("configurable engine matches the hard-coded engine on random hands", () => {
  for (const run of RUNS) {
    it(`${run.count} ${run.kind} hands (seed ${run.seed})`, { timeout: 120_000 * FUZZ_SCALE }, () => {
      const r = rng(run.seed);
      const mismatches: unknown[] = [];
      let scored = 0;
      for (let i = 0; i < run.count; i++) {
        const { hand, free } = HAND_KINDS[run.kind](r);
        const ctx = randomContext(r, TEST_HAND_BASE_CONTEXT, free);
        const parsed = { ...parseScoringHand(hand), bonusTiles: randomBonus(r) };
        const ours = outcome(() => scoreParsedHand(parsed, ctx));
        const legacy = outcome(() => scoreParsedHandLegacy(parsed, ctx));
        if (!("error" in ours)) scored++;
        if (JSON.stringify(ours) !== JSON.stringify(legacy)) {
          mismatches.push({ hand, bonus: parsed.bonusTiles, situation: situation(ctx), ours, legacy });
        }
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
      // The generator really makes winning hands of this shape.
      expect(scored).toBe(run.count);
    });
  }
});
