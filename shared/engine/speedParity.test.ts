import { describe, expect, it } from "vitest";
import {
  allTileKinds,
  COMPLETE_SIZE,
  getWaits,
  isCompleteHand,
  isEightPairsComplete,
  isSixteenUnrelatedComplete,
  isThirteenOrphansComplete,
  MELDS_REQUIRED,
  shanten,
  standardShanten,
  tileCount,
  tileKey,
  type Suit,
  type Tile,
} from "./mahjong";
import { FUZZ_SCALE, randomEightPairs, randomSixteenUnrelated, randomThirteenOrphans, rng, type Rng } from "./randomHands";

// The faster special-hand checks, getWaits and shanten must answer exactly
// as the slower ones they replaced did. Those are kept below, frozen, and
// both run over many random hands: full-wall deals at every size, one-suit
// and orphan-heavy hands, the special hands and their near misses, and
// hands with jokers (which keep the old path). FUZZ=10 for a deep run.

const keys = (ts: Tile[]) => ts.map(tileKey).join(",");

function deal(r: Rng, n: number, pool: Tile[]): Tile[] {
  const wall = pool.flatMap((k) => [k, k, k, k].map((t) => ({ ...t })));
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall.slice(0, n);
}

const KINDS = allTileKinds();
const ORPHAN_POOL = KINDS.filter((t) => t.suit === "z" || t.rank === 1 || t.rank === 9);
const suitPool = (suit: Suit) => KINDS.filter((t) => t.suit === suit);

function randomHand(r: Rng, i: number): { tiles: Tile[]; melds: number } {
  const melds = Math.floor(r() * 6);
  const n = melds * 3 + (r() < 0.5 ? 1 : 2);
  const kind = i % 9;
  if (kind === 0) return { tiles: deal(r, n, suitPool((["m", "t", "b"] as Suit[])[i % 3])), melds };
  if (kind === 1) return { tiles: [...deal(r, Math.min(n, 12), ORPHAN_POOL), ...deal(r, Math.max(0, n - 12), KINDS)], melds };
  if (kind === 2 || kind === 3 || kind === 4) {
    const special = [randomThirteenOrphans, randomSixteenUnrelated, randomEightPairs][kind - 2](r).free;
    // Complete, one short, or one swapped.
    const tiles = special.map((t) => ({ ...t }));
    const roll = r();
    if (roll < 0.4) tiles.splice(Math.floor(r() * tiles.length), 1);
    else if (roll < 0.7) tiles[Math.floor(r() * tiles.length)] = { ...KINDS[Math.floor(r() * KINDS.length)] };
    return { tiles, melds: MELDS_REQUIRED };
  }
  if (kind === 5) {
    // Jokers mixed in.
    const tiles = deal(r, n, KINDS);
    const jokers = 1 + Math.floor(r() * 3);
    for (let j = 0; j < jokers && j < tiles.length; j++) tiles[j] = { suit: "j", rank: 1 };
    return { tiles, melds };
  }
  // Mostly the full 16/17-tile hands play uses.
  const full = r() < 0.7;
  return full ? { tiles: deal(r, r() < 0.5 ? COMPLETE_SIZE : COMPLETE_SIZE - 1, KINDS), melds: MELDS_REQUIRED } : { tiles: deal(r, n, KINDS), melds };
}

