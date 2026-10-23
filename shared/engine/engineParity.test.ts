import { describe, expect, it } from "vitest";
import { parseScoringHand, scoreParsedHand, type BonusTile, type GameContext, type ScoreResult } from "./scoring";
import { scoreParsedHand as scoreParsedHandLegacy, type ScoreResult as LegacyScoreResult } from "./scoringLegacy";
import { TEST_HAND_BASE_CONTEXT, TEST_HANDS } from "./testHands";

// The configurable engine under its default ruleset must score exactly like
// the frozen hard-coded one (scoringLegacy.ts): same total, same patterns,
// same tai each. Every test hand, under its own situation and a handful of
// situation/bonus variations on top, so the context-driven patterns and the
// bonus-tile patterns get exercised on every hand shape too.

const VARIANTS: { name: string; ctx: Partial<GameContext>; bonus?: BonusTile[] }[] = [
  { name: "as written", ctx: {} },
  { name: "self-drawn", ctx: { selfDraw: true } },
  { name: "south seat, west round", ctx: { seatWind: 2, roundWind: 3 } },
  { name: "riichi + instant win", ctx: { riichi: "riichi", instantWin: true } },
  { name: "kong draw 2, rob kong 1", ctx: { kongDraw: 2, robKong: 1 } },
  { name: "dealer streak 3, flower draw 1", ctx: { dealerStreak: 3, flowerDraw: 1 } },
  { name: "sea bottom, double win", ctx: { lastTileWin: "sea-bottom", multiWin: "double" } },
  { name: "heavenly win", ctx: { heavenlyWin: "heaven", selfDraw: true } },
  { name: "one correct flower", ctx: {}, bonus: [{ kind: "flower", rank: 1 }] },
  { name: "two wrong flowers", ctx: {}, bonus: [{ kind: "flower", rank: 2 }, { kind: "season", rank: 3 }] },
];

const summary = (r: ScoreResult | LegacyScoreResult) => ({
  total: r.total,
  matched: r.matched.map((m) => [m.pattern.id, m.tai]),
  second: r.second?.matched.map((m) => [m.pattern.id, m.tai]) ?? null,
});

const outcome = (score: () => ScoreResult | LegacyScoreResult) => {
  try {
    return summary(score());
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

describe("configurable engine matches the hard-coded engine under default rules", () => {
  for (const t of TEST_HANDS) {
    it(`${t.group} / ${t.name}`, () => {
      for (const v of VARIANTS) {
        const parsed = parseScoringHand(t.hand);
        const withBonus = v.bonus ? { ...parsed, bonusTiles: v.bonus } : parsed;
        const ctx: GameContext = { ...TEST_HAND_BASE_CONTEXT, ...t.ctx, ...v.ctx };
        expect(outcome(() => scoreParsedHand(withBonus, ctx)), v.name).toEqual(outcome(() => scoreParsedHandLegacy(withBonus, ctx)));
      }
    });
  }
});
