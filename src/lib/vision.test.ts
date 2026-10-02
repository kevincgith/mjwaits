import { describe, expect, it } from "vitest";
import { parseHand } from "./mahjong";
import {
  clusterRows,
  concealednessScore,
  declarednessScore,
  detailWindows,
  extendRowEnds,
  findRotatedOutlier,
  isCompleteHandRow,
  isHandLikeRow,
  IMG_SIZE,
  isPairOnlyRow,
  isRowADeclared,
  looksLikeConcealedFragment,
  looksLikeDeclaredMelds,
  mapWindowDetections,
  mergeRecheckRuns,
  nonMaxSuppression,
  photoCrop,
  recheckRects,
  regionsFromRows,
  remapDetections,
  resolveVerticalOverlap,
  ROW_PAD_X,
  rowToRegion,
  selectHandRows,
  splitMixedRow,
  type Detection,
} from "./vision";

const detection = (overrides: Partial<Detection> = {}): Detection => ({
  tile: { suit: "m", rank: 1 },
  className: "1m",
  confidence: 0.5,
  box: [100, 100, 140, 180],
  ...overrides,
});

// A row of `count` same-height tiles sitting side by side, all spanning
// [y1, y2] vertically - box height is y2-y1, matching detection()'s own
// default 80px height unless overridden.
const rowOfDetections = (y1: number, y2: number, count: number): Detection[] =>
  Array.from({ length: count }, (_, i) => detection({ box: [i * 40, y1, i * 40 + 40, y2] }));

// A row of `count` DISTINCT, non-adjacent-rank tiles (cycling ranks
// 1,3,5,7,9 within m, then t, then b, before repeating) - unlike
// rowOfDetections' own all-identical tiles, this never accidentally forms
// a meld/kong/pair OR a run (every rank is 2 apart from the next within
// its own suit), useful for simulating a discard pile or other row whose
// tiles genuinely don't group into anything.
const rowOfDistinctTiles = (y1: number, y2: number, count: number): Detection[] => {
  const suits = ["m", "t", "b"] as const;
  const ranks = [1, 3, 5, 7, 9];
  return Array.from({ length: count }, (_, i) => {
    const suit = suits[Math.floor(i / ranks.length) % suits.length];
    const rank = ranks[i % ranks.length];
    return detection({ tile: { suit, rank }, className: `${rank}${suit}`, box: [i * 40, y1, i * 40 + 40, y2] });
  });
};

// A row built straight from algebraic notation (same hand strings used
// throughout scoring.test.ts), one detection per tile with sequential
// boxes - handy for the special-hand fixtures below, where writing out
// each Tile literal by hand would be unwieldy.
const rowFromHand = (hand: string, y1: number, y2: number): Detection[] =>
  parseHand(hand).map((tile, i) =>
    detection({ tile, className: `${tile.rank}${tile.suit}`, box: [i * 40, y1, i * 40 + 40, y2] })
  );

describe("nonMaxSuppression", () => {
  it("keeps a single detection untouched", () => {
    const d = detection();
    expect(nonMaxSuppression([d])).toEqual([d]);
  });

  it("keeps two detections that don't overlap", () => {
    const a = detection({ box: [0, 0, 40, 80] });
    const b = detection({ box: [100, 0, 140, 80] });
    expect(nonMaxSuppression([a, b])).toHaveLength(2);
  });

  it("drops the lower-confidence duplicate when two boxes heavily overlap, even with different guessed classes", () => {
    const winner = detection({ className: "1m", confidence: 0.8, box: [100, 100, 140, 180] });
    const duplicate = detection({
      tile: { suit: "m", rank: 2 },
      className: "2m",
      confidence: 0.5,
      // Nearly identical box - a few pixels off, same physical tile.
      box: [102, 101, 141, 179],
    });
    const result = nonMaxSuppression([duplicate, winner]);
    expect(result).toEqual([winner]);
  });

  it("keeps two adjacent, mostly non-overlapping tiles", () => {
    // Two tiles sitting side by side in a hand photo, boxes just touching.
    const left = detection({ box: [100, 100, 140, 180] });
    const right = detection({ box: [140, 100, 180, 180] });
    expect(nonMaxSuppression([left, right])).toHaveLength(2);
  });

  it("handles an empty input", () => {
    expect(nonMaxSuppression([])).toEqual([]);
  });
});

