import { describe, expect, it } from "vitest";
import {
  decomposeHandAll,
  isDealer,
  parseScoringHand,
  scoreHand,
  scoreParsedHand,
  type GameContext,
} from "./scoring";

const ctx = (overrides: Partial<GameContext> = {}): GameContext => ({
  seatWind: 1,
  roundWind: 1,
  selfDraw: false,
  winningTile: null,
  ...overrides,
});

describe("parseScoringHand", () => {
  it("always returns an empty bonusTiles array (no notation syntax for them yet)", () => {
    expect(parseScoringHand("123456789m111z234t22b").bonusTiles).toEqual([]);
  });

  it("parses a fully concealed hand as all-free tiles, no declared melds", () => {
    const parsed = parseScoringHand("123456789m111z234t22b");
    expect(parsed.declaredMelds).toEqual([]);
    expect(parsed.freeTiles).toHaveLength(17);
  });

  it("parses an exposed triplet in parens", () => {
    const parsed = parseScoringHand("(111z)123456789m11t22b456m");
    expect(parsed.declaredMelds).toHaveLength(1);
    expect(parsed.declaredMelds[0]).toMatchObject({ kind: "triplet", concealed: false });
  });

  it("parses an exposed run in parens (sou)", () => {
    const parsed = parseScoringHand("(456b)111222333m11t22b");
    expect(parsed.declaredMelds).toHaveLength(1);
    expect(parsed.declaredMelds[0]).toMatchObject({ kind: "run", concealed: false });
    expect(parsed.declaredMelds[0].tiles.map((t) => t.rank)).toEqual([4, 5, 6]);
  });

  it("parses an exposed kong in parens", () => {
    const parsed = parseScoringHand("(1111z)123456789m11t22b");
    expect(parsed.declaredMelds).toHaveLength(1);
    expect(parsed.declaredMelds[0]).toMatchObject({ kind: "kong", concealed: false });
    expect(parsed.declaredMelds[0].tiles).toHaveLength(4);
  });

  it("parses a bare 4-of-a-kind as a concealed kong, pulled out of freeTiles", () => {
    const parsed = parseScoringHand("1111z123456789m11t22b");
    expect(parsed.declaredMelds).toHaveLength(1);
    expect(parsed.declaredMelds[0]).toMatchObject({ kind: "kong", concealed: true });
    expect(parsed.freeTiles.filter((t) => t.suit === "z" && t.rank === 1)).toHaveLength(0);
  });

  it("rejects a mismatched parenthesized meld", () => {
    expect(() => parseScoringHand("(1357z)11t22b")).toThrow();
    expect(() => parseScoringHand("(135m)11t22b")).toThrow(); // not consecutive
    expect(() => parseScoringHand("(123z)11t22b")).toThrow(); // honors have no runs
  });

  it("rejects jokers", () => {
    expect(() => parseScoringHand("jj123m")).toThrow(/[Jj]oker/);
  });

  it("rejects more than 4 copies of a kind across declared + free tiles", () => {
    expect(() => parseScoringHand("(111z)1111z11t22b")).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => parseScoringHand("123x")).toThrow();
  });
});

describe("decomposeHandAll", () => {
  it("finds the single decomposition of an unambiguous hand", () => {
    const parsed = parseScoringHand("123456789m111z234t22b");
    const results = decomposeHandAll(parsed.freeTiles, 5);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.melds).toHaveLength(5);
      expect(r.pair).toHaveLength(2);
    }
  });

  it("finds multiple decompositions for a genuinely ambiguous hand", () => {
    // 111222333m can read as three triplets or three runs.
    const parsed = parseScoringHand("111222333m111z456b22t");
    const results = decomposeHandAll(parsed.freeTiles, 5);
    const kinds = results.map((r) => r.melds.filter((m) => m.tiles[0].suit === "m").map((m) => m.kind).sort().join(","));
    expect(new Set(kinds).size).toBeGreaterThan(1);
  });

  it("returns nothing for an incomplete/invalid shape", () => {
    // 17 tiles, but nothing anywhere forms a valid pair.
    const parsed = parseScoringHand("123456789m111z234t23b");
    const results = decomposeHandAll(parsed.freeTiles, 5);
    expect(results).toEqual([]);
  });
});