describe("fast engine checks match the old ones", () => {
  it("shanten, standardShanten and the special checks", () => {
    const r = rng(20261030 + FUZZ_SCALE);
    for (let i = 0; i < 6000 * FUZZ_SCALE; i++) {
      const { tiles, melds } = randomHand(r, i);
      const label = `${keys(tiles)} / ${melds}`;
      expect(standardShanten(tiles, melds), label).toBe(oldStandardShanten(tiles, melds));
      expect(shanten(tiles, melds), label).toBe(oldShanten(tiles, melds));
      // A meld count that doesn't fit the size, too.
      const other = Math.floor(r() * 6);
      expect(standardShanten(tiles, other), label + " / " + other).toBe(oldStandardShanten(tiles, other));
      expect(isThirteenOrphansComplete(tiles), label).toBe(oldIsThirteenOrphansComplete(tiles));
      expect(isEightPairsComplete(tiles), label).toBe(oldIsEightPairsComplete(tiles));
      expect(isSixteenUnrelatedComplete(tiles), label).toBe(oldIsSixteenUnrelatedComplete(tiles));
      expect(isCompleteHand(tiles, melds), label).toBe(oldIsCompleteHand(tiles, melds));
    }
  }, 120_000);

  it("getWaits", () => {
    const r = rng(7 + FUZZ_SCALE);
    for (let i = 0; i < 1500 * FUZZ_SCALE; i++) {
      const { tiles, melds } = randomHand(r, i);
      // Waits need one tile short; drop one when it's a full hand.
      const hand = tiles.length % 3 === 2 ? tiles.slice(1) : tiles;
      const m = (hand.length - 1) / 3;
      expect(keys(getWaits(hand, m)), keys(hand)).toBe(keys(oldGetWaits(hand, m)));
      expect(keys(getWaits(hand, melds)), keys(hand)).toBe(keys(oldGetWaits(hand, melds)));
    }
  }, 120_000);

  it("isCompleteHand on tenpai hands plus each draw", () => {
    const r = rng(99 + FUZZ_SCALE);
    let complete = 0;
    for (let i = 0; i < 400 * FUZZ_SCALE; i++) {
      const { tiles } = randomHand(r, i);
      const hand = tiles.length % 3 === 2 ? tiles.slice(1) : tiles;
      const m = (hand.length - 1) / 3;
      for (const k of KINDS) {
        const t = [...hand, k];
        const got = isCompleteHand(t, m);
        expect(got, keys(t)).toBe(oldIsCompleteHand(t, m));
        if (got) complete++;
      }
    }
    expect(complete).toBeGreaterThan(20);
  }, 120_000);
});

// ---- The old implementations, frozen -----------------------------------

function countsForSuit(tiles: Tile[], suit: Suit, size: number): number[] {
  const counts = new Array(size + 1).fill(0);
  for (const t of tiles) if (t.suit === suit) counts[t.rank]++;
  return counts;
}

function canDecompose(counts: number[], allowRuns: boolean): boolean {
  const size = counts.length - 1;
  let i = 1;
  while (i <= size && counts[i] === 0) i++;
  if (i > size) return true; // nothing left, fully decomposed

  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canDecompose(counts, allowRuns)) {
      counts[i] += 3;
      return true;
    }
    counts[i] += 3;
  }

  if (allowRuns && i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    if (canDecompose(counts, allowRuns)) {
      counts[i]++;
      counts[i + 1]++;
      counts[i + 2]++;
      return true;
    }
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
  }

  return false;
}

const ORPHAN_TILES: Tile[] = [
  { suit: "m", rank: 1 },
  { suit: "m", rank: 9 },
  { suit: "t", rank: 1 },
  { suit: "t", rank: 9 },
  { suit: "b", rank: 1 },
  { suit: "b", rank: 9 },
  { suit: "z", rank: 1 },
  { suit: "z", rank: 2 },
  { suit: "z", rank: 3 },
  { suit: "z", rank: 4 },
  { suit: "z", rank: 5 },
  { suit: "z", rank: 6 },
  { suit: "z", rank: 7 },
];

const ORPHAN_KEYS = new Set(ORPHAN_TILES.map(tileKey));

function countAll(tiles: Tile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tiles) {
    const key = tileKey(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isOrphanRemainder(counts: Map<string, number>): boolean {
  let total = 0;
  let pairs = 0;
  for (const key of ORPHAN_KEYS) {
    const c = counts.get(key) ?? 0;
    if (c < 1 || c > 2) return false;
    if (c === 2) pairs++;
    total += c;
  }
  if (pairs !== 1 || total !== 14) return false;
  for (const [key, c] of counts) {
    if (!ORPHAN_KEYS.has(key) && c > 0) return false;
  }
  return true;
}

function candidateMelds(tiles: Tile[]): Tile[][] {
  const counts = countAll(tiles);
  const melds: Tile[][] = [];
  for (const [key, c] of counts) {
    if (c >= 3) {
      const suit = key[0] as Suit;
      const rank = Number(key.slice(1));
      melds.push([{ suit, rank }, { suit, rank }, { suit, rank }]);
    }
  }
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      const a = `${suit}${rank}`;
      const b = `${suit}${rank + 1}`;
      const c = `${suit}${rank + 2}`;
      if ((counts.get(a) ?? 0) >= 1 && (counts.get(b) ?? 0) >= 1 && (counts.get(c) ?? 0) >= 1) {
        melds.push([{ suit, rank }, { suit, rank: rank + 1 }, { suit, rank: rank + 2 }]);
      }
    }
  }
  return melds;
}

function oldIsThirteenOrphansComplete(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;
  for (const meld of candidateMelds(tiles)) {
    const counts = countAll(tiles);
    for (const t of meld) {
      const key = tileKey(t);
      counts.set(key, (counts.get(key) ?? 0) - 1);
    }
    if (isOrphanRemainder(counts)) return true;
  }
  return false;
}