describe("clusterRows", () => {
  it("splits two clearly separated rows apart, top-to-bottom", () => {
    const top = rowOfDetections(100, 180, 4); // center 140
    const bottom = rowOfDetections(400, 480, 4); // center 440, gap 300 >> 80*0.6
    const rows = clusterRows([...bottom, ...top]); // order shouldn't matter - clusterRows sorts internally
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(top);
    expect(rows[1]).toEqual(bottom);
  });

  it("keeps one row together when detections are all at the same height", () => {
    const oneRow = rowOfDetections(100, 180, 5);
    expect(clusterRows(oneRow)).toEqual([oneRow]);
  });

  it("finds 3+ separate clusters when the photo has that many rows", () => {
    const rows = [rowOfDetections(100, 180, 3), rowOfDetections(400, 480, 3), rowOfDetections(700, 780, 3)];
    expect(clusterRows(rows.flat())).toHaveLength(3);
  });

  it("drops a stray 1-2-tile cluster as noise, keeping only the real rows", () => {
    const top = rowOfDetections(100, 180, 4);
    const bottom = rowOfDetections(400, 480, 4);
    const stray = detection({ box: [0, 1000, 40, 1080] }); // alone, far from both real rows
    const rows = clusterRows([...top, ...bottom, stray]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(top);
    expect(rows[1]).toEqual(bottom);
  });

  it("rescues a lone rotated-looking tile into its nearest neighboring row, instead of dropping it as noise", () => {
    // Sits closer to `top` (center 140, distance 130) than to `bottom`
    // (center 440, distance 170), and its ratio (2.0) is a clear outlier
    // against either row's own upright ratio (0.5) - simulates a 食胡
    // marker tile pulled far enough from its row's main line to trip the
    // gap threshold on its own.
    const top = rowOfDetections(100, 180, 4);
    const bottom = rowOfDetections(400, 480, 4);
    const rotated = detection({ box: [0, 250, 80, 290] }); // width 80, height 40 -> ratio 2.0
    const rows = clusterRows([...top, ...bottom, rotated]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([...top, rotated]);
    expect(rows[1]).toEqual(bottom);
  });

  it("does NOT rescue a lone tile that isn't actually rotated relative to its neighbor - stays dropped as ordinary noise", () => {
    // Same position as the rescue case above, but an upright ratio (0.5)
    // matching the rest of the photo - nothing marks this as the 食胡
    // tile rather than a run-of-the-mill stray misdetection.
    const top = rowOfDetections(100, 180, 4);
    const bottom = rowOfDetections(400, 480, 4);
    const stray = detection({ box: [0, 210, 40, 290] }); // width 40, height 80 -> ratio 0.5, matching top/bottom
    const rows = clusterRows([...top, ...bottom, stray]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(top);
    expect(rows[1]).toEqual(bottom);
  });

  it("keeps a lone single bonus tile as its own row, unlike an equally-alone stray real tile", () => {
    const top = rowOfDetections(100, 180, 4);
    const bottom = rowOfDetections(400, 480, 4);
    const bonusTile = detection({ tile: null, className: "1f", box: [0, 1000, 40, 1080] }); // alone, far from both real rows
    const rows = clusterRows([...top, ...bottom, bonusTile]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual([bonusTile]);
  });

  it("keeps a lone matching PAIR as its own row - the smallest a concealed row can legitimately be", () => {
    const top = rowOfDetections(100, 180, 4);
    const bottom = rowOfDetections(400, 480, 4);
    const pair = [
      detection({ tile: { suit: "b", rank: 5 }, box: [0, 1000, 40, 1080] }),
      detection({ tile: { suit: "b", rank: 5 }, box: [40, 1000, 80, 1080] }),
    ];
    const rows = clusterRows([...top, ...bottom, ...pair]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual(pair);
  });

  it("still drops a 2-tile stray of two DIFFERENT kinds as noise - not a real pair", () => {
    const top = rowOfDetections(100, 180, 4);
    const bottom = rowOfDetections(400, 480, 4);
    const notAPair = [
      detection({ tile: { suit: "b", rank: 5 }, box: [0, 1000, 40, 1080] }),
      detection({ tile: { suit: "b", rank: 6 }, box: [40, 1000, 80, 1080] }),
    ];
    const rows = clusterRows([...top, ...bottom, ...notAPair]);
    expect(rows).toHaveLength(2);
  });

  it("handles an empty input", () => {
    expect(clusterRows([])).toEqual([]);
  });
});

describe("findRotatedOutlier", () => {
  it("finds the one tile whose box ratio stands out from the rest", () => {
    const upright = rowOfDetections(100, 180, 4); // width 40, height 80 -> ratio 0.5
    const rotated = detection({ box: [200, 100, 280, 140] }); // width 80, height 40 -> ratio 2.0
    expect(findRotatedOutlier([...upright, rotated])).toBe(rotated);
  });

  it("returns null when every tile shares roughly the same ratio", () => {
    expect(findRotatedOutlier(rowOfDetections(100, 180, 5))).toBeNull();
  });

  it("returns null with fewer than 3 items - not enough to establish a median", () => {
    const rotated = detection({ box: [200, 100, 280, 140] });
    expect(findRotatedOutlier([detection(), rotated])).toBeNull();
  });

  // Box sizes from a real photo: a sideways winning 1b at the end of a
  // 14-tile concealed row whose box came back only ~1.4x the row's
  // median ratio, while the upright tiles strayed no further than ~1.1x.
  const sidewaysWinRow = () => {
    const widths = [48, 47, 45, 42, 40, 39, 37, 38, 37, 40, 39, 41, 40];
    const heights = [40, 40, 37, 38, 36, 36, 36, 37, 36, 37, 37, 38, 37];
    let x = 0;
    const upright = widths.map((w, i) => detection({ box: [(x += w) - w, 300, x, 300 + heights[i]] }));
    return { upright, sideways: detection({ box: [x, 302, x + 46, 333] }) }; // ratio 1.48 vs median ~1.08
  };

  it("finds a sideways tile under the usual factor when it's clearly the odd one out", () => {
    const { upright, sideways } = sidewaysWinRow();
    expect(findRotatedOutlier([...upright, sideways])).toBe(sideways);
  });

  it("doesn't pick a mild outlier when another tile strays nearly as far", () => {
    const { upright, sideways } = sidewaysWinRow();
    const jittery = detection({ box: [1000, 300, 1050, 337] }); // ratio 1.35 -> ~1.25x the median
    expect(findRotatedOutlier([...upright, jittery, sideways])).toBeNull();
  });

  it("ignores ordinary jitter between upright tiles", () => {
    expect(findRotatedOutlier(sidewaysWinRow().upright)).toBeNull();
  });
});

describe("isPairOnlyRow", () => {
  it("recognizes a matching pair", () => {
    const pair = [detection({ tile: { suit: "b", rank: 5 } }), detection({ tile: { suit: "b", rank: 5 }, box: [40, 100, 80, 180] })];
    expect(isPairOnlyRow(pair)).toBe(true);
  });

  it("rejects 2 tiles of different kinds", () => {
    const notAPair = [detection({ tile: { suit: "b", rank: 5 } }), detection({ tile: { suit: "b", rank: 6 }, box: [40, 100, 80, 180] })];
    expect(isPairOnlyRow(notAPair)).toBe(false);
  });

  it("rejects a bonus tile even if it happens to pair up with a real tile's array position", () => {
    const row = [detection({ tile: { suit: "b", rank: 5 } }), detection({ tile: null, className: "1f", box: [40, 100, 80, 180] })];
    expect(isPairOnlyRow(row)).toBe(false);
  });

  it("rejects any size other than exactly 2", () => {
    expect(isPairOnlyRow([detection()])).toBe(false);
    expect(isPairOnlyRow(rowOfDetections(100, 180, 3))).toBe(false);
    expect(isPairOnlyRow([])).toBe(false);
  });

  it("works generically on a minimal {tile} shape, same as App.tsx's own ReviewDetection", () => {
    const minimalPair = [{ tile: { suit: "z" as const, rank: 3 } }, { tile: { suit: "z" as const, rank: 3 } }];
    expect(isPairOnlyRow(minimalPair)).toBe(true);
  });
});

describe("declarednessScore", () => {
  it("scores a kong (4 identical tiles) as +1 toward declared", () => {
    expect(declarednessScore(rowOfDetections(100, 180, 4))).toBe(1); // rowOfDetections' tiles are all the same kind by default
  });

  it("scores a bonus tile (tile: null) as +1 toward declared", () => {
    const row = [
      detection({ tile: { suit: "m", rank: 1 } }),
      detection({ tile: { suit: "m", rank: 2 }, box: [40, 100, 80, 180] }),
      detection({ tile: null, className: "1f", box: [80, 100, 120, 180] }),
    ];
    expect(declarednessScore(row)).toBe(1);
  });

  it("scores a rotated outlier tile as -1 toward declared", () => {
    const upright = [0, 1, 2].map((i) => detection({ tile: { suit: "m", rank: i + 1 }, box: [i * 40, 100, i * 40 + 40, 180] }));
    const rotated = detection({ tile: { suit: "m", rank: 9 }, box: [200, 100, 280, 140] });
    expect(declarednessScore([...upright, rotated])).toBe(-1);
  });

  it("scores a pair (exactly 2 identical tiles) as -1 toward declared", () => {
    const row = [
      detection({ tile: { suit: "m", rank: 1 } }),
      detection({ tile: { suit: "m", rank: 1 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "m", rank: 2 }, box: [80, 100, 120, 180] }),
    ];
    expect(declarednessScore(row)).toBe(-1);
  });

  it("doesn't double-count a kong's own 4 copies as also being a pair", () => {
    expect(declarednessScore(rowOfDetections(100, 180, 4))).toBe(1); // same fixture as the kong test above - still +1, not 0
  });

  it("returns 0 for a plain row with no signals", () => {
    const row = [0, 1, 2].map((i) => detection({ tile: { suit: "m", rank: i + 1 }, box: [i * 40, 100, i * 40 + 40, 180] }));
    expect(declarednessScore(row)).toBe(0);
  });
});

describe("isRowADeclared", () => {
  it("falls through to declarednessScore's own comparison when neither row is all-bonus or melds-complete", () => {
    // A kong (hasKong -> +1) plus 2 unrelated leftover singles - scores
    // toward declared via declarednessScore, but does NOT fully decompose
    // (even with looksLikeDeclaredMelds' 1-stray tolerance, since there
    // are 2 leftovers here, not 1) - so this exercises the score
    // fallback specifically, not the melds-decisive branch.
    const kongRow = [
      ...rowOfDetections(100, 180, 4),
      detection({ tile: { suit: "m", rank: 2 }, box: [160, 100, 200, 180] }),
      detection({ tile: { suit: "z", rank: 3 }, box: [200, 100, 240, 180] }),
    ];
    const pairRow = [
      detection({ tile: { suit: "b", rank: 5 } }),
      detection({ tile: { suit: "b", rank: 5 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "b", rank: 9 }, box: [80, 100, 120, 180] }),
    ]; // hasPair -> -1
    expect(looksLikeDeclaredMelds(kongRow)).toBe(false);
    expect(looksLikeDeclaredMelds(pairRow)).toBe(false);
    expect(isRowADeclared(kongRow, pairRow)).toBe(true);
    expect(isRowADeclared(pairRow, kongRow)).toBe(false);
  });

  it("decisively picks an all-bonus row as Declared even when the other row has a stronger declaredness score", () => {
    const bonusOnly = [detection({ tile: null, className: "1f" })];
    const kongRow = rowOfDetections(100, 180, 4); // would normally win declarednessScore's own comparison (+1 vs 0)
    expect(isRowADeclared(bonusOnly, kongRow)).toBe(true);
    expect(isRowADeclared(kongRow, bonusOnly)).toBe(false);
  });

  it("decisively picks a melds-complete row as Declared even when the other row has a stronger declarednessScore", () => {
    // The would-be-declared row here has neither a kong nor a bonus tile
    // (declarednessScore alone would score it 0), while the OTHER row has
    // a bonus tile (+1, via hasBonusTile) but no complete meld of its own
    // (2 unrelated real tiles, well short of the 3 needed even with the
    // 1-stray tolerance) - yet the melds-complete row still wins, since
    // looksLikeDeclaredMelds is checked before declarednessScore.
    const run = [
      detection({ tile: { suit: "t", rank: 5 } }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 100, 120, 180] }),
    ];
    const bonusButNoMeld = [
      detection({ tile: null, className: "1f", box: [0, 400, 40, 480] }),
      detection({ tile: { suit: "m", rank: 2 }, box: [40, 400, 80, 480] }),
      detection({ tile: { suit: "z", rank: 5 }, box: [80, 400, 120, 480] }),
    ];
    expect(looksLikeDeclaredMelds(run)).toBe(true);
    expect(declarednessScore(run)).toBe(0);
    expect(looksLikeDeclaredMelds(bonusButNoMeld)).toBe(false);
    expect(declarednessScore(bonusButNoMeld)).toBe(1);
    expect(isRowADeclared(run, bonusButNoMeld)).toBe(true);
    expect(isRowADeclared(bonusButNoMeld, run)).toBe(false);
  });

  it("falls through to position (rowA wins the tie) when both rows are all-bonus", () => {
    const bonusA = [detection({ tile: null, className: "1f" })];
    const bonusB = [detection({ tile: null, className: "2f" })];
    expect(isRowADeclared(bonusA, bonusB)).toBe(true);
  });
});

describe("looksLikeDeclaredMelds", () => {
  it("recognizes a complete run", () => {
    const run = [
      detection({ tile: { suit: "t", rank: 5 } }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 100, 120, 180] }),
    ];
    expect(looksLikeDeclaredMelds(run)).toBe(true);
  });

  it("recognizes a complete triplet", () => {
    expect(looksLikeDeclaredMelds(rowOfDetections(100, 180, 3))).toBe(true);
  });

  it("recognizes a complete kong (4 of a kind)", () => {
    expect(looksLikeDeclaredMelds(rowOfDetections(100, 180, 4))).toBe(true);
  });

  it("recognizes an honor triplet, but not an honor run (honors never form runs)", () => {
    const honorTriplet = [
      detection({ tile: { suit: "z", rank: 3 } }),
      detection({ tile: { suit: "z", rank: 3 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "z", rank: 3 }, box: [80, 100, 120, 180] }),
    ];
    const honorRun = [
      detection({ tile: { suit: "z", rank: 3 } }),
      detection({ tile: { suit: "z", rank: 4 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "z", rank: 5 }, box: [80, 100, 120, 180] }),
    ];
    expect(looksLikeDeclaredMelds(honorTriplet)).toBe(true);
    expect(looksLikeDeclaredMelds(honorRun)).toBe(false);
  });

  it("ignores bonus tiles when checking decomposition - a run plus its own flower still counts", () => {
    const runWithFlower = [
      detection({ tile: { suit: "t", rank: 5 } }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 100, 120, 180] }),
      detection({ tile: null, className: "2f", box: [120, 100, 160, 180] }),
    ];
    expect(looksLikeDeclaredMelds(runWithFlower)).toBe(true);
  });

  it("tolerates exactly ONE leftover stray tile alongside a complete run - e.g. a 食胡 marker tile that got merged into the wrong row", () => {
    const runWithStray = [
      detection({ tile: { suit: "t", rank: 5 } }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "m", rank: 3 }, box: [120, 100, 160, 180] }), // unrelated stray
    ];
    expect(looksLikeDeclaredMelds(runWithStray)).toBe(true);
  });

  it("rejects 2+ leftover stray tiles - the tolerance only covers exactly one", () => {
    const runWithTwoStrays = [
      detection({ tile: { suit: "t", rank: 5 } }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "m", rank: 3 }, box: [120, 100, 160, 180] }),
      detection({ tile: { suit: "z", rank: 1 }, box: [160, 100, 200, 180] }),
    ];
    expect(looksLikeDeclaredMelds(runWithTwoStrays)).toBe(false);
  });

  it("rejects a lone stray tile with no real meld at all", () => {
    expect(looksLikeDeclaredMelds([detection({ tile: { suit: "t", rank: 5 } })])).toBe(false);
  });

  it("rejects a bag of distinct, non-grouping tiles", () => {
    expect(looksLikeDeclaredMelds(rowOfDistinctTiles(100, 180, 7))).toBe(false);
  });

  it("rejects an all-bonus row - nothing real to decompose", () => {
    const bonusOnly = [detection({ tile: null, className: "1f" }), detection({ tile: null, className: "2f" })];
    expect(looksLikeDeclaredMelds(bonusOnly)).toBe(false);
  });

  it("handles an empty input", () => {
    expect(looksLikeDeclaredMelds([])).toBe(false);
  });
});

