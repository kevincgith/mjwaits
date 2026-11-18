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
// 座位's: anywhere below the six tiles, the table's edge solid all round.
const keep = { l: 0, t: 0.42 * W, r: W, b: W };
const RIM = 0.012 * W;
// The face up at a turn: which of the cube's axes points most up, and which way.
const upFace = (q: [number, number, number, number]) => {
  const [w, x, y, z] = q;
  const zs = [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const i = zs.reduce((best, v, j) => (Math.abs(v) > Math.abs(zs[best]) ? j : best), 0);
  return i * 2 + (zs[i] > 0 ? 0 : 1);
};

describe("the Dice tab's thrown dice", () => {
  it("fall from a hand held high, tumble over and over, and stop on the table below the tiles", () => {
    const turns: number[] = [];
    const rolls: number[] = [];
    for (let s = 1; s <= 30; s++) {
      const paths = simulateThrow({ width: W, land, keep, size: SIZE, n: 3, rim: RIM, random: seeded(s) });
      for (const path of paths) {
        // Thrown from well above the table, over your side of it.
        expect(path[0].z).toBeGreaterThan(SIZE * 3);
        expect(path[0].y).toBeGreaterThan(W * 0.6);
        const end = path[path.length - 1];
        // Lying flat on the felt.
        expect(end.z).toBeCloseTo(SIZE / 2, 5);
        expect(end.y).toBeGreaterThan(keep.t - SIZE);
        // Never through the felt, nor over its edge (once in).
        for (const f of path) expect(f.z).toBeGreaterThan(SIZE * 0.45);
        for (const f of path.slice(path.findIndex((f) => f.y < W - RIM - SIZE)))
          for (const c of [f.x, f.y]) {
            expect(c).toBeGreaterThan(RIM + SIZE * 0.5);
            expect(c).toBeLessThan(W - RIM - SIZE * 0.5);
          }
        // Rolling on over the felt once down: the face up changing.
        const down = path.findIndex((f) => f.z < SIZE * 0.75);
        let changes = 0;
        for (let i = down + 1; i < path.length; i++) if (upFace(path[i].q) !== upFace(path[i - 1].q)) changes++;
        rolls.push(changes);
        let turned = 0;
        for (let i = 1; i < path.length; i++) {
          const [a, b] = [path[i - 1].q, path[i].q];
          turned += 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
        }
        turns.push(turned / (2 * Math.PI));
      }
    }
    // Tumbling: a full turn and more, as a rule - and over on the felt, not
    // stopped dead where it lands.
    turns.sort((a, b) => a - b);
    expect(turns[turns.length >> 1]).toBeGreaterThan(1);
    rolls.sort((a, b) => a - b);
    expect(rolls[rolls.length >> 1]).toBeGreaterThanOrEqual(1);
    expect(rolls.filter((r) => r === 0).length).toBeLessThan(rolls.length * 0.45);
  });

  it("are thrown differently each time", () => {
    const starts = [1, 2, 3, 4, 5].map((s) => simulateThrow({ width: W, land, size: SIZE, n: 3, random: seeded(s) })[0][0]);
    expect(new Set(starts.map((f) => Math.round(f.x / 10))).size).toBeGreaterThan(2);
    expect(new Set(starts.map((f) => Math.round(f.z / 10))).size).toBeGreaterThan(2);
  });

  it("bounce off 座位's name cards, never through them", () => {
    // A card in the middle of where they land, and one by your seat.
    const blocks = [
      { x: 0.5 * W, y: 0.62 * W, hw: 0.085 * W, hd: 0.045 * W, h: 0.05 * W },
      { x: 0.5 * W, y: 0.93 * W, hw: 0.085 * W, hd: 0.045 * W, h: 0.05 * W },
    ];
    let knocked = 0;
    for (let s = 1; s <= 30; s++) {
      const paths = simulateThrow({ width: W, land, keep, size: SIZE, n: 3, rim: RIM, blocks, random: seeded(s) });
      for (const path of paths)
        for (const f of path)
          for (const k of blocks) {
            // Low enough to meet it: never overlapping it by much.
            if (f.z - SIZE / 2 > k.h) continue;
            const ox = Math.abs(f.x - k.x) - k.hw;
            const oy = Math.abs(f.y - k.y) - k.hd;
            expect(Math.max(ox, oy)).toBeGreaterThan(SIZE * 0.3);
            if (Math.max(ox, oy) < SIZE * 0.7) knocked++;
          }
    }
    // (And they do meet them.)
    expect(knocked).toBeGreaterThan(0);
  });

  it("stay inside 擲骰's wall", () => {
    const fence = wallFence(W);
    const box = { l: 0.32 * W, t: 0.32 * W, r: 0.68 * W, b: 0.68 * W };
    for (let s = 1; s <= 20; s++) {
      const paths = simulateThrow({ width: W, land: box, size: SIZE, n: 3, fence, random: seeded(s) });
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
      const t = throwDice({ key: "k", width: W, land, size: SIZE, values: [v], random: seeded(v) });
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
    const t = throwDice({ key: "k", width: W, land, size: SIZE, values: [2, 4], random: seeded(9) });
    const a = diceScene(t, W).dice[0].m;
    const b = diceScene(t, W * 2).dice[0].m;
    expect(b[12]).toBeCloseTo(a[12] * 2, 3);
    expect(b[13]).toBeCloseTo(a[13] * 2, 3);
  });
});
