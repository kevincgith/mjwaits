import { describe, expect, it } from "vitest";
import { COMPLETE_SIZE } from "./mahjong";
import { parseScoringHand, scoreHand } from "./scoring";
import { TEST_HAND_BASE_CONTEXT, TEST_HANDS } from "./testHands";

// Guards the generated list (scripts/extract-test-hands.mjs): every hand the
// hidden Test hands sheet can load must still be a hand that scores.
describe("TEST_HANDS", () => {
  it("has hands to offer", () => {
    expect(TEST_HANDS.length).toBeGreaterThan(100);
  });

  it.each(TEST_HANDS.map((t) => [`${t.hand} - ${t.name}`, t] as const))("%s scores", (_label, t) => {
    expect(() => scoreHand(t.hand, { ...TEST_HAND_BASE_CONTEXT, ...t.ctx })).not.toThrow();
  });

  // The app can't hold a hand over its size: a concealed kong is only ever a
  // declared 暗槓 there, never four loose tiles making the hand one too big.
  // So every test hand must write its concealed kongs as "[1111z]".
  it.each(TEST_HANDS.map((t) => [t.hand, t] as const))("%s is the app's hand size", (_label, t) => {
    const parsed = parseScoringHand(t.hand);
    const tiles = parsed.freeTiles.length + parsed.declaredMelds.reduce((n, m) => n + m.tiles.length, 0);
    const kongs = parsed.declaredMelds.filter((m) => m.kind === "kong").length;
    expect(tiles).toBe(COMPLETE_SIZE + kongs);
  });
});
