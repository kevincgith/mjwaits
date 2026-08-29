import { describe, expect, it } from "vitest";
import { clusterRows, nonMaxSuppression, type Detection } from "./vision";

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

  it("handles an empty input", () => {
    expect(clusterRows([])).toEqual([]);
  });
});
