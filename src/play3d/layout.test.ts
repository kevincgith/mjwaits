import { describe, expect, it } from "vitest";
import { feltToHand, layoutTable, type Dims, type Piece } from "./layout";
import { apply, chain, rotateX, translate } from "./mat";
import { giverOrder, swapSlots } from "./swapOrder";
import type { GLFlight, GLSide, GLSwapRow, GLTableView, GLWall } from "./types";

// A phone on its side (844 x 390), as the table measures it there.
const DIMS: Dims = { feltW: 713, feltH: 520, rem: 16, under: 43.9, hand: 48.75, tile: 36.1, wall: 26, wallTop: 35, middle: 19.5, compass: 70.2, handTop: 470 };
// (Seen from your row: near enough the felt's own plane for this.)
DIMS.project = (x, y) => ({ x: x - DIMS.feltW / 2, y: y - DIMS.feltH - 40, s: 1 });

const wall = (count: number): GLWall => ({ count, tiles: null, drew: false, down: false, winningTile: null, melds: [], hideConcealed: true, flowers: [], wallGrow: 1, topple: { at: 0, step: 0, dur: 0.5 } });
const SIDES: GLSide[] = ["bottom", "right", "top", "left"];

// Each taker taking `n` from every other pile, as PlayPanel lays a take out.
function take(taker: GLSide, n: number): GLTableView {
  const givers = SIDES.filter((s) => s !== taker);
  const order = giverOrder(taker, givers.map((side, key) => ({ side, key })));
  const flights: GLFlight[] = [];
  const rowGroups: GLSwapRow["groups"] = [];
  order.forEach((key, group) => {
    const from = givers[key];
    const places = Array.from({ length: n }, (_, i) => i + 1);
    const slots = swapSlots(from, taker, places);
    slots.forEach((place, slot) => flights.push({ id: flights.length + 1, from, place, to: taker, group, slot, tile: null, flip: false }));
    rowGroups.push({ tiles: places.map(() => null), shown: places.map(() => false) });
  });
  const pile = { slots: Array.from({ length: 6 }, () => "back" as const), standing: false, picked: [], arriving: [], pickable: false };
  return {
    walls: { right: wall(16), top: wall(16), left: wall(16) },
    ponds: { bottom: { tiles: [], pinLast: false }, right: { tiles: [], pinLast: false }, top: { tiles: [], pinLast: false }, left: { tiles: [], pinLast: false } },
    mine: { tiles: [], melds: [], hideConcealed: false, flowers: [], toppled: false, drawKey: "", winLead: 0, sliding: true, given: null },
    spotlight: null,
    piles: { bottom: pile, right: pile, top: pile, left: pile },
    rows: { [taker]: { groups: rowGroups } },
    flights,
  };
}

const flying = (ps: Piece[]) => ps.filter((p) => p.fly?.pose);
const centre = (m: Float32Array) => [m[12], m[13]];
const size = (m: Float32Array) => Math.hypot(m[0], m[1], m[2]);

describe("換牌 flights on the WebGL table", () => {
  for (const taker of SIDES)
    it(`never touch on the way to ${taker}'s row`, () => {
      const out = layoutTable(take(taker, 3), DIMS);
      const ps = flying(taker === "bottom" ? out.hand.pieces : out.felt.pieces);
      expect(ps.length).toBe(9);
      // Through the formation's part of the flight (eased in and out of it at the ends).
      for (let v = 0.15; v <= 0.85; v += 0.01) {
        const ms = ps.map((p) => p.fly!.pose!(v));
        for (let i = 0; i < ms.length; i++)
          for (let j = i + 1; j < ms.length; j++) {
            const [a, b] = [centre(ms[i]), centre(ms[j])];
            const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
            // Never nearer than a tile is wide (0.72em), at the size they show.
            expect(gap, `tiles ${i} and ${j} at ${v.toFixed(2)}`).toBeGreaterThanOrEqual(0.72 * Math.max(size(ms[i]), size(ms[j])) - 0.5);
          }
      }
    });
});

describe("換牌 rows on the WebGL table", () => {
  for (const taker of ["left", "right"] as const)
    it(`leave the piles where they lie when ${taker}'s row lands`, () => {
      const before = take(taker, 3);
      const piles = (v: GLTableView) => layoutTable({ ...v, flights: [] }, DIMS).felt.pieces.filter((p) => p.face === "back").map((p) => centre(p.m).map((n) => Math.round(n)).join());
      const shown = { ...before, rows: { [taker]: { groups: before.rows[taker]!.groups.map((g) => ({ ...g, shown: g.shown.map(() => true) })) } } };
      const noRow = { ...before, rows: {} };
      // (The pile places only - every back on the felt but the row's own.)
      const a = piles(noRow);
      const b = piles(shown);
      expect(b.filter((p) => !a.includes(p)).length).toBe(9);
      expect(a.every((p) => b.includes(p))).toBe(true);
    });
  it("turn a formation at most a quarter on the way across", () => {
    for (const taker of SIDES) {
      const out = layoutTable(take(taker, 3), DIMS);
      for (const p of flying(taker === "bottom" ? out.hand.pieces : out.felt.pieces)) {
        const a = p.fly!.pose!(0.15);
        const b = p.fly!.pose!(0.85);
        const turn = Math.abs(((Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) * 180) / Math.PI);
        expect(Math.min(turn, 360 - turn), `to ${taker}`).toBeLessThanOrEqual(91);
      }
    }
  });
});