describe("looksLikeConcealedFragment", () => {
  it("recognizes a run plus its own pair - the classic 'most of the hand is declared' remainder", () => {
    const runPlusPair = [
      detection({ tile: { suit: "m", rank: 7 } }),
      detection({ tile: { suit: "m", rank: 8 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "m", rank: 9 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [120, 100, 160, 180] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [160, 100, 200, 180] }),
    ];
    expect(looksLikeConcealedFragment(runPlusPair)).toBe(true);
  });

  it("recognizes a row that's ENTIRELY just the pair - the smallest legitimate concealed fragment", () => {
    const pairOnly = [
      detection({ tile: { suit: "z", rank: 2 } }),
      detection({ tile: { suit: "z", rank: 2 }, box: [40, 100, 80, 180] }),
    ];
    expect(looksLikeConcealedFragment(pairOnly)).toBe(true);
  });

  it("tries every candidate pair kind, not just the first duplicate found", () => {
    // 666m has count 3 (also >= 2, so it's tried as a candidate pair
    // first, in insertion order) but removing 2 of them leaves an
    // ungroupable leftover 6m - only trying 44t as the pair instead
    // leaves a clean 666m triplet behind. Confirms the search doesn't
    // stop at the first duplicate kind it finds.
    const tiles = [
      detection({ tile: { suit: "m", rank: 6 } }),
      detection({ tile: { suit: "m", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "m", rank: 6 }, box: [80, 100, 120, 180] }), // 666m triplet
      detection({ tile: { suit: "t", rank: 4 }, box: [120, 100, 160, 180] }),
      detection({ tile: { suit: "t", rank: 4 }, box: [160, 100, 200, 180] }), // 44t pair (the real one)
    ];
    expect(looksLikeConcealedFragment(tiles)).toBe(true);
  });

  it("tolerates exactly one leftover stray tile alongside melds + a pair, same as looksLikeDeclaredMelds", () => {
    const withStray = [
      detection({ tile: { suit: "m", rank: 7 } }),
      detection({ tile: { suit: "m", rank: 8 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "m", rank: 9 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [120, 100, 160, 180] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [160, 100, 200, 180] }),
      detection({ tile: { suit: "z", rank: 3 }, box: [200, 100, 240, 180] }), // unrelated stray
    ];
    expect(looksLikeConcealedFragment(withStray)).toBe(true);
  });

  it("rejects a row with no pair at all - every kind appears exactly once", () => {
    expect(looksLikeConcealedFragment(rowOfDistinctTiles(100, 180, 7))).toBe(false);
  });

  it("rejects a discard-pile-like row that merely happens to contain a coincidental pair, with everything else left over ungrouped", () => {
    const discardWithIncidentalPair = [
      detection({ tile: { suit: "m", rank: 2 }, box: [0, 100, 40, 180] }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "b", rank: 9 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "z", rank: 1 }, box: [120, 100, 160, 180] }),
      detection({ tile: { suit: "z", rank: 1 }, box: [160, 100, 200, 180] }),
    ];
    expect(looksLikeConcealedFragment(discardWithIncidentalPair)).toBe(false);
  });

  it("handles an empty input", () => {
    expect(looksLikeConcealedFragment([])).toBe(false);
  });

  // 十三么/十六不搭/嚦咕嚦咕 are always fully concealed by construction
  // (scoring.ts guards all 3 on zero declared melds) and don't decompose
  // into "melds + one pair" the ordinary way at all - looksLikeSpecialHand
  // is the separate path that recognizes them. Same hand strings used
  // throughout scoring.test.ts.
  it("recognizes a complete 十三么 (thirteen orphans) hand", () => {
    expect(looksLikeConcealedFragment(rowFromHand("112349m19t19b1234567z", 100, 180))).toBe(true);
  });

  it("recognizes a complete 十六不搭 (sixteen unrelated) hand", () => {
    expect(looksLikeConcealedFragment(rowFromHand("147m147t258b11234567z", 100, 180))).toBe(true);
  });

  it("recognizes a complete 嚦咕嚦咕 (eight pairs) hand", () => {
    expect(looksLikeConcealedFragment(rowFromHand("1111m223344m5566777t", 100, 180))).toBe(true);
  });

  it("tolerates one extra stray tile on a special hand too - e.g. a 食胡 marker merged in from elsewhere", () => {
    const withStray = [...rowFromHand("112349m19t19b1234567z", 100, 180), detection({ tile: { suit: "b", rank: 5 }, box: [700, 100, 740, 180] })];
    expect(looksLikeConcealedFragment(withStray)).toBe(true);
  });

  it("still rejects a discard pile that happens to be exactly 17 tiles but doesn't actually form any special hand", () => {
    expect(looksLikeConcealedFragment(rowOfDistinctTiles(100, 180, 17))).toBe(false);
  });
});

