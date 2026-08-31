import { describe, expect, it } from "vitest";
import {
  clusterRows,
  declarednessScore,
  dropImplausibleRows,
  findRotatedOutlier,
  IMG_SIZE,
  isRowADeclared,
  nonMaxSuppression,
  rowToRegion,
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
  it("falls through to declarednessScore's own comparison when neither row is all-bonus", () => {
    const kongRow = rowOfDetections(100, 180, 4); // hasKong -> +1
    const pairRow = [
      detection({ tile: { suit: "b", rank: 5 } }),
      detection({ tile: { suit: "b", rank: 5 }, box: [40, 100, 80, 180] }),
      detection({ tile: { suit: "b", rank: 9 }, box: [80, 100, 120, 180] }),
    ]; // hasPair -> -1
    expect(isRowADeclared(kongRow, pairRow)).toBe(true);
    expect(isRowADeclared(pairRow, kongRow)).toBe(false);
  });

  it("decisively picks an all-bonus row as Declared even when the other row has a stronger declaredness score", () => {
    const bonusOnly = [detection({ tile: null, className: "1f" })];
    const kongRow = rowOfDetections(100, 180, 4); // would normally win declarednessScore's own comparison (+1 vs 0)
    expect(isRowADeclared(bonusOnly, kongRow)).toBe(true);
    expect(isRowADeclared(kongRow, bonusOnly)).toBe(false);
  });

  it("falls through to position (rowA wins the tie) when both rows are all-bonus", () => {
    const bonusA = [detection({ tile: null, className: "1f" })];
    const bonusB = [detection({ tile: null, className: "2f" })];
    expect(isRowADeclared(bonusA, bonusB)).toBe(true);
  });
});

describe("dropImplausibleRows", () => {
  it("leaves rows untouched when there are only 2, however large one is", () => {
    const huge = rowOfDetections(100, 180, 30);
    const normal = rowOfDetections(400, 480, 4);
    expect(dropImplausibleRows([huge, normal])).toEqual([huge, normal]);
  });

  it("leaves a single row untouched too", () => {
    const normal = rowOfDetections(100, 180, 4);
    expect(dropImplausibleRows([normal])).toEqual([normal]);
  });

  it("drops an implausibly large row (more real tiles than any hand could hold) when 3+ rows are found", () => {
    const declared = rowOfDetections(100, 180, 4);
    const concealed = rowOfDetections(400, 480, 4);
    const discardPile = rowOfDetections(700, 780, 30); // way past COMPLETE_SIZE + MELDS_REQUIRED (22)
    const rows = dropImplausibleRows([declared, concealed, discardPile]);
    expect(rows).toEqual([declared, concealed]);
  });

  it("can drop down to just 1 row if 2 of the 3+ are implausibly large", () => {
    const concealed = rowOfDetections(400, 480, 4);
    const discardA = rowOfDetections(100, 180, 30);
    const discardB = rowOfDetections(700, 780, 30);
    expect(dropImplausibleRows([discardA, concealed, discardB])).toEqual([concealed]);
  });

  it("handles an empty input", () => {
    expect(dropImplausibleRows([])).toEqual([]);
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