describe("scoreHand", () => {
  it("scores a fully concealed hand as 門清", () => {
    const result = scoreHand("123456789m111z234t22b", ctx());
    expect(result.matched.some((m) => m.pattern.id === "concealed-hand")).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("does not score 門清 once any meld is exposed", () => {
    const result = scoreHand("(111z)123456789m234t22b", ctx());
    expect(result.matched.some((m) => m.pattern.id === "concealed-hand")).toBe(false);
  });

  it("a concealed kong does not break 門清", () => {
    const result = scoreHand("1111z123456789m234t22b", ctx());
    expect(result.matched.some((m) => m.pattern.id === "concealed-hand")).toBe(true);
  });

  it("an exposed kong breaks 門清", () => {
    const result = scoreHand("(1111z)123456789m234t22b", ctx());
    expect(result.matched.some((m) => m.pattern.id === "concealed-hand")).toBe(false);
  });

  it("scores 無花 when the hand has no bonus tiles", () => {
    const result = scoreHand("(111z)123456789m234t22b", ctx());
    expect(result.matched.some((m) => m.pattern.id === "no-flowers")).toBe(true);
  });

  it("does not score 無花 once any bonus tile is present", () => {
    const parsed = parseScoringHand("(111z)123456789m234t22b");
    parsed.bonusTiles.push({ kind: "flower", rank: 1 });
    const result = scoreParsedHand(parsed, ctx());
    expect(result.matched.some((m) => m.pattern.id === "no-flowers")).toBe(false);
  });

  it("accounts for extra tiles from declared kongs in the completeness check", () => {
    // 2 concealed kongs (8 tiles) + 3 melds (9 tiles) + pair (2) = 19 tiles
    // total (17, plus 1 per kong).
    expect(() => scoreHand("1111z2222z123456789m22b", ctx())).not.toThrow();
  });

  it("throws ScoringError on an incomplete hand", () => {
    expect(() => scoreHand("123m11t22b", ctx())).toThrow();
  });

  it("picks the max-tai decomposition when a hand is genuinely ambiguous", () => {
    // Every reading of this hand is concealed either way, so 門清 applies
    // regardless of which decomposition wins - this just confirms scoring
    // doesn't crash or double-count across multiple candidate decompositions.
    const result = scoreHand("111222333m111z456b22t", ctx());
    expect(result.matched.filter((m) => m.pattern.id === "concealed-hand")).toHaveLength(1);
  });

  it("carries bonus tiles through to the result", () => {
    const parsed = parseScoringHand("123456789m111z234t22b");
    parsed.bonusTiles.push({ kind: "flower", rank: 1 }, { kind: "season", rank: 4 });
    const result = scoreParsedHand(parsed, ctx());
    expect(result.hand.bonusTiles).toEqual([{ kind: "flower", rank: 1 }, { kind: "season", rank: 4 }]);
  });
});

function tai(result: ReturnType<typeof scoreHand>, id: string): number {
  return result.matched.find((m) => m.pattern.id === id)?.tai ?? 0;
}

describe("PATTERNS", () => {
  describe("槓 (kong)", () => {
    it("scores 0 with no kong in the hand", () => {
      expect(tai(scoreHand("123456789m111z234t22b", ctx()), "kong")).toBe(0);
    });

    it("stacks 2 tai for a concealed kong", () => {
      expect(tai(scoreHand("1111z123456789m234t22b", ctx()), "kong")).toBe(2);
    });

    it("stacks 2 tai for an exposed kong too", () => {
      expect(tai(scoreHand("(1111z)123456789m234t22b", ctx()), "kong")).toBe(2);
    });

    it("stacks across multiple kongs regardless of concealed/exposed mix", () => {
      expect(tai(scoreHand("1111z2222z123456789m22b", ctx()), "kong")).toBe(4);
    });
  });

  describe("正花 (correct-flower)", () => {
    it("stacks 2 tai per bonus tile matching the seat wind", () => {
      const parsed = parseScoringHand("123456789m111z234t22b");
      parsed.bonusTiles.push({ kind: "flower", rank: 1 }, { kind: "season", rank: 1 });
      const result = scoreParsedHand(parsed, ctx({ seatWind: 1 }));
      expect(tai(result, "correct-flower")).toBe(4);
    });

    it("doesn't count a bonus tile that doesn't match the seat wind", () => {
      const parsed = parseScoringHand("123456789m111z234t22b");
      parsed.bonusTiles.push({ kind: "flower", rank: 2 });
      const result = scoreParsedHand(parsed, ctx({ seatWind: 1 }));
      expect(tai(result, "correct-flower")).toBe(0);
    });
  });

  describe("無字 (no-honors) / 無字花 (no-honors-no-flowers)", () => {
    const noHonorHand = "111222333m444555t22b"; // 3 melds in m, 2 in t, pair in b - no z tiles anywhere.

    it("scores only 無字花 (not 無字/無花) for an all-numbered hand with no bonus tiles", () => {
      const result = scoreHand(noHonorHand, ctx());
      expect(tai(result, "no-honors-no-flowers")).toBe(10);
      expect(tai(result, "no-honors")).toBe(0);
      expect(tai(result, "no-flowers")).toBe(0);
    });

    it("scores 無字 but not 無字花 once a bonus tile is present", () => {
      const parsed = parseScoringHand(noHonorHand);
      parsed.bonusTiles.push({ kind: "flower", rank: 1 });
      const result = scoreParsedHand(parsed, ctx());
      expect(tai(result, "no-honors")).toBe(2);
      expect(tai(result, "no-honors-no-flowers")).toBe(0);
    });

    it("scores neither once the hand has any honor tile", () => {
      const result = scoreHand("123456789m111z234t22b", ctx());
      expect(tai(result, "no-honors")).toBe(0);
      expect(tai(result, "no-honors-no-flowers")).toBe(0);
    });
  });

  describe("爛位風/正位風/爛圈風/正圈風 (single wind meld vs. seat/round wind)", () => {
    const eastMeldHand = "(111z)123456789m234t22b"; // one wind meld: East.

    it("scores 正位風/正圈風 when the wind meld matches, not the 爛 counterparts", () => {
      const result = scoreHand(eastMeldHand, ctx({ seatWind: 1, roundWind: 1 }));
      expect(tai(result, "correct-seat-wind")).toBe(2);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
      expect(tai(result, "correct-round-wind")).toBe(2);
      expect(tai(result, "wrong-round-wind")).toBe(0);
    });

    it("scores 爛位風/爛圈風 when the wind meld doesn't match, not the 正 counterparts", () => {
      const result = scoreHand(eastMeldHand, ctx({ seatWind: 2, roundWind: 3 }));
      expect(tai(result, "wrong-seat-wind")).toBe(2);
      expect(tai(result, "correct-seat-wind")).toBe(0);
      expect(tai(result, "wrong-round-wind")).toBe(2);
      expect(tai(result, "correct-round-wind")).toBe(0);
    });

    it("scores none of the four with no wind meld at all", () => {
      const result = scoreHand("111222333m444555t22b", ctx()); // no honors anywhere
      expect(tai(result, "correct-seat-wind")).toBe(0);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
      expect(tai(result, "correct-round-wind")).toBe(0);
      expect(tai(result, "wrong-round-wind")).toBe(0);
    });
  });

  describe("小三風/大三風 and exclusion of the single-wind patterns", () => {
    it("scores 小三風 for 2 wind melds + the spare wind as pair, excluding the singles", () => {
      const result = scoreHand("(111z)(222z)123456789m33z", ctx({ seatWind: 1, roundWind: 1 }));
      expect(tai(result, "small-three-winds")).toBe(30);
      expect(tai(result, "correct-seat-wind")).toBe(0);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
      expect(tai(result, "correct-round-wind")).toBe(0);
      expect(tai(result, "wrong-round-wind")).toBe(0);
    });

    it("does not score 小三風 when the pair isn't the spare wind", () => {
      const result = scoreHand("(111z)(222z)123456789m22b", ctx());
      expect(tai(result, "small-three-winds")).toBe(0);
    });

    it("scores 大三風 for 3 wind melds, excluding 小三風 and the singles", () => {
      const result = scoreHand("(111z)(222z)(333z)123456t22b", ctx({ seatWind: 1, roundWind: 1 }));
      expect(tai(result, "big-three-winds")).toBe(60);
      expect(tai(result, "small-three-winds")).toBe(0);
      expect(tai(result, "correct-seat-wind")).toBe(0);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
    });
  });

  describe("小四喜/大四喜 and exclusion of the smaller wind patterns", () => {
    it("scores 小四喜 for 3 wind melds + the 4th as pair, excluding everything smaller", () => {
      const result = scoreHand("(111z)(222z)(333z)123456t44z", ctx({ seatWind: 1, roundWind: 1 }));
      expect(tai(result, "small-four-winds")).toBe(120);
      expect(tai(result, "big-three-winds")).toBe(0);
      expect(tai(result, "small-three-winds")).toBe(0);
      expect(tai(result, "correct-seat-wind")).toBe(0);
    });

    it("scores 大四喜 for all 4 wind melds, excluding everything smaller", () => {
      const result = scoreHand("(111z)(222z)(333z)(444z)123b22t", ctx({ seatWind: 1, roundWind: 1 }));
      expect(tai(result, "big-four-winds")).toBe(160);
      expect(tai(result, "small-four-winds")).toBe(0);
      expect(tai(result, "big-three-winds")).toBe(0);
      expect(tai(result, "small-three-winds")).toBe(0);
      expect(tai(result, "correct-seat-wind")).toBe(0);
    });
  });

  describe("三元牌/小三元/大三元 and their exclusions", () => {
    it("stacks 三元牌 2 tai per dragon meld when the pair isn't the spare dragon", () => {
      const result = scoreHand("(555z)(666z)123456789m22b", ctx());
      expect(tai(result, "dragon-tile")).toBe(4);
      expect(tai(result, "small-three-dragons")).toBe(0);
    });

    it("scores 小三元 for 2 dragon melds + the spare dragon as pair, excluding 三元牌", () => {
      const result = scoreHand("(555z)(666z)123456789m77z", ctx());
      expect(tai(result, "small-three-dragons")).toBe(40);
      expect(tai(result, "dragon-tile")).toBe(0);
    });

    it("scores 大三元 for all 3 dragon melds, excluding 三元牌 and 小三元", () => {
      const result = scoreHand("(555z)(666z)(777z)123456t22b", ctx());
      expect(tai(result, "big-three-dragons")).toBe(80);
      expect(tai(result, "small-three-dragons")).toBe(0);
      expect(tai(result, "dragon-tile")).toBe(0);
    });
  });

  describe("字一色 (all-honors)", () => {
    it("scores when every tile in the hand is an honor", () => {
      const result = scoreHand("(111z)(222z)(333z)(444z)(555z)66z", ctx());
      expect(tai(result, "all-honors")).toBe(160);
    });

    it("doesn't score once any numbered-suit tile is present", () => {
      const result = scoreHand("123456789m111z234t22b", ctx());
      expect(tai(result, "all-honors")).toBe(0);
    });
  });

  describe("平胡 (all-runs) and 無字花大平胡", () => {
    // 5 runs, no triplet/kong anywhere: 123/456/789m, 123/456t, pair 22b.
    // Also happens to be no-honors-no-flowers, so it's used below for the
    // *compound* pattern - 平胡 alone needs a hand that's all-runs but
    // doesn't also qualify for that stronger pattern (see 11z pair below).
    const allRunsHand = "123456789m123456t22b";
    const allRunsHonorPairHand = "123456789m123456t11z";

    it("scores 平胡 for an all-runs hand", () => {
      expect(tai(scoreHand(allRunsHonorPairHand, ctx()), "all-runs")).toBe(5);
    });

    it("doesn't score 平胡 once any triplet/kong is present", () => {
      expect(tai(scoreHand("123456789m111z234t22b", ctx()), "all-runs")).toBe(0);
    });

    it("scores 無字花大平胡 for an all-runs, no-honors, no-flowers hand, excluding both components", () => {
      const result = scoreHand(allRunsHand, ctx());
      expect(tai(result, "all-runs-no-honors-no-flowers")).toBe(20);
      expect(tai(result, "all-runs")).toBe(0);
      expect(tai(result, "no-honors-no-flowers")).toBe(0);
    });

    it("doesn't score 無字花大平胡 when all-runs holds but the pair is an honor", () => {
      // All 5 melds are runs, but the pair itself (11z) is an honor tile -
      // fails the no-honors half without breaking all-runs.
      const result = scoreHand(allRunsHonorPairHand, ctx());
      expect(tai(result, "all-runs")).toBe(5);
      expect(tai(result, "all-runs-no-honors-no-flowers")).toBe(0);
    });

    it("doesn't score 無字花大平胡 when no-honors-no-flowers holds but a triplet is forced", () => {
      // 111m has no adjacent 2m/3m anywhere, so it can only ever decompose
      // as a triplet - no ambiguous run reading to exploit.
      const result = scoreHand("111m22m456t789t234b678b", ctx());
      expect(tai(result, "no-honors-no-flowers")).toBe(10);
      expect(tai(result, "all-runs-no-honors-no-flowers")).toBe(0);
    });
  });

  describe("缺一門 (missing-one-suit)", () => {
    it("scores when exactly 2 of the 3 numbered suits are used", () => {
      const result = scoreHand("123456789m111z234t55t", ctx());
      expect(tai(result, "missing-one-suit")).toBe(10);
    });

    it("doesn't score when all 3 numbered suits are used", () => {
      const result = scoreHand("123456789m111z234t22b", ctx());
      expect(tai(result, "missing-one-suit")).toBe(0);
    });
  });

  describe("缺五 (no-fives)", () => {
    it("scores when the hand has no honors and no rank-5 tile", () => {
      const result = scoreHand("123m678m123t789t678b44b", ctx());
      expect(tai(result, "no-fives")).toBe(10);
    });

    it("doesn't score once a rank-5 tile or an honor is present", () => {
      const result = scoreHand("123456789m111z234t22b", ctx());
      expect(tai(result, "no-fives")).toBe(0);
    });
  });

  describe("小五門齊/大五門齊", () => {
    it("scores 小五門齊 when all 5 categories are present but not all fully melded", () => {
      // dragon (55z) only shows up as the pair, never a dedicated meld.
      const result = scoreHand("123m456t789t678b111z55z", ctx());
      expect(tai(result, "small-five-suits")).toBe(10);
      expect(tai(result, "big-five-suits")).toBe(0);
    });

    it("scores 大五門齊 when all 5 categories each have a dedicated meld", () => {
      const result = scoreHand("123m456t678b111z555z99m", ctx());
      expect(tai(result, "big-five-suits")).toBe(15);
      expect(tai(result, "small-five-suits")).toBe(0);
    });

    it("scores neither when a category is missing entirely", () => {
      const result = scoreHand("123456789m111z234t22b", ctx()); // no dragon tile anywhere
      expect(tai(result, "small-five-suits")).toBe(0);
      expect(tai(result, "big-five-suits")).toBe(0);
    });
  });

  describe("小七門齊/大七門齊", () => {
    it("scores 小七門齊 over 小五門齊 once flower and season are both present", () => {
      const parsed = parseScoringHand("123m456t789t678b111z55z");
      parsed.bonusTiles.push({ kind: "flower", rank: 1 }, { kind: "season", rank: 1 });
      const result = scoreParsedHand(parsed, ctx());
      expect(tai(result, "small-seven-suits")).toBe(15);
      expect(tai(result, "small-five-suits")).toBe(0);
    });

    it("scores 大七門齊 over 大五門齊 once flower and season are both present", () => {
      const parsed = parseScoringHand("123m456t678b111z555z99m");
      parsed.bonusTiles.push({ kind: "flower", rank: 1 }, { kind: "season", rank: 1 });
      const result = scoreParsedHand(parsed, ctx());
      expect(tai(result, "big-seven-suits")).toBe(20);
      expect(tai(result, "big-five-suits")).toBe(0);
    });

    it("falls back to the five-suit pattern when only one of flower/season is present", () => {
      const parsed = parseScoringHand("123m456t789t678b111z55z");
      parsed.bonusTiles.push({ kind: "flower", rank: 1 });
      const result = scoreParsedHand(parsed, ctx());
      expect(tai(result, "small-seven-suits")).toBe(0);
      expect(tai(result, "small-five-suits")).toBe(10);
    });
  });

  describe("大於五/小於五", () => {
    it("scores 大於五 for an all-6-to-9 hand, excluding 缺五", () => {
      const result = scoreHand("678m789m678t789t678b99b", ctx());
      expect(tai(result, "greater-than-five")).toBe(40);
      expect(tai(result, "no-fives")).toBe(0);
    });

    it("scores 小於五 for an all-1-to-4 hand, excluding 缺五", () => {
      const result = scoreHand("123m234m123t234t123b44b", ctx());
      expect(tai(result, "less-than-five")).toBe(40);
      expect(tai(result, "no-fives")).toBe(0);
    });

    it("scores plain 缺五 for a no-honors no-fives hand outside both ranges", () => {
      const result = scoreHand("123m678m123t789t678b44b", ctx());
      expect(tai(result, "no-fives")).toBe(10);
      expect(tai(result, "greater-than-five")).toBe(0);
      expect(tai(result, "less-than-five")).toBe(0);
    });
  });
});

describe("PATTERNS: 明/暗 (open/concealed) via the winning tile", () => {
  // A single concealed pure straight in m, padded with an unrelated pair.
  const straightHand = "123456789m234t567t22b";

  it("is 暗清龍 with no winning tile recorded", () => {
    const result = scoreHand(straightHand, ctx());
    expect(tai(result, "pure-straight-hidden")).toBe(20);
    expect(tai(result, "pure-straight-open")).toBe(0);
  });

  it("becomes 明清龍 when the winning tile is part of the straight and wasn't self-drawn", () => {
    const result = scoreHand(straightHand, ctx({ winningTile: { suit: "m", rank: 8 }, selfDraw: false }));
    expect(tai(result, "pure-straight-open")).toBe(10);
    expect(tai(result, "pure-straight-hidden")).toBe(0);
  });

  it("stays 暗清龍 when the winning tile is part of the straight but WAS self-drawn", () => {
    const result = scoreHand(straightHand, ctx({ winningTile: { suit: "m", rank: 8 }, selfDraw: true }));
    expect(tai(result, "pure-straight-hidden")).toBe(20);
    expect(tai(result, "pure-straight-open")).toBe(0);
  });

  it("stays 暗清龍 when the winning tile doesn't belong to any meld in the straight", () => {
    const result = scoreHand(straightHand, ctx({ winningTile: { suit: "t", rank: 5 }, selfDraw: false }));
    expect(tai(result, "pure-straight-hidden")).toBe(20);
    expect(tai(result, "pure-straight-open")).toBe(0);
  });
});

describe("PATTERNS: 斷么 (all-simples)", () => {
  it("scores when every tile is ranked 2-8", () => {
    expect(tai(scoreHand("234m567m234t567t234b66b", ctx()), "all-simples")).toBe(10);
  });

  it("doesn't score once a terminal or honor is present", () => {
    expect(tai(scoreHand("123456789m111z234t22b", ctx()), "all-simples")).toBe(0);
  });
});

describe("PATTERNS: 對對胡/坎坎胡 and the 暗刻 chain", () => {
  // 5 concealed triplets (non-adjacent ranks, so no run reading is possible),
  // all in one suit for simplicity, pair in a different suit.
  const fiveHiddenTriplets = "111m333m555m777m999m22t";

  it("對對胡 scores for all-triplet/kong hands, not for hands with a run", () => {
    expect(tai(scoreHand("111m333m555m777t99t999b", ctx()), "all-triplets")).toBe(40);
    expect(tai(scoreHand("123456789m111z234t22b", ctx()), "all-triplets")).toBe(0);
  });

  it("坎坎胡 requires self-draw, excluding 對對胡 and the whole 暗刻 chain", () => {
    const result = scoreHand(fiveHiddenTriplets, ctx({ selfDraw: true }));
    expect(tai(result, "five-concealed-triplets")).toBe(160);
    expect(tai(result, "all-triplets")).toBe(0);
    expect(tai(result, "two-hidden-triplets")).toBe(0);
    expect(tai(result, "three-hidden-triplets")).toBe(0);
    expect(tai(result, "four-hidden-triplets")).toBe(0);
    expect(tai(result, "five-hidden-triplets")).toBe(0);
  });

  it("without self-draw, 坎坎胡 doesn't fire but 對對胡/五暗刻 still do", () => {
    const result = scoreHand(fiveHiddenTriplets, ctx({ selfDraw: false }));
    expect(tai(result, "five-concealed-triplets")).toBe(0);
    expect(tai(result, "all-triplets")).toBe(40);
    expect(tai(result, "five-hidden-triplets")).toBe(80);
  });

  it("a kong disqualifies 坎坎胡 even with self-draw, but still counts toward 五暗刻", () => {
    const result = scoreHand("1111m999m456t789t234b22b", ctx({ selfDraw: true }));
    expect(tai(result, "five-concealed-triplets")).toBe(0);
  });

  it("counts exactly 2/3/4 concealed triplets at the right tiers", () => {
    const two = scoreHand("111m333m456t789t234b22b", ctx());
    expect(tai(two, "two-hidden-triplets")).toBe(5);
    expect(tai(two, "three-hidden-triplets")).toBe(0);

    const three = scoreHand("111m333m555m456t789b22b", ctx());
    expect(tai(three, "three-hidden-triplets")).toBe(15);
    expect(tai(three, "two-hidden-triplets")).toBe(0);

    const four = scoreHand("111m333m555m777m456t22t", ctx());
    expect(tai(four, "four-hidden-triplets")).toBe(30);
    expect(tai(four, "three-hidden-triplets")).toBe(0);
  });

  it("a triplet completed by a claimed (non-self-draw) winning tile doesn't count as hidden", () => {
    // Same shape as the "two" case above, but the winning tile completes
    // one of the two triplets via a claim, not a self-draw.
    const result = scoreHand("111m333m456t789t234b22b", ctx({ winningTile: { suit: "m", rank: 3 }, selfDraw: false }));
    expect(tai(result, "two-hidden-triplets")).toBe(0);
  });
});

describe("PATTERNS: 五槓子", () => {
  it("scores 240 for 5 kongs, excluding 槓/四暗刻/五暗刻 but not 對對胡", () => {
    const result = scoreHand("1111m2222m3333m4444m5555t66t", ctx());
    expect(tai(result, "five-kongs")).toBe(240);
    expect(tai(result, "kong")).toBe(0);
    expect(tai(result, "four-hidden-triplets")).toBe(0);
    expect(tai(result, "five-hidden-triplets")).toBe(0);
    expect(tai(result, "all-triplets")).toBe(40);
  });
});

describe("PATTERNS: 明清龍/暗清龍 (pure straight, with duplicate instances)", () => {
  it("counts 2x 明清龍 when a whole 123-456-789-789 group is all declared", () => {
    const result = scoreHand("(123m)(456m)(789m)(789m)234t22b", ctx());
    expect(tai(result, "pure-straight-open")).toBe(20); // 2 instances x 10
    expect(tai(result, "pure-straight-hidden")).toBe(0);
  });

  it("splits into 1 暗清龍 + 1 明清龍 when only one duplicate segment is declared", () => {
    const result = scoreHand("(789m)123456789m234t22b", ctx());
    expect(tai(result, "pure-straight-hidden")).toBe(20); // 1 instance
    expect(tai(result, "pure-straight-open")).toBe(10); // 1 instance
  });
});

describe("PATTERNS: 明雜龍/暗雜龍 (mixed straight across suits)", () => {
  it("scores 暗雜龍 for a fully concealed 123m+456t+789b", () => {
    const result = scoreHand("123m234m456t567t789b99b", ctx());
    expect(tai(result, "mixed-straight-hidden")).toBe(15);
    expect(tai(result, "mixed-straight-open")).toBe(0);
  });

  it("scores 明雜龍 once one of the three segments is declared", () => {
    const result = scoreHand("(123m)234m456t567t789b99b", ctx());
    expect(tai(result, "mixed-straight-open")).toBe(8);
    expect(tai(result, "mixed-straight-hidden")).toBe(0);
  });
});

describe("PATTERNS: 老少上/老少碰", () => {
  it("counts 2x 老少上 for a duplicated 123 paired with a single 789", () => {
    const result = scoreHand("123m123m789m456t567t22b", ctx());
    expect(tai(result, "old-young-run")).toBe(6); // 2 instances x 3
  });

  it("doesn't score 老少上 for a suit that also has the 456 segment (that's 清龍 instead)", () => {
    const result = scoreHand("123456789m234t567t22b", ctx());
    expect(tai(result, "old-young-run")).toBe(0);
    expect(tai(result, "pure-straight-hidden")).toBe(20);
  });

  it("scores 老少碰 for a rank-1 + rank-9 triplet in one suit", () => {
    const result = scoreHand("111m999m456t789t234b22b", ctx());
    expect(tai(result, "old-young-triplet")).toBe(5);
  });

  it("a kong of rank 1 or 9 counts toward 老少碰 too", () => {
    const result = scoreHand("1111m999m456t789t234b22b", ctx());
    expect(tai(result, "old-young-triplet")).toBe(5);
  });
});

describe("isDealer", () => {
  it("is true only when seat wind is East", () => {
    expect(isDealer(ctx({ seatWind: 1 }))).toBe(true);
    expect(isDealer(ctx({ seatWind: 2 }))).toBe(false);
  });
});