describe("selectHandRows", () => {
  it("leaves 2 hand-like rows untouched", () => {
    const declared = rowOfDetections(100, 180, 4); // a kong
    const concealed = rowFromHand("123m55t", 400, 480);
    expect(selectHandRows([declared, concealed])).toEqual([declared, concealed]);
  });

  it("drops a messy row even when there are only 2 - a row with more tiles than any hand could hold never gets a box", () => {
    const huge = rowOfDetections(100, 180, 30);
    const normal = rowOfDetections(400, 480, 4);
    expect(selectHandRows([huge, normal])).toEqual([normal]);
  });

  it("leaves a single row untouched too", () => {
    const normal = rowOfDetections(100, 180, 4);
    expect(selectHandRows([normal])).toEqual([normal]);
  });

  it("drops an implausibly large row (more real tiles than any hand could hold) when 3+ rows are found, short-circuiting before the melds check", () => {
    const declared = rowOfDetections(100, 180, 4);
    const concealed = rowOfDetections(400, 480, 4);
    const discardPile = rowOfDetections(700, 780, 30); // way past COMPLETE_SIZE + MELDS_REQUIRED (22)
    const rows = selectHandRows([declared, concealed, discardPile]);
    expect(rows).toEqual([declared, concealed]);
  });

  it("can drop down to just 1 row if 2 of the 3+ are implausibly large", () => {
    const concealed = rowOfDetections(400, 480, 4);
    const discardA = rowOfDetections(100, 180, 30);
    const discardB = rowOfDetections(700, 780, 30);
    expect(selectHandRows([discardA, concealed, discardB])).toEqual([concealed]);
  });

  it("handles an empty input", () => {
    expect(selectHandRows([])).toEqual([]);
  });

  it("picks the one melds-decomposable row as declared, pairing it with the most CONCEALED-LOOKING (not necessarily largest) of the rest", () => {
    // A real photo can leave a genuinely tiny concealed remainder when
    // most of the hand is declared elsewhere - smaller than an ordinary
    // discard pile sitting in the same photo. Here the discard row (12
    // distinct tiles, no declared/concealed signals at all) is far
    // bigger than the true concealed row (just the hand's own pair, 2
    // tiles) - size alone would pick the discard pile, but the pair's
    // own hasPair signal (declarednessScore -1) correctly identifies it
    // as the more concealed-looking of the two.
    const discard = rowOfDistinctTiles(100, 180, 12);
    const declaredMeld = [
      detection({ tile: { suit: "t", rank: 5 }, box: [0, 400, 40, 480] }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 400, 80, 480] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 400, 120, 480] }),
      detection({ tile: null, className: "2f", box: [120, 400, 160, 480] }),
    ];
    const concealed = [
      detection({ tile: { suit: "b", rank: 7 }, box: [0, 700, 40, 780] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [40, 700, 80, 780] }),
    ];
    expect(selectHandRows([discard, declaredMeld, concealed])).toEqual([declaredMeld, concealed]);
  });

  it("picks an all-bonus-tile row as declared even with zero real tiles to decompose into melds - looksLikeDeclaredMelds alone would miss this (canFormMeldsAllowingOneStray on an empty array is false, not true), so this must also be caught via isAllBonusTiles, same as isRowADeclared's own leading check", () => {
    const pile = rowOfDistinctTiles(100, 180, 6); // an unrelated pile of loose tiles, plausible-sized but with no melds/pair/bonus signal of its own
    const bonusOnly = [
      detection({ tile: null, className: "1f", box: [0, 400, 40, 480] }),
      detection({ tile: null, className: "2s", box: [40, 400, 80, 480] }),
    ];
    const concealed = [
      detection({ tile: { suit: "m", rank: 5 }, box: [0, 700, 40, 780] }),
      detection({ tile: { suit: "m", rank: 6 }, box: [40, 700, 80, 780] }),
      detection({ tile: { suit: "m", rank: 7 }, box: [80, 700, 120, 780] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [120, 700, 160, 780] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [160, 700, 200, 780] }),
    ];
    expect(looksLikeDeclaredMelds(bonusOnly)).toBe(false);
    expect(selectHandRows([pile, bonusOnly, concealed])).toEqual([bonusOnly, concealed]);
  });

  it("does the same for just a SINGLE bonus tile declared, not only a 2+-tile bonus row - isAllBonusTiles doesn't care about count", () => {
    const pile = rowOfDistinctTiles(100, 180, 6);
    const oneBonusTile = [detection({ tile: null, className: "3s", box: [0, 400, 40, 480] })];
    // A genuine complete 17-tile hand (COMPLETE_SIZE) - the case this
    // matters most for: nothing else in the photo hints "declared" except
    // the single bonus tile itself.
    const concealed = rowFromHand("123456789m123456b1z1z", 700, 780);
    expect(selectHandRows([pile, oneBonusTile, concealed])).toEqual([oneBonusTile, concealed]);
  });

  it("prefers a genuine pair over a merely-rotated tile when picking the concealed candidate - a discard pile can have an accidentally-rotated tile too, but a matching pair is a stronger signal", () => {
    // The discard row has ONE tile that happens to look rotated (people
    // toss discards carelessly - this is plausible by pure accident,
    // unlike a genuine pair coincidentally appearing among otherwise-
    // independent discards) but no pair. Under plain declarednessScore
    // this would tie with a pair-only concealed candidate (both score
    // -1) - concealednessScore's extra pair weighting breaks that tie
    // correctly in the pair's favor.
    const discardWithRotatedTile = [
      detection({ tile: { suit: "m", rank: 1 }, box: [0, 100, 40, 180] }),
      detection({ tile: { suit: "t", rank: 3 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "b", rank: 9 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "z", rank: 5 }, box: [120, 60, 200, 100] }), // width 80, height 40 -> ratio 2.0, an outlier vs the rest's 0.5
    ];
    const declaredMeld = [
      detection({ tile: { suit: "t", rank: 5 }, box: [0, 400, 40, 480] }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 400, 80, 480] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 400, 120, 480] }),
    ];
    const concealedPairOnly = [
      detection({ tile: { suit: "b", rank: 7 }, box: [0, 700, 40, 780] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [40, 700, 80, 780] }),
    ];
    expect(declarednessScore(discardWithRotatedTile)).toBe(-1);
    expect(declarednessScore(concealedPairOnly)).toBe(-1);
    expect(selectHandRows([discardWithRotatedTile, declaredMeld, concealedPairOnly])).toEqual([declaredMeld, concealedPairOnly]);
  });

  it("picks the structurally-correct concealed fragment even when a discard pile scores LOWER (more concealed-looking) on concealednessScore alone - a real photo can have BOTH a coincidental pair AND a coincidentally-rotated tile in the same discard pile", () => {
    // The discard row has a coincidental pair (1z x2) AND a coincidentally
    // -rotated tile (6z) at once - concealednessScore -3, actually LOWER
    // (more "concealed-looking") than the genuine concealed fragment's own
    // -2. Picking by score alone would get this backwards; the true
    // concealed row still wins because it's the only one that actually
    // decomposes into melds + exactly one pair (looksLikeConcealedFragment).
    const discardWithPairAndRotation = [
      detection({ tile: { suit: "m", rank: 2 }, box: [0, 100, 40, 180] }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "b", rank: 9 }, box: [80, 100, 120, 180] }),
      detection({ tile: { suit: "z", rank: 1 }, box: [120, 100, 160, 180] }),
      detection({ tile: { suit: "z", rank: 1 }, box: [160, 100, 200, 180] }),
      detection({ tile: { suit: "z", rank: 6 }, box: [200, 60, 280, 100] }), // width 80, height 40 -> ratio 2.0, a rotated outlier
    ];
    const declaredMeld = [
      detection({ tile: { suit: "t", rank: 5 }, box: [0, 400, 40, 480] }),
      detection({ tile: { suit: "t", rank: 6 }, box: [40, 400, 80, 480] }),
      detection({ tile: { suit: "t", rank: 7 }, box: [80, 400, 120, 480] }),
    ];
    const concealedFragment = [
      detection({ tile: { suit: "m", rank: 7 }, box: [0, 700, 40, 780] }),
      detection({ tile: { suit: "m", rank: 8 }, box: [40, 700, 80, 780] }),
      detection({ tile: { suit: "m", rank: 9 }, box: [80, 700, 120, 780] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [120, 700, 160, 780] }),
      detection({ tile: { suit: "b", rank: 7 }, box: [160, 700, 200, 780] }),
    ];
    expect(concealednessScore(discardWithPairAndRotation)).toBeLessThan(concealednessScore(concealedFragment));
    expect(looksLikeConcealedFragment(discardWithPairAndRotation)).toBe(false);
    expect(looksLikeConcealedFragment(concealedFragment)).toBe(true);
    expect(selectHandRows([discardWithPairAndRotation, declaredMeld, concealedFragment])).toEqual([declaredMeld, concealedFragment]);
  });

  it("falls back to the single most CONCEALED-LOOKING row (not necessarily largest) when no row decomposes into melds at all", () => {
    const discardA = rowOfDistinctTiles(100, 180, 4);
    const discardB = rowOfDistinctTiles(400, 480, 13); // larger, but no concealed-leaning signal at all
    const concealedGuess = [
      detection({ tile: { suit: "z", rank: 2 }, box: [0, 700, 40, 780] }),
      detection({ tile: { suit: "z", rank: 2 }, box: [40, 700, 80, 780] }),
    ]; // smaller, but carries the hand's own pair signal
    expect(selectHandRows([discardA, discardB, concealedGuess])).toEqual([concealedGuess]);
  });

  it("picks a special hand (十六不搭 here) as the sole concealed candidate over 2 discard piles, even though it never registers as a declared-melds row itself", () => {
    // 十三么/十六不搭/嚦咕嚦咕 are always fully concealed (zero declared
    // melds by construction) - with no separate declared row to pair
    // against, this exercises selectHandRows' "no clear declared row"
    // fallback branch, which must still correctly single out the special
    // hand over unrelated discard piles sitting in the same photo.
    const discardA = rowOfDistinctTiles(400, 480, 8);
    const discardB = rowOfDistinctTiles(700, 780, 8);
    const sixteenUnrelated = rowFromHand("147m147t258b11234567z", 100, 180);
    expect(selectHandRows([discardA, sixteenUnrelated, discardB])).toEqual([sixteenUnrelated]);
  });
});

