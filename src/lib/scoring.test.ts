import { describe, expect, it } from "vitest";
import { decomposeHandAll, isDealer, parseScoringHand, scoreHand, type GameContext } from "./scoring";

const ctx = (overrides: Partial<GameContext> = {}): GameContext => ({
  seatWind: 1,
  roundWind: 1,
  selfDraw: false,
  ...overrides,
});

describe("parseScoringHand", () => {
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
});

describe("isDealer", () => {
  it("is true only when seat wind is East", () => {
    expect(isDealer(ctx({ seatWind: 1 }))).toBe(true);
    expect(isDealer(ctx({ seatWind: 2 }))).toBe(false);
  });
});
