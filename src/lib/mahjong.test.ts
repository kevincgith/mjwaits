import { describe, expect, it } from "vitest";
import {
  analyzeDiscards,
  formatHand,
  getWaits,
  isCheckpointSize,
  isCompleteHand,
  isEightPairsComplete,
  isThirteenOrphansComplete,
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

  it("recognizes the Thirteen Orphans special hand via isThirteenOrphansComplete", () => {
    // 13 orphan singles + an extra 1m (the pair) + a 222m pong (the meld) = 17 tiles
    const tiles = [...parseHand("112922m19t"), ...parseHand("19s1234567z")];
    expect(tiles.length).toBe(17);
    expect(isThirteenOrphansComplete(tiles)).toBe(true);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects an orphan-looking hand missing one orphan kind", () => {
    // Same shape but 2z (South) swapped for a second 3z (West) - not all 13 kinds present
    const tiles = [...parseHand("112922m19t"), ...parseHand("19s1334567z")];
    expect(tiles.length).toBe(17);
    expect(isThirteenOrphansComplete(tiles)).toBe(false);
  });

  it("recognizes the Eight Pairs special hand via isEightPairsComplete", () => {
    // 7 pairs (11m,22m,33m,44m,11z,22z,33z) + a 444z triplet = 17 tiles
    const tiles = [...parseHand("11223344m"), ...parseHand("112233444z")];
    expect(tiles.length).toBe(17);
    expect(isEightPairsComplete(tiles)).toBe(true);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("allows a kind's all 4 copies to count as two of the 8 pairs", () => {
    // 1m x4 and 2z x4 each count as 2 pairs, plus 1s/3s/5z/6z pairs (4 more) = 8 pairs (16),
    // and drawing another 1s upgrades that pair into the triplet (17).
    const tiles = [...parseHand("1111m1133s"), ...parseHand("22225566z1s")];
    expect(tiles.length).toBe(17);
    expect(isEightPairsComplete(tiles)).toBe(true);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects a hand with a lone single tile among otherwise-clean pairs", () => {
    // 8 clean pairs (16 tiles) plus one unrelated stray 9s - not a valid triplet upgrade
    const tiles = [...parseHand("114477m1144t11s1122z"), ...parseHand("9s")];
    expect(tiles.length).toBe(17);
    expect(isEightPairsComplete(tiles)).toBe(false);
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

  it("finds the classic 13-way wait for a tenpai Thirteen Orphans hand", () => {
    // 13 orphan singles + a complete 222m pong = 16 tiles, missing only the pair
    const tiles = parseHand("19222m19t19s1234567z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(
      ["1m", "9m", "1t", "9t", "1s", "9s", "1z", "2z", "3z", "4z", "5z", "6z", "7z"].sort()
    );
  });

  it("finds the wide 8-way wait for a tenpai Eight Pairs hand", () => {
    // 8 distinct pairs, spaced apart so no standard run/triplet coincides -
    // drawing any of the 8 kinds upgrades that pair into the triplet.
    const tiles = parseHand("114477m1144t11s1122z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1m", "4m", "7m", "1t", "4t", "1s", "1z", "2z"].sort());
  });

  it("narrows the Eight Pairs wait when two kinds are already full quads", () => {
    // 1m and 2z are already at 4 copies each (2 pairs' worth), so they can't
    // be drawn again - only the 4 plain pairs (1s/3s/5z/6z) can be upgraded.
    const tiles = parseHand("1111m1133s22225566z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1s", "3s", "5z", "6z"].sort());
  });
});

describe("analyzeDiscards", () => {
  it("finds discard/draw pairs that reach tenpai, and ranks them by acceptance", () => {
    // 11m pair + two disconnected stray tiles (1s, 9s) - not tenpai.
    const tiles = parseHand("11m1s9s");
    expect(getWaits(tiles, 1)).toEqual([]);

    const options = analyzeDiscards(tiles, 1);
    const byDiscard = Object.fromEntries(
      options.map((o) => [`${o.discard.rank}${o.discard.suit}`, o.draws.map((d) => `${d.rank}${d.suit}`).sort()])
    );

    // Discarding the pair tile leaves nothing to build on.
    expect(byDiscard["1m"]).toEqual([]);
    // Discarding 9s leaves 1s as a lone edge tile: 1s/2s/3s extend it into a
    // partial run, and drawing 1m upgrades the pair into a triplet instead.
    expect(byDiscard["9s"]).toEqual(["1m", "1s", "2s", "3s"]);
    // Discarding 1s leaves 9s as a lone edge tile: 7s/8s/9s extend it into a
    // partial run, and drawing 1m upgrades the pair into a triplet instead.
    expect(byDiscard["1s"]).toEqual(["1m", "7s", "8s", "9s"]);

    // Best discards (most draws) come first.
    expect(options[0].draws.length).toBeGreaterThan(options[options.length - 1].draws.length);
  });

  it("returns nothing for hand sizes that aren't a valid checkpoint", () => {
    expect(analyzeDiscards(parseHand("11m1s"))).toEqual([]);
  });
});
