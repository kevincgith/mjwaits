import { describe, expect, it } from "vitest";
import { diceScene, laidDice, simulateThrow, throwDice } from "./dice";
import { wallFence } from "./diceScenes";

// A repeatable random.
const seeded = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const W = 350;
const SIZE = 0.105 * W;
const land = { l: 0.18 * W, t: 0.46 * W, r: 0.82 * W, b: 0.76 * W };

describe("the Dice tab's thrown dice", () => {
  it("come in from your edge and stop where they're meant to - with no unseen walls to bounce off", () => {
    for (let s = 1; s <= 40; s++) {
      const paths = simulateThrow({ land, from: W + SIZE, size: SIZE, n: 3, random: seeded(s) });
      for (const path of paths) {
        expect(path[0].y).toBeGreaterThan(W);
        const end = path[path.length - 1];
        expect(end.z).toBe(0);
        // (Knocked about by each other, a die may stray a little.)
        expect(end.x).toBeGreaterThan(land.l - SIZE);
        expect(end.x).toBeLessThan(land.r + SIZE);
        expect(end.y).toBeGreaterThan(land.t - SIZE);
        expect(end.y).toBeLessThan(land.b + SIZE);
        // Up the table all the way: nothing turns it back.
        for (let i = 1; i < path.length; i++) expect(path[i].y).toBeLessThanOrEqual(path[i - 1].y + SIZE * 0.6);
      }
    }
  });

  it("stay inside 擲骰's wall", () => {
    const fence = wallFence(W);
    const box = { l: 0.32 * W, t: 0.32 * W, r: 0.68 * W, b: 0.68 * W };
    for (let s = 1; s <= 20; s++) {
      const paths = simulateThrow({ land: box, from: W + SIZE, size: SIZE, n: 3, fence, random: seeded(s) });
      for (const path of paths) {
        const end = path[path.length - 1];
        // Inside the wall's inner face, on every side.
        fence.forEach((a, i) => {
          const b = fence[(i + 1) % 4];
          const c = fence[(i + 2) % 4];
          const side = (p: [number, number]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
          expect(Math.sign(side([end.x, end.y]))).toBe(Math.sign(side(c)));
        });
      }
    }
  });

  it("land showing the values thrown, face up, resting on the felt", () => {
    const values = [1, 2, 3, 4, 5, 6];
    for (const v of values) {
      const t = throwDice({ key: "k", width: W, land, from: W + SIZE, size: SIZE, values: [v], random: seeded(v) });
      const { dice } = diceScene(t, W);
      const m = dice[0].m;
      // The cube's +z face (1) carried to where it rests: which of its faces
      // points up is the one whose axis the matrix sends to +z.
      const up = [
        [1, m[10]],
        [6, -m[10]],
        [2, m[6]],
        [5, -m[6]],
        [3, m[2]],
        [4, -m[2]],
      ].sort((a, b) => b[1] - a[1])[0][0];
      expect(up).toBe(v);
      // Its middle half a die above the felt.
      expect(m[14]).toBeCloseTo(SIZE / 2, 3);
      expect(dice[0].anim?.key).toBe("die:k:0");
    }
  });

  it("set by hand, just lie there - across the middle, unthrown", () => {
    const { dice, quads } = diceScene(laidDice({ key: "l", width: W, land, size: SIZE, values: [3, 3, 5] }), W);
    expect(dice.length).toBe(3);
    expect(dice.every((d) => !d.anim)).toBe(true);
    expect(quads.filter((q) => q.kind === "shadow").length).toBe(3);
  });

  it("are drawn to the felt's width now, wherever they were thrown", () => {
    const t = throwDice({ key: "k", width: W, land, from: W + SIZE, size: SIZE, values: [2, 4], random: seeded(9) });
    const a = diceScene(t, W).dice[0].m;
    const b = diceScene(t, W * 2).dice[0].m;
    expect(b[12]).toBeCloseTo(a[12] * 2, 3);
    expect(b[13]).toBeCloseTo(a[13] * 2, 3);
  });
});
