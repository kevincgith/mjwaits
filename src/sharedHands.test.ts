import { describe, expect, it } from "vitest";
import { TEST_HAND_BASE_CONTEXT } from "./lib/testHands";
import {
  formatBonus,
  readCalcHand,
  readSharedHand,
  situationDiff,
  withRecent,
  withRecentCalc,
  type RecentCalcHand,
  type RecentHand,
} from "./sharedHands";

describe("share links", () => {
  it("reads a link's hand, bonus tiles and situation", () => {
    // ?h=(555z)123789m45622t789b&b=f1&c={"seatWind":2,"selfDraw":true}
    const shared = readSharedHand("?h=%28555z%29123789m45622t789b&b=f1&c=eyJzZWF0V2luZCI6Miwic2VsZkRyYXciOnRydWV9");
    expect(shared).toEqual({
      hand: "(555z)123789m45622t789b",
      bonus: [{ kind: "flower", rank: 1 }],
      ctx: { seatWind: 2, selfDraw: true },
    });
  });

  it("reads the 食胡 tile back as a tile", () => {
    const c = btoa(JSON.stringify({ winningTile: "5m" })).replace(/=+$/, "");
    expect(readSharedHand(`?h=123m&c=${c}`)?.ctx.winningTile).toEqual({ suit: "m", rank: 5 });
  });

  it("ignores a link with no hand, or one that doesn't parse", () => {
    expect(readSharedHand("")).toBeNull();
    expect(readSharedHand("?h=12x")).toBeNull();
  });

  it("drops a broken situation rather than the whole hand", () => {
    expect(readSharedHand("?h=123m&c=not-json")).toEqual({ hand: "123m", bonus: [], ctx: {} });
  });

  it("keeps only what differs from the default situation", () => {
    expect(situationDiff({ ...TEST_HAND_BASE_CONTEXT, roundWind: 3, winningTile: { suit: "t", rank: 2 } })).toEqual({
      roundWind: 3,
      winningTile: { suit: "t", rank: 2 },
    });
    expect(situationDiff(TEST_HAND_BASE_CONTEXT)).toEqual({});
  });

  it("writes bonus tiles compactly", () => {
    expect(formatBonus([{ kind: "flower", rank: 2 }, { kind: "season", rank: 4 }])).toBe("f2s4");
  });
});

describe("recent hands", () => {
  const entry = (hand: string, total: number, ctx = {}): RecentHand => ({ hand, bonus: [], ctx, total, at: 0 });

  it("puts a new hand first", () => {
    expect(withRecent([entry("A", 1)], entry("B", 2)).map((r) => r.hand)).toEqual(["B", "A"]);
  });

  it("replaces the front entry when only the situation changed", () => {
    const next = withRecent([entry("A", 1), entry("B", 2)], entry("A", 5, { selfDraw: true }));
    expect(next.map((r) => [r.hand, r.total])).toEqual([
      ["A", 5],
      ["B", 2],
    ]);
  });

  it("returns the same list when nothing changed, so it isn't re-saved", () => {
    const list = [entry("A", 1)];
    expect(withRecent(list, entry("A", 1))).toBe(list);
  });

  it("moves an older copy of the same tiles to the front and keeps ten", () => {
    const list = Array.from({ length: 10 }, (_, i) => entry(`H${i}`, i));
    const next = withRecent(list, entry("H5", 50));
    expect(next[0].hand).toBe("H5");
    expect(next.filter((r) => r.hand === "H5")).toHaveLength(1);
    expect(withRecent(list, entry("new", 0))).toHaveLength(10);
  });
});

describe("Calculator hands", () => {
  const entry = (hand: string, summary = "3 waits"): RecentCalcHand => ({ hand, summary, at: 0 });

  it("reads a ?calc= link, jokers included, and rejects a bad one", () => {
    expect(readCalcHand("?calc=123m456tjj")).toBe("123m456tjj");
    expect(readCalcHand("?calc=12x")).toBeNull();
    expect(readCalcHand("?h=123m")).toBeNull();
  });

  it("keeps one entry while a hand is built up tile by tile", () => {
    const list = withRecentCalc([entry("1112345678999m")], entry("1112345678999m111z", "9 waits"));
    expect(list.map((r) => r.hand)).toEqual(["1112345678999m111z"]);
  });

  it("keeps one entry while a hand is trimmed down", () => {
    expect(withRecentCalc([entry("123456m11t")], entry("123m11t"))).toHaveLength(1);
  });

  it("adds a new entry for a different hand", () => {
    expect(withRecentCalc([entry("123m")], entry("456t")).map((r) => r.hand)).toEqual(["456t", "123m"]);
  });

  it("returns the same list when nothing changed", () => {
    const list = [entry("123m")];
    expect(withRecentCalc(list, entry("123m"))).toBe(list);
  });
});
