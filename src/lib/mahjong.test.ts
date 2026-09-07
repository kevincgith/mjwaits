import { describe, expect, it } from "vitest";
import {
  EFFICIENCY_HORIZON,
  MELDS_REQUIRED,
  TOTAL_TILES,
  allTileKinds,
  analyzeDiscardChoices,
  analyzeDiscardEfficiency,
  analyzeDiscards,
  decomposeEightPairs,
  decomposeHand,
  decomposeSixteenUnrelated,
  decomposeThirteenOrphans,
  formatHand,
  getWaits,
  getWaitsWithJokers,
  isCheckpointSize,
  isCompleteHand,
  isEightPairsComplete,
  isSixteenUnrelatedComplete,
  isThirteenOrphansComplete,
  parseHand,
  shanten,
  standardShanten,
  tileCount,
  tileKey,
} from "./mahjong";
import type { DiscardChoice, Tile } from "./mahjong";

// Independent reference oracle for cross-validating shanten: brute-force
// search over discard+draw exchanges, correct by definition (shanten(hand)
// = 0 if already tenpai, else 1 + min over every discard/draw pair of
// shanten of the result), capped at `maxDepth` exchanges since it's
// exponential. Shares no logic with the block-counting implementation.
function referenceShanten(tiles: Tile[], meldsRequired: number, maxDepth: number): number {
  function solve(hand: Tile[], depth: number): number {
    if (getWaits(hand, meldsRequired).length > 0) return 0;
    if (depth >= maxDepth) return Infinity;
    let best = Infinity;
    const discardKeys = Array.from(new Set(hand.map(tileKey)));
    for (const dk of discardKeys) {
      const idx = hand.findIndex((t) => tileKey(t) === dk);
      const remaining = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
      for (const draw of allTileKinds()) {
        if (tileCount(remaining, draw) >= 4) continue;
        const sub = solve([...remaining, draw], depth + 1);
        if (sub + 1 < best) best = sub + 1;
      }
    }
    return best;
  }
  return solve(tiles, 0);
}

// Independent reference oracle for cross-validating getWaitsWithJokers: a
// plain "try every possible value for every joker" brute force, kept
// deliberately dumb (full permutation via recursion, not even deduped into
// multisets) so it shares no logic with the module under test. Only
// tractable for small joker counts, which is all these tests need.
function bruteForceWaitKeys(tiles: Tile[], meldsRequired: number): Set<string> {
  const jokerCount = tiles.filter((t) => t.suit === "j").length;
  const nonJokers = tiles.filter((t) => t.suit !== "j");
  const kinds = allTileKinds();
  const waitKeys = new Set<string>();

  function assign(remaining: number, chosen: Tile[]) {
    if (remaining === 0) {
      const concreteHand = [...nonJokers, ...chosen];
      for (const wait of getWaits(concreteHand, meldsRequired)) waitKeys.add(tileKey(wait));
      return;
    }
    for (const kind of kinds) {
      chosen.push(kind);
      assign(remaining - 1, chosen);
      chosen.pop();
    }
  }

  assign(jokerCount, []);
  return waitKeys;
}

