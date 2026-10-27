import { describe, expect, it } from "vitest";
import { allTileKinds, isCompleteHand, MELDS_REQUIRED, parseHand, shanten, type Tile } from "./mahjong";

// Readiness against the hands themselves: shanten says how far a hand is
// from winning, and it has to agree with what actually completes it -
// "ready" (0) exactly when some tile wins, and -1 exactly when the hand
// already has. Checked over many hands, biased toward the shapes where the
// special hands' counting (Eight Pairs, Sixteen Unrelated) can go wrong:
// four of a kind, triplets, pairs, scattered singles. (A 叮 was declared
// on 1111m + seven pairs + two singles, which nothing completes.)

// A seeded random, so a failure can be run again.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = allTileKinds();
const same = (a: Tile, b: Tile) => a.suit === b.suit && a.rank === b.rank;
const count = (h: Tile[], t: Tile) => h.filter((x) => same(x, t)).length;

// A hand of `size` tiles, no kind more than four times. `style` biases it.
function deal(rand: () => number, size: number, style: number): Tile[] {
  const hand: Tile[] = [];
  const add = (t: Tile, n: number) => {
    for (let i = 0; i < n && hand.length < size && count(hand, t) < 4; i++) hand.push({ ...t });
  };
  const pick = (pool: Tile[]) => pool[Math.floor(rand() * pool.length)];
  while (hand.length < size) {
    const t = pick(KINDS);
    if (style === 0) add(t, 1); // anything
    else if (style === 1) add(t, rand() < 0.7 ? 2 : rand() < 0.5 ? 4 : 3); // pairs, quads, triplets
    else if (style === 2) add(t, rand() < 0.5 ? 1 : 2); // scattered, some pairs
    else {
      // runs and sets, as real hands are
      const r = rand();
      if (t.suit !== "z" && t.rank <= 7 && r < 0.45) for (let k = 0; k < 3; k++) add({ suit: t.suit, rank: t.rank + k }, 1);
      else add(t, r < 0.75 ? 3 : r < 0.9 ? 2 : 1);
    }
  }
  return hand;
}

// What would complete it, by shape - a fifth copy included: a hand whose
// only wait is a tile it holds all four of is still ready by shape (a dead
// wait - see riichiDiscards, which won't declare on one).
const completers = (hand: Tile[], melds: number) => KINDS.filter((t) => isCompleteHand([...hand, t], melds));

describe("readiness agrees with the hands", () => {
  it("counts 十三么 ready and complete", () => {
    const ready = parseHand("19m19t19b1234567z234m");
    expect(shanten(ready)).toBe(0);
    expect(shanten([...ready, { suit: "z", rank: 1 }])).toBe(-1);
    // One orphan short of it isn't ready by it.
    expect(shanten(parseHand("19m19t19b123456z2345m"))).toBeGreaterThan(0);
  });

  for (const melds of [MELDS_REQUIRED, 4, 3, 2, 1]) {
    it(`a hand needing ${melds} sets: ready exactly when a tile completes it, and complete exactly at -1`, { timeout: 60_000 }, () => {
      const rand = rng(1000 + melds);
      const size = melds * 3 + 1;
      const bad: string[] = [];
      for (let i = 0; i < 2500; i++) {
        const style = i % 4;
        const hand = deal(rand, size, style);
        const sh = shanten(hand, melds);
        const wins = completers(hand, melds);
        if ((sh === 0) !== wins.length > 0) bad.push(`${hand.map((t) => t.rank + t.suit).join(" ")} shanten ${sh}, wins ${wins.length}`);
        // A full hand: complete exactly at -1.
        const full = [...hand, KINDS[Math.floor(rand() * KINDS.length)]];
        if (count(full, full[full.length - 1]) <= 4 && (shanten(full, melds) === -1) !== isCompleteHand(full, melds))
          bad.push(`${full.map((t) => t.rank + t.suit).join(" ")} full: shanten ${shanten(full, melds)}, complete ${isCompleteHand(full, melds)}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }
});
