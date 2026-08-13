import { describe, expect, it } from "vitest";
import {
  MELDS_REQUIRED,
  allTileKinds,
  analyzeDiscards,
  decomposeHand,
  formatHand,
  getWaits,
  getWaitsWithJokers,
  isCheckpointSize,
  isCompleteHand,
  isEightPairsComplete,
  isThirteenOrphansComplete,
  parseHand,
  shanten,
  standardShanten,
  tileCount,
  tileKey,
} from "./mahjong";
import type { Tile } from "./mahjong";

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
    const tiles = parseHand("123m11t22s");
    expect(formatHand(tiles)).toBe("123m11t22s");
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

  it("rejects more than 16 tiles", () => {
    expect(() => parseHand("123456789m12345678t")).toThrow();
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
    const orphans = [...parseHand("112922m19t"), ...parseHand("19s1234567z")];
    expect(isCompleteHand(orphans)).toBe(true);
    expect(decomposeHand(orphans)).toBeNull();
  });

  it("finds a valid breakdown for every wait of a larger hand, matching isCompleteHand", () => {
    const tiles = parseHand("111222333444m11t22s");
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
    const tiles = parseHand("111222333444m11t22s"); // shanpon wait, confirmed tenpai elsewhere
    expect(standardShanten(tiles)).toBe(0);
    expect(shanten(tiles)).toBe(0);
  });

  it("is 1 for a hand one useful exchange from tenpai, cross-validated against brute force", () => {
    // 11m pair + two disconnected stray tiles (1s, 9s) - already confirmed
    // via analyzeDiscards to be exactly 1 discard+draw from tenpai.
    const tiles = parseHand("11m1s9s");
    expect(referenceShanten(tiles, 1, 2)).toBe(1);
    expect(standardShanten(tiles, 1)).toBe(1);
  });

  it("is 2 for a hand with no pair and no connected tiles, cross-validated against brute force", () => {
    // 4 totally isolated tiles: no pair anywhere, nothing adjacent.
    const tiles = parseHand("1m5s1z4z");
    expect(referenceShanten(tiles, 1, 2)).toBe(2);
    expect(standardShanten(tiles, 1)).toBe(2);
  });

  it("drops by exactly 1 after discarding a useless tile for a useful one", () => {
    const before = parseHand("11m1s9s");
    expect(standardShanten(before, 1)).toBe(1);
    // Discard 9s, draw 1s -> 111s... no, draw 2s for a ryanmen extension.
    const after = parseHand("11m1s2s");
    expect(standardShanten(after, 1)).toBe(0);
  });

  it("computes Eight Pairs shanten and folds it into the overall minimum", () => {
    // 5 clean pairs (1m,3m,1t,3t,5s) + 6 unrelated honor singles (16 tiles):
    // Eight Pairs needs 8 - 5 = 3 more pair-units; the standard shape does
    // worse here (5), so the overall shanten should be Eight Pairs' 3.
    const tiles = parseHand("1133m1133t55s123456z");
    expect(tiles.length).toBe(16);
    expect(standardShanten(tiles)).toBe(5);
    expect(shanten(tiles)).toBe(3);
  });

  it("stays fast on a full 16-tile hand", () => {
    const tiles = parseHand("13579m2468t111z5577s");
    expect(tiles.length).toBe(16);
    const start = performance.now();
    shanten(tiles);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("getWaitsWithJokers", () => {
  it("matches plain getWaits when the hand has no jokers", () => {
    const tiles = parseHand("111222333444m11t22s");
    const outcome = getWaitsWithJokers(tiles);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    const waits = outcome.results.map((r) => `${r.wait.rank}${r.wait.suit}`).sort();
    expect(waits).toEqual(["1t", "2s"]);
    expect(outcome.results.every((r) => r.jokers.length === 0)).toBe(true);
  });

  it("finds waits a single joker unlocks, wider than a real tile's own wait shape", () => {
    // 11m pair + lone 5s + 1 joker. Beyond the joker just extending 5s into a
    // run (waits 4s/5s/6s/3s/7s via kanchan/ryanmen shapes), it can also
    // duplicate 5s to pair it, letting 1m/1m + the draw become the triplet
    // - which is why 1m shows up too.
    const tiles = parseHand("11m5sj");
    const outcome = getWaitsWithJokers(tiles, 1);
    expect(outcome.overflowed).toBe(false);
    if (outcome.overflowed) throw new Error("unreachable");
    const waitKeys = outcome.results.map((r) => `${r.wait.rank}${r.wait.suit}`).sort();
    expect(waitKeys).toEqual(["1m", "3s", "4s", "5s", "6s", "7s"]);
  });

  it("every returned joker assignment actually completes the hand", () => {
    const tiles = parseHand("11m5sj");
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
    const hand = parseHand("1m9sjjjjjjjjjjjjjj");
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
      { notation: "11m5sj", melds: 1 }, // 1 joker
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