describe("parseHand / formatHand", () => {
  it("round-trips simple notation", () => {
    const tiles = parseHand("123m11t22b");
    expect(formatHand(tiles)).toBe("123m11t22b");
  });

  it("preserves rank order within a suit rather than re-sorting it", () => {
    const tiles = parseHand("321m");
    expect(formatHand(tiles)).toBe("321m");
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

  it("rejects more than 17 tiles", () => {
    expect(() => parseHand("123456789m123456789t")).toThrow();
  });

  it("parses jokers as bare 'j' characters, exempt from the 4-copy cap", () => {
    const tiles = parseHand("jjjjjj3m");
    expect(tiles.filter((t) => t.suit === "j").length).toBe(6);
    expect(formatHand(tiles)).toBe("3mjjjjjj");
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
    const tiles = [...parseHand("111222333444m"), ...parseHand("11t345b")];
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("accepts a hand with honor triplets", () => {
    const tiles = [...parseHand("111z222z333z444z"), ...parseHand("55z123b")];
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects a hand of the wrong length", () => {
    expect(isCompleteHand(parseHand("111m"))).toBe(false);
  });

  it("rejects an incomplete decomposition", () => {
    // 4 triplets + pair (14 tiles) + 4b,4b,6b, which is not a meld
    const tiles = [...parseHand("111222333444m"), ...parseHand("11t446b")];
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
    const tiles = [...parseHand("112922m19t"), ...parseHand("19b1234567z")];
    expect(tiles.length).toBe(17);
    expect(isThirteenOrphansComplete(tiles)).toBe(true);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("decomposeThirteenOrphans groups the pair, the 12 singles, and the extra meld separately", () => {
    // Same hand as above: 1m doubled is the pair, 222m is the extra meld,
    // the other 12 orphan kinds (9m,1t,9t,1b,9b,1z-7z) are singles.
    const tiles = [...parseHand("112922m19t"), ...parseHand("19b1234567z")];
    const breakdown = decomposeThirteenOrphans(tiles);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.pair.map(tileKey).sort()).toEqual(["m1", "m1"]);
    expect(breakdown!.meld.map(tileKey).sort()).toEqual(["m2", "m2", "m2"]);
    expect(breakdown!.singles.map(tileKey).sort()).toEqual(
      ["m9", "t1", "t9", "b1", "b9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"].sort()
    );
    // Together they account for all 17 tiles with nothing missing or doubled up.
    const regrouped = [...breakdown!.pair, ...breakdown!.meld, ...breakdown!.singles];
    expect(regrouped.map(tileKey).sort()).toEqual(tiles.map(tileKey).sort());
  });

  it("decomposeThirteenOrphans returns null for a non-orphan hand", () => {
    expect(decomposeThirteenOrphans(parseHand("111222333444m111t22b"))).toBeNull();
  });

  it("rejects an orphan-looking hand missing one orphan kind", () => {
    // Same shape but 2z (South) swapped for a second 3z (West) - not all 13 kinds present
    const tiles = [...parseHand("112922m19t"), ...parseHand("19b1334567z")];
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
    // 1m x4 and 2z x4 each count as 2 pairs, plus 1b/3b/5z/6z pairs (4 more) = 8 pairs (16),
    // and drawing another 1b upgrades that pair into the triplet (17).
    const tiles = [...parseHand("1111m1133b"), ...parseHand("22225566z1b")];
    expect(tiles.length).toBe(17);
    expect(isEightPairsComplete(tiles)).toBe(true);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects a hand with a lone single tile among otherwise-clean pairs", () => {
    // 8 clean pairs (16 tiles) plus one unrelated stray 9b - not a valid triplet upgrade
    const tiles = [...parseHand("114477m1144t11b1122z"), ...parseHand("9b")];
    expect(tiles.length).toBe(17);
    expect(isEightPairsComplete(tiles)).toBe(false);
  });

  it("decomposeEightPairs puts the tripled kind first, then the other 7 pairs in tile order", () => {
    const tiles = [...parseHand("11223344m"), ...parseHand("112233444z")];
    const breakdown = decomposeEightPairs(tiles);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.triple.map(tileKey)).toEqual(["z4", "z4", "z4"]);
    expect(breakdown!.pairs.map((p) => p.map(tileKey))).toEqual([
      ["m1", "m1"],
      ["m2", "m2"],
      ["m3", "m3"],
      ["m4", "m4"],
      ["z1", "z1"],
      ["z2", "z2"],
      ["z3", "z3"],
    ]);
    const regrouped = [...breakdown!.triple, ...breakdown!.pairs.flat()];
    expect(regrouped.map(tileKey).sort()).toEqual(tiles.map(tileKey).sort());
  });

  it("decomposeEightPairs groups a kind's all-4-copies as one 4-tile pair group", () => {
    const tiles = [...parseHand("1111m1133b"), ...parseHand("22225566z1b")];
    const breakdown = decomposeEightPairs(tiles);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.triple.map(tileKey)).toEqual(["b1", "b1", "b1"]);
    const quad = breakdown!.pairs.find((p) => p.length === 4);
    expect(quad?.map(tileKey)).toEqual(["m1", "m1", "m1", "m1"]);
  });

  it("decomposeEightPairs returns null for a non-eight-pairs hand", () => {
    expect(decomposeEightPairs(parseHand("111222333444m111t22b"))).toBeNull();
  });

  it("shanten() reports -1 (already complete), not 0, for a genuinely complete Eight Pairs hand", () => {
    // 7 pairs (11m,22m,33m,44m,11z,22z,33z) + a 444z triplet = 17 tiles, complete.
    const complete = [...parseHand("11223344m"), ...parseHand("112233444z")];
    expect(isCompleteHand(complete)).toBe(true);
    expect(isEightPairsComplete(complete)).toBe(true);
    expect(shanten(complete)).toBe(-1);

    // Same shape one tile short (8 clean pairs, 16 tiles) is tenpai (0), not complete -
    // distinguishing this from the above is exactly what the -1 case depends on.
    const tenpai = [...parseHand("11223344m"), ...parseHand("11223344z")];
    expect(shanten(tenpai)).toBe(0);
  });

  it("a hand can be genuinely ambiguous between the standard shape and Eight Pairs", () => {
    // 112233m112233b11222z reads as both 123m123m123b123b + 222z/11z (a
    // standard hand) and 7 pairs + a tripled pair (Eight Pairs). Both
    // decompositions must be available so callers can show both readings.
    const tiles = parseHand("112233m112233b11222z");
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
    expect(decomposeHand(tiles)).not.toBeNull();
    expect(isEightPairsComplete(tiles)).toBe(true);
    expect(decomposeEightPairs(tiles)).not.toBeNull();

    // One tile short (missing the second 2z), it's tenpai waiting on 2z via
    // either shape - shanten() takes the better of both, so it should read
    // as tenpai rather than shanten 1.
    const tenpaiHand = parseHand("112233m112233b1122z");
    expect(tenpaiHand.length).toBe(16);
    expect(shanten(tenpaiHand)).toBe(0);
    expect(getWaits(tenpaiHand).map(tileKey)).toContain("z2");
  });

  it("recognizes the user's Sixteen Unrelated Tiles example via isSixteenUnrelatedComplete", () => {
    // All 7 honors + 1/4/7t, 2/5/8m, 3/6/9b (16 kinds, pairwise unrelated),
    // plus an extra 7t doubling one of them (the pair) = 17 tiles.
    const tiles = [...parseHand("147t258m369b1234567z"), ...parseHand("7t")];
    expect(tiles.length).toBe(17);
    expect(isSixteenUnrelatedComplete(tiles)).toBe(true);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects a hand where two same-suit ranks are too close together", () => {
    // 1t/2t are only 1 apart - a drawn 3t would let them share a chow.
    const tiles = [...parseHand("127t258m369b1234567z"), ...parseHand("7t")];
    expect(tiles.length).toBe(17);
    expect(isSixteenUnrelatedComplete(tiles)).toBe(false);
  });

  it("rejects a hand that isn't shaped as 15 singles + 1 pair", () => {
    // Two doubled kinds (1z, 2z) instead of exactly one - not a valid pair count.
    const tiles = [...parseHand("147t258m369b"), ...parseHand("11223456z")];
    expect(tiles.length).toBe(17);
    expect(isSixteenUnrelatedComplete(tiles)).toBe(false);
  });

  it("decomposeSixteenUnrelated groups the doubled kind as the pair, the rest as singles", () => {
    const tiles = [...parseHand("147t258m369b1234567z"), ...parseHand("7t")];
    const breakdown = decomposeSixteenUnrelated(tiles);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.pair.map(tileKey)).toEqual(["t7", "t7"]);
    expect(breakdown!.singles.length).toBe(15);
    const regrouped = [...breakdown!.pair, ...breakdown!.singles];
    expect(regrouped.map(tileKey).sort()).toEqual(tiles.map(tileKey).sort());
  });

  it("decomposeSixteenUnrelated returns null for a non-sixteen-unrelated hand", () => {
    expect(decomposeSixteenUnrelated(parseHand("111222333444m111t22b"))).toBeNull();
  });
});

describe("getWaits", () => {
  it("finds shanpon wait on 1t/2b for a 16-tile hand", () => {
    const tiles = parseHand("111222333444m11t22b");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1t", "2b"]);
  });

  it("finds the 16-way wait for a tenpai Sixteen Unrelated Tiles hand", () => {
    const tiles = parseHand("147t258m369b1234567z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => tileKey(t)).sort();
    const expected = Array.from(new Set(tiles.map((t) => tileKey(t)))).sort();
    expect(waits).toEqual(expected);
    expect(waits.length).toBe(16);
  });

  it("finds the single-tile wait when Sixteen Unrelated Tiles already has a pre-formed pair", () => {
    // Missing 7z, but 1t is already doubled in hand - the pair comes for
    // free, so this is tenpai waiting on 7z alone, not a 16-way wait.
    const tiles = parseHand("147t258m369b123456z1t");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => tileKey(t));
    expect(waits).toEqual(["z7"]);
  });

  it("finds an edge wait (kanchan) on 3b/6b", () => {
    const tiles = parseHand("111m222m333m444m11t45b");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["3b", "6b"]);
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
    const tiles = parseHand("19222m19t19b1234567z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(
      ["1m", "9m", "1t", "9t", "1b", "9b", "1z", "2z", "3z", "4z", "5z", "6z", "7z"].sort()
    );
  });

  it("finds the wide 8-way wait for a tenpai Eight Pairs hand", () => {
    // 8 distinct pairs, spaced apart so no standard run/triplet coincides -
    // drawing any of the 8 kinds upgrades that pair into the triplet.
    const tiles = parseHand("114477m1144t11b1122z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1m", "4m", "7m", "1t", "4t", "1b", "1z", "2z"].sort());
  });

  it("narrows the Eight Pairs wait when two kinds are already full quads", () => {
    // 1m and 2z are already at 4 copies each (2 pairs' worth), so they can't
    // be drawn again - only the 4 plain pairs (1b/3b/5z/6z) can be upgraded.
    const tiles = parseHand("1111m1133b22225566z");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1b", "3b", "5z", "6z"].sort());
  });
});