function oldIsEightPairsComplete(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;
  const counts = countAll(tiles);
  let tripleKinds = 0;
  for (const c of counts.values()) {
    if (c === 3) tripleKinds++;
    else if (c !== 2 && c !== 4) return false; // a lone single or 5+ copies breaks the pattern
  }
  return tripleKinds === 1;
}

function unrelatedRanksOk(ranks: number[]): boolean {
  if (ranks.length !== 3) return false;
  const sorted = [...ranks].sort((a, b) => a - b);
  return sorted[1] - sorted[0] >= 3 && sorted[2] - sorted[1] >= 3;
}

function oldIsSixteenUnrelatedComplete(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;
  const counts = countAll(tiles);
  let pairKinds = 0;
  for (const c of counts.values()) {
    if (c > 2) return false;
    if (c === 2) pairKinds++;
  }
  if (pairKinds !== 1) return false;

  for (let rank = 1; rank <= 7; rank++) {
    if ((counts.get(`z${rank}`) ?? 0) < 1) return false;
  }
  const bySuit: Record<"m" | "t" | "b", number[]> = { m: [], t: [], b: [] };
  for (const key of counts.keys()) {
    const suit = key[0] as Suit;
    if (suit === "m" || suit === "t" || suit === "b") bySuit[suit].push(Number(key.slice(1)));
  }
  return (["m", "t", "b"] as const).every((suit) => unrelatedRanksOk(bySuit[suit]));
}

function oldIsCompleteHand(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): boolean {
  if (tiles.length !== meldsRequired * 3 + 2) return false;
  if (
    meldsRequired === MELDS_REQUIRED &&
    (oldIsThirteenOrphansComplete(tiles) || oldIsEightPairsComplete(tiles) || oldIsSixteenUnrelatedComplete(tiles))
  ) {
    return true;
  }

  const m = countsForSuit(tiles, "m", 9);
  const t = countsForSuit(tiles, "t", 9);
  const b = countsForSuit(tiles, "b", 9);
  const z = countsForSuit(tiles, "z", 7);

  const suitsData: { counts: number[]; allowRuns: boolean }[] = [
    { counts: m, allowRuns: true },
    { counts: t, allowRuns: true },
    { counts: b, allowRuns: true },
    { counts: z, allowRuns: false },
  ];

  for (const { counts } of suitsData) {
    for (let rank = 1; rank < counts.length; rank++) {
      if (counts[rank] >= 2) {
        counts[rank] -= 2;
        const ok = suitsData.every((sd) => canDecompose(sd.counts, sd.allowRuns));
        counts[rank] += 2;
        if (ok) return true;
      }
    }
  }
  return false;
}

interface BlockOption {
  melds: number;
  partials: number;
}

function paretoPrune(options: BlockOption[]): BlockOption[] {
  let maxMelds = 0;
  for (const o of options) if (o.melds > maxMelds) maxMelds = o.melds;
  const best = new Array<number>(maxMelds + 1).fill(-1);
  for (const o of options) if (o.partials > best[o.melds]) best[o.melds] = o.partials;
  const out: BlockOption[] = [];
  let top = -1;
  for (let m = maxMelds; m >= 0; m--) {
    if (best[m] > top) {
      out.push({ melds: m, partials: best[m] });
      top = best[m];
    }
  }
  return out;
}

const suitOptionsCache = new Map<string, BlockOption[]>();

function suitBlockOptions(counts: number[], allowRuns: boolean): BlockOption[] {
  const cacheKey = (allowRuns ? "r" : "h") + counts.join("");
  const hit = suitOptionsCache.get(cacheKey);
  if (hit) return hit;
  const result = suitBlockOptionsUncached(counts, allowRuns);
  if (suitOptionsCache.size > 200_000) suitOptionsCache.clear();
  suitOptionsCache.set(cacheKey, result);
  return result;
}

