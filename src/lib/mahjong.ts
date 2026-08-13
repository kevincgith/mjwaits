// Core engine for a Taiwanese (16-tile) Mahjong waits calculator.
//
// A complete Taiwanese hand is 5 melds (triplet or run) + 1 pair = 17 tiles.
// A tenpai hand is 16 tiles, one tile short of complete. This module figures
// out, for a given 16-tile hand, which tiles complete it.

export type Suit = "m" | "t" | "s" | "z" | "j";

export interface Tile {
  suit: Suit;
  rank: number; // 1-9 for m/t/s, 1-7 for z (honors), always 1 for j (joker)
}

export const MELDS_REQUIRED = 5;
export const TENPAI_SIZE = MELDS_REQUIRED * 3 + 1; // 16
export const COMPLETE_SIZE = MELDS_REQUIRED * 3 + 2; // 17

// A hand can only be checked for waits at sizes of the form 3n + 1 (one tile
// short of some number of complete melds plus a pair): 1, 4, 7, 10, 13, 16.
export function isCheckpointSize(size: number): boolean {
  return size >= 1 && size <= TENPAI_SIZE && size % 3 === 1;
}

export function meldsForSize(size: number): number {
  return (size - 1) / 3;
}

// Honor order/labels: 1 East, 2 South, 3 West, 4 North, 5 Red, 6 Green, 7 White.
const HONOR_NAMES = ["", "East", "South", "West", "North", "Red", "Green", "White"];

export function tileKey(t: Tile): string {
  return `${t.suit}${t.rank}`;
}

export function allTileKinds(): Tile[] {
  const tiles: Tile[] = [];
  for (const suit of ["m", "t", "s"] as const) {
    for (let rank = 1; rank <= 9; rank++) tiles.push({ suit, rank });
  }
  for (let rank = 1; rank <= 7; rank++) tiles.push({ suit: "z", rank });
  return tiles;
}

export function tileLabel(t: Tile): string {
  if (t.suit === "j") return "Joker";
  if (t.suit === "z") return HONOR_NAMES[t.rank];
  const suitName = t.suit === "m" ? "Man" : t.suit === "t" ? "Pin" : "Sou";
  return `${t.rank} ${suitName}`;
}

// Unicode Mahjong Tiles block glyphs (U+1F000-U+1F02B).
// Honor order: East South West North (1F000-1F003), Red Green White (1F004,1F005,1F006).
const HONOR_CODEPOINTS: Record<number, number> = {
  1: 0x1f000,
  2: 0x1f001,
  3: 0x1f002,
  4: 0x1f003,
  5: 0x1f004,
  6: 0x1f005,
  7: 0x1f006,
};

// U+FE0E forces text (not emoji/color) presentation, since some of these
// codepoints (notably Red Dragon, U+1F004) default to emoji presentation
// while the rest of the block doesn't, which otherwise looks inconsistent.
const TEXT_PRESENTATION = String.fromCodePoint(0xfe0e);

export function tileGlyph(t: Tile): string {
  if (t.suit === "m") return String.fromCodePoint(0x1f007 + (t.rank - 1)) + TEXT_PRESENTATION;
  if (t.suit === "s") return String.fromCodePoint(0x1f010 + (t.rank - 1)) + TEXT_PRESENTATION;
  if (t.suit === "t") return String.fromCodePoint(0x1f019 + (t.rank - 1)) + TEXT_PRESENTATION;
  if (t.suit === "j") return String.fromCodePoint(0x1f02a) + TEXT_PRESENTATION;
  return String.fromCodePoint(HONOR_CODEPOINTS[t.rank]) + TEXT_PRESENTATION;
}

export class ParseError extends Error {}

// Parses algebraic notation like "123456789m11p22s" or "111z" into tiles.
// Jokers are written as one or more bare "j" characters (no digits, since a
// joker has no rank), e.g. "jj" for two jokers.
export function parseHand(input: string): Tile[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];
  const groupPattern = /(\d+)([mtsz])|(j+)/g;
  const tiles: Tile[] = [];
  let matched = "";
  let match: RegExpExecArray | null;
  while ((match = groupPattern.exec(trimmed)) !== null) {
    matched += match[0];
    const [, digits, suitChar, jokers] = match;
    if (jokers !== undefined) {
      for (const _ of jokers) tiles.push({ suit: "j", rank: 1 });
      continue;
    }
    const suit = suitChar as Suit;
    for (const d of digits) {
      const rank = Number(d);
      if (suit === "z") {
        if (rank < 1 || rank > 7) {
          throw new ParseError(`Invalid honor tile "${d}z" (must be 1-7)`);
        }
      } else if (rank < 1 || rank > 9) {
        throw new ParseError(`Invalid tile "${d}${suit}" (must be 1-9)`);
      }
      tiles.push({ suit, rank });
    }
  }
  if (matched.replace(/\s/g, "") !== trimmed.replace(/\s/g, "")) {
    throw new ParseError(`Could not parse: "${trimmed}"`);
  }
  if (tiles.length > TENPAI_SIZE) {
    throw new ParseError(`Too many tiles (max ${TENPAI_SIZE})`);
  }

  const counts = new Map<string, number>();
  for (const t of tiles) {
    if (t.suit === "j") continue; // jokers aren't capped at 4 copies
    const key = tileKey(t);
    const count = (counts.get(key) ?? 0) + 1;
    if (count > 4) {
      throw new ParseError(`Too many copies of ${tileLabel(t)} (max 4)`);
    }
    counts.set(key, count);
  }

  return tiles;
}

