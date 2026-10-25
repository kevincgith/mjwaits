import { describe, expect, it } from "vitest";
import { flightPath } from "./PlaySwap";

// Do two turned rectangles (centre, size, turn in deg) overlap? The
// separating-axis test: they don't if, along one of their four edge
// directions, their shadows don't meet.
type Box = { x: number; y: number; w: number; h: number; r: number };
const corners = (b: Box) => {
  const a = (b.r * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([i, j]) => ({ x: b.x + (i * b.w * c) / 2 - (j * b.h * s) / 2, y: b.y + (i * b.w * s) / 2 + (j * b.h * c) / 2 }));
};
function overlap(a: Box, b: Box): boolean {
  const ca = corners(a);
  const cb = corners(b);
  for (const box of [a, b]) {
    const t = (box.r * Math.PI) / 180;
    for (const axis of [
      { x: Math.cos(t), y: Math.sin(t) },
      { x: -Math.sin(t), y: Math.cos(t) },
    ]) {
      const pa = ca.map((p) => p.x * axis.x + p.y * axis.y);
      const pb = cb.map((p) => p.x * axis.x + p.y * axis.y);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

// A tile 28 wide, 38 tall upright, as flown.
const W = 28;
const H = 38;

function collides(starts: { x: number; y: number }[], ends: { x: number; y: number }[], from: number, to: number, sizes?: number[]) {
  const paths = flightPath(starts, ends, from, to, sizes);
  for (let k = 0; k < paths[0].length; k++) {
    const boxes = paths.map((p, i) => ({ x: starts[i].x + p[k].x, y: starts[i].y + p[k].y, w: W * p[k].s, h: H * p[k].s, r: p[k].r }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) return k;
  }
  return -1;
}

describe("a take's tiles in flight", () => {
  it("start where they lay and land in their row, turned as it runs", () => {
    const starts = [0, 30, 60].map((y) => ({ x: 100, y }));
    const ends = [0, 32, 64].map((x) => ({ x: 300 + x, y: 250 }));
    const paths = flightPath(starts, ends, 90, 0);
    paths.forEach((p, i) => {
      expect(p[0]).toMatchObject({ x: 0, y: 0, r: 90 });
      const last = p[p.length - 1];
      expect(starts[i].x + last.x).toBeCloseTo(ends[i].x, 6);
      expect(starts[i].y + last.y).toBeCloseTo(ends[i].y, 6);
      expect(last.r).toBeCloseTo(0, 6);
    });
  });

  it("never touch: a side seat's column turning into a row across", () => {
    // Left seat's sideways tiles, a column (30 apart), into your row (31 apart).
    const starts = [0, 31, 62, 93, 124, 155].map((y) => ({ x: 290, y: 90 + y }));
    const ends = [0, 31, 62, 93, 124, 155].map((x) => ({ x: 320 + x, y: 280 }));
    expect(collides(starts, ends, 90, 0)).toBe(-1);
    // The right seat's, the other way round.
    expect(collides(starts.map((p) => ({ x: 560, y: p.y })), [...ends].reverse(), -90, 0)).toBe(-1);
  });

  it("never touch: a foreshortened side pile, its tiles growing as they come", () => {
    // Its tiles show 23 apart on screen: flown from a little under that size.
    const starts = [0, 23, 46, 69, 92, 115].map((y) => ({ x: 290, y: 90 + y }));
    const ends = [0, 31.4, 62.8, 94.2, 125.6, 157].map((x) => ({ x: 320 + x, y: 280 }));
    const s0 = (23 / W) * 0.94;
    expect(collides(starts, ends, 90, 0, starts.map(() => s0))).toBe(-1);
    const last = flightPath(starts, ends, 90, 0, starts.map(() => s0))[0];
    expect(last[0].s).toBeCloseTo(s0, 6);
    expect(last[last.length - 1].s).toBeCloseTo(1, 6);
  });

  it("never touch: across into a side row, and side to side", () => {
    const across = [0, 31, 62, 93, 124].map((x) => ({ x: 330 + x, y: 110 }));
    const side = [0, 31, 62, 93, 124].map((y) => ({ x: 200, y: 90 + y }));
    // Turning +90 carries the leftmost to the top (the order the table gives them).
    expect(collides(across, side, 0, 90)).toBe(-1);
    // A half turn carries the top to the bottom.
    expect(collides(side, [...side].reverse().map((p) => ({ x: 660, y: p.y })), 90, -90)).toBe(-1);
  });
});