describe("decomposeHand", () => {
  it("breaks down 1m completing 1234m as 11m + 234m", () => {
    const breakdown = decomposeHand(parseHand("11234m"), 1);
    expect(breakdown).not.toBeNull();
    const format = (g: { suit: string; rank: number }[]) => g.map((t) => `${t.rank}${t.suit}`).join("");
    expect(format(breakdown!.pair)).toBe("1m1m");
    expect(breakdown!.melds.map(format)).toEqual(["2m3m4m"]);
  });

  it("breaks down 4m completing 1234m as 44m + 123m", () => {
    const breakdown = decomposeHand(parseHand("12344m"), 1);
    expect(breakdown).not.toBeNull();
    const format = (g: { suit: string; rank: number }[]) => g.map((t) => `${t.rank}${t.suit}`).join("");
    expect(format(breakdown!.pair)).toBe("4m4m");
    expect(breakdown!.melds.map(format)).toEqual(["1m2m3m"]);
  });

  it("returns null for the wrong hand size", () => {
    expect(decomposeHand(parseHand("11234m"), 5)).toBeNull();
  });

  it("returns null for special hands (they don't decompose into melds+pair)", () => {
    const orphans = [...parseHand("112922m19t"), ...parseHand("19b1234567z")];
    expect(isCompleteHand(orphans)).toBe(true);
    expect(decomposeHand(orphans)).toBeNull();
  });

  it("finds a valid breakdown for every wait of a larger hand, matching isCompleteHand", () => {
    const tiles = parseHand("111222333444m11t22b");
    for (const wait of getWaits(tiles)) {
      const complete = [...tiles, wait];
      const breakdown = decomposeHand(complete);
      expect(breakdown).not.toBeNull();
      expect(breakdown!.melds.length).toBe(MELDS_REQUIRED);
      // Reassemble and confirm it's the same multiset as the complete hand.
      const reassembled = [...breakdown!.pair, ...breakdown!.melds.flat()];
      expect(reassembled.length).toBe(complete.length);
    }
  });
});