export function tileCount(tiles: Tile[], tile: Tile): number {
  return tiles.filter((t) => t.suit === tile.suit && t.rank === tile.rank).length;
}

// Groups tiles by suit (required by the notation format) but otherwise
// preserves the given order of ranks within each suit - callers that want
// ranks sorted should sort `tiles` first (see sortTiles). Jokers (no rank)
// are written as a run of bare "j" characters.
export function formatHand(tiles: Tile[]): string {
  const bySuit: Record<Suit, number[]> = { m: [], t: [], s: [], z: [], j: [] };
  for (const t of tiles) bySuit[t.suit].push(t.rank);
  const order: Suit[] = ["m", "t", "s", "z", "j"];
  return order
    .filter((suit) => bySuit[suit].length > 0)
    .map((suit) => (suit === "j" ? "j".repeat(bySuit.j.length) : bySuit[suit].join("") + suit))
    .join("");
}

export function sortTiles(tiles: Tile[]): Tile[] {
  const order: Record<Suit, number> = { m: 0, t: 1, s: 2, z: 3, j: 4 };
  return [...tiles].sort((a, b) => order[a.suit] - order[b.suit] || a.rank - b.rank);
}

function countsForSuit(tiles: Tile[], suit: Suit, size: number): number[] {
  const counts = new Array(size + 1).fill(0);
  for (const t of tiles) if (t.suit === suit) counts[t.rank]++;
  return counts;
}

// Can `counts` (1-indexed, index 0 unused) be fully decomposed into triplets
// (and runs, if `allowRuns`) with nothing left over?
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

// Same search as canDecompose, but records the actual meld tiles formed
// (pushed onto `groups` on the successful path, popped on backtrack).
function decomposeSuitGroups(counts: number[], allowRuns: boolean, suit: Suit, groups: Tile[][]): boolean {
  const size = counts.length - 1;
  let i = 1;
  while (i <= size && counts[i] === 0) i++;
  if (i > size) return true;

  if (counts[i] >= 3) {
    counts[i] -= 3;
    groups.push([
      { suit, rank: i },
      { suit, rank: i },
      { suit, rank: i },
    ]);
    if (decomposeSuitGroups(counts, allowRuns, suit, groups)) {
      counts[i] += 3;
      return true;
    }
    groups.pop();
    counts[i] += 3;
  }

  if (allowRuns && i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    groups.push([
      { suit, rank: i },
      { suit, rank: i + 1 },
      { suit, rank: i + 2 },
    ]);
    if (decomposeSuitGroups(counts, allowRuns, suit, groups)) {
      counts[i]++;
      counts[i + 1]++;
      counts[i + 2]++;
      return true;
    }
    groups.pop();
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
  }

  return false;
}

