import { describe, expect, it } from "vitest";
import { parseHand } from "./mahjong";
import {
  decomposeHandAll,
  groupDeclaredTiles,
  isDealer,
  parseScoringHand,
  scoreHand,
  scoreParsedHand,
  ScoringError,
  type GameContext,
} from "./scoring";

const ctx = (overrides: Partial<GameContext> = {}): GameContext => ({
  seatWind: 1,
  roundWind: 1,
  selfDraw: false,
  winningTile: null,
  ...overrides,
});

describe("groupDeclaredTiles", () => {
  it("groups three consecutive triplets", () => {
    const result = groupDeclaredTiles(parseHand("111m333t222b"));
    expect(result.leftover).toEqual([]);
    expect(result.melds).toMatchObject([
      { kind: "triplet", concealed: false },
      { kind: "triplet", concealed: false },
      { kind: "triplet", concealed: false },
    ]);
  });

  it("groups a kong ahead of a triplet (checks 4-of-a-kind before 3)", () => {
    const result = groupDeclaredTiles(parseHand("1111m222t"));
    expect(result.leftover).toEqual([]);
    expect(result.melds).toMatchObject([
      { kind: "kong", concealed: false, tiles: [{ suit: "m", rank: 1 }, { suit: "m", rank: 1 }, { suit: "m", rank: 1 }, { suit: "m", rank: 1 }] },
      { kind: "triplet", concealed: false },
    ]);
  });

  it("groups an ascending run", () => {
    const result = groupDeclaredTiles(parseHand("123m"));
    expect(result.leftover).toEqual([]);
    expect(result.melds).toEqual([{ kind: "run", concealed: false, tiles: parseHand("123m") }]);
  });

  it("reads a run whose cluster wasn't detected in rank order (e.g. \"576t\" for a called 6t)", () => {
    const result = groupDeclaredTiles([{ suit: "t", rank: 5 }, { suit: "t", rank: 7 }, { suit: "t", rank: 6 }]);
    expect(result.leftover).toEqual([]);
    expect(result.melds).toEqual([{ kind: "run", concealed: false, tiles: parseHand("567t") }]);
  });

  it("does not read a cross-suit triple as a run", () => {
    const result = groupDeclaredTiles([{ suit: "m", rank: 1 }, { suit: "m", rank: 2 }, { suit: "t", rank: 3 }]);
    expect(result.melds).toEqual([]);
    expect(result.leftover).toHaveLength(3);
  });

  it("bails out at the first tile that does not start a valid meld, leaving the rest as leftover", () => {
    const result = groupDeclaredTiles(parseHand("111m22t"));
    expect(result.melds).toMatchObject([{ kind: "triplet" }]);
    expect(result.leftover).toEqual(parseHand("22t"));
  });

  it("returns everything as leftover when nothing groups", () => {
    const result = groupDeclaredTiles(parseHand("19m"));
    expect(result.melds).toEqual([]);
    expect(result.leftover).toEqual(parseHand("19m"));
  });

  it("handles an empty input", () => {
    expect(groupDeclaredTiles([])).toEqual({ melds: [], leftover: [] });
  });
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

  it("leaves a bare 4-of-a-kind as plain free tiles - concealed-kong detection happens during decomposition, not parsing", () => {
    const parsed = parseScoringHand("1111z123456789m11t22b");
    expect(parsed.declaredMelds).toHaveLength(0);
    expect(parsed.freeTiles.filter((t) => t.suit === "z" && t.rank === 1)).toHaveLength(4);
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

  it("reads a rank held all 4 copies as either a concealed kong or a triplet+run split", () => {
    // 222234t: 4 copies of 2, one 3, one 4 - valid either as a kong (222234
    // -> kong 2222 leaves 3,4 stranded, invalid) or as triplet 222 + run
    // 234 (valid) - only the latter should actually succeed here.
    const parsed = parseScoringHand("222234t123456789m22b");
    const results = decomposeHandAll(parsed.freeTiles, 5);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const tKinds = r.melds.filter((m) => m.tiles[0].suit === "t").map((m) => m.kind).sort();
      expect(tKinds).toEqual(["run", "triplet"]);
    }
  });

  it("reads a rank held all 4 copies as a genuine concealed kong when no run alternative exists", () => {
    // 1111z: honors have no runs, so this can only ever be a kong. 18 free
    // tiles total (the extra tile the kong itself contributes) -> 5 melds
    // (the kong + 3 m-runs + 1 t-run) + pair.
    const parsed = parseScoringHand("1111z123456789m234t22b");
    const results = decomposeHandAll(parsed.freeTiles, 5);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.melds.some((m) => m.kind === "kong" && m.tiles[0].suit === "z")).toBe(true);
    }
  });
});