describe("rowToRegion", () => {
  // A square image exactly IMG_SIZE on each side makes letterbox()'s own
  // scale/pad reversal a no-op (scale 1, zero pad), so the raw box
  // coordinates map straight onto fractions of IMG_SIZE with nothing else
  // to account for - keeps the padding math below easy to hand-verify.
  const squareImage = { naturalWidth: IMG_SIZE, naturalHeight: IMG_SIZE };

  it("applies the normal ROW_PAD_X/ROW_PAD_Y padding to a row with no rotated outlier", () => {
    const row = rowOfDetections(100, 180, 3); // raw bbox x:[0,120] y:[100,180]
    const region = rowToRegion(row, squareImage);
    expect(region.x).toBeCloseTo(0); // already at 0, padding only clamps further negative
    expect(region.y).toBeCloseTo(0.11875);
    expect(region.w).toBeCloseTo(0.2025);
    expect(region.h).toBeCloseTo(0.2);
  });

  it("uses the larger ROTATED_TILE_ROW_PAD_Y instead when the row contains a rotated outlier", () => {
    const upright = rowOfDetections(100, 180, 3); // ratio 0.5 each
    const rotated = detection({ box: [200, 100, 280, 140] }); // ratio 2.0 - a clear outlier
    const region = rowToRegion([...upright, rotated], squareImage);
    expect(region.y).toBeCloseTo(0.1125);
    expect(region.h).toBeCloseTo(0.2125);
  });

  it("uses a caller-supplied padXFraction (e.g. SPLIT_PAD_X) instead of the default ROW_PAD_X", () => {
    // Shifted off x=0 so a smaller pad is actually visible instead of
    // being clamped away by clamp01.
    const row = [
      detection({ box: [100, 100, 140, 180] }),
      detection({ box: [140, 100, 180, 180] }),
      detection({ box: [180, 100, 220, 180] }),
    ];
    const wide = rowToRegion(row, squareImage); // default ROW_PAD_X
    const tight = rowToRegion(row, squareImage, 0.015); // a SPLIT_PAD_X-sized override
    expect(tight.w).toBeLessThan(wide.w);
    expect(tight.x).toBeGreaterThan(wide.x);
  });

  it("never lets padding push the region outside the [0,1] frame", () => {
    const row = rowOfDetections(0, IMG_SIZE, 3); // already spans the full frame vertically
    const region = rowToRegion(row, squareImage);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.y + region.h).toBeLessThanOrEqual(1);
  });

  it("widens a sliver-thin region (e.g. a single bonus tile, no declared melds at all) up to MIN_REGION_WIDTH", () => {
    const oneTile = [detection({ box: [300, 100, 340, 180] })]; // raw width 40/640 = 0.0625, well under 0.1 even padded
    const region = rowToRegion(oneTile, squareImage);
    expect(region.w).toBeCloseTo(0.1);
  });

  it("widens by shifting away from the frame edge rather than clamping short of MIN_REGION_WIDTH", () => {
    const nearEdge = [detection({ box: [0, 100, 20, 180] })]; // sits right at x=0
    const region = rowToRegion(nearEdge, squareImage);
    expect(region.x).toBeCloseTo(0);
    expect(region.w).toBeCloseTo(0.1); // still reaches the full minimum, expanding rightward only
  });

  it("does NOT apply the minimum-width floor when a caller passes a custom padXFraction (e.g. SPLIT_PAD_X) - widening either of splitMixedRow's tightly-packed halves could make them overlap", () => {
    const oneTile = [detection({ box: [300, 100, 340, 180] })];
    const region = rowToRegion(oneTile, squareImage, 0.015);
    expect(region.w).toBeLessThan(0.1);
  });

  it("leaves an already-wide region untouched by the minimum-width floor", () => {
    const wideRow = rowOfDetections(100, 180, 10); // raw width 400/640 = 0.625, way over 0.1
    const region = rowToRegion(wideRow, squareImage);
    expect(region.w).toBeGreaterThan(0.1);
  });

  it("floors the horizontal padding at one tile's own width (minEdgePadTiles) when ROW_PAD_X's proportional padding would be smaller", () => {
    const row = rowOfDetections(100, 180, 3); // raw bbox x:[0,120], each tile 40px wide (40/640 = 0.0625 fraction)
    const withoutFloor = rowToRegion(row, squareImage); // default ROW_PAD_X padding: 0.08 * 0.1875 = 0.015 - smaller than a tile's own width
    const withFloor = rowToRegion(row, squareImage, ROW_PAD_X, 1);
    expect(withFloor.w).toBeGreaterThan(withoutFloor.w);
    expect(withFloor.w).toBeCloseTo(0.25); // 0.1875 raw + 0.0625 pad on each side
  });

  it("leaves the padding at ROW_PAD_X's own (already larger) amount when minEdgePadTiles's floor wouldn't add anything", () => {
    const row = rowOfDetections(100, 180, 20); // raw width fraction 1.25 - ROW_PAD_X's own padding (0.1) already exceeds one tile's width (0.0625)
    const withoutFloor = rowToRegion(row, squareImage);
    const withFloor = rowToRegion(row, squareImage, ROW_PAD_X, 1);
    expect(withFloor.w).toBeCloseTo(withoutFloor.w);
  });
});

