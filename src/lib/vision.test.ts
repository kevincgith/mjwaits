import { describe, expect, it } from "vitest";
import {
  clusterRows,
  declarednessScore,
  findRotatedOutlier,
  IMG_SIZE,
  isPairOnlyRow,
  isRowADeclared,
  looksLikeDeclaredMelds,
  nonMaxSuppression,
  resolveVerticalOverlap,
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

describe("selectHandRows", () => {
  it("leaves rows untouched when there are only 2, however large one is", () => {
    const huge = rowOfDetections(100, 180, 30);
    const normal = rowOfDetections(400, 480, 4);
    expect(selectHandRows([huge, normal])).toEqual([huge, normal]);
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

  it("falls back to the single most CONCEALED-LOOKING row (not necessarily largest) when no row decomposes into melds at all", () => {
    const discardA = rowOfDistinctTiles(100, 180, 4);
    const discardB = rowOfDistinctTiles(400, 480, 13); // larger, but no concealed-leaning signal at all
    const concealedGuess = [
      detection({ tile: { suit: "z", rank: 2 }, box: [0, 700, 40, 780] }),
      detection({ tile: { suit: "z", rank: 2 }, box: [40, 700, 80, 780] }),
    ]; // smaller, but carries the hand's own pair signal
    expect(selectHandRows([discardA, discardB, concealedGuess])).toEqual([concealedGuess]);
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
    expect(region.y).toBeCloseTo(0.09375);
    expect(region.h).toBeCloseTo(0.25);
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