describe("a side seat's melds on the WebGL table", () => {
  for (const taker of ["left", "right"] as const)
    it(`stay put while ${taker}'s 換牌 row is there`, () => {
      const v = take(taker, 3);
      const meld = { kind: "triplet" as const, tiles: [1, 1, 1].map(() => ({ suit: "m" as const, rank: 5 })), concealed: false, from: 1 };
      const withMelds = { ...v, walls: { ...v.walls, [taker]: { ...v.walls[taker], melds: [meld, meld] } } };
      const melds = (w: GLTableView) => layoutTable({ ...w, flights: [] }, DIMS).felt.pieces.filter((p) => p.face === "m5").map((p) => centre(p.m).map((n) => Math.round(n)).join());
      const shown = { ...withMelds, rows: { [taker]: { groups: withMelds.rows[taker]!.groups.map((g) => ({ ...g, shown: g.shown.map(() => true) })) } } };
      expect(melds(shown)).toEqual(melds({ ...withMelds, rows: {} }));
    });
});

describe("your row on the WebGL table", () => {
  it("puts your bonus tiles out a row, above it, once it runs past the screen", () => {
    const v = take("bottom", 1);
    const meld = { kind: "triplet" as const, tiles: [1, 1, 1].map(() => ({ suit: "b" as const, rank: 2 })), concealed: false, from: 1 };
    const flowers = [1, 2, 3, 4].map((rank) => ({ kind: "flower" as const, rank: rank as 1 | 2 | 3 | 4 }));
    const tiles = Array.from({ length: 7 }, () => ({ tile: { suit: "m" as const, rank: 3 }, drawn: false, selected: false, hint: false, danger: false, barred: false, winner: false, enabled: false }));
    const mine = { ...v.mine, tiles, melds: [meld, meld, meld], flowers, sliding: false };
    const row = (room: number) => layoutTable({ ...v, mine, rows: {}, flights: [] }, { ...DIMS, rowRoom: room }).hand.pieces.filter((p) => p.face.startsWith("flower"));
    expect(row(5000).every((p) => p.m[13] > 0)).toBe(true);
    expect(row(400).every((p) => p.m[13] < 0)).toBe(true);
  });
});

describe("換牌 flights keep their tiles' orientation", () => {
  // The way a tile's own x and y point, as drawn (unit vectors).
  const axes = (m: Float32Array) => {
    const n = (i: number) => {
      const v = [m[i], m[i + 1], m[i + 2]];
      const l = Math.hypot(...v);
      return v.map((x) => x / l);
    };
    return [n(0), n(4)];
  };
  const angle = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
  for (const taker of SIDES)
    it(`from pile to ${taker}'s row - no turn when the formation takes over, nor when it hands over`, () => {
      const d = { ...DIMS, feltToHand: undefined };
      const out = layoutTable(take(taker, 3), d);
      for (const p of flying(taker === "bottom" ? out.hand.pieces : out.felt.pieces)) {
        const [sx, sy] = axes(p.fly!.from);
        const [fx, fy] = axes(p.fly!.pose!(0));
        const [ex, ey] = axes(p.m);
        const [gx, gy] = axes(p.fly!.pose!(1));
        // (Your row's flights start as seen on the tilted felt: allow its 32deg.)
        const slack = taker === "bottom" ? 35 : 1;
        expect(Math.max(angle(sx, fx), angle(sy, fy)), "at take-off").toBeLessThanOrEqual(slack);
        expect(Math.max(angle(ex, gx), angle(ey, gy)), "at landing").toBeLessThanOrEqual(slack);
      }
    });
});