describe("resolveVerticalOverlap", () => {
  it("leaves two non-overlapping regions untouched", () => {
    const top = { x: 0, y: 0.1, w: 1, h: 0.2 }; // spans y:[0.1,0.3]
    const bottom = { x: 0, y: 0.5, w: 1, h: 0.2 }; // spans y:[0.5,0.7]
    expect(resolveVerticalOverlap(top, bottom)).toEqual([top, bottom]);
  });

  it("trims two overlapping regions to meet at the midpoint of their combined span, regardless of argument order", () => {
    // top spans y:[0.3,0.5], bottom spans y:[0.4,0.8] - they overlap on
    // [0.4,0.5]; midpoint of top's bottom edge (0.5) and bottom's top
    // edge (0.4) is 0.45.
    const top = { x: 0, y: 0.3, w: 1, h: 0.2 };
    const bottom = { x: 0.2, y: 0.4, w: 0.5, h: 0.4 };
    const [a, b] = resolveVerticalOverlap(top, bottom);
    expect(a.y).toBeCloseTo(0.3);
    expect(a.h).toBeCloseTo(0.15); // trimmed to end at 0.45
    expect(b.y).toBeCloseTo(0.45);
    expect(b.h).toBeCloseTo(0.35); // trimmed to start at 0.45, still ending at 0.8
    // Passing them in the other order produces the same resolved pair, just swapped back.
    const [b2, a2] = resolveVerticalOverlap(bottom, top);
    expect(a2).toEqual(a);
    expect(b2).toEqual(b);
  });

  it("leaves side-by-side regions at the same height untouched - e.g. splitMixedRow's two halves of one row", () => {
    // Same vertical span (one physical row, slightly tilted), separated
    // horizontally - they don't actually overlap, so neither should be
    // sliced into a horizontal strip.
    const concealed = { x: 0.066, y: 0.5, w: 0.757, h: 0.295 };
    const declared = { x: 0.848, y: 0.51, w: 0.071, h: 0.188 };
    expect(resolveVerticalOverlap(declared, concealed)).toEqual([declared, concealed]);
  });

  it("leaves x/w untouched - only y/h are ever trimmed", () => {
    const top = { x: 0.1, y: 0.3, w: 0.6, h: 0.3 };
    const bottom = { x: 0.2, y: 0.5, w: 0.4, h: 0.3 };
    const [a, b] = resolveVerticalOverlap(top, bottom);
    expect(a.x).toBe(0.1);
    expect(a.w).toBe(0.6);
    expect(b.x).toBe(0.2);
    expect(b.w).toBe(0.4);
  });
});

describe("splitMixedRow", () => {
  it("splits a row mixing bonus and real tiles into declared (bonus) and concealed (real) halves", () => {
    const bonus = detection({ tile: null, className: "1f", box: [0, 100, 40, 180] });
    const real = rowOfDetections(100, 180, 4).map((d, i) => ({ ...d, box: [200 + i * 40, 100, 240 + i * 40, 180] as [number, number, number, number] }));
    const result = splitMixedRow([bonus, ...real]);
    expect(result).toEqual({ declared: [bonus], concealed: real });
  });

  it("returns null for a row that's entirely bonus tiles - nothing to split against", () => {
    const bonusOnly = [detection({ tile: null, className: "1f" }), detection({ tile: null, className: "2f" })];
    expect(splitMixedRow(bonusOnly)).toBeNull();
  });

  it("returns null for a row that's entirely real tiles - nothing to split against", () => {
    expect(splitMixedRow(rowOfDetections(100, 180, 4))).toBeNull();
  });

  it("handles an empty input", () => {
    expect(splitMixedRow([])).toBeNull();
  });
});

describe("detailWindows", () => {
  it("splits a wide 16:9 frame into just left/right halves - splitting its height too wouldn't enlarge the tiles any further", () => {
    expect(detailWindows({ naturalWidth: 1188, naturalHeight: 668 })).toEqual([
      { x: 0, y: 0, w: 713, h: 668 },
      { x: 475, y: 0, w: 713, h: 668 },
    ]);
  });

  it("splits a tall 9:16 frame into just top/bottom halves", () => {
    expect(detailWindows({ naturalWidth: 668, naturalHeight: 1188 })).toEqual([
      { x: 0, y: 0, w: 668, h: 713 },
      { x: 0, y: 475, w: 668, h: 713 },
    ]);
  });

  it("uses the full overlapping 2x2 grid for a near-square 4:3 phone photo, where splitting one axis alone barely helps", () => {
    const windows = detailWindows({ naturalWidth: 4032, naturalHeight: 3024 });
    expect(windows).toHaveLength(4);
    expect(windows).toContainEqual({ x: 0, y: 0, w: 2419, h: 1814 });
    expect(windows).toContainEqual({ x: 1613, y: 1210, w: 2419, h: 1814 });
  });
});

describe("mapWindowDetections", () => {
  // 1280x640: the whole photo letterboxes at scale 0.5 with 160px of
  // padding top and bottom. The window is its right 60% (768x640), which
  // letterboxes at scale 640/768 with ~53.3px of padding top and bottom.
  const image = { naturalWidth: 1280, naturalHeight: 640 };
  const win = { x: 512, y: 0, w: 768, h: 640 };

  it("maps a box from the window's letterboxed frame into the whole photo's letterboxed frame", () => {
    const [mapped] = mapWindowDetections([detection({ box: [100, 200, 140, 260] })], win, image);
    // x: window px 100 -> source 512 + 100 / (640/768) = 632 -> whole frame 632 * 0.5 = 316
    // y: window px 200 -> source (200 - 53.33) / (640/768) = 176 -> whole frame 160 + 176 * 0.5 = 248
    expect(mapped.box[0]).toBeCloseTo(316);
    expect(mapped.box[1]).toBeCloseTo(248);
    expect(mapped.box[2]).toBeCloseTo(0.5 * (512 + 140 * 1.2));
    expect(mapped.box[3]).toBeCloseTo(160 + 0.5 * ((260 - 160 / 3) * 1.2));
  });

  it("drops a tile cut off at the window's inner edge, but keeps one touching an edge that's also the photo's own border", () => {
    const cutAtInnerLeft = detection({ box: [0, 200, 30, 260] }); // window's left edge is inside the photo
    const atPhotoRight = detection({ box: [600, 200, 640, 260] }); // window's right edge IS the photo's right edge
    expect(mapWindowDetections([cutAtInnerLeft, atPhotoRight], win, image)).toHaveLength(1);
    expect(mapWindowDetections([cutAtInnerLeft], win, image)).toEqual([]);
  });
});

describe("regionsFromRows", () => {
  it("keeps a split row's two halves whole instead of slicing them into horizontal strips, even when the row is tilted", () => {
    // One tilted row (IMG_SIZE square image, so box px / 640 = fraction):
    // real tiles on the left sit lower, the bonus tile on the right sits
    // higher - the two halves share a vertical span but sit side by side.
    const image = { naturalWidth: IMG_SIZE, naturalHeight: IMG_SIZE };
    const row = [
      detection({ tile: { suit: "m", rank: 1 }, box: [40, 420, 80, 500] }),
      detection({ tile: { suit: "m", rank: 2 }, box: [80, 415, 120, 495] }),
      detection({ tile: { suit: "m", rank: 3 }, box: [120, 410, 160, 490] }),
      detection({ tile: null, className: "3f", box: [500, 380, 540, 460] }),
    ];
    const regions = regionsFromRows([row], image)!;
    const { declared, concealed } = regions;
    // Each region still fully covers its own tiles vertically.
    expect(declared!.y).toBeLessThanOrEqual(380 / IMG_SIZE);
    expect(declared!.y + declared!.h).toBeGreaterThanOrEqual(460 / IMG_SIZE);
    expect(concealed.y).toBeLessThanOrEqual(410 / IMG_SIZE);
    expect(concealed.y + concealed.h).toBeGreaterThanOrEqual(500 / IMG_SIZE);
  });
});

