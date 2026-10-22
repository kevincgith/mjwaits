// Seeded random winning hands and situations, for the fuzz tests
// (engineFuzz.test.ts): ordinary 5-meld hands biased toward the shapes
// patterns care about (one suit, honors, repeated runs, consecutive
// triplets, kongs, declared melds), plus 十三么 / 十六不搭 / 嚦咕嚦咕. Seeded so a
// failure names a hand that reproduces.

import type { Suit, Tile } from "./mahjong";
import type { BonusTile, GameContext } from "./scoring";

export type Rng = () => number;

/** How many hands the fuzz tests try, times the default: `FUZZ=10 npx vitest
 *  run src/lib/engineFuzz.test.ts src/lib/rulesFuzz.test.ts` for a deep run. */
export const FUZZ_SCALE = Math.max(1, Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ) || 1);

/** mulberry32 - small, fast, good enough for test data. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number) => r() < p;

const NUMBER_SUITS: Suit[] = ["m", "t", "b"];
const maxRank = (suit: Suit) => (suit === "z" ? 7 : 9);

export interface RandomHand {
  hand: string;
  /** The concealed tiles, to pick a 食胡 tile from. */
  free: Tile[];
}

type Meld = { suit: Suit; ranks: number[]; declared: "no" | "open" | "concealed-kong" };

function render(melds: Meld[], pair: Tile[]): RandomHand {
  const free: Tile[] = [...pair];
  let declared = "";
  for (const m of melds) {
    const digits = m.ranks.join("");
    if (m.declared === "open") declared += `(${digits}${m.suit})`;
    else if (m.declared === "concealed-kong") declared += `[${digits}${m.suit}]`;
    else free.push(...m.ranks.map((rank) => ({ suit: m.suit, rank })));
  }
  return { hand: declared + freeText(free), free };
}

function freeText(tiles: Tile[]): string {
  let text = "";
  for (const suit of ["m", "t", "b", "z"] as Suit[]) {
    const ranks = tiles.filter((t) => t.suit === suit).map((t) => t.rank).sort((a, b) => a - b);
    if (ranks.length) text += `${ranks.join("")}${suit}`;
  }
  return text;
}

