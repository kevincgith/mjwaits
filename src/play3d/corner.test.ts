import { describe, expect, it } from "vitest";
import { cornerZoom } from "./corner";
import { CORNER_TILT, CORNER_TILT_MAX, CORNER_TILT_MIN, CORNER_YAW } from "./types";

describe("the corner camera's zoom", () => {
  it("leaves the table full size from the starting view and anywhere round it", () => {
    expect(cornerZoom({ yaw: CORNER_YAW, tilt: CORNER_TILT })).toBeCloseTo(1);
    for (const yaw of [0, 90, 180, 270, 405]) expect(cornerZoom({ yaw, tilt: CORNER_TILT })).toBeCloseTo(1);
    expect(cornerZoom({ yaw: CORNER_YAW, tilt: CORNER_TILT_MAX })).toBe(1);
  });

  it("draws it smaller the flatter you look down, so it still fits", () => {
    const zoom = cornerZoom({ yaw: CORNER_YAW, tilt: CORNER_TILT_MIN });
    expect(zoom).toBeLessThan(0.6);
    expect(zoom).toBeGreaterThan(0.4);
  });
});