describe("scoreHand", () => {
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
    // Every reading of this hand is concealed either way, so 門前清 applies
    // regardless of which decomposition wins - this just confirms scoring
    // doesn't crash or double-count across multiple candidate decompositions.
    const result = scoreHand("111222333m111z456b22t", ctx());
    expect(result.matched.filter((m) => m.pattern.id === "concealed-except-kongs")).toHaveLength(1);
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
  describe("底 (base tai)", () => {
    it("applies unconditionally to every completed hand", () => {
      expect(tai(scoreHand("123456789m111z234t22b", ctx()), "base-tai")).toBe(5);
      expect(tai(scoreHand("123m123m123t456b111z22z", ctx()), "base-tai")).toBe(5);
    });
  });

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

  describe("爛花 (wrong-flower)", () => {
    it("stacks 2 tai per bonus tile that doesn't match the seat wind", () => {
      const parsed = parseScoringHand("123456789m111z234t22b");
      parsed.bonusTiles.push({ kind: "flower", rank: 2 }, { kind: "season", rank: 3 });
      const result = scoreParsedHand(parsed, ctx({ seatWind: 1 }));
      expect(tai(result, "wrong-flower")).toBe(4);
      expect(tai(result, "correct-flower")).toBe(0);
    });

    it("doesn't count a bonus tile that matches the seat wind", () => {
      const parsed = parseScoringHand("123456789m111z234t22b");
      parsed.bonusTiles.push({ kind: "flower", rank: 1 });
      const result = scoreParsedHand(parsed, ctx({ seatWind: 1 }));
      expect(tai(result, "wrong-flower")).toBe(0);
      expect(tai(result, "correct-flower")).toBe(2);
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

  describe("爛位風/正位風 (single wind meld vs. seat wind)", () => {
    const eastMeldHand = "(111z)123456789m234t22b"; // one wind meld: East.

    it("scores 正位風 when the wind meld matches, not 爛位風", () => {
      const result = scoreHand(eastMeldHand, ctx({ seatWind: 1 }));
      expect(tai(result, "correct-seat-wind")).toBe(2);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
    });

    it("scores 爛位風 when the wind meld doesn't match, not 正位風", () => {
      const result = scoreHand(eastMeldHand, ctx({ seatWind: 2 }));
      expect(tai(result, "wrong-seat-wind")).toBe(2);
      expect(tai(result, "correct-seat-wind")).toBe(0);
    });

    it("scores neither with no wind meld at all", () => {
      const result = scoreHand("111222333m444555t22b", ctx()); // no honors anywhere
      expect(tai(result, "correct-seat-wind")).toBe(0);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
    });

    it("正圈風 is always 0 tai (placeholder), regardless of round wind match", () => {
      expect(tai(scoreHand(eastMeldHand, ctx({ roundWind: 1 })), "correct-round-wind")).toBe(0);
      expect(tai(scoreHand(eastMeldHand, ctx({ roundWind: 3 })), "correct-round-wind")).toBe(0);
    });
  });

  describe("小三風/大三風 and exclusion of the single-wind patterns", () => {
    it("scores 小三風 for 2 wind melds + the spare wind as pair, excluding the singles", () => {
      const result = scoreHand("(111z)(222z)123456789m33z", ctx({ seatWind: 1, roundWind: 1 }));
      expect(tai(result, "small-three-winds")).toBe(30);
      expect(tai(result, "correct-seat-wind")).toBe(0);
      expect(tai(result, "wrong-seat-wind")).toBe(0);
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
    it("scores when every tile in the hand is an honor, excluding 混老頭 (which needs at least one terminal)", () => {
      const result = scoreHand("(111z)(222z)(333z)(444z)(555z)66z", ctx());
      expect(tai(result, "all-honors")).toBe(160);
      expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
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
    it("scores when exactly 2 of the 3 numbered suits are used and there are no honors", () => {
      const result = scoreHand("123456789m234t678t55t", ctx());
      expect(tai(result, "missing-one-suit")).toBe(10);
    });

    it("doesn't score when all 3 numbered suits are used", () => {
      const result = scoreHand("123456789m234t678t22b", ctx());
      expect(tai(result, "missing-one-suit")).toBe(0);
    });

    it("doesn't score when the pair is honors, even with exactly 2 suits used", () => {
      const result = scoreHand("123123678678m777b11z", ctx());
      expect(tai(result, "missing-one-suit")).toBe(0);
    });

    it("doesn't score when an honor meld is present, even with a non-honor pair and exactly 2 suits used", () => {
      const result = scoreHand("222b444b777b66b444m111z", ctx());
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

  it("counts all 4 combinations when both the low and high segments are duplicated (123m123m456m789m789m) - not just 2 paired by index", () => {
    // Every one of the 2 low copies can pair with every one of the 2 high
    // copies while still sharing the single 456m - 2x2 = 4 instances, not
    // the 2 a naive index-zip would find.
    const result = scoreHand("123m123m456m789m789m55z", ctx());
    expect(tai(result, "pure-straight-hidden")).toBe(80); // 4 instances x 20
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

  it("counts all 4 combinations when both 123 and 789 are duplicated (2x2), not just 2 paired by index", () => {
    const result = scoreHand("123m123m789m789m456t22b", ctx());
    expect(tai(result, "old-young-run")).toBe(12); // 4 instances x 3
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

describe("PATTERNS: 混帶X (common rank across every non-honor meld)", () => {
  it("scores when every non-honor meld shares rank 3 (the pair is exempt)", () => {
    const result = scoreHand("123234345m333b123t11z", ctx());
    expect(tai(result, "mixed-common-rank")).toBe(30);
  });

  it("doesn't score when no single rank is common to every non-honor meld", () => {
    const result = scoreHand("123456789m111z234t22b", ctx());
    expect(tai(result, "mixed-common-rank")).toBe(0);
  });

  it("an honor meld is exempt from needing the common rank too", () => {
    const result = scoreHand("123234345m333b111z33t", ctx());
    expect(tai(result, "mixed-common-rank")).toBe(30);
  });

  it("the pair must also match the shared rank, unless the pair itself is honors", () => {
    // Same shape as above, but the pair (22t) doesn't match the shared rank
    // 3 and isn't honors either.
    expect(tai(scoreHand("123234345m333b111z22t", ctx()), "mixed-common-rank")).toBe(0);
    // An honor pair is exempt even though it doesn't numerically match.
    expect(tai(scoreHand("123234345m333b111z22z", ctx()), "mixed-common-rank")).toBe(30);
  });
});

describe("PATTERNS: 混帶XY (common rank pair across every non-honor meld)", () => {
  it("scores when every non-honor meld shares ranks 2 and 3, excluding 混帶X", () => {
    const result = scoreHand("123234m123t123b11122z", ctx());
    expect(tai(result, "mixed-common-rank-pair")).toBe(50);
    expect(tai(result, "mixed-common-rank")).toBe(0);
  });

  it("doesn't score when only a single rank (not a pair) is common to every meld", () => {
    const result = scoreHand("123234345m333b123t11z", ctx());
    expect(tai(result, "mixed-common-rank-pair")).toBe(0);
    expect(tai(result, "mixed-common-rank")).toBe(30);
  });
});

describe("PATTERNS: 混帶XYZ (common rank triple across every non-honor meld)", () => {
  it("scores when every non-honor meld shares ranks 1, 2, and 3, excluding 混帶XY", () => {
    const result = scoreHand("123m123b123m11122233z", ctx());
    expect(tai(result, "mixed-common-rank-triple")).toBe(60);
    expect(tai(result, "mixed-common-rank-pair")).toBe(0);
    expect(tai(result, "mixed-common-rank")).toBe(0);
  });

  it("still counts with only a single non-honor meld - a run trivially shares its own 3 ranks", () => {
    const result = scoreHand("111z222z555z666z123m33z", ctx());
    expect(tai(result, "mixed-common-rank-triple")).toBe(60);
  });

  it("a lone triplet/kong never qualifies (only 1 distinct rank, never 3)", () => {
    const result = scoreHand("111z222z555z666z333t22b", ctx());
    expect(tai(result, "mixed-common-rank-triple")).toBe(0);
  });
});

describe("PATTERNS: 全帶X (common rank across every meld and the pair, no honors)", () => {
  it("scores when every meld and the pair all share rank 2 - 222234t splits as triplet+run, not a kong - excluding 混帶X", () => {
    const result = scoreHand("123234m222234t123b22b", ctx());
    expect(tai(result, "pure-common-rank")).toBe(120);
    expect(tai(result, "mixed-common-rank")).toBe(0);
  });

  it("doesn't score once any honor meld or honor pair is present", () => {
    expect(tai(scoreHand("123456789m111z234t22b", ctx()), "pure-common-rank")).toBe(0);
  });
});

describe("PATTERNS: 混帶么 (honor presence + terminal in every non-honor meld)", () => {
  it("scores with an honor meld and a terminal in every non-honor meld", () => {
    const result = scoreHand("123m789m123t111z789b22b", ctx());
    expect(tai(result, "mixed-terminal")).toBe(40);
  });

  it("doesn't score once any non-honor meld lacks a terminal", () => {
    const result = scoreHand("123m456m123t111z789b22b", ctx());
    expect(tai(result, "mixed-terminal")).toBe(0);
  });

  it("doesn't score without any honor presence, even if every meld has a terminal", () => {
    const result = scoreHand("123m789m123t789t789b22b", ctx());
    expect(tai(result, "mixed-terminal")).toBe(0);
  });
});

describe("PATTERNS: 全帶么 (no honors, terminal in every meld and the pair)", () => {
  it("scores when every meld and the pair contain a terminal, no honors anywhere", () => {
    const result = scoreHand("123m789m123t789t123b99b", ctx());
    expect(tai(result, "pure-terminal")).toBe(80);
  });

  it("doesn't score once the pair itself lacks a terminal", () => {
    const result = scoreHand("123m789m123t789t123b22b", ctx());
    expect(tai(result, "pure-terminal")).toBe(0);
  });

  it("doesn't score once any honor meld or honor pair is present", () => {
    expect(tai(scoreHand("123456789m111z234t22b", ctx()), "pure-terminal")).toBe(0);
  });
});

describe("PATTERNS: 混老頭/清老頭 (all triplets/kongs, terminals and/or honors)", () => {
  it("scores 混老頭 for all-triplet terminal+honor tiles, excluding the 帶么 patterns", () => {
    const result = scoreHand("111m999m111z555z999t11b", ctx());
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(100);
    expect(tai(result, "mixed-terminal")).toBe(0);
    expect(tai(result, "pure-terminal")).toBe(0);
  });

  it("scores 清老頭 for all-triplet terminal-only tiles (no honors), excluding the 帶么 patterns and 混老頭", () => {
    const result = scoreHand("111m999m111t999t999b11b", ctx());
    expect(tai(result, "pure-terminal-triplets")).toBe(200);
    expect(tai(result, "mixed-terminal")).toBe(0);
    expect(tai(result, "pure-terminal")).toBe(0);
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
  });

  it("stacks with 對對胡 (not excluded)", () => {
    const result = scoreHand("111m999m111z555z999t11b", ctx());
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(100);
    expect(tai(result, "all-triplets")).toBe(40);
  });

  it("doesn't score either once any run is present", () => {
    const result = scoreHand("123m789m123t789t123b99b", ctx());
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
    expect(tai(result, "pure-terminal-triplets")).toBe(0);
  });
});

describe("PATTERNS: 明/暗四歸一 (triplet + run using all 4 copies of a rank)", () => {
  it("scores 暗四歸一 for a fully concealed triplet+run split", () => {
    const result = scoreHand("123m222m777m999b777t11z", ctx());
    expect(tai(result, "four-returns-to-one-hidden")).toBe(15);
    expect(tai(result, "four-returns-to-one-open")).toBe(0);
  });

  it("scores 明四歸一 once the triplet half is declared", () => {
    const result = scoreHand("(222m)123m777m999b777t11z", ctx());
    expect(tai(result, "four-returns-to-one-open")).toBe(5);
    expect(tai(result, "four-returns-to-one-hidden")).toBe(0);
  });
});

describe("PATTERNS: 明/暗四歸二 (pair + 2 runs using all 4 copies of a rank)", () => {
  it("scores 暗四歸二 for a fully concealed pair+2-runs split", () => {
    const result = scoreHand("123m234m22m789t789b111z", ctx());
    expect(tai(result, "four-returns-to-two-hidden")).toBe(30);
    expect(tai(result, "four-returns-to-two-open")).toBe(0);
  });
});

describe("PATTERNS: 明/暗四歸四 (4 runs using all 4 copies of a rank)", () => {
  it("scores 暗四歸四 for 4 concealed runs all containing the same rank", () => {
    const result = scoreHand("234m234m345m456m777t99b", ctx());
    expect(tai(result, "four-returns-to-four-hidden")).toBe(60);
    expect(tai(result, "four-returns-to-four-open")).toBe(0);
  });

  it("stacks 3 instances for 4 identical runs (123m x4) - one per rank (1m/2m/3m), not capped at 1", () => {
    const result = scoreHand("123m123m123m123m456t55z", ctx());
    expect(tai(result, "four-returns-to-four-hidden")).toBe(180);
    expect(tai(result, "four-returns-to-four-open")).toBe(0);
  });
});

describe("PATTERNS: 明/暗般高 (identical sequences)", () => {
  it("scores 暗般高 once for a single pair of identical concealed runs", () => {
    const result = scoreHand("123m123m456t789t111z22b", ctx());
    expect(tai(result, "identical-sequences-hidden")).toBe(8);
    expect(tai(result, "identical-sequences-open")).toBe(0);
  });

  it("scores 明般高 once one of the two identical runs is declared", () => {
    const result = scoreHand("(123m)123m456t789t111z22b", ctx());
    expect(tai(result, "identical-sequences-open")).toBe(5);
    expect(tai(result, "identical-sequences-hidden")).toBe(0);
  });
});

describe("PATTERNS: 明/暗小雙般高 (pair at one end of twin sequences)", () => {
  it("scores 暗小雙般高 for 22334455m, excluding 般高", () => {
    const result = scoreHand("22334455m111z789t789b", ctx());
    expect(tai(result, "small-twin-identical-sequences-hidden")).toBe(15);
    expect(tai(result, "identical-sequences-hidden")).toBe(0);
  });
});

describe("PATTERNS: 明/暗一色三同順 (3 identical sequences)", () => {
  it("scores 暗一色三同順 for 3 concealed identical runs, excluding 般高", () => {
    // No honor meld this time (just an honor pair) - keeps the competing
    // triplet-reading's score (三/四暗刻 + 大三連刻 + 二連刻) below what the
    // run-reading scores here, so max-tai correctly picks the run reading.
    const result = scoreHand("123m123m123m456t789b22z", ctx());
    expect(tai(result, "triple-identical-sequences-hidden")).toBe(60);
    expect(tai(result, "identical-sequences-hidden")).toBe(0);
  });
});

describe("PATTERNS: 明/暗一色四同順 (4 identical sequences)", () => {
  it("scores 暗一色四同順 for 4 concealed identical runs, excluding 般高 and 三同順", () => {
    const result = scoreHand("123m123m123m123m456b22z", ctx());
    expect(tai(result, "quadruple-identical-sequences-hidden")).toBe(160);
    expect(tai(result, "identical-sequences-hidden")).toBe(0);
    expect(tai(result, "triple-identical-sequences-hidden")).toBe(0);
  });
});

describe("PATTERNS: 明/暗真雙般高 (2 separate identical-sequence pairs)", () => {
  it("scores 暗真雙般高 for 123123m + 678678t, excluding 般高", () => {
    const result = scoreHand("123m123m678t678t456b22z", ctx());
    expect(tai(result, "two-separate-identical-sequences-hidden")).toBe(40);
    expect(tai(result, "identical-sequences-hidden")).toBe(0);
  });

  it("doesn't score 暗真雙般高 for 4 identical runs of the same shape (123m x4) - that's 一色四同順, not two separate shapes", () => {
    const result = scoreHand("123m123m123m123m456t55z", ctx());
    expect(tai(result, "quadruple-identical-sequences-hidden")).toBe(160);
    expect(tai(result, "two-separate-identical-sequences-hidden")).toBe(0);
  });
});

describe("PATTERNS: 明/暗單色步步高 (3 ascending sequences, gap 1)", () => {
  it("scores 暗單色步步高 once for 123m234m345m", () => {
    const result = scoreHand("123m234m345m789t111z22b", ctx());
    expect(tai(result, "same-suit-consecutive-hidden")).toBe(30);
  });

  it("counts twice for 123m234m345m345m (the duplicate 345m reuses 123m/234m)", () => {
    const result = scoreHand("123m234m345m345m111z22b", ctx());
    expect(tai(result, "same-suit-consecutive-hidden")).toBe(60);
  });
});

describe("PATTERNS: 明/暗單色二步高 (3 sequences, gap 2)", () => {
  it("scores 暗單色二步高 once for 123m345m567m", () => {
    const result = scoreHand("123m345m567m111z789t22b", ctx());
    expect(tai(result, "same-suit-two-step-hidden")).toBe(15);
  });

  it("counts twice for 123m345m567m567m (the duplicate 567m reuses 123m/345m)", () => {
    const result = scoreHand("123m345m567m567m111z22b", ctx());
    expect(tai(result, "same-suit-two-step-hidden")).toBe(30);
  });
});

describe("PATTERNS: 二連刻 (2 consecutive triplets/kongs)", () => {
  it("scores once for 222m333m", () => {
    expect(tai(scoreHand("222m333m789t456b789b11z", ctx()), "consecutive-triplet-pair")).toBe(5);
  });

  it("still counts with a kong involved (222m3333m)", () => {
    expect(tai(scoreHand("222m3333m456t789t789b22b", ctx()), "consecutive-triplet-pair")).toBe(5);
  });
});

describe("PATTERNS: 小三連刻/大三連刻", () => {
  it("scores 小三連刻 for 22m333m444m (pair at the low end), excluding 二連刻", () => {
    const result = scoreHand("333m444m789t456b789b22m", ctx());
    expect(tai(result, "small-three-consecutive-triplets")).toBe(15);
    expect(tai(result, "consecutive-triplet-pair")).toBe(0);
  });

  it("scores 大三連刻 for 333m444m555m (no pair involved), excluding 二連刻", () => {
    const result = scoreHand("333m444m555m789t111z22b", ctx());
    expect(tai(result, "big-three-consecutive-triplets")).toBe(30);
    expect(tai(result, "consecutive-triplet-pair")).toBe(0);
  });

  it("stacks 3 instances of 大三連刻 for 111m222m333m444m555m - overlapping windows [1,2,3]/[2,3,4]/[3,4,5]", () => {
    const result = scoreHand("111m222m333m444m555m22z", ctx());
    expect(tai(result, "big-three-consecutive-triplets")).toBe(90); // 3 instances x 30
  });

  it("stacks 3 instances of 小三連刻 when the pair sits in the middle of 4 flanking triplets (1m/2m/4m/5m around a 3m pair)", () => {
    const result = scoreHand("111m222m444m555m33m789t", ctx());
    expect(tai(result, "small-three-consecutive-triplets")).toBe(45); // 3 instances x 15
  });
});

describe("PATTERNS: 混一色/清一色", () => {
  it("scores 混一色 for a hand using only one numbered suit plus honors", () => {
    const result = scoreHand("123456789m111z555z22m", ctx());
    expect(tai(result, "half-flush")).toBe(40);
  });

  it("scores 清一色 for a hand using only one numbered suit and no honors, excluding 混一色", () => {
    const result = scoreHand("123456789m123m456m22m", ctx());
    expect(tai(result, "full-flush")).toBe(120);
    expect(tai(result, "half-flush")).toBe(0);
  });
});

describe("PATTERNS: 相逢/明三相逢/暗三相逢/明四相逢/暗四相逢/明五相逢/暗五相逢 (same run across suits)", () => {
  it("scores 相逢 once for 234m+234t (2 suits, same run)", () => {
    const result = scoreHand("234m234t567b789b111z22z", ctx());
    expect(tai(result, "cross-suit-same-run")).toBe(3);
  });

  it("scores 明三相逢 for 567m+567t+567b with one run exposed, excluding 相逢", () => {
    const result = scoreHand("(567m)567t567b111z222z33z", ctx());
    expect(tai(result, "three-suit-same-run-open")).toBe(10);
    expect(tai(result, "three-suit-same-run-hidden")).toBe(0);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });

  it("scores 暗三相逢 for 567m+567t+567b fully concealed, excluding 相逢", () => {
    const result = scoreHand("567m567t567b111z222z33z", ctx());
    expect(tai(result, "three-suit-same-run-hidden")).toBe(20);
    expect(tai(result, "three-suit-same-run-open")).toBe(0);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });

  it("scores 明四相逢 for 456m456m456t456b (one suit doubled) with a run exposed, excluding the lower tiers", () => {
    const result = scoreHand("(456m)456m456t456b111z22z", ctx());
    expect(tai(result, "four-suit-same-run-open")).toBe(40);
    expect(tai(result, "three-suit-same-run-open")).toBe(0);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });

  it("scores 暗四相逢 for 456m456m456t456b fully concealed, excluding the lower tiers", () => {
    const result = scoreHand("456m456m456t456b111z22z", ctx());
    expect(tai(result, "four-suit-same-run-hidden")).toBe(80);
    expect(tai(result, "three-suit-same-run-hidden")).toBe(0);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });

  it("scores 明五相逢 for 234234m234234t234b (5 runs, 2+2+1) with a run exposed, excluding every lower tier", () => {
    const result = scoreHand("(234m)234m234t234t234b22z", ctx());
    expect(tai(result, "five-suit-same-run-open")).toBe(80);
    expect(tai(result, "four-suit-same-run-open")).toBe(0);
    expect(tai(result, "three-suit-same-run-open")).toBe(0);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });

  it("scores 暗五相逢 for 234234234m234t234b (5 runs, 3+1+1) fully concealed, excluding every lower tier", () => {
    const result = scoreHand("234m234m234m234t234b22z", ctx());
    expect(tai(result, "five-suit-same-run-hidden")).toBe(160);
    expect(tai(result, "four-suit-same-run-hidden")).toBe(0);
    expect(tai(result, "three-suit-same-run-hidden")).toBe(0);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });
});

describe("PATTERNS: 雙姊妹 (2 distinct 相逢 instances)", () => {
  it("scores for 123m+123b and 678t+678b (2 distinct instances, no shared meld)", () => {
    const result = scoreHand("123m123b678t678b111z22z", ctx());
    expect(tai(result, "cross-suit-same-run")).toBe(6);
    expect(tai(result, "twin-cross-suit-runs")).toBe(5);
  });

  it("doesn't score for 123m+123m+123t - only 1 instance forms, the 2nd 123m has nothing to pair with", () => {
    const result = scoreHand("123m123m123t456b111z22z", ctx());
    expect(tai(result, "cross-suit-same-run")).toBe(3);
    expect(tai(result, "twin-cross-suit-runs")).toBe(0);
  });
});

describe("PATTERNS: 全姊妹 (every meld is part of a 相逢)", () => {
  it("scores for 123m123m123t678b678t77z - the 2nd 123m still counts (123t is its partner too), excluding 雙姊妹", () => {
    const result = scoreHand("123m123m123t678b678t77z", ctx());
    expect(tai(result, "full-cross-suit-runs")).toBe(20);
    expect(tai(result, "cross-suit-same-run")).toBe(6);
    expect(tai(result, "twin-cross-suit-runs")).toBe(0);
  });

  it("scores for 345t345t345b345b345m55z, even though 相逢 itself is excluded by 暗五相逢", () => {
    const result = scoreHand("345t345t345b345b345m55z", ctx());
    expect(tai(result, "full-cross-suit-runs")).toBe(20);
    expect(tai(result, "five-suit-same-run-hidden")).toBe(160);
    expect(tai(result, "cross-suit-same-run")).toBe(0);
  });

  it("doesn't score when at least one meld has no same-start-rank partner in another suit", () => {
    const result = scoreHand("123m123m123t456b111z22z", ctx());
    expect(tai(result, "full-cross-suit-runs")).toBe(0);
  });
});

describe("PATTERNS: 樓梯 (5 runs, consecutive starting ranks, any suit)", () => {
  it("scores for 123t+234b+345t+456m+567m (starts 1-5, suits unrestricted)", () => {
    const result = scoreHand("123t234b345t456m567m77z", ctx());
    expect(tai(result, "staircase")).toBe(20);
    expect(tai(result, "all-runs")).toBe(5);
  });

  it("doesn't score when the starting ranks aren't consecutive", () => {
    const result = scoreHand("123456789m123m456m22m", ctx());
    expect(tai(result, "staircase")).toBe(0);
  });

  it("doesn't score when a triplet/kong is involved", () => {
    const result = scoreHand("123m234m345m456m111z22z", ctx());
    expect(tai(result, "staircase")).toBe(0);
  });
});

describe("PATTERNS: 五步高/全碟 (stricter 樓梯: same suit or a fixed rotation)", () => {
  it("scores for 234t345m456b567t678m (rotation t,m,b,t,m - positions 4/5 repeat 1/2), excluding 樓梯", () => {
    const result = scoreHand("234t345m456b567t678m55z", ctx());
    expect(tai(result, "rotating-staircase")).toBe(40);
    expect(tai(result, "staircase")).toBe(0);
  });

  it("doesn't score for 234t345m456b567m678t - position 4 (m) doesn't repeat position 1 (t)", () => {
    const result = scoreHand("234t345m456b567m678t55z", ctx());
    expect(tai(result, "rotating-staircase")).toBe(0);
    expect(tai(result, "staircase")).toBe(20);
  });

  it("scores when all 5 runs are the same suit, excluding 樓梯", () => {
    const result = scoreHand("123m234m345m456m567m22z", ctx());
    expect(tai(result, "rotating-staircase")).toBe(40);
    expect(tai(result, "staircase")).toBe(0);
  });
});

describe("PATTERNS: 三寶 (range restriction + all-simples + suit purity/missing-one-suit)", () => {
  it("scores via 缺五 + 斷么 + 清一色, stacking additively with all 3 constituents", () => {
    const result = scoreHand("234t234t678t678t678t33t", ctx());
    expect(tai(result, "three-treasures")).toBe(40);
    expect(tai(result, "no-fives")).toBe(10);
    expect(tai(result, "all-simples")).toBe(10);
    expect(tai(result, "full-flush")).toBe(120);
  });

  it("scores via 缺五 + 斷么 + 缺一門, stacking additively with all 3 constituents", () => {
    const result = scoreHand("234t234t678b678b678b33t", ctx());
    expect(tai(result, "three-treasures")).toBe(40);
    expect(tai(result, "no-fives")).toBe(10);
    expect(tai(result, "all-simples")).toBe(10);
    expect(tai(result, "missing-one-suit")).toBe(10);
  });

  it("doesn't score when 斷么 fails (a terminal is present), even though 缺五 and 清一色 both hold", () => {
    const result = scoreHand("123m123m678m678m678m33m", ctx());
    expect(tai(result, "three-treasures")).toBe(0);
    expect(tai(result, "no-fives")).toBe(10);
    expect(tai(result, "full-flush")).toBe(120);
  });
});

describe("PATTERNS: 兩兄弟/小三兄弟/大三兄弟 (same-rank triplet/kong across suits)", () => {
  it("scores 兩兄弟 for 555t+555b (2 suits, same rank)", () => {
    const result = scoreHand("555t555b123m456m111z22z", ctx());
    expect(tai(result, "cross-suit-same-triplet")).toBe(5);
  });

  it("scores 小三兄弟 for 33t+333m+3333b (pair at one suit, triplet/kong at the other 2), excluding 兩兄弟", () => {
    const result = scoreHand("333m3333b456m789t111z33t", ctx());
    expect(tai(result, "small-three-brothers")).toBe(20);
    expect(tai(result, "cross-suit-same-triplet")).toBe(0);
    expect(tai(result, "big-three-brothers")).toBe(0);
  });

  it("scores 大三兄弟 for 555m+555t+555b (no pair involved), excluding 兩兄弟", () => {
    const result = scoreHand("555m555t555b111z123b22z", ctx());
    expect(tai(result, "big-three-brothers")).toBe(40);
    expect(tai(result, "cross-suit-same-triplet")).toBe(0);
  });
});

describe("PATTERNS: 小三色連刻/大三色連刻 (consecutive ranks across suits)", () => {
  it("scores 小三色連刻 for 33m+444t+555b (pair at one suit, triplets at the other 2, consecutive ranks)", () => {
    const result = scoreHand("444t555b678m111z222z33m", ctx());
    expect(tai(result, "small-three-color-consecutive-triplets")).toBe(10);
  });

  it("scores 大三色連刻 for 333t+4444m+555b (no pair involved, consecutive ranks)", () => {
    const result = scoreHand("333t4444m555b111z678t22z", ctx());
    expect(tai(result, "big-three-color-consecutive-triplets")).toBe(20);
  });
});

describe("PATTERNS: 明/暗三色步步高 (3 suits, runs increasing by 1)", () => {
  it("scores 明三色步步高 for 456t+567m+678b with one run exposed", () => {
    const result = scoreHand("(456t)567m678b111z333z22z", ctx());
    expect(tai(result, "three-color-step-up-open")).toBe(5);
  });

  it("scores 暗三色步步高 for 234m+345t+456b fully concealed", () => {
    const result = scoreHand("234m345t456b111z333z22z", ctx());
    expect(tai(result, "three-color-step-up-hidden")).toBe(10);
    expect(tai(result, "three-color-step-up-open")).toBe(0);
  });

  it("stacks 3 instances for 123456m234567t34599b - each shifted by 1 rank, sharing the lone 345b run", () => {
    // 123m+234t+345b, 234t+345b+456m, and 345b+456m+567t all qualify.
    const result = scoreHand("123456m234567t34599b", ctx());
    expect(tai(result, "three-color-step-up-hidden")).toBe(30); // 3 instances x 10
    expect(tai(result, "three-color-step-up-open")).toBe(0);
  });
});

describe("PATTERNS: 對碰 (shanpon: dual-pair wait completed into a triplet)", () => {
  it("scores when the winning tile completes a triplet from what was a pair - e.g. tenpai on 44m+44t", () => {
    const result = scoreHand("444m123b456b789b111z44t", ctx({ winningTile: { suit: "m", rank: 4 } }));
    expect(tai(result, "shanpon-wait")).toBe(2);
  });

  it("doesn't score when the winning tile instead completes a run", () => {
    const result = scoreHand("444m123b456b789b111z44t", ctx({ winningTile: { suit: "b", rank: 1 } }));
    expect(tai(result, "shanpon-wait")).toBe(0);
  });

  it("doesn't score when no winning tile is recorded", () => {
    const result = scoreHand("444m123b456b789b111z44t", ctx());
    expect(tai(result, "shanpon-wait")).toBe(0);
  });
});

describe("PATTERNS: 將眼 (pair is 2, 5, or 8 - not honors)", () => {
  it("scores when the pair is 5", () => {
    const result = scoreHand("123456789m234t678t55b", ctx());
    expect(tai(result, "middle-tile-pair")).toBe(2);
  });

  it("doesn't score when the pair's rank isn't 2, 5, or 8", () => {
    const result = scoreHand("123456789m234t678t11b", ctx());
    expect(tai(result, "middle-tile-pair")).toBe(0);
  });

  it("doesn't score when the pair is an honor tile, even at rank 2", () => {
    const result = scoreHand("123456789m234t678t22z", ctx());
    expect(tai(result, "middle-tile-pair")).toBe(0);
  });
});

describe("PATTERNS: 獨獨/假獨 (genuine vs. fake single wait)", () => {
  it("scores 假獨 for 12334m completed by 2m - looks like 13m waiting on 2m only, even though the true wait was also open to 5m", () => {
    const result = scoreHand("123m234m678t111z789b22z", ctx({ winningTile: { suit: "m", rank: 2 } }));
    expect(tai(result, "fake-single-wait")).toBe(2);
    expect(tai(result, "genuine-single-wait")).toBe(0);
  });

  it("scores 獨獨 for a genuine kanchan wait (13m waiting on 2m only, no overlapping alternate reading), excluding 假獨", () => {
    const result = scoreHand("123m456m789t111z234b22b", ctx({ winningTile: { suit: "m", rank: 2 } }));
    expect(tai(result, "genuine-single-wait")).toBe(2);
    expect(tai(result, "fake-single-wait")).toBe(0);
  });

  it("neither scores when no winning tile is recorded", () => {
    const result = scoreHand("123m234m678t111z789b22z", ctx());
    expect(tai(result, "genuine-single-wait")).toBe(0);
    expect(tai(result, "fake-single-wait")).toBe(0);
  });
});

describe("PATTERNS: 門前清 (concealed hand)", () => {
  it("scores when the only declared meld is a kong", () => {
    const result = scoreHand("(1111z)123456789m234t22b", ctx());
    expect(tai(result, "concealed-except-kongs")).toBe(5);
  });

  it("doesn't score when a declared triplet is present", () => {
    const result = scoreHand("(111z)123456789m234t22b", ctx());
    expect(tai(result, "concealed-except-kongs")).toBe(0);
  });
});

describe("PATTERNS: 自摸/門清自摸 (self-drawn win)", () => {
  it("scores plain 自摸 when a declared meld is present, not 門清自摸", () => {
    const result = scoreHand("(111z)123456789m234t22b", ctx({ selfDraw: true }));
    expect(tai(result, "self-draw")).toBe(1);
    expect(tai(result, "concealed-self-draw")).toBe(0);
  });

  it("scores 門清自摸 when 門前清 holds too, excluding plain 自摸", () => {
    const result = scoreHand("123456789m234t678t22b", ctx({ selfDraw: true }));
    expect(tai(result, "concealed-self-draw")).toBe(3);
    expect(tai(result, "self-draw")).toBe(0);
    expect(tai(result, "concealed-except-kongs")).toBe(5);
  });

  it("neither scores when the win wasn't self-drawn", () => {
    const result = scoreHand("123456789m234t678t22b", ctx());
    expect(tai(result, "self-draw")).toBe(0);
    expect(tai(result, "concealed-self-draw")).toBe(0);
  });
});

describe("PATTERNS: 全求人/半求人 (all melds declared)", () => {
  const allDeclaredHand = "(111z)(222z)(123m)(456m)(789m)55t";
  const oneConcealedHand = "(111z)(222z)(123m)(456m)789m55t";

  it("scores 全求人 when every meld is declared and the win is claimed", () => {
    const result = scoreHand(allDeclaredHand, ctx());
    expect(tai(result, "everyone-else-completes-it")).toBe(30);
    expect(tai(result, "half-everyone-else-completes-it")).toBe(0);
  });

  it("scores 半求人 when every meld is declared and the win is self-drawn", () => {
    const result = scoreHand(allDeclaredHand, ctx({ selfDraw: true }));
    expect(tai(result, "half-everyone-else-completes-it")).toBe(15);
    expect(tai(result, "everyone-else-completes-it")).toBe(0);
  });

  it("neither scores when one meld is still concealed", () => {
    expect(tai(scoreHand(oneConcealedHand, ctx()), "everyone-else-completes-it")).toBe(0);
    expect(tai(scoreHand(oneConcealedHand, ctx({ selfDraw: true })), "half-everyone-else-completes-it")).toBe(0);
  });
});

describe("PATTERNS: 大雞/大鴨 (nothing but the base + at most one bonus tile)", () => {
  const boringHand = "(123m)222b234t567t789b22z";

  it("scores 大雞 for a hand with no other pattern detected", () => {
    const result = scoreHand(boringHand, ctx());
    expect(tai(result, "big-chicken")).toBe(30);
    expect(tai(result, "big-duck")).toBe(0);
  });

  it("scores 大鴨 instead (stacking with 自摸, but not 大雞) when that same boring hand is self-drawn", () => {
    const result = scoreHand(boringHand, ctx({ selfDraw: true }));
    expect(tai(result, "big-chicken")).toBe(0);
    expect(tai(result, "big-duck")).toBe(15);
    expect(tai(result, "self-draw")).toBe(1);
  });

  it("doesn't score when another pattern is detected", () => {
    const result = scoreHand("123456789m111z234t22b", ctx());
    expect(tai(result, "big-chicken")).toBe(0);
    expect(tai(result, "big-duck")).toBe(0);
  });
});

describe("PATTERNS: 十三么 (Thirteen Orphans)", () => {
  it("scores 底 + 十三么 only, for all 13 orphan kinds + a doubled pair + one ordinary meld", () => {
    const result = scoreHand("112349m19t19b1234567z", ctx());
    expect(tai(result, "thirteen-orphans")).toBe(160);
    expect(tai(result, "base-tai")).toBe(5);
    expect(result.total).toBe(165);
    expect(result.matched).toHaveLength(2);
  });

  it("doesn't fire for an ordinary hand", () => {
    const result = scoreHand("123456789m111z234t22b", ctx());
    expect(tai(result, "thirteen-orphans")).toBe(0);
  });

  it("isn't recognized when any meld is declared, even if the free tiles alone would qualify", () => {
    expect(() => scoreHand("(123m)119m19t19b1234567z", ctx())).toThrow(ScoringError);
  });
});

describe("PATTERNS: 明/暗四歸 (Thirteen Orphans: one kind held all 4 copies)", () => {
  it("scores 暗四歸 when the quad kind (7z) is concealed - no winning tile recorded", () => {
    const result = scoreHand("19m19t19b1234567z777z1m", ctx());
    expect(tai(result, "orphans-four-return-hidden")).toBe(15);
    expect(tai(result, "orphans-four-return-open")).toBe(0);
    // A quad on an orphan kind is always also a triplet-of-orphan meld, so
    // 混老頭 (see the next describe block) fires alongside it here too.
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(100);
    expect(result.total).toBe(280);
  });

  it("still scores 暗四歸 when the win is self-drawn, even if the winning tile matches the quad", () => {
    const result = scoreHand("19m19t19b1234567z777z1m", ctx({ selfDraw: true, winningTile: { suit: "z", rank: 7 } }));
    expect(tai(result, "orphans-four-return-hidden")).toBe(15);
    expect(tai(result, "orphans-four-return-open")).toBe(0);
  });

  it("scores 明四歸 when the winning tile completed the quad and wasn't self-drawn", () => {
    const result = scoreHand("19m19t19b1234567z777z1m", ctx({ winningTile: { suit: "z", rank: 7 } }));
    expect(tai(result, "orphans-four-return-open")).toBe(5);
    expect(tai(result, "orphans-four-return-hidden")).toBe(0);
    // Marking the winning tile also makes 獨獨 (genuine single wait, +2)
    // computable and it turns out to hold for this exact hand - see the
    // dedicated 自摸/獨獨-in-special-hands describe block below.
    expect(tai(result, "genuine-single-wait")).toBe(2);
    expect(result.total).toBe(272);
  });

  it("scores 明四歸 for the quad on a numbered tile (9b) too, not just honors", () => {
    const result = scoreHand("19m19t19b1234567z999b7z", ctx({ winningTile: { suit: "b", rank: 9 } }));
    expect(tai(result, "orphans-four-return-open")).toBe(5);
    expect(result.total).toBe(272);
  });

  it("doesn't score when no orphan kind reaches 4 copies", () => {
    const result = scoreHand("112349m19t19b1234567z", ctx());
    expect(tai(result, "orphans-four-return-open")).toBe(0);
    expect(tai(result, "orphans-four-return-hidden")).toBe(0);
  });
});

describe("PATTERNS: 混帶么/混老頭 (Thirteen Orphans: the ordinary meld's own shape)", () => {
  it("scores 混帶么 when the ordinary meld is a run containing a terminal (123m)", () => {
    const result = scoreHand("111239m19t19b1234567z", ctx());
    expect(tai(result, "mixed-terminal")).toBe(40);
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
    expect(result.total).toBe(205);
  });

  it("doesn't score either when the ordinary meld has no terminal and isn't honors (234m)", () => {
    const result = scoreHand("112349m19t19b1234567z", ctx());
    expect(tai(result, "mixed-terminal")).toBe(0);
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
    expect(result.total).toBe(165);
  });

  it("scores 混老頭 (excluding 混帶么) when the ordinary meld is a terminal triplet (111m) - also a quad, so 暗四歸 stacks too", () => {
    const result = scoreHand("11119m19t19b12345677z", ctx());
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(100);
    expect(tai(result, "mixed-terminal")).toBe(0);
    expect(tai(result, "orphans-four-return-hidden")).toBe(15);
    expect(result.total).toBe(280);
  });

  it("doesn't score when the ordinary meld is an unrelated middle-rank triplet (555b)", () => {
    const result = scoreHand("119m19t19b555b1234567z", ctx());
    expect(tai(result, "mixed-terminal")).toBe(0);
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
    expect(result.total).toBe(165);
  });
});

describe("PATTERNS: 十六不搭 (Sixteen Unrelated Tiles)", () => {
  it("scores 底 + 十六不搭 only, for all 7 honors + 3 mutually-unrelated ranks per suit + a doubled pair", () => {
    // m and t happen to share ranks here (1,4,7 each) but b doesn't join
    // in, so this avoids both 不搭三相逢 (needs all 3 suits to match) and
    // 不搭雜龍 (needs the ranks to jointly span 1-9) - see their own
    // describe blocks below for those.
    const result = scoreHand("147m147t258b11234567z", ctx());
    expect(tai(result, "sixteen-unrelated")).toBe(50);
    expect(tai(result, "base-tai")).toBe(5);
    expect(result.total).toBe(55);
    expect(result.matched).toHaveLength(2);
  });

  it("doesn't fire for an ordinary hand", () => {
    const result = scoreHand("123456789m111z234t22b", ctx());
    expect(tai(result, "sixteen-unrelated")).toBe(0);
  });

  it("isn't recognized when two ranks in the same suit are too close together (gap < 3)", () => {
    // t's ranks are 2,4,8 here - only a gap of 2 between 2 and 4, so this
    // isn't a valid 十六不搭 shape, and the tiles don't form an ordinary
    // hand either (that's rather the point of "unrelated" tiles).
    expect(() => scoreHand("147m248t369b11234567z", ctx())).toThrow(ScoringError);
  });

  it("isn't recognized when any meld is declared", () => {
    expect(() => scoreHand("(123m)7m258t369b1234567z", ctx())).toThrow(ScoringError);
  });
});

describe("PATTERNS: 十六不搭(十六飛) (16-way wait - the 食胡 tile completed the pair)", () => {
  const hand = "147m147t258b11234567z"; // pair is 1z; avoids 不搭三相逢/不搭雜龍, see above

  it("scores 60 tai instead of 50 when the winning tile completed the pair", () => {
    const result = scoreHand(hand, ctx({ winningTile: { suit: "z", rank: 1 } }));
    expect(tai(result, "sixteen-unrelated-flying")).toBe(60);
    expect(tai(result, "sixteen-unrelated")).toBe(0);
    expect(result.total).toBe(65);
  });

  it("scores the base 50 tai when the winning tile completed one of the 15 singles instead", () => {
    const result = scoreHand(hand, ctx({ winningTile: { suit: "m", rank: 4 } }));
    expect(tai(result, "sixteen-unrelated")).toBe(50);
    expect(tai(result, "sixteen-unrelated-flying")).toBe(0);
    // This particular hand's 4m happens to also be a genuine single wait
    // (+2) - see the dedicated 自摸/獨獨-in-special-hands describe block.
    expect(tai(result, "genuine-single-wait")).toBe(2);
    expect(result.total).toBe(57);
  });

  it("scores the base 50 tai when no winning tile is recorded", () => {
    const result = scoreHand(hand, ctx());
    expect(tai(result, "sixteen-unrelated")).toBe(50);
    expect(tai(result, "sixteen-unrelated-flying")).toBe(0);
  });
});

describe("PATTERNS: 不搭三相逢 (十六不搭: same 3 ranks across all 3 suits)", () => {
  it("scores an extra 20 tai when all 3 suits use the same 3 ranks", () => {
    const result = scoreHand("159m159t159b12345677z", ctx());
    expect(tai(result, "sixteen-unrelated-same-ranks")).toBe(20);
    expect(tai(result, "sixteen-unrelated")).toBe(50);
    expect(result.total).toBe(75);
  });

  it("doesn't score when the suits' ranks don't all match", () => {
    const result = scoreHand("147m147t258b11234567z", ctx());
    expect(tai(result, "sixteen-unrelated-same-ranks")).toBe(0);
  });
});

describe("PATTERNS: 不搭雜龍 (十六不搭: ranks span 1-9 across all 3 suits)", () => {
  it("scores an extra 20 tai when the 3 suits' ranks jointly cover 1-9 with no overlap", () => {
    const result = scoreHand("147m258b369t12344567z", ctx());
    expect(tai(result, "sixteen-unrelated-straight")).toBe(20);
    expect(tai(result, "sixteen-unrelated")).toBe(50);
    expect(result.total).toBe(75);
  });

  it("doesn't score when the suits' ranks overlap instead of jointly spanning 1-9", () => {
    const result = scoreHand("147m147t258b11234567z", ctx());
    expect(tai(result, "sixteen-unrelated-straight")).toBe(0);
  });
});

describe("PATTERNS: 自摸/獨獨 apply to the special hands too", () => {
  it("scores 自摸 for a self-drawn 十三么", () => {
    const result = scoreHand("112349m19t19b1234567z", ctx({ selfDraw: true }));
    expect(tai(result, "self-draw")).toBe(1);
    expect(result.total).toBe(166);
  });

  it("scores 自摸 for a self-drawn 十六不搭", () => {
    const result = scoreHand("147m147t258b11234567z", ctx({ selfDraw: true }));
    expect(tai(result, "self-draw")).toBe(1);
    expect(result.total).toBe(56);
  });

  it("scores 獨獨 for a 十三么 hand where the 食胡 tile was a genuine single wait", () => {
    const result = scoreHand("19m19t19b1234567z777z1m", ctx({ winningTile: { suit: "z", rank: 7 } }));
    expect(tai(result, "genuine-single-wait")).toBe(2);
  });

  it("doesn't score 獨獨 for a 十六不搭 hand with a genuine multi-way wait", () => {
    // Pre-completion "158m14t369b..." waits on 7t/8t/9t (t's third rank
    // just needs to sit >=3 away from both 1 and 4) - a true 3-way wait,
    // not a single one, even though the completed hand is still a valid
    // 十六不搭 either way.
    const result = scoreHand("158m147t369b11234567z", ctx({ winningTile: { suit: "t", rank: 7 } }));
    expect(tai(result, "genuine-single-wait")).toBe(0);
    expect(tai(result, "sixteen-unrelated")).toBe(50);
  });

  it("scores 假獨 for a 十三么 hand where the winning tile doubles as both the ordinary meld's edge and its own single", () => {
    // Pre-completion "19m1t789t19b12345677z" waits on 6t/9t - either
    // extends the already-complete 7t8t9t run at one edge or the other.
    // Winning on 9t specifically also duplicates 9t's own single-kind
    // requirement, the same "an alternate reading pins down the winning
    // tile" ambiguity 假獨 captures elsewhere via a duplicated rank.
    const result = scoreHand("19m1t7899t19b12345677z", ctx({ winningTile: { suit: "t", rank: 9 } }));
    expect(tai(result, "fake-single-wait")).toBe(2);
    expect(tai(result, "genuine-single-wait")).toBe(0);
    expect(tai(result, "thirteen-orphans")).toBe(160);
  });

  it("doesn't score 假獨 for the same 十三么 shape when won on the other edge (6t)", () => {
    const result = scoreHand("19m1t6789t19b12345677z", ctx({ winningTile: { suit: "t", rank: 6 } }));
    expect(tai(result, "fake-single-wait")).toBe(0);
    expect(tai(result, "genuine-single-wait")).toBe(0);
    expect(tai(result, "thirteen-orphans")).toBe(160);
  });
});

describe("PATTERNS: 嚦咕嚦咕/嚦咕嚦咕八飛 (Eight Pairs)", () => {
  it("scores 底 + 嚦咕嚦咕 (50) when the pre-completion wait count is 2 or fewer", () => {
    // Pre-completion: 111m 223344m 5566777t - already has two kinds at
    // count 3 (1m and 7t). Whichever one stays "the triple," the other
    // must be bumped to 4 (2 pairs) to complete - exactly 2 valid
    // completions (1m or 7t), matching the user's own worked example.
    // This hand's own quad (1m) also picks up 明四歸 (5), and its 2m/5t
    // pairs pick up 將眼 (4), and using only 2 suits with no honors picks
    // up 缺一門 (10) - all separately-tested elsewhere; only 嚦咕嚦咕
    // itself is asserted here.
    const result = scoreHand("1111m223344m5566777t", ctx({ winningTile: { suit: "m", rank: 1 } }));
    expect(tai(result, "eight-pairs")).toBe(50);
    expect(tai(result, "eight-pairs-flying")).toBe(0);
  });

  it("scores 底 + 嚦咕嚦咕 (50) for a genuine single wait too", () => {
    // Pre-completion: 11223344t 77889m 777z - everything already paired
    // except 9m (a lone single) and 7z (already the triple) - only 9m
    // completes it.
    const result = scoreHand("11223344t778899m777z", ctx({ winningTile: { suit: "m", rank: 9 } }));
    expect(tai(result, "eight-pairs")).toBe(50);
    expect(tai(result, "eight-pairs-flying")).toBe(0);
  });

  it("scores 底 + 嚦咕嚦咕八飛 (60) when the pre-completion hand is all-even (a clean 8-pairs shape)", () => {
    // Pre-completion: 5555t 7777t 9999m 11z 7z - every kind is at an even
    // count (4,4,4,2) already, so this counts as an 8-way wait even though
    // 5t/7t/9m are already at their 4-copy cap and can't literally be
    // drawn again - only 1z/7z remain drawable, but the shape itself is
    // what counts per the user's clarified rule.
    // This hand's 5t quad also picks up 將眼 (4, rank 5) and 暗四歸 (15,
    // the found quad kind not matching the claimed 1z) - separately
    // tested elsewhere; only 嚦咕嚦咕八飛 itself is asserted here.
    const result = scoreHand("5555t7777t9999m111z77z", ctx({ winningTile: { suit: "z", rank: 1 } }));
    expect(tai(result, "eight-pairs-flying")).toBe(60);
    expect(tai(result, "eight-pairs")).toBe(0);
  });

  it("falls back to the base 50 tai when no winning tile is recorded", () => {
    const result = scoreHand("1111m223344m5566777t", ctx());
    expect(tai(result, "eight-pairs")).toBe(50);
    expect(tai(result, "eight-pairs-flying")).toBe(0);
  });

  it("doesn't fire for an ordinary hand", () => {
    const result = scoreHand("123456789m111z234t22b", ctx());
    expect(tai(result, "eight-pairs")).toBe(0);
    expect(tai(result, "eight-pairs-flying")).toBe(0);
  });

  it("isn't recognized when any meld is declared", () => {
    expect(() => scoreHand("(123m)9999m1122334455t", ctx())).toThrow(ScoringError);
  });

  it("doesn't pollute a normal decomposition's score just because the same tiles also happen to satisfy 嚦咕嚦咕's per-kind-count check", () => {
    // 4 identical runs - also passes 嚦咕嚦咕's structural check (1m/2m/3m
    // at 4 copies each) - but 一色四同順 (160) far outscores 嚦咕嚦咕 (50),
    // so the normal reading should win outright, with no stray
    // eight-pairs/eight-pairs-flying entries anywhere in the result.
    const result = scoreHand("123m123m123m123m456b22z", ctx());
    expect(tai(result, "quadruple-identical-sequences-hidden")).toBe(160);
    expect(tai(result, "eight-pairs")).toBe(0);
    expect(tai(result, "eight-pairs-flying")).toBe(0);
    expect(result.second).toBeUndefined();
  });
});

describe("PATTERNS: 明/暗四歸 applies within 嚦咕嚦咕 too", () => {
  it("scores 明四歸 when the winning tile completed a 4-copy kind, claimed", () => {
    const result = scoreHand("11112233445566m777z", ctx({ winningTile: { suit: "m", rank: 1 } }));
    expect(tai(result, "orphans-four-return-open")).toBe(5);
    expect(tai(result, "orphans-four-return-hidden")).toBe(0);
  });

  it("scores 暗四歸 for the same shape when concealed", () => {
    const result = scoreHand("11112233445566m777z", ctx());
    expect(tai(result, "orphans-four-return-hidden")).toBe(15);
    expect(tai(result, "orphans-four-return-open")).toBe(0);
  });
});

describe("PATTERNS: other patterns reused within 嚦咕嚦咕 (per the user's own list)", () => {
  it("scores 小五門齊 when all 5 categories are touched, without needing a dedicated meld per category", () => {
    const result = scoreHand("1199m1199t1199b11z555z", ctx());
    expect(tai(result, "small-five-suits")).toBe(10);
    expect(tai(result, "big-five-suits")).toBe(0);
  });

  it("scores 斷么 when every tile is ranked 2-8 with no honors", () => {
    const result = scoreHand("223344556677m22t888t", ctx());
    expect(tai(result, "all-simples")).toBe(10);
  });

  it("scores 缺一門 when only 2 numbered suits are used and no honors are present", () => {
    const result = scoreHand("11223344m556677t888t", ctx());
    expect(tai(result, "missing-one-suit")).toBe(10);
  });

  it("scores 缺五 when no tile is ranked 5 and no honors are present", () => {
    const result = scoreHand("1144m2266999t338877b", ctx());
    expect(tai(result, "no-fives")).toBe(10);
  });

  it("scores 大於五 (excluding 缺五) when every tile is ranked 6-9", () => {
    const result = scoreHand("66778899m667788999t", ctx());
    expect(tai(result, "greater-than-five")).toBe(40);
    expect(tai(result, "no-fives")).toBe(0);
  });

  it("scores 小於五 (excluding 缺五) when every tile is ranked 1-4", () => {
    const result = scoreHand("11223344m112233444t", ctx());
    expect(tai(result, "less-than-five")).toBe(40);
    expect(tai(result, "no-fives")).toBe(0);
  });

  it("scores 三寶 (stacking with its constituents) when 缺五 + 斷么 + 清一色 all hold at once", () => {
    const result = scoreHand("22223333446677888m", ctx());
    expect(tai(result, "three-treasures")).toBe(40);
    expect(tai(result, "no-fives")).toBe(10);
    expect(tai(result, "all-simples")).toBe(10);
    expect(tai(result, "full-flush")).toBe(120);
  });

  it("scores 三元嚦咕 when all 3 dragon kinds are merely present - no triplet or pair-role required", () => {
    // The user's own example: 5z/6z/7z all sit as plain pairs, nothing
    // upgraded to a triplet, nothing acting as "the pair" in the 小三元
    // sense - still qualifies.
    const result = scoreHand("112233m22333t556677z", ctx());
    expect(tai(result, "eight-pairs-three-dragons")).toBe(20);
  });

  it("scores 三風嚦咕 when at least 3 wind kinds are present", () => {
    const result = scoreHand("11223344555m112233z", ctx());
    expect(tai(result, "eight-pairs-three-winds")).toBe(15);
    expect(tai(result, "eight-pairs-four-winds")).toBe(0);
  });

  it("scores 四喜嚦咕 (excluding 三風嚦咕) when all 4 wind kinds are present", () => {
    const result = scoreHand("112233444m11223344z", ctx());
    expect(tai(result, "eight-pairs-four-winds")).toBe(60);
    expect(tai(result, "eight-pairs-three-winds")).toBe(0);
  });

  it("scores 清老頭 (excluding 混老頭) for an all-terminals hand", () => {
    const result = scoreHand("11119999m1199t11999b", ctx());
    expect(tai(result, "pure-terminal-triplets")).toBe(200);
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
  });

  it("scores 混老頭 for a mixed terminals-and-honors hand", () => {
    const result = scoreHand("11119999m1199t11b111z", ctx());
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(100);
  });

  it("scores 混一色 (excluding nothing extra) for one numbered suit plus honors", () => {
    const result = scoreHand("1122334455m1122333z", ctx());
    expect(tai(result, "half-flush")).toBe(40);
  });

  it("scores 清一色 for a single pure numbered suit", () => {
    const result = scoreHand("11223344556677888m", ctx());
    expect(tai(result, "full-flush")).toBe(120);
  });

  it("scores 字一色 for an all-honors hand, excluding 混老頭 (which needs at least one terminal)", () => {
    const result = scoreHand("11112233445566777z", ctx());
    expect(tai(result, "all-honors")).toBe(160);
    expect(tai(result, "mixed-terminal-honor-triplets")).toBe(0);
  });

  it("never scores 門前清 for a 嚦咕嚦咕 hand", () => {
    const result = scoreHand("1111m223344m5566777t", ctx());
    expect(tai(result, "concealed-except-kongs")).toBe(0);
  });
});

describe("PATTERNS: 將眼 stacks per qualifying pair in 嚦咕嚦咕 (not just one)", () => {
  it("fires once per pair/quad at rank 2, 5, or 8 - 3 times here for 6 tai total", () => {
    const result = scoreHand("2255m88t11224447766z", ctx());
    expect(tai(result, "middle-tile-pair")).toBe(6);
  });

  it("doesn't count a quad's extra pair-unit if its rank isn't 2/5/8", () => {
    const result = scoreHand("1111m3344667799t111z", ctx());
    expect(tai(result, "middle-tile-pair")).toBe(0);
  });
});

describe("PATTERNS: 自摸/獨獨 apply to 嚦咕嚦咕 too", () => {
  it("scores 自摸 for a self-drawn 嚦咕嚦咕", () => {
    const result = scoreHand("1111m223344m5566777t", ctx({ selfDraw: true }));
    expect(tai(result, "self-draw")).toBe(1);
  });

  it("scores 獨獨 when the pre-completion 嚦咕嚦咕 wait was genuinely single", () => {
    const result = scoreHand("112233445566z777z99m", ctx({ winningTile: { suit: "m", rank: 9 } }));
    expect(tai(result, "genuine-single-wait")).toBe(2);
  });

  it("scores 假獨 for a 嚦咕嚦咕 hand with two already-tripled kinds - drawing the 4th of either quads it while the other stays a plain triple", () => {
    // Pre-completion "225577t8844222b111m" already sits at 3 copies of
    // both 2b and 1m - waits on either's 4th copy (2b or 1m). Whichever
    // wins becomes a quad while the other stays the fixed "triple" slot.
    const resultB = scoreHand("225577t8844222b2b111m", ctx({ winningTile: { suit: "b", rank: 2 } }));
    expect(tai(resultB, "fake-single-wait")).toBe(2);
    expect(tai(resultB, "genuine-single-wait")).toBe(0);
    expect(tai(resultB, "eight-pairs")).toBe(50);

    const resultM = scoreHand("225577t8844222b111m1m", ctx({ winningTile: { suit: "m", rank: 1 } }));
    expect(tai(resultM, "fake-single-wait")).toBe(2);
    expect(tai(resultM, "genuine-single-wait")).toBe(0);
    expect(tai(resultM, "eight-pairs")).toBe(50);
  });

  it("doesn't score 假獨 for the same dual-already-tripled shape without a 食胡 tile set", () => {
    const result = scoreHand("225577t8844222b2b111m", ctx());
    expect(tai(result, "fake-single-wait")).toBe(0);
  });

  it("doesn't score 假獨 for a clean 嚦咕嚦咕 completion (8 pairs, one cleanly upgraded to a triple)", () => {
    const result = scoreHand("1122334455667788m1m", ctx({ winningTile: { suit: "m", rank: 1 } }));
    expect(tai(result, "fake-single-wait")).toBe(0);
  });
});

describe("PATTERNS: 嚦咕雙食 (same tiles valid as both 嚦咕嚦咕 and an ordinary hand)", () => {
  it("sums both readings' totals and exposes both as `matched`/`second`", () => {
    // 112233m + 667788t + 777z + 55z: reads either as 3 pairs of runs in
    // m/t (123m+123m, 678t+678t) + 777z + 55z (ordinary hand), or as 7
    // pairs (1m,2m,3m,6t,7t,8t,5z) + 1 triple (7z) (嚦咕嚦咕).
    const result = scoreHand("112233m667788t777z55z", ctx());
    expect(result.second).toBeDefined();
    expect(tai(result, "eight-pairs")).toBe(50);
    const secondTai = (id: string) => result.second!.matched.find((m) => m.pattern.id === id)?.tai ?? 0;
    expect(secondTai("two-separate-identical-sequences-hidden")).toBe(40);
    expect(result.total).toBe(result.matched.reduce((s, m) => s + m.tai, 0) + result.second!.matched.reduce((s, m) => s + m.tai, 0));
  });

  it("doesn't set `second` when only one reading is valid", () => {
    const result = scoreHand("1111m223344m5566777t", ctx());
    expect(result.second).toBeUndefined();
  });
});

describe("isDealer", () => {
  it("is true only when seat wind is East", () => {
    expect(isDealer(ctx({ seatWind: 1 }))).toBe(true);
    expect(isDealer(ctx({ seatWind: 2 }))).toBe(false);
  });
});
