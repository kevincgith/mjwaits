import { describe, expect, it } from "vitest";
import { layoutTable, type Dims, type Piece } from "./layout";
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
      const meld = { kind: "pung" as const, tiles: [1, 1, 1].map(() => ({ suit: "m" as const, rank: 5 })), concealed: false };
      const withMelds = { ...v, walls: { ...v.walls, [taker]: { ...v.walls[taker], melds: [meld, meld] } } };
      const melds = (w: GLTableView) => layoutTable({ ...w, flights: [] }, DIMS).felt.pieces.filter((p) => p.face === "m5").map((p) => centre(p.m).map((n) => Math.round(n)).join());
      const shown = { ...withMelds, rows: { [taker]: { groups: withMelds.rows[taker]!.groups.map((g) => ({ ...g, shown: g.shown.map(() => true) })) } } };
      expect(melds(shown)).toEqual(melds({ ...withMelds, rows: {} }));
    });
});