function suitBlockOptionsUncached(counts: number[], allowRuns: boolean): BlockOption[] {
  const size = counts.length - 1;
  const memo = new Map<string, BlockOption[]>();

  function search(from: number): BlockOption[] {
    let i = from;
    while (i <= size && counts[i] === 0) i++;
    if (i > size) return [{ melds: 0, partials: 0 }];

    const key = counts.slice(i, size + 1).join(",");
    const cached = memo.get(key);
    if (cached) return cached;

    const found: BlockOption[] = [];
    const collect = (deltaMelds: number, deltaPartials: number) => {
      for (const sub of search(i)) {
        found.push({ melds: sub.melds + deltaMelds, partials: sub.partials + deltaPartials });
      }
    };

    if (counts[i] >= 3) {
      counts[i] -= 3;
      collect(1, 0);
      counts[i] += 3;
    }
    if (counts[i] >= 2) {
      counts[i] -= 2;
      collect(0, 1);
      counts[i] += 2;
    }
    if (allowRuns) {
      if (i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
        counts[i]--;
        counts[i + 1]--;
        counts[i + 2]--;
        collect(1, 0);
        counts[i]++;
        counts[i + 1]++;
        counts[i + 2]++;
      }
      if (i <= size - 1 && counts[i + 1] > 0) {
        counts[i]--;
        counts[i + 1]--;
        collect(0, 1);
        counts[i]++;
        counts[i + 1]++;
      }
      if (i <= size - 2 && counts[i + 2] > 0) {
        counts[i]--;
        counts[i + 2]--;
        collect(0, 1);
        counts[i]++;
        counts[i + 2]++;
      }
    }
    // Waste this single tile and move on.
    counts[i]--;
    collect(0, 0);
    counts[i]++;

    const pruned = paretoPrune(found);
    memo.set(key, pruned);
    return pruned;
  }
  return search(1);
}

function combineBlockOptions(perSuit: BlockOption[][]): BlockOption[] {
  let combined: BlockOption[] = [{ melds: 0, partials: 0 }];
  for (const options of perSuit) {
    const next: BlockOption[] = [];
    for (const c of combined) {
      for (const o of options) next.push({ melds: c.melds + o.melds, partials: c.partials + o.partials });
    }
    combined = paretoPrune(next);
  }
  return combined;
}

function oldStandardShanten(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): number {
  const suitsData: { counts: number[]; allowRuns: boolean }[] = [
    { counts: countsForSuit(tiles, "m", 9), allowRuns: true },
    { counts: countsForSuit(tiles, "t", 9), allowRuns: true },
    { counts: countsForSuit(tiles, "b", 9), allowRuns: true },
    { counts: countsForSuit(tiles, "z", 7), allowRuns: false },
  ];

  const scoreCombos = (combos: BlockOption[], hasPair: boolean): number => {
    let best = Infinity;
    for (const { melds, partials } of combos) {
      const cappedPartials = Math.min(partials, meldsRequired - melds);
      const blocksUsed = melds + cappedPartials;
      let sh = 2 * (meldsRequired - melds) - cappedPartials - (hasPair ? 1 : 0);
      if (!hasPair && blocksUsed === meldsRequired) sh += 1; // no tiles left in reserve to start a pair
      best = Math.min(best, sh);
    }
    return best;
  };

  // Each suit's options only ever depend on that suit's own counts, so
  // reserving a pair/tanki in one suit never needs the other 3 suits'
  // options recomputed - only swap out the one that actually changed.
  const baseOptions = suitsData.map((sd) => suitBlockOptions(sd.counts, sd.allowRuns));
  let overallBest = scoreCombos(combineBlockOptions(baseOptions), false);

  for (let i = 0; i < suitsData.length; i++) {
    const sd = suitsData[i];
    for (let rank = 1; rank < sd.counts.length; rank++) {
      if (sd.counts[rank] < 2) continue;
      sd.counts[rank] -= 2;
      const perSuit = baseOptions.slice();
      perSuit[i] = suitBlockOptions(sd.counts, sd.allowRuns);
      sd.counts[rank] += 2;
      overallBest = Math.min(overallBest, scoreCombos(combineBlockOptions(perSuit), true));
    }
  }

  // Try reserving a single tile as a tanki (pair-in-progress) candidate -
  // not a complete pair yet, but enough that the "no reserve at all"
  // penalty above shouldn't apply: drawing its match completes the pair for
  // free. Without this, a lone tile left over after melds/partials (e.g.
  // 123m9m, one meld plus a tanki wait on 9m) was scored as if nothing were
  // held back at all, overstating shanten by 1 - the block search above
  // only ever considers a *complete* pair (>=2 matching), never a single.
  for (let i = 0; i < suitsData.length; i++) {
    const sd = suitsData[i];
    for (let rank = 1; rank < sd.counts.length; rank++) {
      if (sd.counts[rank] < 1) continue;
      sd.counts[rank] -= 1;
      const perSuit = baseOptions.slice();
      perSuit[i] = suitBlockOptions(sd.counts, sd.allowRuns);
      sd.counts[rank] += 1;
      const combos = combineBlockOptions(perSuit);
      for (const { melds, partials } of combos) {
        const cappedPartials = Math.min(partials, meldsRequired - melds);
        const sh = 2 * (meldsRequired - melds) - cappedPartials; // no -1 (pair isn't complete), no +1 (a tile IS held back)
        overallBest = Math.min(overallBest, sh);
      }
    }
  }

  return overallBest;
}

