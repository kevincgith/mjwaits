import { describe, expect, it } from "vitest";
import { formatHand, getWaits, isCompleteHand, parseHand } from "./mahjong";

describe("parseHand / formatHand", () => {
  it("round-trips simple notation", () => {
    const tiles = parseHand("123m11p22s");
    expect(formatHand(tiles)).toBe("123m11p22s");
  });

  it("rejects out-of-range ranks", () => {
    expect(() => parseHand("9z")).toThrow();
    expect(() => parseHand("0m")).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => parseHand("123x")).toThrow();
  });
});

describe("isCompleteHand", () => {
  it("accepts 5 triplets/runs + a pair (17 tiles)", () => {
    // 4 triplets of man + pair of pin + one run of sou = 5 melds + pair
    const tiles = parseHand("111222333444m11p345s");
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("accepts a hand with honor triplets", () => {
    const tiles = parseHand("111z222z333z444z55z123s");
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(true);
  });

  it("rejects a hand of the wrong length", () => {
    expect(isCompleteHand(parseHand("111m"))).toBe(false);
  });

  it("rejects an incomplete decomposition", () => {
    // 4 triplets + pair (14 tiles) + 4s,4s,6s, which is not a meld
    const tiles = parseHand("111222333444m11p446s");
    expect(tiles.length).toBe(17);
    expect(isCompleteHand(tiles)).toBe(false);
  });
});

describe("getWaits", () => {
  it("finds shanpon wait on 1p/2s for a 16-tile hand", () => {
    const tiles = parseHand("111222333444m11p22s");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["1p", "2s"]);
  });

  it("finds an edge wait (kanchan) on 3s/6s", () => {
    const tiles = parseHand("111m222m333m444m11p45s");
    expect(tiles.length).toBe(16);
    const waits = getWaits(tiles).map((t) => `${t.rank}${t.suit}`).sort();
    expect(waits).toEqual(["3s", "6s"]);
  });

  it("returns empty for a hand that is not tenpai", () => {
    const tiles = parseHand("13579m2468p111z");
    expect(getWaits(tiles)).toEqual([]);
  });
});