function withinFour(tiles: Tile[]): boolean {
  const counts = new Map<string, number>();
  for (const t of tiles) {
    const k = `${t.rank}${t.suit}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (counts.get(k)! > 4) return false;
  }
  return true;
}

/** An ordinary hand: 5 melds and a pair. */
export function randomNormalHand(r: Rng): RandomHand {
  for (;;) {
    const suitCount = pick(r, [1, 1, 2, 2, 3]);
    const suits = [...NUMBER_SUITS].sort(() => r() - 0.5).slice(0, suitCount);
    const honors = chance(r, 0.45);
    const pool: Suit[] = honors ? [...suits, "z"] : suits;
    const melds: Meld[] = [];

    // Themes that random melds alone would almost never hit.
    const theme = r();
    if (theme < 0.2) {
      // 連刻: 2-5 consecutive triplets.
      const suit = pick(r, suits);
      const len = int(r, 2, 5);
      const start = int(r, 1, 10 - len);
      for (let i = 0; i < len; i++) melds.push({ suit, ranks: [start + i, start + i, start + i], declared: "no" });
    } else if (theme < 0.35) {
      // 般高: the same run 2-4 times.
      const suit = pick(r, suits);
      const start = int(r, 1, 7);
      for (let i = int(r, 2, 4); i > 0; i--) melds.push({ suit, ranks: [start, start + 1, start + 2], declared: "no" });
    } else if (theme < 0.45) {
      // 龍 / straights: 123 456 789.
      const suit = pick(r, suits);
      for (const s of [1, 4, 7]) melds.push({ suit, ranks: [s, s + 1, s + 2], declared: "no" });
    } else if (theme < 0.55 && suits.length >= 2) {
      // 相逢 / 兄弟: one run or triplet across suits.
      const rank = int(r, 1, 7);
      const triplet = chance(r, 0.5);
      for (const suit of suits) melds.push({ suit, ranks: triplet ? [rank, rank, rank] : [rank, rank + 1, rank + 2], declared: "no" });
    } else if (theme < 0.62) {
      // Winds / dragons.
      const base = chance(r, 0.5) ? [1, 2, 3, 4] : [5, 6, 7];
      for (const rank of base.slice(0, int(r, 2, base.length))) melds.push({ suit: "z", ranks: [rank, rank, rank], declared: "no" });
    } else if (theme < 0.68) {
      // 步步高: runs stepping up by 1 or 2, in one suit or across them.
      const step = int(r, 1, 2);
      const len = int(r, 3, 4);
      const start = int(r, 1, 7 - step * (len - 1));
      for (let i = 0; i < len; i++) {
        const s = start + i * step;
        melds.push({ suit: chance(r, 0.5) ? suits[0] : pick(r, suits), ranks: [s, s + 1, s + 2], declared: "no" });
      }
    } else if (theme < 0.72) {
      // 雜龍: 123 456 789 in different suits.
      for (const s of [1, 4, 7]) melds.push({ suit: pick(r, NUMBER_SUITS), ranks: [s, s + 1, s + 2], declared: "no" });
    } else if (theme < 0.77) {
      // 老頭: triplets of 1s and 9s (and honors, if any).
      for (let i = int(r, 3, 5); i > 0; i--) {
        const suit = pick(r, pool);
        const rank = suit === "z" ? int(r, 1, 7) : pick(r, [1, 9]);
        melds.push({ suit, ranks: [rank, rank, rank], declared: "no" });
      }
    } else if (theme < 0.8) {
      // 槓: 3-5 kongs.
      for (let i = int(r, 3, 5); i > 0; i--) {
        const suit = pick(r, pool);
        melds.push({ suit, ranks: Array(4).fill(int(r, 1, maxRank(suit))), declared: "no" });
      }
    }
    while (melds.length > 5) melds.pop();

    while (melds.length < 5) {
      const suit = pick(r, pool);
      const kind = suit === "z" ? (chance(r, 0.12) ? "kong" : "triplet") : pick(r, ["run", "run", "run", "triplet", "triplet", "kong"]);
      if (kind === "run") {
        const start = int(r, 1, 7);
        melds.push({ suit, ranks: [start, start + 1, start + 2], declared: "no" });
      } else {
        const rank = int(r, 1, maxRank(suit));
        melds.push({ suit, ranks: Array(kind === "kong" ? 4 : 3).fill(rank), declared: "no" });
      }
    }
    // Some melds declared - all of them now and then (全求人) - and kongs
    // always (a bare 4 isn't read as a kong).
    const declareRate = chance(r, 0.1) ? 1 : 0.2;
    for (const m of melds) {
      if (m.ranks.length === 4) m.declared = chance(r, 0.5) ? "open" : "concealed-kong";
      else if (chance(r, declareRate)) m.declared = "open";
    }
    const pairSuit = pick(r, pool);
    const pairRank = int(r, 1, maxRank(pairSuit));
    const pair = [{ suit: pairSuit, rank: pairRank }, { suit: pairSuit, rank: pairRank }];
    const all = [...melds.flatMap((m) => m.ranks.map((rank) => ({ suit: m.suit, rank }))), ...pair];
    if (withinFour(all)) return render(melds, pair);
  }
}

const ORPHANS: Tile[] = [
  ...NUMBER_SUITS.flatMap((suit) => [1, 9].map((rank) => ({ suit, rank }))),
  ...[1, 2, 3, 4, 5, 6, 7].map((rank) => ({ suit: "z" as Suit, rank })),
];

/** 十三么: the 13 orphans, one doubled, plus any meld. */
export function randomThirteenOrphans(r: Rng): RandomHand {
  for (;;) {
    const tiles = [...ORPHANS, pick(r, ORPHANS)];
    const suit = pick(r, ["m", "t", "b", "z"] as Suit[]);
    if (suit !== "z" && chance(r, 0.5)) {
      const start = int(r, 1, 7);
      tiles.push(...[start, start + 1, start + 2].map((rank) => ({ suit, rank })));
    } else {
      const rank = int(r, 1, maxRank(suit));
      tiles.push(...[0, 1, 2].map(() => ({ suit, rank })));
    }
    if (withinFour(tiles)) return { hand: freeText(tiles), free: tiles };
  }
}

const UNRELATED_RANKS = [
  [1, 4, 7], [1, 4, 8], [1, 4, 9], [1, 5, 8], [1, 5, 9], [1, 6, 9], [2, 5, 8], [2, 5, 9], [2, 6, 9], [3, 6, 9],
];

/** 十六不搭: 3 unrelated ranks per suit, all 7 honors, one tile doubled. */
export function randomSixteenUnrelated(r: Rng): RandomHand {
  const tiles: Tile[] = [
    ...NUMBER_SUITS.flatMap((suit) => pick(r, UNRELATED_RANKS).map((rank) => ({ suit, rank }))),
    ...[1, 2, 3, 4, 5, 6, 7].map((rank) => ({ suit: "z" as Suit, rank })),
  ];
  tiles.push(pick(r, tiles));
  return { hand: freeText(tiles), free: tiles };
}

/** 嚦咕嚦咕: 7 pairs (a kind may be two of them) and a triplet. */
export function randomEightPairs(r: Rng): RandomHand {
  for (;;) {
    const suits: Suit[] = chance(r, 0.4) ? [pick(r, NUMBER_SUITS)] : ["m", "t", "b", "z"];
    const tiles: Tile[] = [];
    const kind = () => {
      const suit = pick(r, suits);
      return { suit, rank: int(r, 1, maxRank(suit)) };
    };
    for (let i = 0; i < 7; i++) {
      const t = kind();
      tiles.push(t, { ...t });
    }
    const t = kind();
    tiles.push(t, { ...t }, { ...t });
    if (withinFour(tiles)) return { hand: freeText(tiles), free: tiles };
  }
}

export const HAND_KINDS = {
  normal: randomNormalHand,
  "thirteen-orphans": randomThirteenOrphans,
  "sixteen-unrelated": randomSixteenUnrelated,
  "eight-pairs": randomEightPairs,
} as const;

/** A random situation for a hand. Combinations the UI wouldn't allow
 *  (自摸 with 搶槓…) are fine: both engines must agree on them anyway. */
export function randomContext(r: Rng, base: GameContext, free: Tile[]): GameContext {
  const rare = <T>(none: T, others: readonly T[], p = 0.12): T => (chance(r, p) ? pick(r, others) : none);
  return {
    ...base,
    seatWind: int(r, 1, 4) as GameContext["seatWind"],
    roundWind: int(r, 1, 4) as GameContext["roundWind"],
    selfDraw: chance(r, 0.4),
    winningTile: free.length && chance(r, 0.8) ? { ...pick(r, free) } : null,
    riichi: rare("none", ["riichi", "heavenly-riichi", "earthly-riichi"] as const, 0.2),
    instantWin: chance(r, 0.08),
    eatRiichi: chance(r, 0.06),
    earlyWin: rare("none", ["four", "seven", "ten"] as const, 0.06),
    multiWin: rare("none", ["double", "triple"] as const, 0.06),
    heavenlyWin: rare("none", ["heaven", "earth", "man"] as const, 0.04),
    lastTileWin: rare("none", ["river-bottom", "sea-bottom"] as const, 0.08),
    flowerDraw: chance(r, 0.1) ? int(r, 1, 2) : 0,
    kongDraw: chance(r, 0.1) ? int(r, 1, 2) : 0,
    robKong: chance(r, 0.05) ? 1 : 0,
    dealerStreak: chance(r, 0.25) ? int(r, 1, 4) : 0,
    manualVisibleTripleWin: chance(r, 0.06),
    manualVisibleExhaustedMultiWait: chance(r, 0.06),
  };
}

/** 0-4 distinct bonus tiles, mostly 0 or 1. */
export function randomBonus(r: Rng): BonusTile[] {
  const n = pick(r, [0, 0, 0, 1, 1, 2, 3, 4]);
  const all: BonusTile[] = (["flower", "season"] as const).flatMap((kind) => ([1, 2, 3, 4] as const).map((rank) => ({ kind, rank })));
  return all.sort(() => r() - 0.5).slice(0, n);
}