describe("recheckRects", () => {
  it("only ever grows the region outward, so no tile the user included is ever cropped off", () => {
    const rect = { x: 0.3, y: 0.3, w: 0.4, h: 0.2 };
    const variants = recheckRects(rect);
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(v.x).toBeLessThanOrEqual(rect.x);
      expect(v.y).toBeLessThanOrEqual(rect.y);
      expect(v.x + v.w).toBeGreaterThanOrEqual(rect.x + rect.w - 1e-9);
      expect(v.y + v.h).toBeGreaterThanOrEqual(rect.y + rect.h - 1e-9);
    }
  });

  it("clamps to the photo and drops variants that clamping makes identical to the region or to each other", () => {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    expect(recheckRects(full)).toEqual([]); // nowhere left to grow
    const variants = recheckRects({ x: 0, y: 0.3, w: 1, h: 0.2 }); // already full-width
    for (const v of variants) expect(v.x >= 0 && v.x + v.w <= 1 + 1e-9).toBe(true);
    const keys = variants.map((v) => [v.x, v.y, v.w, v.h].map((n) => n.toFixed(6)).join());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("remapDetections", () => {
  const image = { naturalWidth: 1000, naturalHeight: 500 };

  it("round-trips a box through the photo: crop A's frame -> crop B's frame lands on the same photo pixels", () => {
    const a = photoCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, image); // 500x200 px at (100,100)
    const b = photoCrop({ x: 0.05, y: 0.1, w: 0.7, h: 0.6 }, image); // 700x300 px at (50,50)
    // In A's letterbox frame (scale 640/500 = 1.28, padY = (640-256)/2 = 192),
    // box [128, 256, 192, 320] covers photo px x 200-250, y 150-200.
    const [mapped] = remapDetections([detection({ box: [128, 256, 192, 320] })], a, b);
    // In B's frame (scale 640/700, padY = (640 - 300*640/700)/2):
    const s = 640 / 700;
    const padY = (640 - 300 * s) / 2;
    expect(mapped.box[0]).toBeCloseTo((200 - 50) * s);
    expect(mapped.box[1]).toBeCloseTo(padY + (150 - 50) * s);
    expect(mapped.box[2]).toBeCloseTo((250 - 50) * s);
    expect(mapped.box[3]).toBeCloseTo(padY + (200 - 50) * s);
  });

  it("drops a tile whose center falls outside the target crop - a wider re-check crop mustn't pull in the neighbouring row", () => {
    const wide = photoCrop({ x: 0, y: 0, w: 1, h: 1 }, image);
    const region = photoCrop({ x: 0.2, y: 0.4, w: 0.6, h: 0.2 }, image); // photo y 200-300
    // Whole-photo frame: scale 0.64, padY 160. A tile at photo y 100-150 (above the region):
    const outside = detection({ box: [200, 160 + 64, 230, 160 + 96] });
    // ...and one at photo y 220-280 (inside it):
    const inside = detection({ box: [200, 160 + 140.8, 230, 160 + 179.2] });
    expect(remapDetections([outside, inside], wide, region)).toHaveLength(1);
  });
});

describe("mergeRecheckRuns", () => {
  const tile = (className: string, x: number, confidence = 0.8): Detection =>
    detection({ className, tile: { suit: className.slice(-1) as "b", rank: Number(className[0]) }, confidence, box: [x, 100, x + 40, 180] });

  it("adds a tile the first pass missed only when a majority of re-check runs found it", () => {
    const first = [tile("2b", 100), tile("3b", 140)];
    const runs = [
      [tile("1b", 60), tile("2b", 100), tile("3b", 140)],
      [tile("1b", 61), tile("2b", 100)],
      [tile("1b", 59), tile("3b", 140)],
      [tile("2b", 100), tile("3b", 140)],
      [tile("2b", 100), tile("5z", 400)], // a one-off stray in a single run
    ];
    const merged = mergeRecheckRuns(first, runs);
    expect(merged.map((d) => d.className).sort()).toEqual(["1b", "2b", "3b"]);
    expect(merged.find((d) => d.className === "1b")!.recovery).toBe("added");
    expect(merged.filter((d) => d.recovery === null)).toHaveLength(2);
  });

  it("does not add a tile found by only half the re-check runs", () => {
    const runs = [[tile("1b", 60)], [tile("1b", 60)], [], []];
    expect(mergeRecheckRuns([], runs)).toEqual([]);
  });

  it("always keeps a first-pass tile, and renames it when the re-check runs mostly read it as something else", () => {
    const first = [tile("1z", 60, 0.45)];
    const runs = [[tile("1b", 60, 0.7)], [tile("1b", 61, 0.72)], [tile("1z", 60, 0.5)], []];
    const [only] = mergeRecheckRuns(first, runs);
    expect(only.className).toBe("1b");
    expect(only.tile).toEqual({ suit: "b", rank: 1 });
    expect(only.recovery).toBe("reclassified");
    expect(only.box).toEqual(first[0].box); // keeps the first pass's own box
    expect(mergeRecheckRuns([tile("4b", 200)], [[], []])).toEqual([{ ...tile("4b", 200), recovery: null }]);
  });
});

describe("isCompleteHandRow / selectHandRows with a complete concealed hand", () => {
  // 南南南 西西西 白白白 東東東 北北北 + 七萬 pair - a complete 17-tile hand.
  const completeHand = () => rowFromHand("222333555111444z77m", 400, 480);
  const bonus = (className: string, x: number, y1 = 400, y2 = 480) => detection({ tile: null, className, box: [x, y1, x + 40, y2] });

  it("recognises a row whose real tiles form a complete hand, ignoring bonus tiles in it", () => {
    const row = [bonus("2f", 0), bonus("4s", 40), bonus("1s", 80), ...completeHand().map((d) => ({ ...d, box: [d.box[0] + 120, d.box[1], d.box[2] + 120, d.box[3]] as Detection["box"] }))];
    expect(isCompleteHandRow(row)).toBe(true);
    expect(isCompleteHandRow(rowOfDistinctTiles(400, 480, 17))).toBe(false); // 17, but no hand shape
  });

  it("tolerates one detection mistake - a tile missed, misread, or extra - but not two", () => {
    const hand = completeHand();
    expect(isCompleteHandRow(hand.slice(1))).toBe(true); // one missed (16)
    const misread = hand.map((d, i) => (i === 4 ? { ...d, tile: { suit: "b" as const, rank: 5 }, className: "5b" } : d));
    expect(isCompleteHandRow(misread)).toBe(true); // one misread (17)
    expect(isCompleteHandRow([...hand, detection({ tile: { suit: "t", rank: 9 }, className: "9t", box: [900, 400, 940, 480] })])).toBe(true); // one extra (18)
    expect(isCompleteHandRow(hand.slice(2))).toBe(false); // two missed (15)
    const twoMisread = misread.map((d, i) => (i === 10 ? { ...d, tile: { suit: "m" as const, rank: 1 }, className: "1m" } : d));
    expect(isCompleteHandRow(twoMisread)).toBe(false); // two misread
  });

  it("drops a discard pile next to a complete hand, even with only 2 rows - the discard pile can't be declared melds", () => {
    const discards = rowOfDistinctTiles(100, 180, 9);
    const hand = completeHand();
    expect(selectHandRows([discards, hand])).toEqual([hand]);
  });

  it("keeps a separate all-bonus row alongside a complete hand as the declared side, dropping the discard pile", () => {
    const discards = rowOfDistinctTiles(100, 180, 9);
    const flowers = [bonus("1f", 0, 250, 330), bonus("2f", 40, 250, 330)];
    const hand = completeHand();
    expect(selectHandRows([discards, flowers, hand])).toEqual([flowers, hand]);
  });
});

describe("regionsFromRows with bonus tiles in the same row as the hand", () => {
  const image = { naturalWidth: IMG_SIZE, naturalHeight: IMG_SIZE };
  const real = (x: number) => detection({ tile: { suit: "z", rank: 2 }, box: [x, 400, x + 40, 480] });
  const bonus = (x: number) => detection({ tile: null, className: "2f", box: [x, 400, x + 40, 480] });

  it("draws two side-by-side boxes when the bonus tiles sit together at one end", () => {
    const row = [bonus(20), bonus(60), real(140), real(180), real(220)];
    const { declared, concealed } = regionsFromRows([row], image)!;
    expect(declared).toBeDefined();
    expect(declared!.x + declared!.w).toBeLessThanOrEqual(concealed.x);
  });

  it("still draws two boxes when the bonus tiles touch the hand, meeting halfway between the touching tiles", () => {
    const row = [bonus(20), bonus(60), real(100), real(140), real(180)]; // 2nd bonus tile's right edge = 1st real tile's left edge
    const { declared, concealed } = regionsFromRows([row], image)!;
    expect(declared).toBeDefined();
    expect(declared!.x + declared!.w).toBeCloseTo(100 / IMG_SIZE);
    expect(concealed.x).toBeCloseTo(100 / IMG_SIZE);
    expect(declared!.x).toBeLessThanOrEqual(20 / IMG_SIZE);
    expect(concealed.x + concealed.w).toBeGreaterThanOrEqual(220 / IMG_SIZE);
  });

  it("gives the bonus-tile box at least 1.5 tiles of room at its outer end, so a missed outer bonus tile stays inside it", () => {
    const row = [bonus(200), bonus(240), real(280), real(320), real(360)]; // tiles 40 wide
    const { declared } = regionsFromRows([row], image)!;
    expect(declared!.x).toBeLessThanOrEqual((200 - 1.5 * 40) / IMG_SIZE + 1e-9);
  });

  it("never lets the two halves overlap by a rounding error, and never slices the bonus box - across many tile positions", () => {
    for (let i = 0; i < 400; i++) {
      const x0 = 3 + i * 1.37; // assorted fractional positions
      const w = 38 + (i % 7) * 0.61;
      const row = [0, 1, 2].map((k) => bonus(x0 + k * w)).concat([3, 4, 5, 6].map((k) => real(x0 + k * w)));
      row.forEach((d) => (d.box[2] = d.box[0] + w));
      const { declared, concealed } = regionsFromRows([row], { naturalWidth: 1000, naturalHeight: 640 })!;
      expect(declared).toBeDefined();
      expect(declared!.x + declared!.w).toBeLessThanOrEqual(concealed.x);
      // bonus box still spans its tiles top to bottom (tiles span y 400-480 of 640, frame padded to 1000 wide)
      expect(declared!.h).toBeGreaterThan(concealed.h * 0.9);
    }
  });

  it("gives a tile-sized gap between the bonus tiles and the hand to the bonus box - a missed bonus tile most likely sits there", () => {
    const row = [bonus(20), bonus(60), real(140), real(180), real(220)]; // a 40px (1 tile) gap after the 2nd bonus tile
    const { declared, concealed } = regionsFromRows([row], image)!;
    expect(declared!.x + declared!.w).toBeCloseTo(140 / IMG_SIZE, 4); // boundary at the hand's own edge, not the midpoint (120)
    expect(concealed.x).toBeCloseTo(140 / IMG_SIZE, 4);
  });

  it("works with the bonus tiles at the right-hand end too", () => {
    const row = [real(20), real(60), real(100), bonus(140), bonus(180)];
    const { declared, concealed } = regionsFromRows([row], image)!;
    expect(declared!.x).toBeCloseTo(140 / IMG_SIZE);
    expect(concealed.x + concealed.w).toBeCloseTo(140 / IMG_SIZE);
  });

  it("falls back to one Concealed box around the whole row when bonus tiles are at both ends - no clean split", () => {
    const row = [bonus(20), real(100), real(140), real(180), bonus(260)];
    const regions = regionsFromRows([row], image)!;
    expect(regions.declared).toBeUndefined();
    expect(regions.concealed.x).toBeLessThanOrEqual(20 / IMG_SIZE);
    expect(regions.concealed.x + regions.concealed.w).toBeGreaterThanOrEqual(300 / IMG_SIZE);
  });
});

describe("isHandLikeRow (messy rows get no box)", () => {
  it("rejects a discard pile, however neatly it's laid out - the tiles don't group into anything", () => {
    // The real discard row from a test photo: 9b 5z 9m 9b 2m 4b 7t 5b 2z.
    expect(isHandLikeRow(rowFromHand("9b5z9m9b2m4b7t5b2z", 100, 180))).toBe(false);
    expect(isHandLikeRow(rowOfDistinctTiles(100, 180, 8))).toBe(false);
  });

  it("accepts every kind of row a hand is made of", () => {
    expect(isHandLikeRow(rowFromHand("123m555t789b", 100, 180))).toBe(true); // declared melds
    expect(isHandLikeRow(rowFromHand("123m456t77z", 100, 180))).toBe(true); // melds + pair
    expect(isHandLikeRow(rowFromHand("123m456t789b11z2z", 100, 180))).toBe(true); // one tile short - waiting
    expect(isHandLikeRow(rowFromHand("123456789m123456b1z", 100, 180))).toBe(true); // a 16-tile waiting hand
    expect(isHandLikeRow(rowFromHand("33b", 100, 180))).toBe(true); // just the pair
    expect(isHandLikeRow([detection({ tile: null, className: "1f" })])).toBe(true); // bonus only
  });

  it("still accepts a real row read with one mistake", () => {
    // 123m 456t 789b + 11z, with the 5t misread as 5b
    expect(isHandLikeRow(rowFromHand("123m4t5b6t789b11z", 100, 180))).toBe(true);
  });

  it("drops a messy row between the two real ones", () => {
    const discards = rowFromHand("9b5z9m9b2m4b7t5b2z", 100, 180);
    const declared = rowFromHand("123m555t", 400, 480);
    const concealed = rowFromHand("456b77z", 700, 780);
    expect(selectHandRows([discards, declared, concealed])).toEqual([declared, concealed]);
  });

  it("returns nothing when every row is messy - the caller falls back to its default boxes", () => {
    expect(selectHandRows([rowOfDistinctTiles(100, 180, 7), rowOfDistinctTiles(400, 480, 9)])).toEqual([]);
  });
});

describe("extendRowEnds (tiles missed at a row's ends)", () => {
  // Tiles 40 wide, 80 tall, sitting side by side along y 400-480.
  const t = (className: string, x: number, y1 = 400, y2 = 480) =>
    detection({ className, tile: { suit: className.slice(-1) as "b", rank: Number(className[0]) }, box: [x, y1, x + 40, y2] });

  it("adds the missed end tiles, tile by tile - e.g. a concealed row's 1b and 2b", () => {
    const row = [t("3b", 200), t("6b", 260), t("7b", 300)];
    const grown = extendRowEnds(row, [t("2b", 160), t("1b", 120), t("3b", 201)]); // 3b again = the same tile, seen twice
    expect(grown.map((d) => d.className).sort()).toEqual(["1b", "2b", "3b", "6b", "7b"]);
  });

  it("grows the right-hand end too, and across an ordinary gap between melds", () => {
    const row = [t("1m", 100), t("2m", 140), t("3m", 180)];
    const grown = extendRowEnds(row, [t("4t", 250), t("5t", 290)]); // 30px gap after 3m - under 2 tiles
    expect(grown).toHaveLength(5);
  });

  it("doesn't jump to something further than 2 tile-widths away", () => {
    const row = [t("1m", 100), t("2m", 140), t("3m", 180)];
    expect(extendRowEnds(row, [t("9t", 320)])).toEqual(row); // 100px gap = 2.5 tiles
  });

  it("changes nothing for one big row with nothing past its ends", () => {
    const row = [t("1f", 0), t("2f", 40), t("1m", 80), t("2m", 120), t("3m", 160)];
    expect(extendRowEnds(row, [])).toEqual(row);
    expect(extendRowEnds(row, row.map((d) => ({ ...d })))).toHaveLength(5); // the look re-finds the same tiles - no duplicates
  });

  it("never pulls in a bonus-tile row sitting just above the concealed row", () => {
    const concealed = [t("3b", 200), t("4b", 240), t("5b", 280)];
    const bonusAbove = [detection({ tile: null, className: "1f", box: [150, 330, 190, 395] }), detection({ tile: null, className: "2f", box: [110, 330, 150, 395] })];
    expect(extendRowEnds(concealed, bonusAbove)).toEqual(concealed); // centres above the row's own band
  });

  it("never takes a tile that already belongs to another row, even if it's in line", () => {
    const concealed = [t("3b", 200), t("4b", 240), t("5b", 280)];
    const bonus = detection({ tile: null, className: "1f", box: [160, 400, 200, 480] }); // tight against the row, same height
    expect(extendRowEnds(concealed, [bonus], [bonus])).toEqual(concealed);
  });
});
