import { describe, expect, it } from "vitest";
import {
  formatHand,
  getWaits,
  isCheckpointSize,
  isCompleteHand,
  parseHand,
  tileCount,
} from "./mahjong";

describe("parseHand / formatHand", () => {
  it("round-trips simple notation", () => {
    const tiles = parseHand("123m11t22s");
    expect(formatHand(tiles)).toBe("123m11t22s");
  });

  it("rejects out-of-range ranks", () => {
    expect(() => parseHand("9z")).toThrow();
    expect(() => parseHand("0m")).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => parseHand("123x")).toThrow();
  });

  it("allows exactly 4 copies of a tile", () => {
    const tiles = parseHand("1111m");
    expect(tiles.length).toBe(4);
  });

  it("rejects a 5th copy of the same tile", () => {
    expect(() => parseHand("11111m")).toThrow();
    expect(() => parseHand("1111m1m")).toThrow();
    expect(() => parseHand("11111z")).toThrow();
  });

  it("rejects more than 16 tiles", () => {
    expect(() => parseHand("123456789m12345678t")).toThrow();
  });
});

describe("isCheckpointSize", () => {
  it("accepts sizes of the form 3n+1 up to 16", () => {
    expect([1, 4, 7, 10, 13, 16].every(isCheckpointSize)).toBe(true);
  });

  it("rejects everything else, including 0 and above 16", () => {
    expect([0, 2, 3, 5, 6, 17].some(isCheckpointSize)).toBe(false);
  });
});

describe("tileCount", () => {
  it("counts occurrences of a specific tile", () => {
    const tiles = parseHand("1112m");
    expect(tileCount(tiles, { suit: "m", rank: 1 })).toBe(3);
    expect(tileCount(tiles, { suit: "m", rank: 2 })).toBe(1);
    expect(tileCount(tiles, { suit: "m", rank: 3 })).toBe(0);
  });
});

describe("isCompleteHand", () => {
  it("accepts 5 triplets/runs + a pair (17 tiles)", () => {
    // 4 triplets of man + pair of pin + one run of sou = 5 melds + pair
    const tiles = [...parseHand("111222333444m"), ...parseHand("11t345s")];
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("accepts a hand with honor triplets", () => {
    const tiles = [...parseHand("111z222z333z444z"), ...parseHand("55z123s")];
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects a hand of the wrong length", () => {
    expect(isCompleteHand(parseHand("111m"))).toBe(false);
  });

  it("rejects an incomplete decomposition", () => {
    // 4 triplets + pair (14 tiles) + 4s,4s,6s, which is not a meld
    const tiles = [...parseHand("111222333444m"), ...parseHand("11t446s")];
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(false);
  });

  it("supports a smaller meld count for partial-hand checkpoints", () => {
    // 1 meld + pair (5 tiles) = meldsRequired 1
    expect(isCompleteHand(parseHand("111m22t"), 1)).toBe(true);
    expect(isCompleteHand(parseHand("111m23t"), 1)).toBe(false);
  });
});

describe("getWaits", () => {
  it("finds shanpon wait on 1t/2s for a 16-tile hand", () => {
    const tiles = parseHand("111222333444m11t22s");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1t", "2s"]);
  });

  it("finds an edge wait (kanchan) on 3s/6s", () => {
    const tiles = parseHand("111m222m333m444m11t45s");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["3s", "6s"]);
  });

  it("returns empty for a hand that is not tenpai", () => {
    const tiles = parseHand("13579m2468t111z");
    expect(getWaits(tiles)).toEqual([]);
  });

  it("supports smaller checkpoint sizes (4 tiles, 1 meld required)", () => {
    // 11m pair + 23t partial run -> waits on 1t/4t
    const tiles = parseHand("11m23t");
    const waits = getWaits(tiles, 1).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1t", "4t"]);
  });
});
