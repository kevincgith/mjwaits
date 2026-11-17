import { describe, expect, it } from "vitest";
import { seatsScene, wallScene, type SeatsTable } from "./diceScenes";

const centre = (m: Float32Array | number[]) => [m[12], m[13]];

describe("擲骰's wall on the WebGL felt", () => {
  it("is four walls of 18 stacks, two tiles high, all inside the felt's 16px border", () => {
    const { pieces, quads } = wallScene(350, null);
    expect(pieces.length).toBe(4 * 18 * 2);
    expect(quads.filter((q) => q.kind === "picked").length).toBe(0);
    for (const p of pieces) {
      const [x, y] = centre(p.m);
      expect(x).toBeGreaterThan(16);
      expect(x).toBeLessThan(350 - 16);
      expect(y).toBeGreaterThan(16);
      expect(y).toBeLessThan(350 - 16);
    }
  });

  it("rims the counted run in gold and opens the gap after it - on that side only", () => {
    const whole = wallScene(350, null).pieces;
    const broken = wallScene(350, { side: "right", gapAfter: 10 });
    expect(broken.quads.filter((q) => q.kind === "picked").length).toBe(10);
    expect(broken.quads.filter((q) => q.kind === "pin").length).toBe(1);
    const moved = broken.pieces.filter((p, i) => Math.hypot(p.m[12] - whole[i].m[12], p.m[13] - whole[i].m[13]) > 0.5);
    // Stacks 10..17 of the right wall, both tiles of each, eased along (down).
    expect(moved.length).toBe(8 * 2);
    expect(moved.every((p) => p.ease?.key.startsWith("wall:right:"))).toBe(true);
  });
});

describe("座位's tiles on the WebGL felt", () => {
  const table = (step: number): SeatsTable => ({
    step,
    revealed: ["z1", "t1", "z2", "z3", "t2", "z4"],
    edged: ["t1", "z1", "z2", "z3", "z4", "t2"],
    dealt: step >= 7 ? { z1: { at: 0, seat: 2, order: 0 }, z2: { at: 1, seat: 3, order: 1 }, z3: { at: 2, seat: 0, order: 2 }, z4: { at: 3, seat: 1, order: 3 } } : null,
  });

  it("turns all six over at the reveal, then slides the 筒 to the ends", () => {
    expect(seatsScene(350, table(4)).pieces.map((p) => p.anim?.key)).toEqual(["flip:z1", "flip:t1", "flip:z2", "flip:z3", "flip:t2", "flip:z4"]);
    const ends = seatsScene(350, table(5)).pieces;
    const xs = Object.fromEntries(ends.map((p) => [p.face, p.m[12]]));
    expect(xs.t1).toBeLessThan(Math.min(xs.z1, xs.z2, xs.z3, xs.z4));
    expect(xs.t2).toBeGreaterThan(Math.max(xs.z1, xs.z2, xs.z3, xs.z4));
  });

  it("deals each wind to its player, then carries it to their new seat - at full size", () => {
    const dealt = seatsScene(350, table(7)).pieces.filter((p) => p.face.startsWith("z"));
    const seated = seatsScene(350, table(8)).pieces.filter((p) => p.face.startsWith("z"));
    expect(dealt.every((p) => p.anim?.key.startsWith("deal:"))).toBe(true);
    expect(seated.every((p) => p.anim?.key.startsWith("seat:"))).toBe(true);
    // z1 was dealt to the bottom seat (0) and goes to the top (2).
    const z1 = seated.find((p) => p.face === "z1")!;
    expect(centre(z1.anim!.pose(0))).toEqual(centre(dealt.find((p) => p.face === "z1")!.m));
    expect(z1.m[13]).toBeLessThan(350 / 2);
    // Same size as the 筒 left in the row.
    const size = (m: Float32Array | number[]) => Math.hypot(m[0], m[1], m[2]);
    const pin = seatsScene(350, table(8)).pieces.find((p) => p.face === "t1")!;
    for (const p of seated) expect(size(p.m)).toBeCloseTo(size(pin.m), 5);
  });
});