describe("standardShanten / shanten", () => {
  it("is 0 for a tenpai hand", () => {
    const tiles = parseHand("111222333444m11t22b"); // shanpon wait, confirmed tenpai elsewhere
    expect(standardShanten(tiles)).toBe(0);
    expect(shanten(tiles)).toBe(0);
  });

  it("is 0 for a tanki (single-tile pair) wait, cross-validated against brute force", () => {
    // 123m complete + a lone 9m - waiting to pair the 9m alone. The block
    // search only ever tried reserving a *complete* pair (2+ matching
    // tiles) for the "no penalty" case, never a single leftover tile held
    // back as a tanki candidate, which overstated shanten by 1 here.
    const tiles = parseHand("123m9m");
    expect(getWaits(tiles, 1)).toEqual([{ suit: "m", rank: 9 }]);
    expect(referenceShanten(tiles, 1, 2)).toBe(0);
    expect(standardShanten(tiles, 1)).toBe(0);
    expect(shanten(tiles, 1)).toBe(0);
  });

  it("is 1 for a hand one useful exchange from tenpai, cross-validated against brute force", () => {
    // 11m pair + two disconnected stray tiles (1b, 9b) - already confirmed
    // via analyzeDiscards to be exactly 1 discard+draw from tenpai.
    const tiles = parseHand("11m1b9b");
    expect(referenceShanten(tiles, 1, 2)).toBe(1);
    expect(standardShanten(tiles, 1)).toBe(1);
  });

  it("is 2 for a hand with no pair and no connected tiles, cross-validated against brute force", () => {
    // 4 totally isolated tiles: no pair anywhere, nothing adjacent.
    const tiles = parseHand("1m5b1z4z");
    expect(referenceShanten(tiles, 1, 2)).toBe(2);
    expect(standardShanten(tiles, 1)).toBe(2);
  });

  it("drops by exactly 1 after discarding a useless tile for a useful one", () => {
    const before = parseHand("11m1b9b");
    expect(standardShanten(before, 1)).toBe(1);
    // Discard 9b, draw 1b -> 111b... no, draw 2b for a ryanmen extension.
    const after = parseHand("11m1b2b");
    expect(standardShanten(after, 1)).toBe(0);
  });

  it("computes Eight Pairs shanten and folds it into the overall minimum", () => {
    // 5 clean pairs (1m,3m,1t,3t,5b) + 6 unrelated honor singles (16 tiles):
    // Eight Pairs needs 8 - 5 = 3 more pair-units; the standard shape does
    // worse here (5), so the overall shanten should be Eight Pairs' 3.
    const tiles = parseHand("1133m1133t55b123456z");
    expect(tiles.length).toBe(16);
    expect(standardShanten(tiles)).toBe(5);
    expect(shanten(tiles)).toBe(3);
  });

  it("stays fast on a full 16-tile hand", () => {
    const tiles = parseHand("13579m2468t111z5577b");
    expect(tiles.length).toBe(16);
    const start = performance.now();
    shanten(tiles);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("stays fast on a dense hand that used to blow up the block search combinatorially", () => {
    // Many same-suit ranks all holding 2 copies (chiitoitsu-shaped): the
    // block search revisits the same rank many times as its count depletes,
    // and without memoizing by remaining-counts state, different branch
    // orderings that land on the identical state got re-explored from
    // scratch - this hand took ~80ms per call before that was fixed.
    const tiles = parseHand("1122334455667788m");
    expect(tiles.length).toBe(16);
    const start = performance.now();
    shanten(tiles);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("computes Sixteen Unrelated Tiles shanten and folds it into the overall minimum", () => {
    // All 16 target kinds already present (7 honors + 3 unrelated ranks per
    // suit) - tenpai (0), waiting on any of those 16 to form the pair.
    const tenpai = parseHand("147t258m369b1234567z");
    expect(tenpai.length).toBe(16);
    expect(shanten(tenpai)).toBe(0);

    // Missing 7z, but a spare 1t (a duplicate) is already in hand to serve
    // as the pair "for free" - still tenpai, just now waiting on 7z alone
    // instead of a 16-way wait.
    const pairInHand = parseHand("147t258m369b123456z1t");
    expect(pairInHand.length).toBe(16);
    expect(shanten(pairInHand)).toBe(0);

    // Missing 7z, and the 16th tile (9m) is genuinely wasted - too close to
    // 8m to count as another unit, and not a duplicate of anything - so
    // there's no pre-formed pair either: exactly 1 exchange from tenpai.
    const oneAway = parseHand("147t258m369b123456z9m");
    expect(oneAway.length).toBe(16);
    expect(shanten(oneAway)).toBe(1);
  });
});

describe("getWaitsWithJokers", () => {
  it("matches plain getWaits when the hand has no jokers", () => {
    const tiles = parseHand("111222333444m11t22b");
    const outcome = getWaitsWithJokers(tiles);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    const waits = outcome.results.map((r) => `${r.wait.rank}${r.wait.suit}`).sort();
    expect(waits).toEqual(["1t", "2b"]);
    expect(outcome.results.every((r) => r.jokers.length === 0)).toBe(true);
  });

  it("finds waits a single joker unlocks, wider than a real tile's own wait shape", () => {
    // 11m pair + lone 5b + 1 joker. Beyond the joker just extending 5b into a
    // run (waits 4b/5b/6b/3b/7b via kanchan/ryanmen shapes), it can also
    // duplicate 5b to pair it, letting 1m/1m + the draw become the triplet
    // - which is why 1m shows up too.
    const tiles = parseHand("11m5bj");
    const outcome = getWaitsWithJokers(tiles, 1);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    const waitKeys = outcome.results.map((r) => `${r.wait.rank}${r.wait.suit}`).sort();
    expect(waitKeys).toEqual(["1m", "3b", "4b", "5b", "6b", "7b"]);
  });

  it("every returned joker assignment actually completes the hand", () => {
    const tiles = parseHand("11m5bj");
    const outcome = getWaitsWithJokers(tiles, 1);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    for (const { wait, jokers } of outcome.results) {
      const nonJokers = tiles.filter((t) => t.suit !== "j");
      const reconstructed = [...nonJokers, ...jokers, wait];
      expect(isCompleteHand(reconstructed, 1)).toBe(true);
    }
  });

  it("solves 16 jokers (all 34 kinds wait) instantly via the wildcard search, not brute force", () => {
    // The old combinatorial approach would need C(49,16) ~= 3.3 trillion
    // combinations here - the point of the wildcard-budget search is that
    // it doesn't need to enumerate joker values at all to see that a
    // single free joker can always mirror whatever is drawn.
    const tiles = parseHand("jjjjjjjjjjjjjjjj"); // 16 jokers
    expect(tiles.length).toBe(16);
    const start = performance.now();
    const outcome = getWaitsWithJokers(tiles);
    const elapsed = performance.now() - start;
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    expect(outcome.results.length).toBe(34); // every real kind is a valid wait
    expect(elapsed).toBeLessThan(500);
  });

  it("every result from a heavy-joker hand still reconstructs to a genuinely complete hand", () => {
    // 2 real tiles + 14 jokers = 16 (a valid checkpoint size).
    const hand = parseHand("1m9bjjjjjjjjjjjjjj");
    expect(hand.length).toBe(16);
    const outcome = getWaitsWithJokers(hand);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    const nonJokers = hand.filter((t) => t.suit !== "j");
    for (const { wait, jokers } of outcome.results) {
      const reconstructed = [...nonJokers, ...jokers, wait];
      expect(reconstructed.length).toBe(17);
      expect(isCompleteHand(reconstructed)).toBe(true);
    }
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  it("matches an independent brute-force oracle across a range of joker hands", () => {
    const cases: { notation: string; melds: number }[] = [
      { notation: "11m5bj", melds: 1 }, // 1 joker
      { notation: "1122mj", melds: 1 }, // 1 joker, different shape
      { notation: "23mjj", melds: 1 }, // 2 jokers
      { notation: "1mjjj", melds: 1 }, // the exact user-reported case: 2 jokers form
      // a pong with 1m, the 3rd joker is free to pair with anything
      { notation: "12345678mjj", melds: 3 }, // 2 jokers, larger hand
    ];
    for (const { notation, melds } of cases) {
      const tiles = parseHand(notation);
      const expected = bruteForceWaitKeys(tiles, melds);
      const outcome = getWaitsWithJokers(tiles, melds);
      expect(outcome.overflowed).toBe(false);
      if (outcome.overflowed) throw new Error("unreachable");
      const actual = new Set(outcome.results.map((r) => tileKey(r.wait)));
      expect(actual).toEqual(expected);
    }
  });

  it("confirms the user's example: 1mjjj waits on all 34 kinds", () => {
    // 1m + 2 jokers form a pong (111m); the 3rd joker is entirely free and
    // can mirror whatever is drawn to form the pair.
    const tiles = parseHand("1mjjj");
    const outcome = getWaitsWithJokers(tiles, 1);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    expect(outcome.results.length).toBe(34);
  });
});

describe("analyzeDiscards", () => {
  it("finds discard/draw pairs that reach tenpai, and ranks them by acceptance", () => {
    // 11m pair + two disconnected stray tiles (1b, 9b) - not tenpai.
    const tiles = parseHand("11m1b9b");
    expect(getWaits(tiles, 1)).toEqual([]);

    const options = analyzeDiscards(tiles, 1);
    const byDiscard = Object.fromEntries(
      options.map((o) => [`${o.discard.rank}${o.discard.suit}`, o.draws.map((d) => `${d.rank}${d.suit}`).sort()])
    );

    // Discarding the pair tile leaves nothing to build on.
    expect(byDiscard["1m"]).toEqual([]);
    // Discarding 9b leaves 1b as a lone edge tile: 1b/2b/3b extend it into a
    // partial run, and drawing 1m upgrades the pair into a triplet instead.
    expect(byDiscard["9b"]).toEqual(["1b", "1m", "2b", "3b"]);
    // Discarding 1b leaves 9b as a lone edge tile: 7b/8b/9b extend it into a
    // partial run, and drawing 1m upgrades the pair into a triplet instead.
    expect(byDiscard["1b"]).toEqual(["1m", "7b", "8b", "9b"]);

    // Best discards (most draws) come first.
    expect(options[0].draws.length).toBeGreaterThan(options[options.length - 1].draws.length);
  });

  it("returns nothing for hand sizes that aren't a valid checkpoint", () => {
    expect(analyzeDiscards(parseHand("11m1b"))).toEqual([]);
  });
});

describe("analyzeDiscardEfficiency", () => {
  it("matches the user's worked example: 1278m555t111333777z, discard 1m, draw 2m -> waits 69m (8 tiles)", () => {
    const tiles = parseHand("1278m555t111333777z");
    expect(getWaits(tiles, 5)).toEqual([]);

    const options = analyzeDiscardEfficiency(tiles, 5);
    const discard1m = options.find((o) => o.discard.suit === "m" && o.discard.rank === 1);
    expect(discard1m).toBeDefined();

    const drawKinds = discard1m!.draws.map((d) => `${d.draw.rank}${d.draw.suit}`).sort();
    expect(drawKinds).toEqual(["2m", "6m", "9m"]);

    const draw2m = discard1m!.draws.find((d) => d.draw.suit === "m" && d.draw.rank === 2);
    expect(draw2m).toBeDefined();
    // Only one 2m is already visible in the hand, so 3 remain.
    expect(draw2m!.drawRemaining).toBe(3);
    // Drawing 2m pairs it up, leaving a 7m8m ryanmen waiting on 6m/9m - 4 of each untouched.
    const waitKinds = draw2m!.resultingWaits.map((t) => `${t.rank}${t.suit}`).sort();
    expect(waitKinds).toEqual(["6m", "9m"]);
    expect(draw2m!.resultingWaitsTotal).toBe(8);

    // Sorted most likely to win first, and every probability is a real [0, 1].
    for (let i = 1; i < options.length; i++) {
      expect(options[i].winProbability).toBeLessThanOrEqual(options[i - 1].winProbability);
    }
    for (const o of options) {
      expect(o.winProbability).toBeGreaterThanOrEqual(0);
      expect(o.winProbability).toBeLessThanOrEqual(1);
      expect(o.tenpaiProbability).toBeGreaterThanOrEqual(0);
      expect(o.tenpaiProbability).toBeLessThanOrEqual(1);
      // A useful discard can't be likelier to win than to first reach tenpai.
      expect(o.winProbability).toBeLessThanOrEqual(o.tenpaiProbability + 1e-9);
    }

    // tenpaiProbability is exactly the closed-form geometric "at least one
    // accepting tile within EFFICIENCY_HORIZON draws" for its acceptance count.
    const unseen = TOTAL_TILES - 16;
    const expectedTenpai = 1 - (1 - discard1m!.acceptance / unseen) ** EFFICIENCY_HORIZON;
    expect(discard1m!.tenpaiProbability).toBeCloseTo(expectedTenpai, 12);
  });

  it("ranks a dead-tile discard above one that breaks a live shape", () => {
    // 3 triplets + 11m pair + 56t ryanmen + 13b kanchan + a dead lone 7z:
    // 1-shanten, needing 56t and 13b both filled. Pitching the dead 7z keeps
    // every accepting draw (4t/7t/2b) live; pitching 6t guts the ryanmen and
    // leaves nothing that reaches tenpai in one draw.
    const tiles = parseHand("11333555777m56t13b7z");
    expect(tiles.length).toBe(16);
    expect(getWaits(tiles, 5)).toEqual([]);

    const options = analyzeDiscardEfficiency(tiles, 5);
    const dropDead = options.find((o) => o.discard.suit === "z" && o.discard.rank === 7)!;
    const breakShape = options.find((o) => o.discard.suit === "t" && o.discard.rank === 6)!;
    expect(dropDead.acceptance).toBeGreaterThan(breakShape.acceptance);
    expect(dropDead.winProbability).toBeGreaterThan(breakShape.winProbability);
    expect(options.indexOf(dropDead)).toBeLessThan(options.indexOf(breakShape));
  });

  it("returns nothing for hand sizes that aren't a valid checkpoint", () => {
    expect(analyzeDiscardEfficiency(parseHand("11m1b"))).toEqual([]);
  });
});

describe("analyzeDiscardChoices", () => {
  it("recognizes an already-complete 17-tile hand, but still analyzes what breaking it would look like", () => {
    // 111m/222m/333m/444m/111t (5 melds) + 22b (pair) = complete.
    const tiles = parseHand("111222333444m111t22b");
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);

    const outcome = analyzeDiscardChoices(tiles);
    expect(outcome.alreadyComplete).toBe(true);

    // One choice per distinct discardable kind, same as the non-complete case.
    const uniqueKinds = new Set(tiles.map(tileKey)).size;
    expect(outcome.choices.length).toBe(uniqueKinds);

    // Discarding either 2b leaves a lone 2b tanki - still tenpai, waiting on 2b.
    const discard2b = outcome.choices.find((c) => c.discard.suit === "b" && c.discard.rank === 2);
    expect(discard2b!.resultingShanten).toBe(0);
    expect(discard2b!.waits.map(tileKey)).toEqual(["b2"]);
  });

  it("ranks discards by resulting shanten, tenpai first with its waits", () => {
    // The tenpai hand from earlier (waits 1t/2b) plus an extra 9m that
    // isn't one of those waits - not complete, but discarding the extra 9m
    // exactly reverts to the known-tenpai 16-tile hand.
    const tenpaiHand = parseHand("123456789m111z11t22b");
    expect(getWaits(tenpaiHand, 5).map(tileKey).sort()).toEqual(["b2", "t1"]);

    const tiles = parseHand("1234567899m111z11t22b");
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(false);

    const outcome = analyzeDiscardChoices(tiles);
    expect(outcome.alreadyComplete).toBe(false);
    if (outcome.alreadyComplete) throw new Error("unreachable");

    const discard9m = outcome.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 9);
    expect(discard9m).toBeDefined();
    expect(discard9m!.resultingShanten).toBe(0);
    expect(discard9m!.waits.map(tileKey).sort()).toEqual(["b2", "t1"]);
    // Two of each already visible in the 16-tile hand, so 2 remain apiece.
    expect(discard9m!.waitsTotal).toBe(4);

    // Sorted best (lowest shanten) first.
    for (let i = 1; i < outcome.choices.length; i++) {
      expect(outcome.choices[i].resultingShanten).toBeGreaterThanOrEqual(outcome.choices[i - 1].resultingShanten);
    }
    expect(outcome.choices[0]).toBe(outcome.choices.find((c) => c.resultingShanten === 0));

    // One choice per distinct discardable kind; waits only populated at tenpai.
    const uniqueKinds = new Set(tiles.map(tileKey)).size;
    expect(outcome.choices.length).toBe(uniqueKinds);
    for (const choice of outcome.choices) {
      expect(choice.waits.length > 0).toBe(choice.resultingShanten === 0);
      expect(choice.waitsTotal > 0).toBe(choice.resultingShanten === 0);
    }
  });

  it("includes improving draws (and their remaining counts) for non-tenpai choices", () => {
    const tiles = parseHand("1234567899m111z11t22b");
    const outcome = analyzeDiscardChoices(tiles);
    expect(outcome.alreadyComplete).toBe(false);
    if (outcome.alreadyComplete) throw new Error("unreachable");

    const discard1m = outcome.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 1);
    expect(discard1m).toBeDefined();
    expect(discard1m!.resultingShanten).toBe(1);
    const draws = discard1m!.improvingDraws.map((d) => `${d.draw.rank}${d.draw.suit}x${d.remaining}`).sort();
    // 1m itself is a valid improving draw (redraw it, then discard 4m/7m/etc
    // instead this time), but only 3 remain: one is the copy just discarded.
    expect(draws).toEqual(["1mx3", "1tx2", "2bx2", "4mx3", "7mx3", "9mx2"]);
    expect(discard1m!.improvingDrawsTotal).toBe(15);

    // Every improving draw should actually reduce shanten below 1 for some
    // follow-up discard - re-verified independently here (not just trusting
    // the internal shortcut) by brute-forcing every possible discard.
    for (const { draw } of discard1m!.improvingDraws) {
      const discardIndex = tiles.findIndex((t) => t.suit === discard1m!.discard.suit && t.rank === discard1m!.discard.rank);
      const remaining = [...tiles.slice(0, discardIndex), ...tiles.slice(discardIndex + 1)];
      const withDraw = [...remaining, draw];
      let best = Infinity;
      for (const t of new Set(withDraw.map(tileKey))) {
        const idx = withDraw.findIndex((x) => tileKey(x) === t);
        const afterDiscard = [...withDraw.slice(0, idx), ...withDraw.slice(idx + 1)];
        best = Math.min(best, shanten(afterDiscard, 5));
      }
      expect(best).toBeLessThan(1);
    }

    // Non-tenpai choices never populate waits/waitsTotal, and vice versa.
    for (const choice of outcome.choices) {
      expect(choice.improvingDraws.length > 0 || choice.resultingShanten === 0).toBe(true);
      expect(choice.improvingDrawsTotal > 0).toBe(choice.resultingShanten !== 0 && choice.improvingDraws.length > 0);
    }
  });

  it("doesn't double-count a tile that was just discarded as still fully available", () => {
    // 1119m1z: discarding 9m or 1z reaches tenpai directly (111m is already
    // a complete meld, the other lone tile is a tanki wait) - discarding 1m
    // is the worst option here, landing at shanten 1. Of its three 1m's,
    // one was just discarded and two remain in hand - only 1 more truly
    // exists to draw, not the 2 you'd get from just checking the hand.
    const tiles = parseHand("1119m1z");
    expect(tiles.length).toBe(5);
    const outcome = analyzeDiscardChoices(tiles, 1);
    expect(outcome.alreadyComplete).toBe(false);
    if (outcome.alreadyComplete) throw new Error("unreachable");

    const discard9m = outcome.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 9);
    const discard1z = outcome.choices.find((c) => c.discard.suit === "z" && c.discard.rank === 1);
    expect(discard9m!.resultingShanten).toBe(0);
    expect(discard1z!.resultingShanten).toBe(0);

    const discard1m = outcome.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 1);
    expect(discard1m!.resultingShanten).toBe(1);
    const oneManDraw = discard1m!.improvingDraws.find((d) => d.draw.suit === "m" && d.draw.rank === 1);
    expect(oneManDraw).toBeDefined();
    expect(oneManDraw!.remaining).toBe(1); // 2 held (post-discard) + 1 just discarded = 3 accounted for, 1 truly left

    // 1m x1 + 7m x4 + 8m x4 + 9m x3 + 1z x3 = 15; excluding the 1m redraw
    // itself (the only draw matching the discarded kind) leaves 14.
    expect(discard1m!.improvingDrawsTotal).toBe(15);
    expect(discard1m!.improvingDrawsTotalExcludingRedraw).toBe(14);
  });

  it("shrinks waits, drawable counts and the unseen denominator by the `seen` pile", () => {
    // Discarding 9m leaves 123456789m 111z 11t 22b tenpai on 1t / 2b - two of
    // each already held, so waitsTotal 4 on a fresh wall.
    const tiles = parseHand("1234567899m111z11t22b");
    const fresh = analyzeDiscardChoices(tiles, 5);
    const freshDiscard9m = fresh.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 9)!;
    expect(freshDiscard9m.resultingShanten).toBe(0);
    expect(freshDiscard9m.waits.map(tileKey).sort()).toEqual(["b2", "t1"]);
    expect(freshDiscard9m.waitsTotal).toBe(4);

    // Put both remaining 1t in the discard pile: 1t is now dead (2 held + 2
    // seen = 4), so the wait collapses to 2b alone, worth 2.
    const seen = parseHand("11t");
    const withPile = analyzeDiscardChoices(tiles, 5, seen);
    const pileDiscard9m = withPile.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 9)!;
    expect(pileDiscard9m.waits.map(tileKey)).toEqual(["b2"]);
    expect(pileDiscard9m.waitsTotal).toBe(2);

    // Win probability uses the pile-shrunk wait total over a pile-shrunk
    // unseen count (TOTAL_TILES - 17 - seen.length).
    const unseen = TOTAL_TILES - 17 - seen.length;
    expect(pileDiscard9m.winProbability).toBeCloseTo(1 - (1 - 2 / unseen) ** EFFICIENCY_HORIZON, 12);
    expect(pileDiscard9m.winProbability).toBeLessThan(freshDiscard9m.winProbability);

    // No `seen` argument is unchanged from before.
    expect(analyzeDiscardChoices(tiles, 5).choices).toEqual(fresh.choices);
  });

  it("takes a shorter `horizon` and reports lower odds over it", () => {
    const tiles = parseHand("1234567899m111z11t22b");
    const short = analyzeDiscardChoices(tiles, 5, [], 3);
    const shortDiscard9m = short.choices.find((c) => c.discard.suit === "m" && c.discard.rank === 9)!;
    expect(shortDiscard9m.resultingShanten).toBe(0);
    const unseen = TOTAL_TILES - 17;
    expect(shortDiscard9m.winProbability).toBeCloseTo(1 - (1 - shortDiscard9m.waitsTotal / unseen) ** 3, 12);

    const long = analyzeDiscardChoices(tiles, 5).choices.find(
      (c) => c.discard.suit === "m" && c.discard.rank === 9
    )!;
    expect(shortDiscard9m.winProbability).toBeLessThan(long.winProbability);
  });

  it("orders every choice by the full comparator (shanten, then win prob, then ukeire)", () => {
    const cmp = (a: DiscardChoice, b: DiscardChoice) =>
      a.resultingShanten - b.resultingShanten ||
      b.winProbability - a.winProbability ||
      b.improvingDrawsTotalExcludingRedraw - a.improvingDrawsTotalExcludingRedraw ||
      tileKey(a.discard).localeCompare(tileKey(b.discard));

    let sawTwoShantenTier = false;
    for (let trial = 0; trial < 60; trial++) {
      const wall: Tile[] = [];
      for (const k of allTileKinds()) for (let i = 0; i < 4; i++) wall.push({ ...k });
      for (let i = wall.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [wall[i], wall[j]] = [wall[j], wall[i]];
      }
      const outcome = analyzeDiscardChoices(wall.slice(0, 17));
      for (let i = 1; i < outcome.choices.length; i++) {
        expect(cmp(outcome.choices[i - 1], outcome.choices[i])).toBeLessThanOrEqual(0);
      }
      // Random 17-tile hands are almost always 2+ shanten under every discard,
      // where ordering rests entirely on the ukeire tiebreak.
      if (
        outcome.choices.length > 1 &&
        outcome.choices.every((c) => c.resultingShanten >= 2) &&
        new Set(outcome.choices.map((c) => c.improvingDrawsTotalExcludingRedraw)).size > 1
      ) {
        sawTwoShantenTier = true;
      }
    }
    expect(sawTwoShantenTier).toBe(true);
  });

  it("carries two-phase tenpai/win probabilities, exact at tenpai and ordered within a shanten tier", () => {
    const tiles = parseHand("1234567899m111z11t22b");
    const outcome = analyzeDiscardChoices(tiles);
    if (outcome.alreadyComplete) throw new Error("unreachable");
    const unseen = TOTAL_TILES - 17;

    for (const c of outcome.choices) {
      expect(c.winProbability).toBeGreaterThanOrEqual(0);
      expect(c.winProbability).toBeLessThanOrEqual(1);
      expect(c.tenpaiProbability).toBeGreaterThanOrEqual(0);
      expect(c.tenpaiProbability).toBeLessThanOrEqual(1);
      if (c.resultingShanten === 0) {
        // Already tenpai (unless it's a dead shape with every winning copy
        // gone): win is the closed-form geometric draw of one of `waitsTotal`
        // live tiles within the horizon.
        expect(c.tenpaiProbability).toBe(c.waitsTotal > 0 ? 1 : 0);
        const expected = 1 - (1 - c.waitsTotal / unseen) ** EFFICIENCY_HORIZON;
        expect(c.winProbability).toBeCloseTo(expected, 12);
      } else if (c.resultingShanten === 1) {
        expect(c.winProbability).toBeGreaterThan(0);
        expect(c.winProbability).toBeLessThan(1);
      } else {
        // 2+ shanten isn't modelled.
        expect(c.winProbability).toBe(0);
        expect(c.tenpaiProbability).toBe(0);
      }
    }

    // Within one resulting-shanten tier, choices are ordered by winProbability desc.
    for (let i = 1; i < outcome.choices.length; i++) {
      const prev = outcome.choices[i - 1];
      const cur = outcome.choices[i];
      if (prev.resultingShanten === cur.resultingShanten) {
        expect(cur.winProbability).toBeLessThanOrEqual(prev.winProbability + 1e-12);
      }
    }
  });

  it("stays fast even on a dense hand (many same-suit ranks holding 2 copies)", () => {
    const tiles = parseHand("1122334455667788m9m");
    expect(tiles.length).toBe(17);
    const start = performance.now();
    analyzeDiscardChoices(tiles);
    expect(performance.now() - start).toBeLessThan(400);
  });

  it("returns nothing for hand sizes that aren't a valid checkpoint", () => {
    const outcome = analyzeDiscardChoices(parseHand("11m1b"));
    expect(outcome).toEqual({ alreadyComplete: false, choices: [] });
  });
});