// The 13 "orphan" kinds: the terminal (1/9) of each numbered suit, plus all
// 7 honors.
const ORPHAN_TILES: Tile[] = [
  { suit: "m", rank: 1 },
  { suit: "m", rank: 9 },
  { suit: "t", rank: 1 },
  { suit: "t", rank: 9 },
  { suit: "s", rank: 1 },
  { suit: "s", rank: 9 },
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

// After removing one candidate meld, do the remaining 14 tiles consist of
// exactly the 13 orphan kinds, each once, except one kind twice (the pair)?
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
  for (const suit of ["m", "t", "s"] as const) {
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

// The Taiwanese 16-tile Thirteen Orphans special hand: all 13 orphan kinds
// (one of each), one of them doubled to form the pair, plus one ordinary
// meld (pong or chow) - 13 + 1 + 3 = 17 tiles. Structurally unrelated to the
// standard "N melds + pair" shape, so it's checked separately.
export function isThirteenOrphansComplete(tiles: Tile[]): boolean {
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

// The Taiwanese 16-tile Eight Pairs special hand ("liuliu"): 8 pairs of
// tile kinds (16 tiles), plus one more tile matching one of those pairs,
// upgrading it to a triplet - 7*2 + 1*3 = 17 tiles. A kind can also appear
// as all 4 copies at once, counting as two of the 8 pairs.
export function isEightPairsComplete(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;
  const counts = countAll(tiles);
  let tripleKinds = 0;
  for (const c of counts.values()) {
    if (c === 3) tripleKinds++;
    else if (c !== 2 && c !== 4) return false; // a lone single or 5+ copies breaks the pattern
  }
  return tripleKinds === 1;
}

// For Sixteen Unrelated Tiles, two same-suit ranks are "unrelated" (could
// never share a chow, even with a helpful third tile) once they're at least
// 3 apart - e.g. 1/4/7 all work together, but 1/2 or 1/3 don't, since a
// drawn 3 or 2 would let them share a run. The tightest such gap fits at
// most 3 ranks into 1-9 (e.g. 1/4/7), so each numbered suit contributes
// exactly 3 kinds; combined with all 7 honors (which - having no runs at
// all - are always mutually unrelated) that's the full 16.
function unrelatedRanksOk(ranks: number[]): boolean {
  if (ranks.length !== 3) return false;
  const sorted = [...ranks].sort((a, b) => a - b);
  return sorted[1] - sorted[0] >= 3 && sorted[2] - sorted[1] >= 3;
}

// The Taiwanese 16-tile Sixteen Unrelated Tiles special hand: all 7 honors,
// plus 3 mutually-unrelated ranks (see unrelatedRanksOk) from each of m/t/s
// - 7 + 3*3 = 16 distinct kinds - plus one more tile matching one of those
// 16 to form the pair (15*1 + 1*2 = 17 tiles total).
export function isSixteenUnrelatedComplete(tiles: Tile[]): boolean {
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
  const bySuit: Record<"m" | "t" | "s", number[]> = { m: [], t: [], s: [] };
  for (const key of counts.keys()) {
    const suit = key[0] as Suit;
    if (suit === "m" || suit === "t" || suit === "s") bySuit[suit].push(Number(key.slice(1)));
  }
  return (["m", "t", "s"] as const).every((suit) => unrelatedRanksOk(bySuit[suit]));
}

// Checks whether `tiles` decomposes into `meldsRequired` melds (triplet/run)
// plus exactly one pair, i.e. tiles.length must be meldsRequired * 3 + 2.
export function isCompleteHand(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): boolean {
  if (tiles.length !== meldsRequired * 3 + 2) return false;
  if (
    meldsRequired === MELDS_REQUIRED &&
    (isThirteenOrphansComplete(tiles) || isEightPairsComplete(tiles) || isSixteenUnrelatedComplete(tiles))
  ) {
    return true;
  }

  const m = countsForSuit(tiles, "m", 9);
  const t = countsForSuit(tiles, "t", 9);
  const s = countsForSuit(tiles, "s", 9);
  const z = countsForSuit(tiles, "z", 7);

  const suitsData: { counts: number[]; allowRuns: boolean }[] = [
    { counts: m, allowRuns: true },
    { counts: t, allowRuns: true },
    { counts: s, allowRuns: true },
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

export interface HandBreakdown {
  pair: Tile[];
  melds: Tile[][];
}

// Returns one valid meld+pair decomposition of a complete standard-shape
// hand (special hands like Thirteen Orphans/Eight Pairs don't decompose
// this way and return null here). For a hand with jokers already resolved
// to concrete tiles (see getWaitsWithJokers's `jokers` field), this finds
// SOME valid grouping - not necessarily the exact one the joker search
// used internally, but an equally valid one, which is all display needs.
export function decomposeHand(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): HandBreakdown | null {
  if (tiles.length !== meldsRequired * 3 + 2) return null;

  const suitsData: { suit: Suit; counts: number[]; allowRuns: boolean }[] = [
    { suit: "m", counts: countsForSuit(tiles, "m", 9), allowRuns: true },
    { suit: "t", counts: countsForSuit(tiles, "t", 9), allowRuns: true },
    { suit: "s", counts: countsForSuit(tiles, "s", 9), allowRuns: true },
    { suit: "z", counts: countsForSuit(tiles, "z", 7), allowRuns: false },
  ];

  for (const sd of suitsData) {
    for (let rank = 1; rank < sd.counts.length; rank++) {
      if (sd.counts[rank] < 2) continue;
      sd.counts[rank] -= 2;
      const melds: Tile[][] = [];
      const ok = suitsData.every((s2) => decomposeSuitGroups(s2.counts, s2.allowRuns, s2.suit, melds));
      sd.counts[rank] += 2;
      if (ok) {
        return {
          pair: [
            { suit: sd.suit, rank },
            { suit: sd.suit, rank },
          ],
          melds,
        };
      }
    }
  }
  return null;
}

// --- Shanten (distance to tenpai) --------------------------------------
//
// Shanten counts the minimum number of discard+draw exchanges needed to
// reach tenpai (0 = already tenpai). Unlike isCompleteHand/getWaits, which
// only need to know whether a decomposition exists, shanten needs the BEST
// achievable decomposition, since a hand rarely decomposes cleanly.
//
// A "block" is a complete meld (3 tiles), a partial meld/"taatsu" (2 tiles
// needing exactly 1 more - a pair-toward-triplet, a two-sided run shape, or
// a closed/kanchan run shape), or the pair (2 matching tiles, reserved
// separately, at most one per hand). Leftover tiles are simply wasted.

interface BlockOption {
  melds: number;
  partials: number;
}

function paretoPrune(options: BlockOption[]): BlockOption[] {
  const unique = Array.from(new Map(options.map((o) => [`${o.melds},${o.partials}`, o])).values());
  return unique.filter(
    (a) => !unique.some((b) => b !== a && b.melds >= a.melds && b.partials >= a.partials && (b.melds > a.melds || b.partials > a.partials))
  );
}

// Every Pareto-optimal (melds, partials) combination achievable by
// decomposing `counts` - not necessarily completely, leftover tiles are
// simply left unused. `counts` is restored to its original values on return
// (mutated only transiently during the search).
function suitBlockOptions(counts: number[], allowRuns: boolean): BlockOption[] {
  const size = counts.length - 1;
  const found: BlockOption[] = [];

  function search(from: number, melds: number, partials: number) {
    let i = from;
    while (i <= size && counts[i] === 0) i++;
    if (i > size) {
      found.push({ melds, partials });
      return;
    }

    if (counts[i] >= 3) {
      counts[i] -= 3;
      search(i, melds + 1, partials);
      counts[i] += 3;
    }
    if (counts[i] >= 2) {
      counts[i] -= 2;
      search(i, melds, partials + 1);
      counts[i] += 2;
    }
    if (allowRuns) {
      if (i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
        counts[i]--;
        counts[i + 1]--;
        counts[i + 2]--;
        search(i, melds + 1, partials);
        counts[i]++;
        counts[i + 1]++;
        counts[i + 2]++;
      }
      if (i <= size - 1 && counts[i + 1] > 0) {
        counts[i]--;
        counts[i + 1]--;
        search(i, melds, partials + 1);
        counts[i]++;
        counts[i + 1]++;
      }
      if (i <= size - 2 && counts[i + 2] > 0) {
        counts[i]--;
        counts[i + 2]--;
        search(i, melds, partials + 1);
        counts[i]++;
        counts[i + 2]++;
      }
    }
    // Waste this single tile and move on.
    counts[i]--;
    search(i, melds, partials);
    counts[i]++;
  }

  search(1, 0, 0);
  return paretoPrune(found);
}

// Combine each suit's independent options into the Pareto-optimal set of
// achievable (melds, partials) totals across the whole hand.
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

// Standard-shape shanten for a hand at any checkpoint size (works the same
// way isCheckpointSize/meldsForSize do for smaller practice sizes, not just
// the full 16-tile hand). Doesn't know about jokers or the special hands
// (Thirteen Orphans, Eight Pairs) - see shanten() below, which folds in
// Eight Pairs.
export function standardShanten(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): number {
  const suitsData: { counts: number[]; allowRuns: boolean }[] = [
    { counts: countsForSuit(tiles, "m", 9), allowRuns: true },
    { counts: countsForSuit(tiles, "t", 9), allowRuns: true },
    { counts: countsForSuit(tiles, "s", 9), allowRuns: true },
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

  let overallBest = scoreCombos(combineBlockOptions(suitsData.map((sd) => suitBlockOptions(sd.counts, sd.allowRuns))), false);

  for (const sd of suitsData) {
    for (let rank = 1; rank < sd.counts.length; rank++) {
      if (sd.counts[rank] < 2) continue;
      sd.counts[rank] -= 2;
      const combos = combineBlockOptions(suitsData.map((s2) => suitBlockOptions(s2.counts, s2.allowRuns)));
      sd.counts[rank] += 2;
      overallBest = Math.min(overallBest, scoreCombos(combos, true));
    }
  }

  return overallBest;
}

// Eight Pairs shanten: 8 - (number of "pair units", where a kind with 2
// copies is 1 unit and a kind with all 4 is 2 units). Only meaningful at
// the full 16-tile hand size, matching how the special hand itself works.
function eightPairsShanten(tiles: Tile[]): number {
  const counts = countAll(tiles);
  let pairUnits = 0;
  for (const c of counts.values()) pairUnits += Math.floor(c / 2);
  return 8 - pairUnits;
}

interface UnrelatedDpState {
  units: number;
  // Whether some selection achieving `units` also keeps a spare duplicate of
  // one of its ranks - the pair can then come "for free" from tiles already
  // in hand, rather than needing a 17th tile, unlocking a single-tile wait
  // one slot earlier (see sixteenUnrelatedShanten).
  hasPair: boolean;
}

// Best (units, hasPair) achievable for one numbered suit's rank counts, such
// that every selected pair of ranks is at least 3 apart - a DP over rank,
// capped at 3 selected ranks (see unrelatedRanksOk for why 3 is the ceiling
// in 1-9).
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

// Sixteen Unrelated Tiles shanten: the target shape has 16 "slots" - all 7
// honors, plus 3 mutually-unrelated ranks in each of m/t/s - so shanten
// counts how many of those 16 slots still need a discard+draw exchange to
// fill, minus 1 more if a spare duplicate already in hand can serve as the
// pair without needing a dedicated 17th tile. Only meaningful at the full
// 16-tile hand size, matching the special hand itself.
function sixteenUnrelatedShanten(tiles: Tile[]): number {
  const mState = maxUnrelatedWithPair(countsForSuit(tiles, "m", 9));
  const tState = maxUnrelatedWithPair(countsForSuit(tiles, "t", 9));
  const sState = maxUnrelatedWithPair(countsForSuit(tiles, "s", 9));

  const zCounts = countsForSuit(tiles, "z", 7);
  let honorUnits = 0;
  let honorHasPair = false;
  for (let r = 1; r <= 7; r++) {
    if (zCounts[r] > 0) {
      honorUnits++;
      if (zCounts[r] >= 2) honorHasPair = true;
    }
  }

  const units = mState.units + tState.units + sState.units + honorUnits;
  const hasPair = mState.hasPair || tState.hasPair || sState.hasPair || honorHasPair;
  return 16 - units - (hasPair ? 1 : 0);
}

// Overall shanten: the best of the standard shape, Eight Pairs, and Sixteen
// Unrelated Tiles. Doesn't account for jokers (callers should check for
// those separately) or Thirteen Orphans (whose shanten interacts with the
// extra required meld in a way this module doesn't compute yet).
export function shanten(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): number {
  let best = standardShanten(tiles, meldsRequired);
  if (meldsRequired === MELDS_REQUIRED) {
    best = Math.min(best, eightPairsShanten(tiles));
    best = Math.min(best, sixteenUnrelatedShanten(tiles));
  }
  return best;
}

// For a hand one tile short of meldsRequired melds + a pair (length
// meldsRequired * 3 + 1), returns every tile kind that completes it.
export function getWaits(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): Tile[] {
  if (tiles.length !== meldsRequired * 3 + 1) return [];

  const waits: Tile[] = [];
  for (const candidate of allTileKinds()) {
    if (tileCount(tiles, candidate) >= 4) continue; // all 4 copies already used, can't draw a 5th
    if (isCompleteHand([...tiles, candidate], meldsRequired)) {
      waits.push(candidate);
    }
  }
  return waits;
}

// Joker support: a joker tile can stand in for any of the 34 real tile
// kinds. Rather than brute-forcing which real tile each joker becomes (kept
// below, but only as a bounded fallback for special-hand detection), treat
// joker count as a shared wildcard budget spent during the ordinary
// meld/pair search - this makes wait-finding O(34 candidate draws x a
// small bounded search), independent of how many jokers are in the hand.

interface JokerSuitData {
  suit: Suit;
  counts: number[];
  allowRuns: boolean;
}

// A hard ceiling on recursive search steps, shared across one
// getWaitsWithJokers call, as a defensive guard against any pathological
// hand shape. Benchmarked well under 1000 steps for realistic 16-tile
// hands, so this should never actually trigger.
const JOKER_SEARCH_STEP_LIMIT = 300_000;

// Tries to fully decompose `suitsData` (from suitIndex onward) into exactly
// `meldsRemaining` melds, spending from the shared `jokers` budget to pad
// any shortfall. Runs are tried anchored at each of their 3 possible
// positions relative to the lowest available real rank (start/mid/end) -
// once lower ranks are drained to 0, a joker can fill in below a real tile,
// so only trying "i as the low member" would miss valid decompositions.
// On success, pushes the resolved tile for every joker spent onto
// `resolved` (excess jokers beyond what's structurally needed become
// pure-joker melds, given a placeholder value since any works).
function decomposeMeldsWithJokers(
  suitsData: JokerSuitData[],
  suitIndex: number,
  meldsRemaining: number,
  jokers: number,
  resolved: Tile[],
  steps: { count: number }
): boolean {
  steps.count++;
  if (steps.count > JOKER_SEARCH_STEP_LIMIT) return false;

  if (suitIndex === suitsData.length) {
    if (jokers !== meldsRemaining * 3) return false;
    for (let k = 0; k < meldsRemaining; k++) {
      resolved.push({ suit: "m", rank: 1 }, { suit: "m", rank: 1 }, { suit: "m", rank: 1 });
    }
    return true;
  }

  const sd = suitsData[suitIndex];
  const counts = sd.counts;
  let i = 1;
  while (i < counts.length && counts[i] === 0) i++;
  if (i >= counts.length) {
    return decomposeMeldsWithJokers(suitsData, suitIndex + 1, meldsRemaining, jokers, resolved, steps);
  }
  if (meldsRemaining <= 0) return false;

  // Triplet at i.
  const tripletCost = Math.max(0, 3 - counts[i]);
  if (tripletCost <= jokers) {
    const used = Math.min(counts[i], 3);
    counts[i] -= used;
    for (let k = 0; k < tripletCost; k++) resolved.push({ suit: sd.suit, rank: i });
    if (decomposeMeldsWithJokers(suitsData, suitIndex, meldsRemaining - 1, jokers - tripletCost, resolved, steps)) {
      counts[i] += used;
      return true;
    }
    for (let k = 0; k < tripletCost; k++) resolved.pop();
    counts[i] += used;
  }

  // Runs containing i, anchored with i as the low/mid/high member.
  if (sd.allowRuns) {
    const patterns: [number, number, number][] = [
      [i, i + 1, i + 2],
      [i - 1, i, i + 1],
      [i - 2, i - 1, i],
    ];
    for (const pattern of patterns) {
      const [a, , c] = pattern;
      if (a < 1 || c >= counts.length) continue;
      let cost = 0;
      for (const r of pattern) if (counts[r] === 0) cost++;
      if (cost > jokers) continue;
      const usedReal = pattern.map((r) => (counts[r] > 0 ? 1 : 0));
      for (let k = 0; k < 3; k++) {
        counts[pattern[k]] -= usedReal[k];
        if (usedReal[k] === 0) resolved.push({ suit: sd.suit, rank: pattern[k] });
      }
      if (decomposeMeldsWithJokers(suitsData, suitIndex, meldsRemaining - 1, jokers - cost, resolved, steps)) {
        for (let k = 0; k < 3; k++) counts[pattern[k]] += usedReal[k];
        return true;
      }
      for (let k = 0; k < 3; k++) {
        if (usedReal[k] === 0) resolved.pop();
        counts[pattern[k]] += usedReal[k];
      }
    }
  }

  return false;
}

// Joker-aware standard-shape completeness check for `nonJokerTiles` (no
// joker suit) plus `jokerCount` wildcards, decomposed into `meldsRequired`
// melds + 1 pair. Returns a valid resolution for the jokers if possible
// (one example among possibly several), or null if impossible or the
// shared step budget ran out.
function resolveStandardWithJokers(
  nonJokerTiles: Tile[],
  jokerCount: number,
  meldsRequired: number,
  steps: { count: number }
): Tile[] | null {
  if (nonJokerTiles.length + jokerCount !== meldsRequired * 3 + 2) return null;

  const suitsData: JokerSuitData[] = [
    { suit: "m", counts: countsForSuit(nonJokerTiles, "m", 9), allowRuns: true },
    { suit: "t", counts: countsForSuit(nonJokerTiles, "t", 9), allowRuns: true },
    { suit: "s", counts: countsForSuit(nonJokerTiles, "s", 9), allowRuns: true },
    { suit: "z", counts: countsForSuit(nonJokerTiles, "z", 7), allowRuns: false },
  ];

  for (const sd of suitsData) {
    for (let r = 1; r < sd.counts.length; r++) {
      if (sd.counts[r] === 0) continue;
      const used = Math.min(sd.counts[r], 2);
      const cost = 2 - used;
      if (cost > jokerCount) continue;
      sd.counts[r] -= used;
      const resolved: Tile[] = [];
      for (let k = 0; k < cost; k++) resolved.push({ suit: sd.suit, rank: r });
      const ok = decomposeMeldsWithJokers(suitsData, 0, meldsRequired, jokerCount - cost, resolved, steps);
      sd.counts[r] += used;
      if (ok) return resolved;
      if (steps.count > JOKER_SEARCH_STEP_LIMIT) return null;
    }
  }

  // Pure-joker pair (no real anchor at all).
  if (jokerCount >= 2) {
    const resolved: Tile[] = [
      { suit: "m", rank: 1 },
      { suit: "m", rank: 1 },
    ];
    if (decomposeMeldsWithJokers(suitsData, 0, meldsRequired, jokerCount - 2, resolved, steps)) {
      return resolved;
    }
  }

  return null;
}

// C(n + k - 1, k), the number of multisets of size k drawn from n kinds.
function combinationsWithRepetition(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n + k - 1 - i)) / (i + 1);
  }
  return result;
}

// Every distinct multiset of `count` real tiles that could substitute for
// that many jokers, respecting the 4-copies-per-kind cap against whatever
// non-joker tiles are already present (`baseCounts`). Returns null if the
// number of combinations would exceed `cap`. Kept as a bounded fallback for
// special-hand detection (Thirteen Orphans, Eight Pairs), which the fast
// wildcard search above doesn't know about.
function jokerSubstitutions(count: number, baseCounts: Map<string, number>, cap: number): Tile[][] | null {
  if (count === 0) return [[]];
  const kinds = allTileKinds();
  const results: Tile[][] = [];
  let overflowed = false;

  function backtrack(startIndex: number, remaining: number, current: Tile[]) {
    if (overflowed) return;
    if (remaining === 0) {
      results.push([...current]);
      if (results.length > cap) overflowed = true;
      return;
    }
    for (let i = startIndex; i < kinds.length && !overflowed; i++) {
      const kind = kinds[i];
      const key = tileKey(kind);
      const alreadyUsed = (baseCounts.get(key) ?? 0) + current.filter((t) => tileKey(t) === key).length;
      if (alreadyUsed >= 4) continue;
      current.push(kind);
      backtrack(i, remaining - 1, current); // same start index -> combinations, not permutations
      current.pop();
    }
  }

  backtrack(0, count, []);
  return overflowed ? null : results;
}

// Special hands are only checked with jokers when there are few enough that
// the combinatorial fallback stays cheap (benchmarked: 4 jokers is ~66,045
// combinations, well under a second).
const SPECIAL_HAND_JOKER_LIMIT = 4;
export const MAX_JOKER_COMBINATIONS = 100_000;

export interface JokerWaitResult {
  wait: Tile;
  // What each joker resolves to for this particular wait (empty if the hand
  // has no jokers). One valid assignment among possibly several.
  jokers: Tile[];
}

export type JokerWaitsOutcome =
  | { overflowed: false; results: JokerWaitResult[] }
  | { overflowed: true; estimatedCombinations: number };

// Joker-aware version of getWaits. Behaves exactly like getWaits when there
// are no jokers; otherwise combines the fast wildcard-decomposition search
// (standard N-melds + pair shape, any joker count) with a small bounded
// brute-force fallback that also catches special hands (Thirteen Orphans,
// Eight Pairs) when there are few enough jokers for that to be cheap.
export function getWaitsWithJokers(
  tiles: Tile[],
  meldsRequired: number = MELDS_REQUIRED
): JokerWaitsOutcome {
  const jokerCount = tiles.filter((t) => t.suit === "j").length;
  if (jokerCount === 0) {
    return { overflowed: false, results: getWaits(tiles, meldsRequired).map((wait) => ({ wait, jokers: [] })) };
  }

  const nonJokers = tiles.filter((t) => t.suit !== "j");
  const found = new Map<string, Tile[]>();
  const steps = { count: 0 };
  let overflowed = false;

  for (const candidate of allTileKinds()) {
    if (tileCount(nonJokers, candidate) >= 4) continue;
    if (steps.count > JOKER_SEARCH_STEP_LIMIT) {
      overflowed = true;
      break;
    }
    const resolution = resolveStandardWithJokers([...nonJokers, candidate], jokerCount, meldsRequired, steps);
    if (resolution) found.set(tileKey(candidate), resolution);
  }

  if (!overflowed && jokerCount <= SPECIAL_HAND_JOKER_LIMIT) {
    const baseCounts = countAll(nonJokers);
    const substitutions = jokerSubstitutions(jokerCount, baseCounts, MAX_JOKER_COMBINATIONS);
    if (substitutions !== null) {
      for (const substitution of substitutions) {
        const concreteHand = [...nonJokers, ...substitution];
        for (const wait of getWaits(concreteHand, meldsRequired)) {
          const key = tileKey(wait);
          if (!found.has(key)) found.set(key, substitution);
        }
      }
    }
  }

  if (overflowed) {
    const estimate = combinationsWithRepetition(allTileKinds().length, jokerCount);
    return { overflowed: true, estimatedCombinations: estimate };
  }

  const results = Array.from(found.entries()).map(([key, jokers]) => ({
    wait: allTileKinds().find((t) => tileKey(t) === key)!,
    jokers,
  }));
  return { overflowed: false, results };
}

export interface DiscardOption {
  discard: Tile;
  draws: Tile[];
}

function uniqueTileKinds(tiles: Tile[]): Tile[] {
  const seen = new Set<string>();
  const unique: Tile[] = [];
  for (const t of tiles) {
    const key = tileKey(t);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(t);
    }
  }
  return unique;
}

// For a hand at a checkpoint size (meldsRequired * 3 + 1), and assuming it is
// NOT already tenpai, finds every (discard, resulting useful draws) pair:
// for each distinct tile you could discard, which tiles - once drawn - bring
// the hand back to that size and into tenpai. Options are sorted by number
// of useful draws, most first.
export function analyzeDiscards(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): DiscardOption[] {
  const size = meldsRequired * 3 + 1;
  if (tiles.length !== size) return [];

  const options: DiscardOption[] = [];
  for (const discard of uniqueTileKinds(tiles)) {
    const discardIndex = tiles.findIndex((t) => t.suit === discard.suit && t.rank === discard.rank);
    const remaining = [...tiles.slice(0, discardIndex), ...tiles.slice(discardIndex + 1)];

    const draws: Tile[] = [];
    for (const candidate of allTileKinds()) {
      if (tileCount(remaining, candidate) >= 4) continue;
      const redrawn = [...remaining, candidate];
      if (getWaits(redrawn, meldsRequired).length > 0) {
        draws.push(candidate);
      }
    }
    options.push({ discard, draws });
  }

  return options.sort((a, b) => b.draws.length - a.draws.length);
}

export interface DiscardDrawDetail {
  // A tile that, once drawn after this discard, brings the hand to tenpai.
  draw: Tile;
  // How many copies of `draw` are left to draw (4 minus copies already visible in hand).
  drawRemaining: number;
  // The wait the hand ends up with after drawing `draw`.
  resultingWaits: Tile[];
  // Total remaining copies across all of `resultingWaits` (the "waits count" total).
  resultingWaitsTotal: number;
}

export interface DiscardEfficiency {
  discard: Tile;
  draws: DiscardDrawDetail[];
  // Sum over draws of drawRemaining * resultingWaitsTotal: a rough weight for
  // "how many two-step paths (draw, then win-tile) this discard opens up."
  // Higher is better. Jokers are not supported (matches analyzeDiscards).
  score: number;
}

// Like analyzeDiscards, but for each useful draw also looks one step further:
// the remaining count of that draw tile, and the wait (plus its own remaining
// count) the hand would have once that tile is drawn. Options are sorted by
// `score`, a weighted-probability proxy built on the same remaining-count
// logic as the Waits Count feature, most efficient discard first.
export function analyzeDiscardEfficiency(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): DiscardEfficiency[] {
  const size = meldsRequired * 3 + 1;
  if (tiles.length !== size) return [];

  const options: DiscardEfficiency[] = [];
  for (const discard of uniqueTileKinds(tiles)) {
    const discardIndex = tiles.findIndex((t) => t.suit === discard.suit && t.rank === discard.rank);
    const remaining = [...tiles.slice(0, discardIndex), ...tiles.slice(discardIndex + 1)];

    const draws: DiscardDrawDetail[] = [];
    let score = 0;
    for (const candidate of allTileKinds()) {
      const drawRemaining = 4 - tileCount(remaining, candidate);
      if (drawRemaining <= 0) continue;
      const redrawn = [...remaining, candidate];
      const resultingWaits = getWaits(redrawn, meldsRequired);
      if (resultingWaits.length === 0) continue;

      const resultingWaitsTotal = resultingWaits.reduce((sum, w) => sum + (4 - tileCount(redrawn, w)), 0);
      draws.push({ draw: candidate, drawRemaining, resultingWaits, resultingWaitsTotal });
      score += drawRemaining * resultingWaitsTotal;
    }

    draws.sort((a, b) => b.drawRemaining * b.resultingWaitsTotal - a.drawRemaining * a.resultingWaitsTotal);
    options.push({ discard, draws, score });
  }

  return options.sort((a, b) => b.score - a.score);
}