describe("the felt seen from your row (feltToHand)", () => {
  it("draws a felt point exactly where the felt's own view does", () => {
    // The felt tipped back 32deg about its foot, in a canvas; the two eyes apart.
    const felt = chain(translate(60, 40, 0), translate(356, 520, 0), rotateX(32), translate(-356, -520, 0));
    const stage = { d: 1100, ox: 422, oy: 160 };
    const row = { ox: 430, oy: 310 - 0.6 * 60 };
    const hand = { x: 120, y: 310 };
    const handMid = hand.x + 300;
    const seen = (d: number, ox: number, oy: number, p: number[]) => [ox + ((p[0] - ox) * d) / (d - p[2]), oy + ((p[1] - oy) * d) / (d - p[2])];
    const m = feltToHand(felt, stage, row, handMid, hand.y);
    for (const q of [[0, 0, 0], [700, 500, 0], [350, 260, 18], [120, 480, 40]]) {
      const byFelt = seen(stage.d, stage.ox, stage.oy, apply(felt, q[0], q[1], q[2]));
      const inRow = apply(m, q[0], q[1], q[2]);
      const byRow = seen(stage.d, row.ox, row.oy, [inRow[0] + handMid, inRow[1] + hand.y, inRow[2]]);
      expect(byRow[0]).toBeCloseTo(byFelt[0], 3);
      expect(byRow[1]).toBeCloseTo(byFelt[1], 3);
    }
  });
});

describe("a side seat's 換牌 row", () => {
  for (const taker of ["left", "right"] as const)
    for (const setup of ["a flower", "a flower and two melds", "nothing else"] as const)
      it(`stays within ${taker}'s wall with ${setup} in front of it`, () => {
        const v = take(taker, 2);
        const meld = { kind: "triplet" as const, tiles: [1, 1, 1].map(() => ({ suit: "m" as const, rank: 5 })), concealed: false, from: 1 };
        const wall = { ...v.walls[taker], flowers: setup === "nothing else" ? [] : [{ kind: "flower" as const, rank: 1 as const }], melds: setup.includes("melds") ? [meld, meld] : [] };
        const shown = { ...v, piles: null, walls: { ...v.walls, [taker]: wall }, flights: [], rows: { [taker]: { groups: v.rows[taker]!.groups.map((g) => ({ ...g, shown: g.shown.map(() => true) })) } } };
        const out = layoutTable(shown, DIMS).felt.pieces;
        const theirs = (p: Piece) => (taker === "left" ? p.m[12] < DIMS.feltW * 0.3 : p.m[12] > DIMS.feltW * 0.7);
        const wallYs = out.filter((p) => p.face === "z7" && theirs(p)).map((p) => p.m[13]);
        const rowYs = out.filter((p) => p.face === "back" && theirs(p)).map((p) => p.m[13]);
        expect(rowYs.length).toBe(6);
        const [lo, hi] = [Math.min(...wallYs), Math.max(...wallYs)];
        for (const y of rowYs) {
          expect(y).toBeGreaterThanOrEqual(lo - DIMS.tile);
          expect(y).toBeLessThanOrEqual(hi + DIMS.tile);
        }
      });
});

describe("your 換牌 pile", () => {
  it("stands on the felt, not over it", () => {
    const v = take("right", 1);
    const mine = { slots: [1, 2, 3].map((rank) => ({ suit: "m" as const, rank })), standing: true, picked: [], arriving: [], pickable: false };
    const out = layoutTable({ ...v, piles: { bottom: mine }, flights: [], rows: {} }, DIMS).felt.pieces.filter((p) => p.face.startsWith("m"));
    expect(out.length).toBe(3);
    for (const p of out) {
      // Its block's eight corners: the lowest touches the felt.
      const zs = [-0.36, 0.36].flatMap((x) => [-0.4565, 0.4565].flatMap((y) => [0, 0.42].map((z) => apply(p.m, x, y, z)[2])));
      expect(Math.min(...zs)).toBeCloseTo(0, 3);
    }
  });
});

describe("a side seat's 換牌 row, alone in front of the wall", () => {
  for (const taker of ["left", "right"] as const)
    it(`keeps clear of ${taker}'s standing tiles`, () => {
      const v = take(taker, 2);
      const shown = { ...v, piles: null, flights: [], rows: { [taker]: { groups: v.rows[taker]!.groups.map((g) => ({ ...g, shown: g.shown.map(() => true) })) } } };
      const out = layoutTable(shown, DIMS).felt.pieces;
      const theirs = (p: Piece) => (taker === "left" ? p.m[12] < DIMS.feltW * 0.3 : p.m[12] > DIMS.feltW * 0.7);
      // The standing tiles' extent across (every corner of each block), and the row tiles'.
      const xs = (p: Piece) => [-0.36, 0.36].flatMap((x) => [-0.4565, 0.4565].flatMap((y) => [0, 0.42].map((z) => apply(p.m, x, y, z)[0])));
      // (A side wall's blocks stand with their thickness across the table.)
      const wall = out.filter((p) => p.face === "z7" && Math.abs(p.m[8]) > Math.abs(p.m[9]) && theirs(p)).flatMap(xs);
      const row = out.filter((p) => p.face === "back" && theirs(p)).flatMap(xs);
      if (taker === "left") expect(Math.min(...row)).toBeGreaterThan(Math.max(...wall));
      else expect(Math.max(...row)).toBeLessThan(Math.min(...wall));
    });
});