function eightPairsShanten(tiles: Tile[]): number {
  const counts = countAll(tiles);
  let pairUnits = 0;
  let hasSpare = false;
  for (const c of counts.values()) {
    pairUnits += Math.floor(c / 2);
    // Only a kind held three times is the spare: all four are two pairs
    // already, and can't also be the triplet (1111 + 7 pairs + 2 singles
    // isn't ready - it read as ready, and was declared 叮).
    if (c === 3) hasSpare = true;
  }
  return 8 - pairUnits - (hasSpare ? 1 : 0);
}

interface UnrelatedDpState {
  units: number;
  // Whether some selection achieving `units` also keeps a spare duplicate of
  // one of its ranks - the pair can then come "for free" from tiles already
  // in hand, rather than needing a 17th tile, unlocking a single-tile wait
  // one slot earlier (see sixteenUnrelatedShanten).
  hasPair: boolean;
}

function maxUnrelatedWithPair(counts: number[]): UnrelatedDpState {
  let prev3: UnrelatedDpState = { units: 0, hasPair: false };
  let prev2: UnrelatedDpState = { units: 0, hasPair: false };
  let prev1: UnrelatedDpState = { units: 0, hasPair: false };
  let current: UnrelatedDpState = { units: 0, hasPair: false };
  for (let r = 1; r <= 9; r++) {
    const base = r - 3 >= 0 ? prev3 : { units: 0, hasPair: false };
    current = prev1; // skip r
    if (counts[r] > 0) {
      const use: UnrelatedDpState = { units: base.units + 1, hasPair: base.hasPair || counts[r] >= 2 };
      if (use.units > current.units) current = use;
      else if (use.units === current.units) current = { units: current.units, hasPair: current.hasPair || use.hasPair };
    }
    prev3 = prev2;
    prev2 = prev1;
    prev1 = current;
  }
  return current;
}

function sixteenUnrelatedShanten(tiles: Tile[]): number {
  const mState = maxUnrelatedWithPair(countsForSuit(tiles, "m", 9));
  const tState = maxUnrelatedWithPair(countsForSuit(tiles, "t", 9));
  const bState = maxUnrelatedWithPair(countsForSuit(tiles, "b", 9));

  const zCounts = countsForSuit(tiles, "z", 7);
  let honorUnits = 0;
  let honorHasPair = false;
  for (let r = 1; r <= 7; r++) {
    if (zCounts[r] > 0) {
      honorUnits++;
      if (zCounts[r] >= 2) honorHasPair = true;
    }
  }

  const units = mState.units + tState.units + bState.units + honorUnits;
  const hasPair = mState.hasPair || tState.hasPair || bState.hasPair || honorHasPair;
  return 16 - units - (hasPair ? 1 : 0);
}

function oldShanten(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): number {
  let best = oldStandardShanten(tiles, meldsRequired);
  if (meldsRequired === MELDS_REQUIRED) {
    best = Math.min(best, eightPairsShanten(tiles));
    best = Math.min(best, sixteenUnrelatedShanten(tiles));
    // (Ready or complete by it needs at least 12 of the 13 orphans in hand.)
    const orphans = new Set(tiles.filter((t) => t.suit === "z" || t.rank === 1 || t.rank === 9).map(tileKey)).size;
    if (orphans >= 12) {
      if (best > -1 && tiles.length === COMPLETE_SIZE && oldIsThirteenOrphansComplete(tiles)) best = -1;
      else if (best > 0 && tiles.length === COMPLETE_SIZE - 1 && allTileKinds().some((t) => oldIsThirteenOrphansComplete([...tiles, t]))) best = 0;
    }
  }
  return best;
}

function oldGetWaits(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): Tile[] {
  if (tiles.length !== meldsRequired * 3 + 1) return [];

  const waits: Tile[] = [];
  for (const candidate of allTileKinds()) {
    if (tileCount(tiles, candidate) >= 4) continue; // all 4 copies already used, can't draw a 5th
    if (oldIsCompleteHand([...tiles, candidate], meldsRequired)) {
      waits.push(candidate);
    }
  }
  return waits;
}